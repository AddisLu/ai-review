// 題庫 (the 題庫 tab): everything photographed is a search — tap chips (several in a group = any of
// them; groups narrow each other), see how many questions that is, then 直接練習 / 列印 at once. The
// questions themselves show only when asked (看題目). Every count is what tapping it would give.
// 組合: several searches kept side by side, practised or printed as one paper.
// The analysis lives on its own tab (#/bank?view=analysis), the exams photographed on 已拍的考卷 (exams.js).
import { get, parentNow, post, qs, state } from '../api.js';
import { $, confirmBox, debounce, errToast, esc, html, icon, localDay, modal, termStart, toast } from '../ui.js';
import { WRONG_PAPER, makePaper } from './common.js';
import { assign, bindPicker, practise, rowHtml } from './picker.js';
import { bankTabs } from './exams.js';

const PAGE = 60;
const STATUS = [['unmastered', '待加強', 'unmastered'], ['teacher', '老師打叉', 'teacher'], ['marks', '螢光筆・記號', 'marks'],
  ['favorite', '收藏', 'favorite'], ['mastered', '已學會', 'mastered']];
const STATUS_FLAGS = { unmastered: ['unmastered'], teacher: ['teacher'], marks: ['highlighted', 'marked'], favorite: ['favorite'], mastered: ['mastered'] };
const TIMES = [['', '全部時間'], ['0', '今天'], ['7', '7 天內'], ['30', '30 天內'], ['term', '本學期'], ['90', '3 個月內']];
const sinceOf = (t) => (t === 'term' ? termStart() : localDay(-Number(t)));
const SOURCES = [['scan', '拍照的考卷'], ['ai,similar', 'AI 出的題目'], ['manual', '自己新增']];
const SORTS = [['new', '最新的在前'], ['wrong', '錯最多次的在前'], ['exam', '依考卷、題號']];
const EMPTY = () => ({ q: '', status: [], subjects: [], chapters: [], exams: [], qtypes: [], sources: ['scan'], school: [], time: '', sort: 'new' });

const known = {};  // 章節 seen before (a picked one can drop to 0 and leave the list)
let F, facets, main, page, openUnits = new Set(), moreExams = false, moreUnits = new Set();

const key = (k) => `${k}:${state.studentId}`;
function load() {
  try { F = { ...EMPTY(), ...(JSON.parse(sessionStorage.getItem(key('bankF2'))) || {}) }; } catch { F = EMPTY(); }
}
function save() { try { sessionStorage.setItem(key('bankF2'), JSON.stringify(F)); } catch { /* private mode */ } }
function mix() { try { return JSON.parse(localStorage.getItem(key('bankMix'))) || []; } catch { return []; } }
function saveMix(m) { try { localStorage.setItem(key('bankMix'), JSON.stringify(m)); } catch { /* private mode */ } }

function params(f = F) {
  return {
    q: f.q, flags_any: f.status.flatMap((s) => STATUS_FLAGS[s] || []).join(','), subject: f.subjects.join(','),
    chapter: f.chapters.join(','), exam_id: f.exams.join(','), qtype: f.qtypes.join(','), source: f.sources.join(','),
    since: f.time !== '' ? sinceOf(f.time) : '', school: f.school.length === 1 ? f.school[0] : '',
  };
}

export async function render(el) {
  main = el;
  load();
  html(main, `<div class="bs-page">
  <div class="page-head bk-top"><div class="grow"><h1>題庫</h1><div class="sub">點選條件（同一排可以選好幾個）→ 直接練習或列印</div></div>
    <a class="btn ghost sm" href="#/bank?view=analysis">${icon('chart', 16)} 弱點分析</a>
    <button class="btn ghost sm" id="bknew" aria-label="新增題目">${icon('plus', 16)}<span class="bk-lbl"> 新增題目</span></button></div>
  ${bankTabs('q')}
  <div class="bs">
    <div class="bs-main">
      <label class="bk-q card">${icon('search', 20)}<input type="search" id="bkq" placeholder="搜尋題目、考卷名稱、章節… 例如：分數、第3回、水溶液" value="${esc(F.q)}" enterkeyhint="search" autocomplete="off"></label>
      <div id="bsgroups" class="bs-groups"></div>
    </div>
    <aside class="bs-side">
      <div class="card bs-res" id="bsres"></div>
      <div id="bsmix"></div>
    </aside>
  </div>
  <div class="bs-bar" id="bsbar"></div></div>`);
  const typed = debounce(() => { F.q = $('#bkq').value.trim(); changed(); }, 300);
  $('#bkq').addEventListener('input', (e) => { if (!e.isComposing) typed(); });
  $('#bkq').addEventListener('compositionend', typed);
  $('#bknew').onclick = async () => {
    const { editQuestion } = await import('./common.js');
    if (await editQuestion({}, { isNew: true, defaults: { subject: F.subjects[0] || '數學', is_wrong: 1 } })) changed();
  };
  page = main.querySelector('.bs-page');
  page.addEventListener('click', onClick);
  drawMix();
  await changed();
}

let seq = 0;
async function changed() {
  save();
  const my = ++seq;
  const since = Object.fromEntries(['0', '7', '30', '90', 'term'].map((d) => [`since_${d}`, sinceOf(d)]));
  const f = await get('/api/bank/facets' + qs({ ...params(), ...since }));
  if (my !== seq || !page.isConnected) return;  // a newer tap already asked again
  facets = f;
  for (const c of f.chapters || []) known[c.key] = c;
  drawGroups();
  drawResult();
}

// ---- the chips -------------------------------------------------------------------------------
const chip = (grp, val, label, n, on, extra = '') =>
  `<button class="bs-chip ${on ? 'on' : ''} ${!n && !on ? 'zero' : ''} ${extra}" data-g="${grp}" data-v="${esc(val)}" aria-pressed="${on}">${label}${n !== null ? `<span>${n || 0}</span>` : ''}</button>`;
const group = (title, body) => body ? `<div class="bs-group"><div class="bs-gt">${title}</div><div class="bs-chips">${body}</div></div>` : '';

function drawGroups() {
  const fl = facets.flags || {};
  const subjects = Object.entries(facets.subjects || {});
  for (const s of F.subjects) if (!subjects.some(([x]) => x === s)) subjects.push([s, 0]);
  const exams = facets.exams || [];
  const shownEx = moreExams ? exams : exams.slice(0, 8);
  for (const id of F.exams) if (!shownEx.some((e) => String(e.id) === id)) { const e = exams.find((x) => String(x.id) === id); if (e) shownEx.push(e); }
  const qtypes = Object.entries(facets.qtypes || {});
  const src = facets.sources || {};
  html($('#bsgroups'), `
    ${group('狀態', chip('status', '', '全部', fl.total, !F.status.length) + STATUS.map(([v, l, k]) => chip('status', v, l, fl[k], F.status.includes(v), v === 'unmastered' || v === 'teacher' ? 'red' : '')).join(''))}
    ${group('科目', subjects.map(([s, n]) => chip('subject', s, esc(s), n, F.subjects.includes(s), 'subj')).join(''))}
    ${chaptersHtml()}
    ${group('種類', chip('school', '1', '🏫 學校考卷', (facets.school || {})['1'] || 0, F.school.includes('1')) + chip('school', '0', '其他（補習班、參考書…）', (facets.school || {})['0'] || 0, F.school.includes('0')))}
    ${group('考卷', shownEx.map((e) => chip('exam', String(e.id), esc(e.title), e.n, F.exams.includes(String(e.id)), 'ex')).join('') +
      (exams.length > 8 ? `<button class="bs-more" data-more="exams">${moreExams ? '收起' : `全部 ${exams.length} 份 ▾`}</button>` : ''))}
    ${group('題型', qtypes.map(([s, n]) => chip('qtype', s, esc(s), n, F.qtypes.includes(s))).join(''))}
    ${group('時間', TIMES.map(([v, l]) => chip('time', v, l, (facets.times || {})[v] || 0, F.time === v)).join(''))}
    ${group('來源', SOURCES.map(([v, l]) => chip('source', v, l, v.split(',').reduce((t, k) => t + (src[k] || 0), 0), F.sources.includes(v))).join(''))}`);
}

// 章節 of the subjects picked: 自然 by the review book (生物／理化／地球科學 → 單元, its 主題 under it),
// the others by curriculum unit
function chaptersHtml() {
  if (!F.subjects.length) return '<div class="bs-group"><div class="bs-gt">章節</div><div class="bs-hint">先點上面的科目，這裡就會出現它的章節（自然依參考書目次）</div></div>';
  const all = (facets.chapters || []).filter((c) => F.subjects.some((s) => c.key.startsWith(s + ':')));
  for (const k of F.chapters) if (!all.some((c) => c.key === k)) all.push({ ...(known[k] || { key: k, label: k.split(':')[1], group: k.split(':')[0], topic: 0 }), n: 0 });
  all.sort((a, b) => order(a) - order(b));
  if (!all.length) return '';
  const groups = [];
  for (const c of all) {
    let g = groups.find((x) => x.name === c.group);
    if (!g) groups.push(g = { name: c.group, items: [] });
    g.items.push(c);
  }
  const unitOf = (k) => k.split('.')[0];
  return `<div class="bs-group"><div class="bs-gt">章節</div>${groups.map((g) => {
    const units = g.items.filter((c) => !c.topic);
    const many = units.length > 12 && !moreUnits.has(g.name);
    const shown = many ? units.slice(0, 12).concat(units.filter((u, i) => i >= 12 && F.chapters.includes(u.key))) : units;
    return `<div class="bs-cg"><div class="bs-cgt">${esc(g.name)}</div>${shown.map((u) => {
      const topics = g.items.filter((c) => c.topic && unitOf(c.key) === u.key);
      const open = openUnits.has(u.key) || topics.some((t) => F.chapters.includes(t.key));
      return `<div class="bs-unit">${chip('chapter', u.key, esc(u.label), u.n, F.chapters.includes(u.key), 'unit')}${topics.length
        ? `<button class="bs-open ${open ? 'on' : ''}" data-open="${esc(u.key)}" aria-label="${open ? '收起主題' : '展開主題'}">${open ? '▴' : `▾ ${topics.length} 個主題`}</button>` : ''}
        ${open ? `<div class="bs-topics">${topics.map((t) => chip('chapter', t.key, esc(t.label.replace(/^主題(\d+) /, '$1 ')), t.n, F.chapters.includes(t.key), 'topic')).join('')}</div>` : ''}</div>`;
    }).join('')}${units.length > 12 ? `<button class="bs-more" data-moreu="${esc(g.name)}">${many ? `全部 ${units.length} 個單元 ▾` : '收起'}</button>` : ''}</div>`;
  }).join('')}</div>`;
}

// ---- what is found, and what to do with it ----------------------------------------------------
function tokens() {
  const t = [];
  const add = (grp, val, label) => t.push(`<button class="bs-tok" data-g="${grp}" data-v="${esc(val)}">${esc(label)} ✕</button>`);
  if (F.q) t.push(`<button class="bs-tok" data-clearq="1">「${esc(F.q)}」 ✕</button>`);
  F.status.forEach((v) => add('status', v, STATUS.find((s) => s[0] === v)?.[1] || v));
  F.subjects.forEach((v) => add('subject', v, v));
  F.chapters.forEach((v) => add('chapter', v, chapterName(v)));
  F.exams.forEach((v) => add('exam', v, (facets.exams || []).find((e) => String(e.id) === v)?.title || '考卷'));
  F.qtypes.forEach((v) => add('qtype', v, v));
  F.school.forEach((v) => add('school', v, v === '1' ? '學校考卷' : '其他考卷'));
  if (F.time) add('time', F.time, TIMES.find((x) => x[0] === F.time)[1]);
  if (F.sources.join() !== 'scan') F.sources.forEach((v) => add('source', v, SOURCES.find((x) => x[0] === v)?.[1] || v));
  return t.join('');
}

// book order: 生物 → 理化 → 地球科學, units in number order with their topics after them
const order = (c) => { const [u, t] = c.key.split(':')[1].split('.'); return /^\d+$/.test(u) ? Number(u) * 100 + Number(t || 0) : 99999; };

function chapterName(k) {
  const c = known[k];
  const [s, ch] = k.split(':');
  if (!c) return `${s} ${ch}`;
  if (c.topic) {
    const unit = known[k.split('.')[0]];
    return `${unit ? unit.label.replace(/ .*/, '') : ''}・${c.label.replace(/^主題\d+ /, '')}`;
  }
  return c.label;
}

function labelFor(f = F) {
  const parts = [];
  if (f.chapters.length) parts.push(f.chapters.slice(0, 2).map(chapterName).join('、') + (f.chapters.length > 2 ? '…' : ''));
  else if (f.subjects.length) parts.push(f.subjects.join('、'));
  if (f.exams.length) parts.push(((facets.exams || []).find((e) => String(e.id) === f.exams[0])?.title || '').slice(0, 14) + (f.exams.length > 1 ? ` 等 ${f.exams.length} 份` : ''));
  if (f.q) parts.push(`「${f.q}」`);
  if (f.school.length === 1) parts.unshift(f.school[0] === '1' ? '學校考卷' : '');
  if (f.time === 'term') parts.unshift('本學期');
  parts.push(wrongish(f) ? '錯題' : f.status.length ? f.status.map((s) => STATUS.find((x) => x[0] === s)[1]).join('、') : '練習');
  return parts.filter(Boolean).join(' ');
}

function drawResult() {
  const n = facets.total || 0;
  const tok = tokens();
  html($('#bsres'), `<div class="bs-n"><b>${n}</b> 題</div>
    <div class="bs-toks">${tok || '<span class="small muted">還沒選條件：全部拍過的題目</span>'}</div>
    ${tok ? '<button class="btn link sm bs-clear" data-act="clear">清除條件</button>' : ''}
    <div class="bs-acts">${n ? `<button class="btn ok" data-act="practice">${icon('play', 16)} 直接練習</button>
      <button class="btn soft" data-act="print">${icon('print', 16)} 列印</button>
      <button class="btn ghost" data-act="mix">＋ 加入組合</button>
      <button class="btn link" data-act="list">看題目 ›</button>
      ${tok && parentNow() ? `<button class="btn link sm bs-del" data-act="del">${icon('trash', 14)} 刪除這 ${n} 題</button>` : ''}` : '<span class="small muted">找不到符合的題目，換個條件試試</span>'}</div>`);
  html($('#bsbar'), `<button class="bs-bn" data-act="list" aria-label="看這 ${n} 題"><b>${n}</b> 題 ›</button>${n ? `<button class="btn ok" data-act="practice">${icon('play', 16)} 練習</button>
    <button class="btn soft" data-act="print">${icon('print', 16)} 列印</button>
    <button class="btn soft" data-act="mix">＋組合</button>` : ''}`);
}

function toggle(arr, v) { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); }
function toggle0(set, v) { set.has(v) ? set.delete(v) : set.add(v); }
const wrongish = (f) => f.status.some((s) => s === 'unmastered' || s === 'teacher');

async function onClick(e) {
  if (e.target.closest('.modal')) return;
  const c = e.target.closest('[data-g]');
  if (c) {
    const g = c.dataset.g, v = c.dataset.v;
    if (g === 'status') { if (!v) F.status = []; else toggle(F.status, v); }
    else if (g === 'subject') {
      toggle(F.subjects, v);
      if (!F.subjects.includes(v)) F.chapters = F.chapters.filter((k) => !k.startsWith(v + ':'));
    } else if (g === 'chapter') {
      toggle(F.chapters, v);
      const on = F.chapters.includes(v);
      if (on && !F.subjects.includes(v.split(':')[0])) F.subjects.push(v.split(':')[0]);
      if (on && !v.includes('.')) F.chapters = F.chapters.filter((k) => !k.startsWith(v + '.'));  // a whole unit covers its topics
      if (on && v.includes('.')) F.chapters = F.chapters.filter((k) => k !== v.split('.')[0]);
    } else if (g === 'exam') toggle(F.exams, v);
    else if (g === 'qtype') toggle(F.qtypes, v);
    else if (g === 'time') F.time = F.time === v ? '' : v;
    else if (g === 'source') toggle(F.sources, v);
    else if (g === 'school') toggle(F.school, v);
    return changed();
  }
  if (e.target.closest('[data-clearq]')) { F.q = ''; $('#bkq').value = ''; return changed(); }
  const o = e.target.closest('[data-open]');
  if (o) { toggle0(openUnits, o.dataset.open); return drawGroups(); }
  if (e.target.closest('[data-more]')) { moreExams = !moreExams; return drawGroups(); }
  const mu = e.target.closest('[data-moreu]');
  if (mu) { toggle0(moreUnits, mu.dataset.moreu); return drawGroups(); }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'clear') { F = EMPTY(); $('#bkq').value = ''; return changed(); }
  if (act === 'list') return showList();
  if (act === 'del') return deleteFound();
  const ids = await idsNow();
  if (!ids.length) return;
  if (act === 'practice') return practise(ids.slice(0, 300), labelFor());
  if (act === 'print') return makePaper(ids.slice(0, 300), labelFor(), wrongish(F) ? { ...WRONG_PAPER, template: 'wrong' } : null);
  if (act === 'mix') return addMix({ label: labelFor(), ids, wrong: wrongish(F) });
}

// 刪除題庫資料 (parents): every question the conditions find — only with some condition chosen
async function deleteFound() {
  const { ids } = await get('/api/questions/ids' + qs(params()));
  if (!ids.length) return;
  if (!await confirmBox(`從題庫刪除「${esc(labelFor())}」的 ${ids.length} 題？<br><span class="small muted">題目、詳解和每個孩子的作答紀錄都會刪掉，不能復原。考卷照片會留著（要整份刪：到那份考卷按「刪除這份考卷」）。</span>`, `刪除 ${ids.length} 題`, true)) return;
  try {
    const r = await post('/api/questions/bulk', { ids, action: 'delete' });
    toast(`已刪除 ${r.deleted ?? ids.length} 題`, 'ok');
    changed();
    return true;
  } catch (e) { errToast(e); }
  return false;
}

async function idsNow() {
  const { ids } = await get('/api/questions/ids' + qs(params()));
  if (ids.length > 300) toast(`一次最多 300 題，先用前 300 題（共 ${ids.length} 題）`);
  return ids;
}

// ---- 看題目: the questions found, to look at or pick a few ---------------------------------------
async function showList() {
  let items = [], total = 0, sort = F.sort;
  const sel = new Set();
  const exams = Object.fromEntries((facets.exams || []).map((e) => [e.id, e]));
  modal({
    title: `${esc(labelFor())}・${facets.total} 題`, wide: true,
    body: `<div class="bk-head" style="margin-top:0;flex-wrap:wrap;gap:8px"><span class="small muted" style="flex:1 1 100%">點題目勾選；› 打開那一題</span>
        <label class="bk-sort"><select id="lsort" aria-label="排序">${SORTS.map(([v, l]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn soft sm" id="lall">全選</button>
        ${tokens() && parentNow() ? `<button class="btn ghost sm bs-del" id="ldel">${icon('trash', 14)} 全部刪除</button>` : ''}</div>
      <div class="pk-list" id="llist"></div><div id="lmore"></div>`,
    onOpen: (m) => {
      const list = m.querySelector('#llist');
      const picker = bindPicker(m.querySelector('.modal-body'), {
        list: () => items, sel, title: () => labelFor(),
        extra: [{ label: '＋ 加入組合', run: (ids) => addMix({ label: `${labelFor()}（挑 ${ids.length} 題）`, ids, wrong: items.some((q) => ids.includes(q.id) && q.is_wrong) }) }],
        onDelete: () => { fetchList(); changed(); },
      });
      const fetchList = async (more = false) => {
        const r = await get('/api/questions' + qs({ ...params(), sort, limit: PAGE, offset: more ? items.length : 0 }));
        items = more ? items.concat(r.items) : r.items;
        total = r.total;
        html(list, items.map((q) => rowHtml(q, exams, sel)).join('') || '<div class="empty">沒有題目</div>');
        const lm = m.querySelector('#lmore');
        lm.innerHTML = items.length < total ? `<button class="btn ghost block">再顯示 ${Math.min(PAGE, total - items.length)} 題（共 ${total} 題）</button>` : '';
        if (lm.firstChild) lm.firstChild.onclick = () => fetchList(true);
      };
      m.querySelector('#lsort').onchange = (e) => { sort = F.sort = e.target.value; save(); fetchList(); };
      m.querySelector('#lall').onclick = (e) => {
        const all = items.every((q) => sel.has(q.id));
        items.forEach((q) => (all ? sel.delete(q.id) : sel.add(q.id)));
        html(list, items.map((q) => rowHtml(q, exams, sel)).join(''));
        e.target.textContent = all ? '全選' : '取消全選';
        picker.draw();
      };
      const ld = m.querySelector('#ldel');
      if (ld) ld.onclick = async () => { if (await deleteFound()) { sel.clear(); picker.draw(); fetchList(); } };
      fetchList();
    },
  });
}

// ---- 組合: several searches practised or printed together ----------------------------------------
function addMix(item) {
  const m = mix();
  if (m.some((x) => x.label === item.label && x.ids.length === item.ids.length)) { toast('這個條件已經在組合裡了'); return; }
  m.push({ ...item, ids: item.ids.slice(0, 300) });
  saveMix(m);
  drawMix();
  toast(`已加入組合（${item.ids.length} 題）— 再換條件找下一組，最後一起練習或列印`, 'ok');
}

function drawMix() {
  const m = mix(), box = $('#bsmix');
  if (!box) return;
  const ids = [...new Set(m.flatMap((x) => x.ids))];
  box.className = m.length ? 'card bs-mix' : '';
  html(box, m.length ? `<div class="bs-mixh"><b>組合</b><span class="small muted">${m.length} 組・共 ${ids.length} 題（重複的只算一次）</span></div>
    ${m.map((x, i) => `<div class="bs-mixi"><span>${esc(x.label)}</span><b>${x.ids.length}</b><button class="icon-btn" data-mixdel="${i}" aria-label="拿掉這一組">✕</button></div>`).join('')}
    <div class="bs-acts"><button class="btn ok" data-mixgo="practice">${icon('play', 16)} 合併練習</button>
      <button class="btn soft" data-mixgo="print">${icon('print', 16)} 合併列印</button>
      ${state.status.user.role === 'parent' ? '<button class="btn soft" data-mixgo="assign">指派</button>' : ''}
      <button class="btn link sm" data-mixgo="clear">清空</button></div>` : '');
  box.querySelectorAll('[data-mixdel]').forEach((b) => b.onclick = () => { const x = mix(); x.splice(Number(b.dataset.mixdel), 1); saveMix(x); drawMix(); });
  box.querySelectorAll('[data-mixgo]').forEach((b) => b.onclick = () => {
    const x = mix(), all = [...new Set(x.flatMap((i) => i.ids))].slice(0, 300);
    const title = x.map((i) => i.label).join(' ＋ ').slice(0, 40);
    if (b.dataset.mixgo === 'clear') { saveMix([]); return drawMix(); }
    if (b.dataset.mixgo === 'practice') return practise(all, title);
    if (b.dataset.mixgo === 'assign') return assign(all, title);
    return makePaper(all, title, x.some((i) => i.wrong) ? { ...WRONG_PAPER, template: 'wrong' } : null);
  });
}
