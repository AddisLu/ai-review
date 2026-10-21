// 題庫 → 已拍的考卷 (#/bank?view=exams): every exam photographed, newest scan first, found by tapping
// chips or typing part of its name. It used to sit beside the camera on 掃描; it lives here now.
import { get, post, state, thumbUrl, waitJob } from '../api.js';
import { $, SUBJECT_META, errToast, esc, fmtDate, html, icon, localDay, subjectColor, termStart, toast } from '../ui.js';
import { EXAMS_HREF, checkWatched } from './scan.js';

// the tabs of 題庫: 找題目 (banksearch.js) and 已拍的考卷 (here)
export const bankTabs = (on) => `<nav class="seg bk-tabs" aria-label="題庫">${[['q', '#/bank', '找題目'], ['exams', EXAMS_HREF, '已拍的考卷']]
  .map(([k, href, l]) => `<a href="${href}" class="${on === k ? 'on' : ''}" ${on === k ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;

// a parent who picked a child sees (and regenerates) that child's exams; on her own record, the family's
const kidId = () => { const u = state.status.user; return u.role === 'parent' && state.studentId !== u.id ? state.studentId : null; };

export async function render(main) {
  html(main, `<div class="ex-page">
  <div class="page-head bk-top"><div class="grow"><h1>題庫</h1><div class="sub">像書櫃一樣：一天一層，最新的在最上面；同一科疊成一疊，點一下展開</div></div>
    <a class="btn ghost sm" href="#/bank?view=analysis">${icon('chart', 16)}<span class="bk-lbl"> 弱點分析</span></a>
    <a class="btn ghost sm" href="#/scan">${icon('scan', 16)}<span class="bk-lbl"> 拍考卷</span></a></div>
  ${bankTabs('exams')}
  <div class="ex-tools">
    <input type="search" id="exq" placeholder="找考卷（名稱、科目）" style="flex:1 1 220px;width:auto;min-height:40px;font-size:16px">
    ${state.status.user.role === 'parent' ? `<button class="btn sm soft" id="regen">${icon('redo', 15)} 依範本重新產生</button>` : ''}</div>
  <div id="exf" class="exf"></div>
  <div id="exams" class="ex-case"><div class="empty"><span class="spinner"></span></div></div></div>`);
  const rg = $('#regen');
  if (rg) rg.onclick = () => regenerate(null, kidId());
  await loadExams();
}

// 第幾回: exams of one series (e.g. 私中入學測驗模擬試題 語文推理 第1回、第2回…) are grouped, so it is
// easy to see which ones are already photographed and which are still missing
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function seriesOf(title = '') {
  const m = title.match(/第\s*([0-9０-９]+|[一二三四五六七八九十]+)\s*[回次]/);
  if (!m) return null;
  let n = m[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 65248));
  n = /^\d+$/.test(n) ? Number(n) : n.length === 1 ? CN[n] : n === '十' ? 10 : n.startsWith('十') ? 10 + CN[n[1]] : CN[n[0]] * 10 + (CN[n[2]] || 0);
  const base = title.replace(m[0], '').replace(/[《》（）()〈〉【】\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return { base, n };
}

// a shelf's label: 今天 / 昨天, the date, the weekday (the year only when it is not this year)
const WD = '日一二三四五六';
function dayLabel(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const today = localDay(), y = localDay(-1);
  const dt = new Date(`${d}T12:00:00`), date = d.startsWith(today.slice(0, 4)) ? fmtDate(d).slice(5) : fmtDate(d);
  return `${d === today ? '今天・' : d === y ? '昨天・' : ''}${date}（${WD[dt.getDay()]}）`;
}

let examQ = '';
// the piles opened on the 書櫃 (day|subject), kept while the tab is open
let openPiles = (() => { try { return new Set(JSON.parse(sessionStorage.getItem('examPiles') || '[]')); } catch { return new Set(); } })();
// 已拍的考卷 filters: tap chips (several in one row = any of them); every count is what tapping gives
const EF0 = () => ({ kid: [], subject: [], school: [], kind: [], mode: [], bank: [], time: '', fix: false });
let EF = (() => { try { return { ...EF0(), ...JSON.parse(sessionStorage.getItem('examF') || '{}') }; } catch { return EF0(); } })();
const anyFilter = () => EF.kid.length || EF.subject.length || EF.school.length || EF.kind.length || EF.mode.length || EF.bank.length || EF.time || EF.fix;
const EGROUPS = {
  kid: (e) => String(e.student_id), subject: (e) => e.subject || '未分類', school: (e) => (e.school ? '1' : '0'), kind: (e) => e.kind_name || '其他',
  mode: (e) => (e.mode === 'grade' ? 'grade' : 'exam'), bank: (e) => (e.in_bank === false ? 'out' : 'in'),
};
const ELABEL = { school: { 1: '🏫 學校考卷', 0: '其他' }, mode: { exam: '整理考卷', grade: '功課批改' }, bank: { in: '在題庫', out: '不在題庫' } };
const ETIMES = [['7', '7 天內'], ['30', '30 天內'], ['term', '本學期'], ['90', '3 個月內']];
const esince = (t) => (t === 'term' ? termStart() : localDay(-Number(t)));
function passes(e, skip) {
  for (const [g, f] of Object.entries(EGROUPS)) if (g !== skip && EF[g].length && !EF[g].includes(f(e))) return false;
  if (skip !== 'time' && EF.time && (e.exam_date || e.created_at || '').slice(0, 10) < esince(EF.time)) return false;
  if (skip !== 'fix' && EF.fix && !(e.to_fix || e.n_wrong)) return false;
  return true;
}
function filterExams(all) {
  const box = $('#exf');
  if (box) {
    const count = (g, v) => all.filter((e) => passes(e, g) && (g === 'time' ? (e.exam_date || e.created_at || '').slice(0, 10) >= esince(v) : g === 'fix' ? (e.to_fix || e.n_wrong) : EGROUPS[g](e) === v)).length;
    const vals = (g) => [...new Set(all.map(EGROUPS[g]))];
    const chip = (g, v, label) => { const n = count(g, v), on = g === 'time' ? EF.time === v : g === 'fix' ? EF.fix : EF[g].includes(v);
      return `<button class="bs-chip ${on ? 'on' : ''} ${!n && !on ? 'zero' : ''}" data-eg="${g}" data-ev="${esc(v)}" aria-pressed="${on}">${esc(label)}<span>${n}</span></button>`; };
    const kids = state.status.students || [];
    const row = (title, chips) => chips ? `<div class="exf-row"><span class="exf-t">${title}</span><div class="exf-c">${chips}</div></div>` : '';
    box.innerHTML = (vals('kid').length > 1 ? row('孩子', vals('kid').map((v) => chip('kid', v, (kids.find((k) => String(k.id) === v) || {}).name || '?')).join('')) : '')
      + row('科目', vals('subject').map((v) => chip('subject', v, v)).join(''))
      + row('學校', ['1', '0'].map((v) => chip('school', v, ELABEL.school[v])).join(''))
      + row('類型', vals('kind').map((v) => chip('kind', v, v)).join(''))
      + row('方式', ['exam', 'grade'].filter((v) => vals('mode').includes(v)).map((v) => chip('mode', v, ELABEL.mode[v])).join('')
        + chip('fix', '1', '有錯題、要訂正'))
      + (vals('bank').length > 1 ? row('題庫', ['in', 'out'].map((v) => chip('bank', v, ELABEL.bank[v])).join('')) : '')
      + row('時間', ETIMES.map(([v, l]) => chip('time', v, l)).join(''))
      + (anyFilter() ? '<button class="btn link sm" id="exfclear">清除條件</button>' : '');
    box.querySelectorAll('[data-eg]').forEach((b) => b.onclick = () => {
      const g = b.dataset.eg, v = b.dataset.ev;
      if (g === 'time') EF.time = EF.time === v ? '' : v;
      else if (g === 'fix') EF.fix = !EF.fix;
      else { const i = EF[g].indexOf(v); i >= 0 ? EF[g].splice(i, 1) : EF[g].push(v); }
      try { sessionStorage.setItem('examF', JSON.stringify(EF)); } catch { /* private mode */ }
      loadExams();
    });
    const c = box.querySelector('#exfclear');
    if (c) c.onclick = () => { EF = EF0(); try { sessionStorage.removeItem('examF'); } catch { /* */ } loadExams(); };
  }
  return all.filter((e) => passes(e));
}

export async function loadExams() {
  let exams = await get('/api/exams');
  checkWatched(exams);
  const el = $('#exams');
  if (!el) return;
  const q = $('#exq');
  if (q && !q.oninput) q.oninput = () => { examQ = q.value.trim(); loadExams(); };
  if (q) q.value = examQ;
  if (examQ) exams = exams.filter((e) => `${e.title} ${e.subject || ''} ${e.owner_name || ''} ${e.kind_name || ''}`.includes(examQ));
  exams = filterExams(exams);
  if (!exams.length) {
    el.innerHTML = `<div class="empty">${examQ || anyFilter() ? '找不到符合的考卷，換個條件試試' : '還沒有掃描過考卷'}</div>`;
    return;
  }
  const owners = new Set(exams.map((e) => e.owner_name));
  const dupKey = (e) => `${e.student_id}|${e.title}|${e.exam_date || ''}`;
  const seen = {};
  exams.forEach((e) => { seen[dupKey(e)] = (seen[dupKey(e)] || 0) + 1; });
  // which 回 of each series are photographed (over every date, so a shelf's set knows what is still missing)
  const series = new Map();
  for (const e of exams) {
    const sr = seriesOf(e.title);
    if (!sr) continue;
    const k = `${e.student_id}|${sr.base}`;
    if (!series.has(k)) series.set(k, { base: sr.base, ns: [] });
    series.get(k).ns.push(sr.n);
    e._series = k; e._n = sr.n;
  }
  // a book standing on the shelf: its cover (first page) and its name; score, pages, wrong ones… are
  // inside. Only what needs attention shows on the cover (處理中、失敗、拍重複、a series' missing 回)
  const cover = (e, tag = '') => `<div class="book-cover" style="background-image:url('${thumbUrl(e.thumb, e.thumb_v)}')">
        ${e.status === 'processing' ? '<span class="tag warn book-tag"><span class="spinner" style="width:10px;height:10px;border-width:2px"></span> 處理中</span>'
          : e.status === 'error' ? '<span class="tag bad book-tag">失敗</span>'
          : seen[dupKey(e)] > 1 ? '<span class="tag warn book-tag">重複拍了</span>' : tag}</div>`;
  const missingOf = (e) => {
    if (!e._series) return 0;
    const ns = [...new Set(series.get(e._series).ns.filter(Number.isFinite))];
    const max = ns.length ? Math.max(...ns) : 0;
    let m = 0; for (let i = 1; i < max; i++) if (!ns.includes(i)) m++;
    return m;
  };
  const book = (e) => `
    <div class="book" data-id="${e.id}" role="link" tabindex="0" aria-label="${esc(e.title)}">
      ${cover(e, missingOf(e) ? `<span class="tag warn book-tag">還缺 ${missingOf(e)} 回</span>` : '')}
      <div class="book-t">${esc(e.title)}</div>
      ${owners.size > 1 ? `<div class="book-m">${e.owner_avatar || ''}${esc(e.owner_name || '')}</div>` : ''}
    </div>`;
  // the 書櫃: one shelf (row) per day, newest on top. On a shelf each subject is one pile of books —
  // tap it to open the pile under the row and see every book's name; a subject with one book is just that book
  const dayOf = (e) => (e.exam_date || e.created_at || '').slice(0, 10) || '未知日期';
  const shelves = new Map();
  for (const e of exams) {
    const d = dayOf(e), sj = e.subject || '未分類';
    if (!shelves.has(d)) shelves.set(d, new Map());
    const subs = shelves.get(d);
    if (!subs.has(sj)) subs.set(sj, []);
    subs.get(sj).push(e);
  }
  const order = Object.keys(SUBJECT_META());  // 數學、國語… in the family's usual order, then the rest
  const rank = (sj) => (order.includes(sj) ? order.indexOf(sj) : order.length + (sj === '未分類' ? 1 : 0));
  // in a pile: a series' 回 stand together in 回 order, the rest newest first
  const sorted = (list) => [...list].sort((a, b) => (a._series || '').localeCompare(b._series || '') || (a._series ? a._n - b._n : b.id - a.id));
  const subjLabel = (sj, n) => `<div class="shelf-subj-t"><i></i>${esc(sj)}${n > 1 ? `<span>${n}</span>` : ''}</div>`;
  const shelfHtml = (d, subs) => {
    const n = [...subs.values()].reduce((a, b) => a + b.length, 0);
    const cols = [...subs.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
    const row = cols.map(([sj, list]) => {
      const k = `${d}|${sj}`, on = openPiles.has(k);
      if (list.length === 1) return `<div class="shelf-subj" style="--sc:${subjectColor(sj)}">${subjLabel(sj, 1)}${book(list[0])}</div>`;
      const top = sorted(list)[0];
      return `<div class="shelf-subj" style="--sc:${subjectColor(sj)}">${subjLabel(sj, list.length)}
        <button class="pile ${on ? 'on' : ''}" data-pile="${esc(k)}" aria-expanded="${on}" aria-label="${esc(sj)} ${list.length} 份，${on ? '收起' : '展開'}">
          <span class="pile-layers" style="--n:${Math.min(list.length, 4)}">${cover(top)}</span><span class="pile-n">${list.length}</span></button></div>`;
    }).join('');
    const open = cols.filter(([sj, list]) => list.length > 1 && openPiles.has(`${d}|${sj}`)).map(([sj, list]) =>
      `<div class="pile-open" style="--sc:${subjectColor(sj)}"><div class="pile-open-t">${subjLabel(sj, list.length)}<button class="btn link sm" data-pile="${esc(`${d}|${sj}`)}">收起</button></div>
        <div class="books">${sorted(list).map(book).join('')}</div></div>`).join('');
    return `<section class="shelf"><div class="shelf-date"><b>${dayLabel(d)}</b><span class="small muted">${n} 份</span></div>
      <div class="shelf-row">${row}</div>${open}<div class="shelf-board" aria-hidden="true"></div></section>`;
  };
  el.innerHTML = `<div class="bookcase">${[...shelves.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([d, subs]) => shelfHtml(d, subs)).join('')}</div>`;
  el.querySelectorAll('.book').forEach((c) => {
    c.onclick = () => { location.hash = `#/exam/${c.dataset.id}`; };
    c.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); c.click(); } };
  });
  el.querySelectorAll('[data-pile]').forEach((b) => b.onclick = () => {
    const k = b.dataset.pile;
    openPiles.has(k) ? openPiles.delete(k) : openPiles.add(k);
    try { sessionStorage.setItem('examPiles', JSON.stringify([...openPiles])); } catch { /* private mode */ }
    loadExams();
  });
  if (exams.some((e) => e.status === 'processing')) {  // only while one is being read (the list shows nothing else that changes)
    clearTimeout(loadExams._t);
    loadExams._t = setTimeout(() => location.hash === EXAMS_HREF && loadExams(), 4000);
  }
}

// 依範本重新產生: after changing templates or adding a type, sort the exams again and make their
// Word paper, answer key and NAS folder again — shows what each exam will become first
export async function regenerate(ids = null, studentId = null) {
  const { modal: m_ } = await import('../ui.js');
  let who = studentId;
  const kid = studentId && (state.status.students || []).find((s) => s.id === studentId);
  const family = (state.status.students || []).filter((s) => s.role !== 'parent').length > 1;
  const plan = async (reset) => (await post('/api/exams/regenerate', { ids, reset, dry: true, student_id: who })).plan;
  let reset = false, list = await plan(false);
  if (!list.length) { toast('還沒有整理好的考卷'); return; }
  m_({
    title: '依範本重新產生',
    body: `<p class="small" style="margin-top:0">用現在的範本設定，重新產生${ids ? '這份考卷' : '每份考卷'}的 Word 試卷、解答卷，並更新 NAS 的「考卷」資料夾。題目、錯題和作答紀錄都不會變。</p>
      ${!ids && kid && family ? `<label class="check" style="margin-bottom:6px"><input type="checkbox" id="rgall"> 全家的考卷都重新產生（不只${esc(kid.name)}的）</label>` : ''}
      <label class="check" style="margin-bottom:8px"><input type="checkbox" id="rgreset"> 手動選過範本的也改回「依類型自動」（套用新增的類型和關鍵字）</label>
      <div class="group" id="rgplan" style="max-height:46vh;overflow:auto"></div>
      <button class="btn block lg" id="rggo" style="margin-top:12px">開始重新產生</button>`,
    onOpen: (m, close) => {
      const draw = () => { m.querySelector('#rgplan').innerHTML = list.map((x) => `<div class="gi"><span class="t small">${family && x.owner ? esc(x.owner) + '・' : ''}${esc(x.title)}</span><span class="small"><b>${esc(x.template)}</b>${x.auto ? '' : '（手動選的）'}</span></div>`).join(''); };
      draw();
      m.querySelector('#rgreset').onchange = async (e) => { reset = e.target.checked; list = await plan(reset); draw(); };
      const all = m.querySelector('#rgall');
      if (all) all.onchange = async () => { who = all.checked ? null : studentId; list = await plan(reset); draw(); };
      m.querySelector('#rggo').onclick = async () => {
        close();
        try {
          const r = await post('/api/exams/regenerate', { ids, reset, student_id: who });
          toast(`重新產生 ${r.plan.length} 份中，可以繼續做別的事，完成後 NAS 也會更新`, 'ok');
          // progress on whichever 「依範本重新產生」 button is on screen (this list or the exam page)
          const btn = () => document.querySelector('#regen, #exregen');
          const label = btn() ? btn().innerHTML : '';
          const res = await waitJob(r.job_id, (j) => { const b = btn(); if (b && j.status === 'running') { b.disabled = true; b.textContent = `重新產生中 ${j.progress || 0}%…`; } });
          if (btn()) { btn().disabled = false; btn().innerHTML = label; }
          toast(`已依範本重新產生 ${res.exams} 份考卷（Word、解答、NAS）`, 'ok');
          if ($('#exams')) loadExams();
        } catch (e) { errToast(e); if (document.querySelector('#regen, #exregen')) document.querySelector('#regen, #exregen').disabled = false; }
      };
    },
  });
}
