import { api, del, get, mediaUrl, parentNow, post, put, state, thumbUrl, waitJob } from '../api.js';
import { $, $$, busy, confirmBox, debounce, errToast, esc, html, icon, localDay, modal, promptBox, rich, subjectIcon, toast } from '../ui.js';
import { WRONG_PAPER, bindQuestionCards, editQuestion, makePaper, questionCard, runJob } from './common.js';
import { bindPicker, rowHtml } from './picker.js';

let exam, sel, filter, tab, imgV, examQ = '', view = 'home';
const autoSolved = new Set();

export async function render(main, [id, v]) {
  view = v || 'home';
  paperEdit = false;
  examQ = '';
  sel = new Set();
  filter = 'all';
  tab = 'questions';
  imgV = Date.now();
  await load(main, Number(id));
}

async function load(main, id) {
  exam = await get(`/api/exams/${id}?lite=1`);
  const running = exam.job && (exam.job.status === 'running' || exam.job.status === 'queued');
  if (exam.status === 'processing' && !exam.questions.length) {
    html(main, `<div class="card center" style="margin-top:8vh"><div class="spinner" style="width:40px;height:40px"></div>
      <h2 style="margin-top:14px">AI 正在辨識「${esc(exam.title)}」</h2><p class="sub" id="jmsg">${esc((exam.job || {}).message || '')}</p>
      <div class="progress"><i id="jbar" style="width:${(exam.job || {}).progress || 3}%"></i></div>
      <p class="small muted">題目辨識好會先顯示，詳解會接著自動補上。</p></div>`);
    setTimeout(() => location.hash.startsWith(`#/exam/${id}`) && main.isConnected && load(main, id), 2500);
    return;
  }
  draw(main);
  if (running && (exam.status === 'solving' || exam.status === 'processing')) {
    // Questions are visible; keep refreshing while explanations arrive.
    const banner = document.createElement('div');
    banner.className = 'card tight row';
    banner.style.borderColor = 'var(--pri)';
    banner.innerHTML = `<span class="spinner" style="width:16px;height:16px;border-width:2px"></span><span id="jmsg2" class="small" style="flex:1">${esc(exam.job.message || 'AI 產生詳解中…')}</span>`;
    (main.querySelector('#exbanner') || main.firstElementChild).append(banner);
    const poll = async () => {
      if (!location.hash.startsWith(`#/exam/${id}`) || !main.isConnected) return;
      const j = await get(`/api/jobs/${exam.job.id}`);
      if (j.status !== 'running' && j.status !== 'queued') {
        if (j.status === 'error') errToast(new Error(j.message));
        else toast('全部整理完成！', 'ok');
        return load(main, id);
      }
      const fresh = await get(`/api/exams/${id}?lite=1`);
      const solved = (e) => e.questions.filter((q) => q.solved).length;
      if (solved(fresh) !== solved(exam) || fresh.questions.length !== exam.questions.length) {
        const y = window.scrollY;
        await load(main, id);
        window.scrollTo(0, y);
        return;
      }
      const m = document.getElementById('jmsg2');
      if (m) m.textContent = j.message;
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  }
}

// the exam arrives without each question's long parts (詳解、圖、提示…, exam.lite names them): they
// come when a question is opened (that one) or practised / all explanations shown (the whole exam once)
async function fullQ(q) {
  if (!exam.lite || q._full) return q;
  const f = await get(`/api/questions/${q.id}`);
  exam.lite.forEach((k) => { if (k in f) q[k] = f[k]; });
  q._full = true;
  return q;
}
// only some long parts of every question (e.g. explanation, steps for 全部顯示詳解)
async function partsAll(keys) {
  if (!exam.lite || exam.questions.every((q) => q._full || keys.every((k) => k in q))) return;
  const e = exam, f = await get(`/api/exams/${e.id}?only=${keys.join(',')}`);
  const by = new Map(f.questions.map((q) => [q.id, q]));
  e.questions.forEach((q) => { const x = by.get(q.id); if (x && !q._full) keys.forEach((k) => { q[k] = x[k]; }); });
}
function fullAll() {
  const e = exam;
  if (!e.lite) return Promise.resolve(e);
  e._fullP = e._fullP || get(`/api/exams/${e.id}`).then((f) => {
    const by = new Map(f.questions.map((q) => [q.id, q]));
    e.questions.forEach((q) => { const x = by.get(q.id); if (x) { e.lite.forEach((k) => { if (k in x) q[k] = x[k]; }); q._full = true; } });
    e.lite = null;
    return e;
  }).catch((err) => { e._fullP = null; throw err; });
  return e._fullP;
}
async function quiz(qs, opts) {
  const t = setTimeout(() => toast('載入題目中…'), 400);
  try { await fullAll(); } finally { clearTimeout(t); }
  const { startQuiz } = await import('./quiz.js');
  return startQuiz(qs, opts);
}

// a page's photo: the small one at once, then the sharp one (data-hi) — the page shows in a moment
function sharpen(img) {
  const u = img.dataset.hi;
  if (!u || img.dataset.sharpening) return;
  img.dataset.sharpening = '1';
  const h = new Image();
  h.src = u;
  const done = () => { delete img.dataset.hi; img.dispatchEvent(new Event('sharp')); };
  h.decode().then(() => { img.src = u; done(); }, done);
}
function progressive(root) {
  root.querySelectorAll('img[data-hi]').forEach((img) => {
    if (img.complete && img.naturalWidth) sharpen(img);
    else img.addEventListener('load', () => sharpen(img), { once: true });
  });
}
const pageImg = (p, extra = '') => `<img src="${thumbUrl(p.scan_path, p.scan_v, 480)}" data-hi="${thumbUrl(p.scan_path, p.scan_v, 1200)}" alt="第 ${p.idx + 1} 頁" ${extra}>`;

// 漏拍提醒: numbers missing in a run (a page not photographed, a question not seen) or read twice
function gapsCard() {
  const g = exam.gaps || [];
  if (!g.length) return '';
  const pages = g.some((x) => x.kind === 'missed_page');
  const dup = g.filter((x) => x.kind === 'dup_page');
  return `<div class="card tight ex-gaps"><b>⚠️ ${dup.length ? '有一頁拍了兩次' : pages ? '可能漏拍了' : '題號不連續，可能有題目沒辨識到'}</b>
    <ul>${g.slice(0, 6).map((x) => `<li>${esc(x.text)}${x.kind === 'dup_page' && parentNow()
      ? ` <button class="btn sm bad" data-delpage="${x.page_id}" data-pn="${x.drop || x.pages[1]}">刪除第 ${x.drop || x.pages[1]} 頁</button>` : ''}</li>`).join('')}${g.length > 6 ? `<li class="muted">還有 ${g.length - 6} 處</li>` : ''}</ul>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sm ok" data-v="pages">${icon('scan', 15)} 補拍・換這一頁</button>
      <button class="btn sm soft" data-v="questions">檢查題目</button></div></div>`;
}

async function deletePage(main, pid, pn) {
  const n = exam.questions.filter((q) => q.page_id === pid).length;
  if (!await confirmBox(`刪除第 ${pn} 頁？<br><span class="small muted">這一頁的照片和 ${n} 題會刪掉（批改也拿掉），後面的頁往前移。不能復原。</span>`, '刪除', true)) return;
  try {
    const r = await del(`/api/exams/${exam.id}/pages/${pid}`);
    toast(`已刪除第 ${pn} 頁（${r.removed} 題）`, 'ok');
    load(main, exam.id);
  } catch (e) { errToast(e); }
}

function counts() {
  const q = exam.questions;
  return {
    all: q.length, wrong: q.filter((x) => x.is_wrong).length, hl: q.filter((x) => x.is_highlighted).length,
    marked: q.filter((x) => x.is_marked).length, fav: q.filter((x) => x.is_favorite).length,
    unsolved: q.filter((x) => !x.solved).length,
  };
}

const FILTERS = {
  all: () => true, wrong: (q) => q.is_wrong, hl: (q) => q.is_highlighted,
  marked: (q) => q.is_marked, fav: (q) => q.is_favorite, unsolved: (q) => !q.solved,
};

// The exam page: what this paper is, what to do next (one card), and every feature as a tile —
// 批改結果, 練習, 對答案, 列印・下載, 原卷照片, 檢查題目, 加入題庫. Each opens its own view
// (#/exam/16?v=grade …, so 返回 works); nothing long is shown until it is asked for.
const VIEWS = { grade: '批改結果', key: '對答案', print: '列印・下載', pages: '原卷照片', questions: '檢查題目' };
const go = (v) => { location.hash = `#/exam/${exam.id}${v && v !== 'home' ? `?v=${v}` : ''}`; };
const inBankNow = () => (exam.options || {}).in_bank !== false;

function draw(main) {
  const c = counts();
  if (view !== 'home' && VIEWS[view]) return drawView(main, c);
  const pageErr = exam.pages.filter((p) => p.status === 'error');
  const g = (exam.options || {}).grade_summary;
  const answered = g ? Object.values(g).reduce((a, b) => a + b, 0) - (g.blank || 0) : 0;
  const judged = g ? (g.correct || 0) + (g.wrong || 0) + (g.partial || 0) : 0;  // 請你確認 is not counted until decided
  const score = judged ? Math.round((100 * ((g.correct || 0) + 0.5 * (g.partial || 0))) / judged) : null;
  const fix = g ? (g.wrong || 0) + (g.partial || 0) : 0;
  const grading = (exam.options || {}).mode === 'grade' && !g && busyNow();
  const tile = (v, ico, title, sub, extra = '') => `<button class="ex-tile ${extra}" data-v="${v}"><span class="ex-ti">${ico}</span><span class="ex-tt"><b>${title}</b><span>${sub}</span></span>${icon('chev', 18)}</button>`;
  html(main, `
  <div class="page-head ex-head">
    <a href="#/bank?view=exams" class="back" aria-label="返回">${icon('back', 22)}</a>
    <div class="grow"><h1>${esc(exam.title)}</h1>
      <div class="sub">${ownerHtml()}${(exam.options || {}).school ? `<button class="tag school-tag" id="exschool" title="${esc((exam.options || {}).school_why || '學校考卷')}">🏫 學校考卷${(exam.options || {}).school_term ? `・${esc(exam.options.school_term)}` : ''}</button> · ` : ''}${esc(exam.subject || '未分類')} · ${exam.exam_date || ''} · ${exam.pages.length} 頁 · ${c.all} 題${(exam.template || {}).kind_name ? ` · ${esc(exam.template.kind_name)}` : ''}</div></div>
    <button class="icon-btn" id="exset" aria-label="這份考卷的設定" title="設定（改名、刪除）">${icon('edit', 20)}</button>
  </div>
  <div id="exbanner"></div>
  ${(exam.status === 'error' || pageErr.length) ? `<div class="card" style="border-color:var(--bad)">有 ${pageErr.length || '部分'} 頁處理失敗：${esc((pageErr[0] || {}).error || (exam.job || {}).message || '')}
    ${busyNow() ? '<span class="small muted" style="margin-left:8px">其他頁還在整理，整理完就可以重試這幾頁</span>'
      : `<button class="btn sm bad" id="retry" style="margin-left:8px">重新處理這 ${pageErr.length || ''} 頁</button>`}</div>` : ''}
  <div class="card ex-next">
    ${g ? `<div class="grade-score ${score >= 90 ? '' : score >= 70 ? 'mid' : 'low'}"><b>${score ?? '-'}</b><span>分</span></div>
      <div class="ex-nt"><b>${fix ? `要訂正 ${fix} 題` : '全部都對，太棒了！🎉'}</b>
        <span class="small muted">寫了 ${answered} 題・對 ${g.correct || 0}${(g.ask || 0) + (g.unsure || 0) ? `・<b class="t-ask">${(g.ask || 0) + (g.unsure || 0)} 題請你確認</b>` : ''}${g.blank ? `・沒寫 ${g.blank}` : ''}</span></div>
      <div class="ex-na">${fix ? `<button class="btn ok" id="nredo">${icon('play', 16)} 錯的馬上再做一次</button>` : ''}<button class="btn soft" data-v="grade">看批改結果（紅筆）</button></div>`
    : grading ? `<span class="spinner" style="width:28px;height:28px"></span><div class="ex-nt"><b>AI 正在批改…</b><span class="small muted">好了會通知你，可以先去做別的</span></div>`
    : c.wrong ? `<span class="ex-ni bad">✗</span><div class="ex-nt"><b>錯 ${c.wrong} 題</b><span class="small muted">考卷上被打叉、或你標為錯題的</span></div>
      <div class="ex-na"><button class="btn ok" id="nwrong">${icon('play', 16)} 練習錯的 ${c.wrong} 題</button><button class="btn soft" id="ngrade">✅ 批改</button></div>`
    : `<span class="ex-ni">✅</span><div class="ex-nt"><b>下一步：批改這一份</b><span class="small muted">用拍照時寫的答案，或重寫後再拍照；AI 一題一題改</span></div>
      <div class="ex-na"><button class="btn ok" id="ngrade">✅ 批改</button><button class="btn soft" id="npractice">${icon('play', 16)} 直接練習</button></div>`}
  </div>
  ${gapsCard()}
  <div class="ex-tiles">
    ${tile('grade', '✅', g ? '批改結果' : '批改這一份', g ? `${score ?? '-'} 分・${fix ? `要訂正 ${fix} 題` : '全對'}・紅筆標在原卷上` : '用拍照時的答案，或重寫後拍照')}
    ${tile('practice', icon('play', 22), '練習這一份', `${c.all} 題・可以只練錯的、打亂順序`)}
    ${tile('key', '🔑', '對答案', c.unsolved ? `解答整理中（還差 ${c.unsolved} 題）` : `${c.all} 題的答案・點一題看詳解`)}
    ${tile('print', icon('print', 22), '列印・下載', `題目卷・解答卷・錯題卷（${esc((exam.template || {}).name || '範本')}）`)}
    ${tile('pages', icon('image', 22), '原卷照片', `${exam.pages.length} 頁・某一頁拍不好可以換`)}
    ${tile('questions', icon('search', 22), '檢查題目', `${c.all} 題・確認掃描辨識得對不對`)}
    <label class="ex-tile ex-bank ${inBankNow() ? 'on' : ''}"><span class="ex-ti">📚</span><span class="ex-tt"><b>加入題庫</b>
      <span>${inBankNow() ? '在題庫裡：可以搜尋、組卷、每日練習' : '不在題庫：只批改、錯的重寫'}</span></span>
      <input type="checkbox" class="switch" id="exbank" ${inBankNow() ? 'checked' : ''} aria-label="加入題庫"></label>
    ${parentNow() ? `<button class="ex-tile ex-del" id="exdel"><span class="ex-ti">${icon('trash', 22)}</span><span class="ex-tt"><b>刪除這份考卷</b>
      <span>照片和 ${c.all} 題一起從題庫刪除（家長）</span></span>${icon('chev', 18)}</button>` : ''}
  </div>`);
  const xd = $('#exdel');
  if (xd) xd.onclick = () => deleteExam();
  main.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
    const v = b.dataset.v;
    if (v === 'practice') return practiceMenu();
    if (v === 'grade' && !g) return gradeMenu(main);
    go(v);
  });
  const nr = $('#nredo');
  if (nr) nr.onclick = () => redoWrong(main);
  const nw = $('#nwrong');
  if (nw) nw.onclick = async () => {
    const qs = exam.questions.filter((q) => q.is_wrong && q.solved);
    if (!qs.length) { toast('答案還在整理，等一下再試'); return; }
    await quiz(qs, { mode: 'review', conceptFirst: true, title: `訂正：${exam.title}`, source: `exam:${exam.id}` });
    load(main, exam.id);
  };
  const ng = $('#ngrade');
  if (ng) ng.onclick = () => gradeMenu(main);
  const np = $('#npractice');
  if (np) np.onclick = () => practiceMenu();
  $('#exbank').onchange = async (e) => {
    try {
      const r = await put(`/api/exams/${exam.id}/bank`, { in_bank: e.target.checked });
      exam.options = { ...(exam.options || {}), in_bank: r.in_bank };
      toast(r.in_bank ? '已加入題庫' : '已從題庫拿掉（考卷和批改都還在）', 'ok');
      draw(main);
    } catch (err) { errToast(err); e.target.checked = !e.target.checked; }
  };
  $('#exset').onclick = () => settingsMenu(main);
  const xs = $('#exschool');
  if (xs) xs.onclick = () => settingsMenu(main);
  bindOwner(main);
  bindCommon(main, c, pageErr);
}

// the wrong (and partly right) ones from the 批改, practised at once
async function redoWrong(main) {
  const gr = (exam.options || {}).grade || {};
  const ids = exam.questions.filter((q) => gr[q.id] && FIX.includes(gr[q.id].result)).map((q) => q.id);
  if (!ids.length) return;
  try {
    if (inBankNow()) await post('/api/questions/bulk', { ids, action: 'set', data: { is_wrong: 1, mastered: 0, next_review: localDay() } });
    const qs = exam.questions.filter((q) => ids.includes(q.id) && q.solved);
    if (!qs.length) { toast('這幾題的答案還在整理，等一下再做'); return; }
    await quiz(qs, { mode: 'practice', title: `訂正：${exam.title}`, source: `exam:${exam.id}` });
    load(main, exam.id);
  } catch (e) { errToast(e); }
}

function drawView(main, c) {
  html(main, `
  <div class="ex-subhead">
    <button class="back" id="exhome" aria-label="回到這份考卷">${icon('back', 22)}</button>
    <div class="grow"><div class="small muted ex-subt">${esc(exam.title)}</div><h1>${VIEWS[view]}</h1></div>
    ${view === 'pages' ? `<label class="btn sm soft"><input type="file" accept="image/*,.heic,.heif,application/pdf,.pdf" multiple id="addpage" hidden>${icon('scan', 16)} 再拍一頁</label>` : ''}
  </div>
  <div id="exbanner"></div>
  ${view === 'grade' ? gradeCard() : view === 'print' ? printView(c) : view === 'key' ? keyView() : ''}
  <div id="tabbody"></div>`);
  $('#exhome').onclick = () => go('home');
  if (view === 'grade') bindGrade(main);
  if (view === 'print') { bindResult(main); bindPrint(main); }
  if (view === 'key') bindKey(main);
  if (view === 'questions') { if (isVertical() && !paperEdit) drawPaper(main, c); else drawQuestions(main, c); }
  if (view === 'pages') drawPages(main);
  bindCommon(main, c, []);
}

// what every view shares: 再拍一頁, retry, the 詳解 still missing
function bindCommon(main, c, pageErr) {
  if (!main._delPage) {  // 刪除這一頁 (the warning card, 原卷照片): one listener for every view
    main._delPage = true;
    main.addEventListener('click', (e) => {
      const b = e.target.closest('[data-delpage]');
      if (b && main.contains(b)) deletePage(main, Number(b.dataset.delpage), b.dataset.pn);
    });
  }
  const ap = $('#addpage');
  if (ap) ap.onchange = async (e) => {
    const list = [...e.target.files];
    if (!list.length) return;
    const { shrink } = await import('./scan.js');
    const fd = new FormData();
    for (const f of list) { const x = await shrink(f); fd.append('files', x, x.name); }
    try {
      const r = await api(`/api/exams/${exam.id}/pages`, { method: 'POST', form: fd });
      toast(`收到了，AI 正在整理${r.pages > 1 ? `這 ${r.pages} 頁` : '這一頁'}`, 'ok');
      load(main, exam.id);
    } catch (err) { errToast(err); }
  };
  // leftovers without an explanation get one automatically — no button to find
  if (c.unsolved && exam.status === 'ready' && !(exam.job && exam.job.status === 'running') && !autoSolved.has(exam.id)) {
    autoSolved.add(exam.id);
    post(`/api/exams/${exam.id}/solve`).then(() => setTimeout(() => main.isConnected && load(main, exam.id), 1500)).catch(() => {});
  }
  const retry = $('#retry');
  if (retry) retry.onclick = async () => {
    if (!await confirmBox(`會重新辨識失敗的 ${pageErr.length || ''} 頁（其他頁不動），確定嗎？`, '重新處理')) return;
    await runJob(post(`/api/exams/${exam.id}/retry`), '重新處理中…');
    load(main, exam.id);
  };
}

function bindOwner(main) {
  const ow = $('#exowner');
  if (ow) ow.onchange = async () => {
    const kid = (state.status.students || []).find((x) => x.id === Number(ow.value));
    if (!await confirmBox(`把這份考卷（${exam.questions.length} 題、錯題和作答紀錄）改成 ${esc(kid.name)} 的？`, '改成她的')) { ow.value = String(exam.student_id); return; }
    try {
      await put(`/api/exams/${exam.id}/owner`, { student_id: kid.id });
      toast(`已改成 ${kid.name} 的考卷`, 'ok');
      const chip = document.querySelector(`.kidbar [data-kid="${kid.id}"]`);
      if (chip) chip.click(); else load(main, exam.id);
    } catch (e) { errToast(e); ow.value = String(exam.student_id); }
  };
}

// ✏️ the paper itself: its name, date, subject; delete it
// 刪除這份考卷 (parents): its photos and every question go; only from the 題庫 = the 加入題庫 switch
async function deleteExam() {
  const fix = exam.questions.filter((q) => q.is_wrong).length;
  if (!await confirmBox(`刪除「${esc(exam.title)}」？<br><span class="small muted">${exam.pages.length} 頁照片和 ${exam.questions.length} 題${fix ? `（含錯題 ${fix} 題）` : ''}、作答紀錄都會刪掉，不能復原。<br>只想讓它不出現在題庫：把「加入題庫」關掉就好，考卷和批改會留著。</span>`, '刪除', true)) return;
  try { await del(`/api/exams/${exam.id}`); toast('已刪除', 'ok'); location.hash = '#/bank?view=exams'; } catch (e) { errToast(e); }
}

function settingsMenu(main) {
  const subjects = Object.keys(state.status.subjects || {});
  modal({
    title: '這份考卷',
    body: `<label class="field"><span>名稱</span><input type="text" id="stitle" value="${esc(exam.title)}"></label>
      <div class="grid g2"><label class="field"><span>科目</span><select id="ssubj"><option value="">未分類</option>${subjects.map((x) => `<option ${x === exam.subject ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="field"><span>日期</span><input type="date" id="sdate" value="${esc(exam.exam_date || '')}"></label></div>
      <label class="inbank"><input type="checkbox" class="selbox" id="sschool" ${(exam.options || {}).school ? 'checked' : ''}>
        <span><b>🏫 學校考卷</b><span class="small muted">${(exam.options || {}).school_set ? '你設定的' : (exam.options || {}).school_why ? `AI 看到「${esc(exam.options.school_why)}」` : 'AI 沒看到班級、姓名、座號'}・期中、期末可以在題庫裡挑「學校考卷」複習</span></span></label>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        ${parentNow() ? `<button class="btn ghost" id="sdel" style="color:var(--bad)">${icon('trash', 16)} 刪除這份考卷</button>` : '<span></span>'}
        <button class="btn" id="ssave">儲存</button></div>`,
    onOpen: (m, close) => {
      m.querySelector('#ssave').onclick = async () => {
        const body = { title: m.querySelector('#stitle').value.trim() || exam.title, subject: m.querySelector('#ssubj').value, exam_date: m.querySelector('#sdate').value };
        if (body.subject !== (exam.subject || '')) body.apply_subject = true;  // its questions follow
        const sch = m.querySelector('#sschool').checked;
        if (sch !== !!(exam.options || {}).school) { body.school = sch; exam.options = { ...(exam.options || {}), school: sch, school_set: true }; }
        try { await put(`/api/exams/${exam.id}`, body); Object.assign(exam, body); close(); draw(main); toast('已儲存', 'ok'); } catch (e) { errToast(e); }
      };
      const sd = m.querySelector('#sdel');
      if (sd) sd.onclick = () => { close(); deleteExam(); };
    },
  });
}

// 🔑 對答案: every answer, big enough to read on a phone, by section; tap one for its 詳解. Graded: her
// answer and the mark beside it.
function keyView() {
  const gr = (exam.options || {}).grade || {};
  const groups = [];
  for (const q of exam.questions) {
    const sec = (q.section || '').trim();
    let g = groups[groups.length - 1];
    if (!g || g.sec !== sec) groups.push(g = { sec, items: [] });
    g.items.push(q);
  }
  const row = (q) => {
    const r = gr[q.id], [ic, cls] = r ? (GRADE[r.result] || GRADE.unsure) : ['', ''];
    const ans = q.answer || (r && r.answer) || '';
    return `<button class="key-row" data-k="${q.id}">
      <span class="key-n">${esc(q.number || '?')}</span>
      <span class="key-a">${ans ? rich(ans) : '<span class="muted small">（答案整理中）</span>'}</span>
      ${r ? `<span class="key-m ${cls}" title="${esc((GRADE[r.result] || GRADE.unsure)[2])}">${ic}${r.read_as ? `<small>${rich(r.read_as)}</small>` : ''}</span>` : ''}
    </button><div class="key-x hidden" id="kx${q.id}"></div>`;
  };
  return `<div class="key-tools"><button class="btn sm soft" id="kall">全部顯示詳解</button><span class="spacer"></span>
      <button class="btn sm ghost" id="ka4">${icon('search', 15)} 看 A4 解答卷</button>
      <button class="btn sm ghost" id="kpdf">${icon('download', 15)} PDF</button></div>
    ${Object.keys(gr).length ? '<p class="small muted" style="margin:0 4px 8px">右邊是批改：✓ 對、✗ 錯、△ 部分對，小字是她寫的答案</p>' : ''}
    ${groups.map((g) => `<div class="card key-card">${g.sec ? `<div class="key-sec">${esc(g.sec)}</div>` : ''}${g.items.map(row).join('')}</div>`).join('')}`;
}

function bindKey(main) {
  // 全部顯示: each explanation is written out when it scrolls near (375 at once took seconds)
  const near = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { near.unobserve(e.target); fill(Number(e.target.id.slice(2))); }
  }), { rootMargin: '600px' });
  const show = (id, on, lazy = false) => {
    const box = $(`#kx${id}`);
    if (!box) return;
    on = on ?? box.classList.contains('hidden');
    box.classList.toggle('hidden', !on);
    if (on && !box.innerHTML) {
      if (lazy) { box.innerHTML = '<span class="muted small">…</span>'; near.observe(box); } else fill(id);
    }
  };
  const fill = async (id) => {
    const q = exam.questions.find((x) => x.id === id), box = $(`#kx${id}`);
    if (!box) return;
    if (!q._full && !('explanation' in q)) { box.innerHTML = '<span class="spinner"></span>'; await fullQ(q).catch(() => {}); }
    html(box, q.explanation ? rich(q.explanation) : (q.steps || []).length ? `<ol>${q.steps.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>` : '<span class="muted">詳解整理中</span>');
  };
  main.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => show(Number(b.dataset.k)));
  $('#kall').onclick = async (e) => {
    const on = e.target.textContent.startsWith('全部顯示');
    if (on) { e.target.disabled = true; await partsAll(['explanation', 'steps']).catch(errToast); e.target.disabled = false; }
    exam.questions.forEach((q) => show(q.id, on, true));
    e.target.textContent = on ? '收起詳解' : '全部顯示詳解';
  };
  $('#ka4').onclick = async () => { const { openPreview } = await import('./templates.js'); openPreview(exam.template.id, { exam: { id: exam.id, title: exam.title, n: exam.questions.length }, key: true }); };
  $('#kpdf').onclick = async () => {
    const r = await post(`/api/templates/${exam.template.id}/sample`, { exam_id: exam.id, key_only: true });
    toast('產生 PDF 中…');
    location.href = `/api/print/pdf/${r.token}`;
  };
}

// 🖨 列印・下載: the template it is laid out with, then each paper in one tap
function printView(c) {
  const wrong = exam.questions.filter((q) => q.is_wrong).length;
  const hl = exam.questions.filter((q) => q.is_highlighted || q.is_marked).length;
  const item = (p, ico, title, sub, dis = false) => `<button class="ex-tile" data-p="${p}" ${dis ? 'disabled' : ''}><span class="ex-ti">${ico}</span><span class="ex-tt"><b>${title}</b><span>${sub}</span></span>${icon('chev', 18)}</button>`;
  return `${resultCard(c, true)}
    <div class="ex-tiles">
      ${item('all', icon('doc', 22), '題目卷', '用範本排版・可下載 Word／PDF')}
      ${item('key', '🔑', '解答卷・詳解本', '答案和詳解')}
      ${item('wrong', '✗', '錯題卷', wrong ? `只印錯的 ${wrong} 題` : '沒有錯題', !wrong)}
      ${item('hl', '🖍', '重點題', hl ? `螢光筆、記號 ${hl} 題` : '沒有標記的題目', !hl)}
    </div>`;
}

function bindPrint(main) {
  main.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => printOne(b.dataset.p));
}

// 直書 originals (國語): the 電子試卷 opens as the paper itself — vertical, right to left, 注音 beside
// the characters, like the photo — with 逐題編輯 one tap away
let paperEdit = false;
const isVertical = () => ((exam.options || {}).layout || {}).direction === 'vertical';
async function drawPaper(main, c) {
  const body = $('#tabbody');
  html(body, `<div class="row" style="margin-bottom:10px;gap:8px;align-items:center;flex-wrap:wrap">
      <div class="seg" style="margin:0"><button class="on">原稿樣式（直書）</button><button id="toedit">逐題編輯</button></div>
      <span class="small muted">和原稿一樣直書排版；下載的 Word／PDF 也是這個樣子</span></div>
    <div class="paper-preview"><iframe id="vpaper" title="電子試卷（直書）"></iframe></div>`);
  $('#toedit').onclick = () => { paperEdit = true; drawQuestions(main, c); };
  try {
    const t = exam.template || {};
    const r = await post(`/api/templates/${t.id || 'quiz'}/sample`, { exam_id: exam.id });
    const f = $('#vpaper');
    if (f) f.src = `/print.html?t=${r.token}&preview=1`;
  } catch (e) { errToast(e); }
}

function drawQuestions(main, c) {
  // this exam's questions as a short list to search and pick from (the › on a row opens it)
  const body = $('#tabbody');
  let list = [];
  html(body, `
    <div class="card bk-search" style="margin-bottom:10px">
      <label class="bk-q">${icon('search', 20)}<input type="search" id="exq" placeholder="在這份考卷裡找：題號、文字、單元…" value="${esc(examQ)}" enterkeyhint="search" autocomplete="off"></label>
      <div class="bk-status">${[['all', '全部', c.all], ['wrong', '錯題', c.wrong], ['hl', '螢光筆', c.hl], ['marked', '記號', c.marked], ['fav', '收藏', c.fav]]
        .map(([k, l, n]) => `<button class="bk-st ${filter === k ? 'on' : ''}" data-f="${k}">${l}<span>${n}</span></button>`).join('')}</div>
    </div>
    <div class="bk-head"><b id="exn"></b><span class="spacer"></span>
      ${isVertical() ? '<button class="btn sm soft" id="topaper">看原稿樣式（直書）</button>' : ''}
      <button class="btn sm ghost" id="addq">${icon('plus', 15)} 新增題目</button>
      <button class="btn sm soft" id="selall">全選</button></div>
    <div class="pk-list" id="qlist"></div>`);
  const extra = [{ label: '標為錯題', run: async (ids) => { await post('/api/questions/bulk', { ids, action: 'set', data: { is_wrong: 1 } }); toast('已加入錯題本', 'ok'); load(main, exam.id); } }];
  const picker = bindPicker(body, { list: () => list, sel, title: () => `${exam.title.slice(0, 24)} 精選題`, extra, onDelete: () => load(main, exam.id) });
  const drawList = () => {
    const words = examQ.toLowerCase().split(/\s+/).filter(Boolean);
    // a number alone is a question number (第 8 題), anything else is looked for in the text
    const match = (q) => words.every((w) => (/^\d+$/.test(w) ? String(q.number) === w
      : `${q.stem} ${q.unit || ''} ${q.chapter_label || ''} ${q.qtype || ''} ${q.answer || ''}`.toLowerCase().includes(w)));
    list = exam.questions.filter(FILTERS[filter]).filter(match);
    $('#exn').textContent = `${list.length} 題`;
    html($('#qlist'), list.map((q) => rowHtml(q, {}, sel)).join('') || '<div class="empty">找不到符合的題目</div>');
    $('#selall').textContent = list.length && list.every((q) => sel.has(q.id)) ? '取消全選' : '全選';
  };
  const q = $('#exq');
  const typed = debounce(() => { examQ = q.value.trim(); drawList(); }, 250);
  q.addEventListener('input', (e) => { if (!e.isComposing) typed(); });
  q.addEventListener('compositionend', typed);
  body.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => {
    filter = b.dataset.f; body.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); drawList();
  });
  $('#selall').onclick = () => { const all = list.every((x) => sel.has(x.id)); list.forEach((x) => (all ? sel.delete(x.id) : sel.add(x.id))); drawList(); picker.draw(); };
  const tp = $('#topaper');
  if (tp) tp.onclick = () => { paperEdit = false; drawPaper(main, c); };
  $('#addq').onclick = async () => {
    const id = await editQuestion({}, { isNew: true, defaults: { exam_id: exam.id, subject: exam.subject || '數學', is_wrong: 0 } });
    if (id) load(main, exam.id);
  };
  drawList();
}

function drawPages(main) {
  const body = $('#tabbody');
  // 59-page homework: the first pages are drawn at once, the others when they scroll near
  const card = (p) => `
      <div class="card" data-card="${p.id}">
        <div class="row" style="margin-bottom:10px"><h3 style="margin:0">第 ${p.idx + 1} 頁</h3>
          ${(() => { const n = exam.questions.filter((q) => q.page_id === p.id).length;
            return p.scan_path ? (n ? `<span class="tag">辨識到 ${n} 題</span>` : '<span class="tag warn">這一頁沒有辨識到題目</span>') : ''; })()}
          ${p.meta && p.meta.highlights && p.meta.highlights.length ? `<span class="tag hl">偵測到 ${p.meta.highlights.length} 處螢光筆</span>` : ''}
          ${p.meta && p.meta.notes ? `<details class="small muted pg-notes"><summary>AI 備註</summary>${esc(p.meta.notes)}</details>` : ''}
          <span class="spacer"></span>
          <label class="btn sm ok"><input type="file" accept="image/*,.heic,.heif,application/pdf,.pdf" data-replace="${p.id}" hidden>${icon('scan', 15)} 換這一頁</label>
          <button class="btn sm soft" data-corners="${p.id}">調整四個角</button>
          ${parentNow() && exam.pages.length > 1 ? `<button class="btn sm ghost" data-delpage="${p.id}" data-pn="${p.idx + 1}" style="color:var(--bad)">${icon('trash', 14)} 刪除這一頁</button>` : ''}
          ${p.scan_path && !(p.meta && p.meta.scan) ? `<button class="btn sm warn" data-rescan="${p.id}">用新的前處理重做</button>` : ''}
          ${p.scan_path ? `<button class="btn sm soft" data-region="${p.id}">框選新增題目</button>` : ''}
        </div>
        ${p.status === 'error' ? `<div class="tag bad">${esc(p.error)}</div>` : ''}
        ${p.scan_path ? `<div class="pg-pair"><div><div class="pg-cap"><div class="seg pg-seg" role="tablist" aria-label="看哪一張">
              <button class="on" data-pv="scan" data-pid="${p.id}">前處理後</button><button data-pv="orig" data-pid="${p.id}">原始照片</button></div>
            ${p.meta && p.meta.half ? `<span class="tag">${p.meta.half === 'L' ? '攤開的左頁' : '攤開的右頁'}（同一張照片${p.meta.turn === 180 ? '・已轉正' : ''}）</span>` : ''}
            ${p.meta && p.meta.scan ? `<span class="small muted">${p.meta.scan.digital ? '電子檔（不用校正）' : p.meta.scan.manual ? '手動四角' : p.meta.scan.warped ? '自動抓四角' : '整張'}${(p.meta.scan.dewarp || {}).applied ? '・彎曲校正' : ''}</span>` : '<span class="tag warn">舊版前處理</span>'}</div>
          <div class="pg-orig hidden" data-orig="${p.id}"><div class="cn-box" style="position:relative"><img data-osrc="/api/pages/${p.id}/photo" alt="原始照片"></div></div>
          <div class="page-view" data-page="${p.id}">
            ${pageImg(p, p.idx ? 'loading="lazy" decoding="async"' : 'fetchpriority="high"')}
            ${exam.questions.filter((q) => q.page_id === p.id && q.bbox).map((q) => {
              const [x0, y0, x1, y1] = q.bbox;
              return `<div class="qbox ${q.is_wrong ? 'wrong' : ''} ${q.is_highlighted ? 'hl' : ''}" data-q="${q.id}"
                style="left:${x0 / 10}%;top:${y0 / 10}%;width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%"><span>${esc(q.number || '?')}</span></div>`;
            }).join('')}
        </div></div>
        <div><div class="pg-cap">重新產生的電子試卷 <button class="btn link sm" data-pgbig="${p.id}">放大看</button></div>
          <div class="pg-gen" data-pgen="${p.id}"><span class="spinner"></span></div></div></div>` : `<img src="${mediaUrl(p.orig_path)}" style="max-height:300px">`}
      </div>`;
  html(body, `
    <div class="card tight row">
      <span class="small">左邊是「前處理後」的照片（自動抓四角拉正、彎曲校正、去陰影；可以切換看原始照片），右邊是重新產生的電子試卷（可編輯、圖形重畫）——兩邊對照，看題目有沒有漏、字和圖對不對。拍得不好、或又寫了新的題目：按那一頁的「換這一頁」重拍，只重新辨識那一頁${(exam.options || {}).grade ? '並重新批改' : ''}。藍框＝AI 辨識到的題目（點一下看題目）；漏掉的題目用「框選新增」補上。</span>
      ${exam.pages.some((p) => p.scan_path && !(p.meta && p.meta.scan)) ? `<button class="btn sm soft" id="rescanall" style="margin-left:auto">整份用新的前處理重做（${exam.pages.filter((p) => p.scan_path && !(p.meta && p.meta.scan)).length} 頁）</button>` : ''}
    </div>
    ${exam.pages.map((p, i) => (i < 3 ? card(p) : `<div class="card pg-lazy" data-lazy="${p.id}"><h3 style="margin:0">第 ${p.idx + 1} 頁</h3></div>`)).join('')}`);

  // each page's regenerated paper, made when it scrolls into view (a 59-page homework stays quick)
  const specFor = async (pid) => {
    const pg = exam.pages.find((x) => x.id === pid);
    const ids = exam.questions.filter((q) => q.page_id === pid).sort((a, b) => a.seq - b.seq).map((q) => q.id);
    if (!ids.length) return null;
    const t = exam.template || {};
    const r = await post('/api/print/spec', { title: `${exam.title}（第 ${pg.idx + 1} 頁）`, question_ids: ids, exam_id: exam.id,
      config: { ...(t.config || {}), template: t.id, keep_original: true, header: false, answers: 'none', explanations: false } });
    return r.token;
  };
  const showGen = async (box) => {
    if (box.dataset.done) return;
    box.dataset.done = '1';
    // the paper is asked for at once; on a computer the sharp photo is shown first (it is what tells
    // whether the page was taken well) — a phone shows the small photo and does not wait
    const making = specFor(Number(box.dataset.pgen));
    const img = box.closest('.card').querySelector('.page-view img');
    if (img && img.dataset.hi && !narrow()) {
      await new Promise((r) => { img.addEventListener('sharp', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 5000); });
    }
    try {
      const tok = await making;
      box.innerHTML = tok ? `<iframe title="重新產生的電子試卷" src="/print.html?t=${tok}&preview=1"></iframe>`
        : '<div class="small muted" style="padding:20px">這一頁沒有題目可以產生（可以用「框選新增」補上，或換一張拍得清楚的）</div>';
    } catch (e) { box.innerHTML = `<div class="small" style="padding:20px">${esc(e.message)}</div>`; }
  };
  const io = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); showGen(e.target); } }), { rootMargin: '300px' });
  const bind = (root) => {
    progressive(root);
    root.querySelectorAll('[data-pgen]').forEach((b) => io.observe(b));
    root.querySelectorAll('[data-pgbig]').forEach((b) => b.onclick = async () => {
      const tok = await specFor(Number(b.dataset.pgbig));
      if (!tok) { toast('這一頁沒有辨識到題目'); return; }
      modal({ title: '重新產生的電子試卷', wide: true, body: `<div class="paper-preview"><iframe src="/print.html?t=${tok}&preview=1"></iframe></div>` });
    });
    root.querySelectorAll('.qbox').forEach((b) => b.onclick = async () => {
      const q = await fullQ(exam.questions.find((x) => x.id === Number(b.dataset.q))).catch((e) => { errToast(e); return null; });
      if (!q) return;
      modal({ title: `第 ${esc(q.number)} 題`, wide: true, body: questionCard(q, { compact: false }),
        onOpen: (m) => bindQuestionCards(m, () => q, () => load(main, exam.id)) });
    });
    // 前處理後 ⇄ 原始照片 (the photo as taken, with the outline that was used)
    root.querySelectorAll('[data-pv]').forEach((b) => b.onclick = async () => {
      const pid = b.dataset.pid, orig = b.dataset.pv === 'orig';
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const ob = body.querySelector(`[data-orig="${pid}"]`), sv = body.querySelector(`.page-view[data-page="${pid}"]`);
      ob.classList.toggle('hidden', !orig); sv.classList.toggle('hidden', orig);
      const img = ob.querySelector('img');
      if (orig && !img.src) {
        img.src = img.dataset.osrc;
        try {
          const r = await get(`/api/pages/${pid}/corners`);
          const { cornersSvg } = await import('../corners.js');
          if (r.corners && r.corners.length) img.insertAdjacentHTML('afterend', cornersSvg(r.corners));
        } catch { /* the photo alone */ }
      }
    });
    const rescanOne = async (pid) => {
      const pg = exam.pages.find((x) => x.id === Number(pid));
      const res = await runJob(post(`/api/exams/${exam.id}/pages/${pg.id}/corners`, { auto: true }), `用新的前處理重做第 ${pg.idx + 1} 頁…`);
      if (res) toast(`第 ${pg.idx + 1} 頁重做好了：${res.kept} 題保留${res.added ? `、新增 ${res.added} 題` : ''}${res.removed ? `、${res.removed} 題拿掉` : ''}`, 'ok');
      imgV = Date.now();
      load(main, exam.id);
    };
    root.querySelectorAll('[data-rescan]').forEach((b) => b.onclick = () => rescanOne(b.dataset.rescan));
    root.querySelectorAll('[data-corners]').forEach((b) => b.onclick = async () => {
      const pg = exam.pages.find((x) => x.id === Number(b.dataset.corners));
      const r = await get(`/api/pages/${pg.id}/corners`);
      const { editCorners } = await import('../corners.js');
      const c = await editCorners(`/api/pages/${pg.id}/photo`, r.corners, { title: `第 ${pg.idx + 1} 頁：調整四個角` });
      if (!c) return;
      const res = await runJob(post(`/api/exams/${exam.id}/pages/${pg.id}/corners`, { corners: c }), `用新的四個角重新校正、辨識第 ${pg.idx + 1} 頁…`);
      if (res) toast(`第 ${pg.idx + 1} 頁重新校正好了${res.added ? `，新增 ${res.added} 題` : ''}${res.removed ? `、${res.removed} 題拿掉` : ''}`, 'ok');
      imgV = Date.now();
      load(main, exam.id);
    });
    root.querySelectorAll('[data-replace]').forEach((inp) => inp.onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const pg = exam.pages.find((x) => x.id === Number(inp.dataset.replace));
      const n = exam.questions.filter((q) => q.page_id === pg.id).length;
      e.target.value = '';
      if (!await confirmBox(`用新照片重新辨識第 ${pg.idx + 1} 頁？<br><span class="small muted">這一頁的 ${n} 題會重新讀；題號一樣的題目保留錯題和作答紀錄${(exam.options || {}).grade ? '，這一頁會重新批改' : ''}。其他頁不動。</span>`, '換這一頁')) return;
      const { shrink } = await import('./scan.js');
      const x = await shrink(f);
      const fd = new FormData();
      fd.append('file', x, x.name);
      const res = await runJob(api(`/api/exams/${exam.id}/pages/${pg.id}/replace`, { method: 'POST', form: fd }), `AI 重新辨識第 ${pg.idx + 1} 頁…`);
      if (res) toast(`第 ${pg.idx + 1} 頁換好了：${res.kept} 題保留${res.added ? `、新增 ${res.added} 題` : ''}${res.removed ? `、${res.removed} 題拿掉` : ''}${res.graded ? '，已重新批改' : ''}`, 'ok');
      imgV = Date.now();
      load(main, exam.id);
    });
    root.querySelectorAll('[data-region]').forEach((b) => b.onclick = () => regionSelect(main, exam.pages.find((p) => p.id === Number(b.dataset.region))));
  };
  const ra = $('#rescanall');
  if (ra) ra.onclick = async () => {
    const n = exam.pages.filter((p) => p.scan_path && !(p.meta && p.meta.scan)).length;
    if (!await confirmBox(`用新的前處理重做這份的每一頁（${exam.pages.length} 頁），AI 會重新辨識每一頁（約每頁半分鐘到一分鐘）。題號一樣的題目保留錯題和作答紀錄${(exam.options || {}).grade ? '，並重新批改' : ''}。`, '開始重做')) return;
    const res = await runJob(post(`/api/exams/${exam.id}/rescan`), '用新的前處理重做中…');
    if (res) toast(`重做好了：${res.pages} 頁`, 'ok');
    imgV = Date.now();
    load(main, exam.id);
  };
  bind(body);
  const lazy = new IntersectionObserver((ents) => ents.forEach((e) => {
    if (!e.isIntersecting) return;
    lazy.unobserve(e.target);
    const p = exam.pages.find((x) => x.id === Number(e.target.dataset.lazy));
    e.target.insertAdjacentHTML('afterend', card(p));
    const el = e.target.nextElementSibling;
    e.target.remove();
    bind(el);
  }), { rootMargin: narrow() ? '500px' : '1500px' });  // a phone: not several previews at once
  body.querySelectorAll('[data-lazy]').forEach((x) => lazy.observe(x));
}
const narrow = () => window.matchMedia('(max-width: 700px)').matches;
// each preview (print.html in a frame) says how tall it is: the frame grows to it — no scrolling inside
// a frame on a phone. The 放大看 window keeps its own height (it scrolls itself).
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (ev.origin !== location.origin || !d || d.type !== 'paper-size' || !d.t) return;
  document.querySelectorAll('.pg-gen iframe').forEach((f) => {
    if (f.src.includes(`t=${d.t}`)) f.style.height = `${Math.max(240, Math.min(d.h + 4, 20000))}px`;
  });
});



// Drag a rectangle on an image; resolves to a 0..1000 box.
function dragBox(container, onBox) {
  const img = container.querySelector('img');
  let start = null, box = null;
  container.style.touchAction = 'none';
  const pos = (e) => {
    const r = img.getBoundingClientRect();
    return [Math.max(0, Math.min(1000, (e.clientX - r.left) / r.width * 1000)), Math.max(0, Math.min(1000, (e.clientY - r.top) / r.height * 1000))];
  };
  container.onpointerdown = (e) => {
    e.preventDefault();
    start = pos(e);
    box && box.remove();
    box = document.createElement('div');
    box.className = 'drawbox';
    container.appendChild(box);
    container.setPointerCapture(e.pointerId);
  };
  container.onpointermove = (e) => {
    if (!start) return;
    const p = pos(e);
    const [x0, x1] = [Math.min(start[0], p[0]), Math.max(start[0], p[0])];
    const [y0, y1] = [Math.min(start[1], p[1]), Math.max(start[1], p[1])];
    Object.assign(box.style, { left: x0 / 10 + '%', top: y0 / 10 + '%', width: (x1 - x0) / 10 + '%', height: (y1 - y0) / 10 + '%' });
    box.dataset.b = JSON.stringify([x0, y0, x1, y1].map(Math.round));
  };
  container.onpointerup = () => {
    start = null;
    if (box && box.dataset.b) onBox(JSON.parse(box.dataset.b));
  };
}

function regionSelect(main, page) {
  let picked = null;
  modal({
    title: '框選題目', wide: true,
    body: `<p class="small">用手指或滑鼠在題目上拉一個框（包含題目和選項），AI 會把它轉成文字並加入題庫，自動標記為錯題。</p>
      <div class="page-view" id="rv" style="touch-action:none"><img src="${thumbUrl(page.scan_path, page.scan_v, 1200)}" draggable="false"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-close>取消</button>
      <button class="btn" id="rgo" disabled>辨識這個範圍</button></div>`,
    onOpen: (m, close) => {
      dragBox(m.querySelector('#rv'), (b) => { picked = b; m.querySelector('#rgo').disabled = (b[2] - b[0] < 10 || b[3] - b[1] < 10); });
      m.querySelector('#rgo').onclick = async () => {
        close();
        const res = await runJob(post(`/api/pages/${page.id}/region`, { box: picked }), 'AI 辨識框選範圍…');
        if (res) { toast(`新增了 ${res.question_ids.length} 題`, 'ok'); load(main, exam.id); }
      };
    },
  });
}

async function printOne(p) {
  const ids = exam.questions.map((q) => q.id);
  const wrong = exam.questions.filter((q) => q.is_wrong).map((q) => q.id);
  const hl = exam.questions.filter((q) => q.is_highlighted || q.is_marked).map((q) => q.id);
  if (p === 'key') {
    const { openPreview } = await import('./templates.js');
    openPreview(exam.template.id, { exam: { id: exam.id, title: exam.title, n: exam.questions.length }, key: true });
  } else {
    const list = p === 'wrong' ? wrong : p === 'hl' ? hl : ids;
    // the exam's template (chosen when it was scanned, or by its kind)
    const tpl = p === 'wrong' ? { id: 'wrong', config: WRONG_PAPER } : exam.template;
    makePaper(list, `${exam.title}${p === 'wrong' ? '－錯題卷' : p === 'hl' ? '－重點題' : ''}`, { ...(tpl.config || {}), template: tpl.id });
  }
}


const busyNow = () => exam.status === 'processing' || !!(exam.job && ['queued', 'running'].includes(exam.job.status));

// whose exam (a parent can move one that was filed under the wrong child)
function ownerHtml() {
  const u = state.status.user;
  const kids = (state.status.students || []).filter((x) => x.role !== 'parent');
  const all = state.status.students || [];
  const cur = all.find((x) => x.id === exam.student_id);
  if (!u || u.role !== 'parent' || !kids.length) return '';
  if (kids.length === 1 && cur && cur.id === kids[0].id) return `${esc(cur.name)}的考卷 · `;  // nothing to choose
  const wrong = cur && cur.role === 'parent';
  return `<label class="exowner ${wrong ? 'bad' : ''}">${wrong ? '⚠ ' : ''}<select id="exowner" aria-label="這是誰的考卷">
    ${wrong ? `<option value="${cur.id}">${esc(cur.name)}（家長，請改成孩子）</option>` : ''}
    ${kids.map((k) => `<option value="${k.id}" ${k.id === exam.student_id ? 'selected' : ''}>${esc(k.name)}的考卷</option>`).join('')}</select></label> · `;
}

// 排版成品: what this exam turned into — check it in one tap, change it if it is not right
function resultCard(c, compact = false) {
  const t = exam.template;
  if (!t || !c.all || exam.status === 'processing') return '';
  return `<div class="card exam-result">
    <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
      <span class="ti">${icon('doc', 20)}</span>
      <div style="flex:1;min-width:200px"><b>排成「${esc(t.name)}」${t.custom ? '<span class="tag">我的 Word 範本</span>' : ''}</b>
        <div class="small muted">${t.auto ? `AI 判斷這是「${esc(t.kind_name)}」` : '你選的範本'}・題目卷、解答卷都可以下載成 Word／PDF</div></div>
      <select id="extpl" aria-label="換範本" style="width:auto;max-width:100%"></select>
    </div>
    ${(() => { const up = exam.questions.filter((q) => q.upgraded_at).length, n = exam.questions.length;
      return up < n ? `<div class="small up-line" style="margin-top:10px"><span class="progress" style="flex:1"><i style="width:${Math.round(100 * up / n)}%"></i></span>
        <span>AI 正在對照原稿校對、重畫圖：${up}/${n} 題</span>${state.status.user.role === 'parent' ? '<button class="btn sm soft" id="exprio">優先處理這份</button>' : ''}</div>` : ''; })()}
    ${verifyLine()}
    ${fidelityLine()}
    <div class="row" style="gap:6px;margin-top:10px;flex-wrap:wrap">
      ${compact ? '' : `<button class="btn sm ok" id="expractice">${icon('play', 15)} 直接練習這一份</button>
      <button class="btn sm soft" id="exgrade">✅ 批改</button>`}
      <button class="btn sm soft" data-res="q">${icon('search', 15)} 看題目卷</button>
      <button class="btn sm soft" data-res="k">${icon('search', 15)} 看解答卷</button>
      <details class="xmenu"><summary class="btn sm ghost">${icon('download', 15)} 下載</summary><div class="xmenu-list">
        <button data-dl="docx">題目卷・Word（可編輯）</button><button data-dl="pdf">題目卷・PDF</button>
        <button data-dl="docx" data-key="1">解答卷・Word</button><button data-dl="pdf" data-key="1">解答卷・PDF</button></div></details>
      ${state.status.user.role === 'parent' ? `<details class="xmenu"><summary class="btn sm ghost" aria-label="更多">⋯</summary><div class="xmenu-list">
        <button id="exregen">${icon('redo', 15)} 依範本重新產生 Word、解答、NAS</button>
        <button id="exup">${icon('bolt', 15)} AI 重新校對、重畫圖</button>
        <button id="exverify">${icon('search', 15)} AI 複查答案、詳解</button>
        <button id="exfid">${icon('image', 15)} AI 比對原卷（不一致的重做）</button>
        ${((exam.options || {}).layout || {}).zhuyin ? '<button id="exzy">ㄅㄆㄇ 補注音（缺注音的題目）</button>' : ''}
        <a href="#/templates">${icon('doc', 15)} 範本設定</a></div></details>` : ''}
    </div></div>`;
}

// 與原卷一致: the regenerated paper compared with the photos — what was redone, what still differs
function fidelityLine() {
  const f = (exam.options || {}).fidelity;
  if (!f) return '';
  const still = f.still || [];
  return `<div class="small" style="margin-top:10px">${still.length ? '⚠️' : '✅'} 和原卷比對（${esc((f.checked_at || '').slice(5, 16).replace('T', ' '))}）：
    ${f.questions} 題看過${f.found ? `，${f.found} 題不一致、已重做 ${f.fixed} 題` : '，全部一致'}${still.length
      ? `；<b style="color:var(--bad)">仍不一致 ${still.length} 題</b>：${still.slice(0, 8).map((x) => `第 ${esc(x.number)} 題（${esc((x.problems || [])[0] || '')}）`).join('、')}${still.length > 8 ? '…' : ''}` : ''}</div>`;
}

// 答案複查: what the second look at the answers found (and changed), for the parent to see
function verifyLine() {
  const v = (exam.options || {}).verify;
  if (!v) return '';
  const when = String(v.at || '').slice(5, 16).replace('T', ' ');
  if (!(v.changed || []).length) return `<div class="small muted" style="margin-top:8px">🔍 答案複查（${esc(when)}）：${v.checked} 題的答案和詳解都沒問題</div>`;
  return `<details class="small" style="margin-top:8px"><summary>🔍 答案複查（${esc(when)}）：${v.checked} 題看過，改了 ${v.changed.length} 題的答案——${v.changed.map((x) => `第 ${esc(x.number)} 題`).join('、')}</summary>
    <ul style="margin:6px 0 0;padding-left:20px">${v.changed.map((x) => `<li>第 ${esc(x.number)} 題：<s class="muted">${rich(x.old)}</s> → <b>${rich(x.new)}</b>${x.why ? `<span class="muted">（${esc(x.why)}）</span>` : ''}</li>`).join('')}</ul></details>`;
}

async function bindResult(main) {
  const sel = $('#extpl');
  if (!sel) return;
  const t = exam.template;
  const all = await get('/api/templates').catch(() => null);
  if (!all || !sel.isConnected) return;
  sel.innerHTML = `<option value="auto">依類型自動（${esc(t.kind_name)}）</option>` +
    all.templates.filter((x) => !x.hidden || x.id === t.id).map((x) => `<option value="${x.id}">${esc(x.name)}${x.kind === 'custom' ? '（我的範本）' : ''}</option>`).join('');
  sel.value = t.auto ? 'auto' : t.id;
  sel.onchange = async () => {
    try {
      exam.template = await put(`/api/exams/${exam.id}/template`, { id: sel.value });
      toast(`改用「${exam.template.name}」排版`, 'ok');
      draw(main);
    } catch (e) { errToast(e); }
  };
  const pp = $('#expractice');
  if (pp) pp.onclick = () => practiceMenu();
  const eg = $('#exgrade');
  if (eg) eg.onclick = () => gradeMenu(main);
  const pr = $('#exprio');
  if (pr) pr.onclick = async () => { try { await post(`/api/exams/${exam.id}/priority`); toast('這份會先處理（正在做的題目做完就換它）', 'ok'); } catch (e) { errToast(e); } };
  const up = $('#exup');
  if (up) up.onclick = async () => {
    if (!await confirmBox('AI 會對照原稿重新校對每一題、把圖重畫成 SVG（或做成表格），並重寫詳解。在背景進行，約每題半分鐘到一分鐘。', '開始')) return;
    try { await post('/api/exams/upgrade', { exam_id: exam.id, force: true }); toast('已開始，在背景進行；完成後題目和 Word／PDF 會自動更新', 'ok'); } catch (e) { errToast(e); }
  };
  const fd = $('#exfid');
  if (fd) fd.onclick = async () => {
    try {
      const r = await post(`/api/exams/${exam.id}/fidelity`);
      toast('和原卷比對中，在背景進行（每頁約半分鐘）…', 'ok');
      const res = await waitJob(r.job_id);
      toast(res.found ? `比對完成：${res.found} 題不一致，重做後 ${res.fixed} 題已一致${(res.still || []).length ? `，${res.still.length} 題仍需你確認` : ''}` : '比對完成：每一題都和原卷一致', 'ok');
      if (location.hash.startsWith(`#/exam/${exam.id}`)) load(main, exam.id);
    } catch (e) { errToast(e); }
  };
  const zy = $('#exzy');
  if (zy) zy.onclick = async () => {
    try {
      const r = await post(`/api/exams/${exam.id}/zhuyin`);
      toast('補注音中，在背景進行…', 'ok');
      const res = await waitJob(r.job_id, (j) => { if (j.status === 'running') toast(j.message || '補注音中…'); });
      toast(res.total ? `補好 ${res.done} 題的注音${res.failed ? `，${res.failed} 題沒成功（可以再按一次）` : ''}` : (res.skipped || '每一題都已經有注音了'), 'ok');
      if (location.hash === `#/exam/${exam.id}`) load(main, exam.id);
    } catch (e) { errToast(e); }
  };
  const vf = $('#exverify');
  if (vf) vf.onclick = async () => {
    if (!await confirmBox('AI 會不看原本的答案，照原稿照片把每一題再做一次，和原本的答案、詳解比對；不一樣的會改過來，並列出給你看。在背景進行，約每題十幾秒。', '開始複查')) return;
    try {
      const r = await post(`/api/exams/${exam.id}/verify`);
      toast('已開始複查，在背景進行；完成後會告訴你改了哪幾題', 'ok');
      const res = await waitJob(r.job_id);
      toast(res.changed ? `複查完成：${res.checked} 題看過，改了 ${res.changed} 題的答案或詳解（考卷頁上方有列出）` : `複查完成：${res.checked} 題的答案都沒問題`, 'ok');
      if (location.hash === `#/exam/${exam.id}`) load(main, exam.id);
    } catch (e) { errToast(e); }
  };
  // a menu closes when something else is tapped
  $$('details.xmenu', main).forEach((d) => d.ontoggle = () => {
    if (!d.open) return;
    const off = (ev) => { if (!d.contains(ev.target) || ev.target.closest('.xmenu-list > *')) { d.open = false; document.removeEventListener('click', off, true); } };
    setTimeout(() => document.addEventListener('click', off, true));
  });
  const rg = $('#exregen');
  if (rg) rg.onclick = async () => { const { regenerate } = await import('./exams.js'); regenerate([exam.id]); };
  const { openPreview } = await import('./templates.js');
  $$('[data-res]', main).forEach((b) => b.onclick = () => openPreview(exam.template.id, { exam: { id: exam.id, title: exam.title, n: exam.questions.length }, key: b.dataset.res === 'k' }));
  $$('[data-dl]', main).forEach((b) => b.onclick = async () => {
    b.closest('details').open = false;
    const r = await post(`/api/templates/${exam.template.id}/sample`, { exam_id: exam.id, key_only: !!b.dataset.key });
    toast(b.dataset.dl === 'pdf' ? '產生 PDF 中…' : '產生 Word 中…');
    location.href = `/api/print/${b.dataset.dl}/${r.token}`;
  });
}


// 直接練習這一份: each round is a task with its own score; what she already got right is not asked
// again (by default she continues with the ones not done yet and the ones wrong last time)
async function practiceMenu() {
  const all = exam.questions.filter((q) => q.solved);
  if (!all.length) { toast('題目的答案還在整理中，等一下再試'); return; }
  const source = `exam:${exam.id}`;
  const pr = await get(`/api/practice/progress?source=${encodeURIComponent(source)}`).catch(() => ({ right: [], wrong: [], rounds: [] }));
  const right = new Set(pr.right), wrongLast = new Set(pr.wrong);
  const todo = all.filter((q) => !right.has(q.id));
  // from the 批改 too: marked wrong / partly right, and the ones she left blank (not yet done right since)
  const gr = (exam.options || {}).grade || {};
  const res = (q) => (gr[q.id] || {}).result;
  const wrong = all.filter((q) => wrongLast.has(q.id) || (!right.has(q.id) && ((q.is_wrong && !q.mastered) || ['wrong', 'partial'].includes(res(q)))));
  const blank = all.filter((q) => res(q) === 'blank' && !right.has(q.id) && !wrong.includes(q));
  const both = all.filter((q) => wrong.includes(q) || blank.includes(q));  // in the paper's order
  // 錯題紀錄: every question she ever got wrong while practising this paper, most-missed first
  const wc = pr.wrong_counts || {};
  const missed = all.filter((q) => wc[q.id]).sort((a, b) => wc[b.id] - wc[a.id]);
  const tried = new Set([...pr.right, ...pr.wrong]);
  const go = async (list, opts) => {
    await quiz(list, { title: exam.title, track: { source, title: exam.title }, ...opts });
    load(document.getElementById('main'), exam.id);
  };
  const rounds = pr.rounds || [];
  modal({
    title: '練習這一份',
    body: `${rounds.length ? `<div class="group" style="margin-bottom:12px">${rounds.slice(-4).reverse().map((r, i) => `<div class="gi"><span class="t small">第 ${rounds.length - i} 次・${r.created_at.slice(5, 16).replace('T', ' ')}</span>
        <span class="small"><b class="${r.pct >= 80 ? 'ok-ink' : r.pct >= 60 ? '' : 'bad-ink'}">${r.pct ?? '-'}%</b>（${r.correct}/${r.done} 題${r.done < r.n ? `，做了 ${r.done}/${r.n}` : ''}）</span></div>`).join('')}</div>` : ''}
      <div class="stack" style="gap:8px">
      ${todo.length && todo.length < all.length ? `<button class="bk-opt rec" data-p="todo"><span class="ti">${icon('play', 20)}</span><span style="flex:1"><b>繼續：還沒答對的 ${todo.length} 題</b><span class="sub">已經答對的 ${all.length - todo.length} 題不用再做${todo.some((q) => !tried.has(q.id)) ? `・還沒做過 ${todo.filter((q) => !tried.has(q.id)).length} 題` : ''}</span></span></button>` : ''}
      ${missed.length ? `<button class="bk-opt" data-p="missed"><span class="ti orange">${icon('redo', 20)}</span><span style="flex:1"><b>錯過的題：${missed.length} 題</b><span class="sub">練習時答錯過的（錯最多次的先）：${missed.slice(0, 6).map((q) => `第${esc(String(q.number || '?'))}題 錯${wc[q.id]}次`).join('、')}${missed.length > 6 ? '…' : ''}</span></span></button>` : ''}
      ${!todo.length ? '<div class="card tight ok-soft">這一份每一題都答對過了，太厲害了！</div>' : ''}
      <button class="bk-opt ${todo.length === all.length ? 'rec' : ''}" data-p="all"><span class="ti">${icon('redo', 20)}</span><span style="flex:1"><b>整份重做</b><span class="sub">${all.length} 題・照考卷順序</span></span></button>
      ${wrong.length && blank.length ? `<button class="bk-opt" data-p="both"><span class="ti orange">${icon('x', 20)}</span><span style="flex:1"><b>錯的＋沒寫的</b><span class="sub">${both.length} 題（錯 ${wrong.length}、沒寫 ${blank.length}）・照考卷順序</span></span></button>` : ''}
      ${wrong.length ? `<button class="bk-opt" data-p="wrong"><span class="ti orange">${icon('x', 20)}</span><span style="flex:1"><b>只練錯的</b><span class="sub">${wrong.length} 題・先看觀念再作答</span></span></button>` : ''}
      ${blank.length ? `<button class="bk-opt" data-p="blank"><span class="ti">○</span><span style="flex:1"><b>只練沒寫的</b><span class="sub">${blank.length} 題・考卷上空著沒寫的</span></span></button>` : ''}
      <button class="bk-opt" data-p="shuffle"><span class="ti green">${icon('bolt', 20)}</span><span style="flex:1"><b>打亂順序練</b><span class="sub">${all.length} 題・確定不是背答案</span></span></button>
    </div>`,
    onOpen: (m, close) => m.querySelectorAll('[data-p]').forEach((b) => b.onclick = () => {
      close();
      const p = b.dataset.p;
      if (p === 'todo') go(todo, { mode: 'practice' });
      else if (p === 'wrong') go(wrong, { mode: 'review', conceptFirst: true });
      else if (p === 'missed') go(missed, { mode: 'review' });
      else if (p === 'both') go(both, { mode: 'practice' });
      else if (p === 'blank') go(blank, { mode: 'practice' });
      else if (p === 'shuffle') go([...all].sort(() => Math.random() - 0.5), { mode: 'practice' });
      else go(all, { mode: 'practice' });
    }),
  });
}


// 批改功課: the pages she wrote on, marked like a teacher would — a red ✗ / △ on each wrong one, so it
// can be held next to the paper. Tap a mark for what she wrote, the AI's note and (only if asked) the
// answer; ticked ones (the wrong ones, to start) go to the 錯題本 and can be redone at once.
// 請你確認 (ask; an older 「?」 too): the AI could not decide even close up, a parent decides
const GRADE = { correct: ['✓', 'ok', '對'], wrong: ['✗', 'bad', '錯'], partial: ['△', 'warn', '部分對'], blank: ['○', 'gray', '沒寫'],
  ask: ['確認', 'ask', '請你確認'], unsure: ['確認', 'ask', '請你確認'] };
const isAsk = (r) => r === 'ask' || r === 'unsure';
const FIX = ['wrong', 'partial'];
let gsel = null, gselFor = null, gAll = false, gOrder = [];
function gradeCard() {
  const g = (exam.options || {}).grade;
  if (!g) return '';
  const gkey = `${exam.id}:${(exam.options || {}).graded_at || ''}`;
  if (gselFor !== gkey) { gsel = new Set(exam.questions.filter((q) => g[q.id] && FIX.includes(g[q.id].result)).map((q) => q.id)); gselFor = gkey; gAll = false; }
  const qs = exam.questions.filter((q) => g[q.id]);
  const n = (k) => qs.filter((q) => g[q.id].result === k).length;
  const answered = qs.length - n('blank');  // questions not written yet (unfinished homework) do not count
  const judged = n('correct') + n('wrong') + n('partial');  // nor those the AI could not read
  const score = judged ? Math.round((100 * (n('correct') + 0.5 * n('partial'))) / judged) : '-';
  const asks = qs.filter((q) => isAsk(g[q.id].result));
  const bad = qs.filter((q) => ['wrong', 'partial'].includes(g[q.id].result) || isAsk(g[q.id].result))
    .sort((x, y) => (x.page_id || 0) - (y.page_id || 0) || (x.bbox ? x.bbox[1] : 0) - (y.bbox ? y.bbox[1] : 0));
  gOrder = bad.map((q) => q.id);
  const badPages = new Set(bad.map((q) => q.page_id));
  const pages = exam.pages.filter((p) => p.scan_path && qs.some((q) => q.page_id === p.id && q.bbox));
  const shown = gAll ? pages : pages.filter((p) => badPages.has(p.id));
  const fromRedo = (exam.options || {}).grade_source === 'photos';
  return `<div class="card grade-card">
    <div class="row" style="gap:14px;align-items:center;flex-wrap:wrap">
      <div class="grade-score"><b>${score}</b><span>分</span></div>
      <div style="flex:1;min-width:180px"><b style="font-size:17px">批改好了</b>
        <div class="small">寫了 ${answered} 題：對 ${n('correct')}・<b class="t-bad">錯 ${n('wrong')}</b>${n('partial') ? `・部分對 ${n('partial')}` : ''}${n('blank') ? `・沒寫 ${n('blank')}` : ''}</div></div>
    </div>
    ${asks.length ? `<div class="card tight gr-ask"><b>有 ${asks.length} 題 AI 放大看了還是不確定</b>
      <span class="small">${parentNow() ? '一題一題給你看她寫的和正確答案，你按「對」或「錯」就好（錯的會加入要訂正）。' : '請爸爸媽媽幫忙確認對錯。'}</span>
      ${parentNow() ? `<button class="btn ok sm" id="gask">開始確認 ${asks.length} 題</button>` : ''}</div>` : ''}
    ${bad.length ? `<div class="gr-chips"><span class="small muted">要訂正：</span>${byPage(bad).map(([pg, list]) =>
      `${pg ? `<span class="gr-pgl">第${pg}頁</span>` : ''}${list.map((q) => {
        const [ic, cls] = GRADE[g[q.id].result] || GRADE.unsure;
        return `<button class="gr-chip ${cls} ${gsel.has(q.id) ? 'on' : ''}" data-gjump="${q.id}">${ic} ${esc(q.number || '?')}</button>`;
      }).join('')}`).join('')}</div>` : '<div class="gr-allok">全部都對，太棒了！🎉</div>'}
    <div class="small muted" style="margin:8px 0">${fromRedo ? '紅筆畫在原本拍的考卷上（重寫的答案寫在點開的說明裡）。' : ''}點紅色記號看寫了什麼、哪裡錯；要看答案再按「看答案」。</div>
    <div class="gr-pages">${shown.map((p) => `<div class="gr-page" data-gpage="${p.id}">
      <div class="gr-pn">第 ${p.idx + 1} 頁</div>
      <div class="gr-img">${pageImg(p, 'loading="lazy" decoding="async"')}
      ${qs.filter((q) => q.page_id === p.id && q.bbox).map((q) => {
        const r = g[q.id].result, [ic, cls] = GRADE[r] || GRADE.unsure;
        const [x0, y0, x1, y1] = q.bbox;
        const fix = r !== 'correct' && r !== 'blank';
        return `<button class="gr-mark ${cls} ${fix ? 'fix' : ''} ${gsel.has(q.id) ? 'on' : ''}" data-gq="${q.id}" title="第 ${esc(q.number || '')} 題"
          style="left:${x0 / 10}%;top:${y0 / 10}%;width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%"><i>${ic}</i></button>`;
      }).join('')}</div></div>`).join('')}</div>
    ${pages.length > shown.length ? `<button class="btn ghost block sm" id="gall">看全部 ${pages.length} 頁（含全對的頁）</button>` : gAll && pages.length > badPages.size ? '<button class="btn link sm" id="gall">只看有錯的頁</button>' : ''}
    ${bad.filter((q) => !q.bbox || !q.page_id).length ? `<div class="small muted">有 ${bad.filter((q) => !q.bbox || !q.page_id).length} 題在照片上找不到位置，點上面的題號看。</div>` : ''}
    <div class="row gr-acts">
      <button class="btn ok" id="gredo">${icon('play', 16)} <span id="gn">${gsel.size}</span> 題馬上再做一次</button>
      ${inBankNow() ? '<button class="btn ghost" id="gsave">只加入錯題本</button>' : '<span class="small muted">不在題庫：錯的只在這裡重寫</span>'}
      <span class="spacer"></span><button class="btn link sm" id="gagain">重寫再批改</button>
    </div></div>`;

  // the questions to fix, by the page they are on (numbers start again on each part of a paper)
  function byPage(list) {
    const idx = Object.fromEntries(exam.pages.map((p) => [p.id, p.idx + 1]));
    const multi = new Set(list.map((q) => q.page_id)).size > 1;
    const out = [];
    for (const q of list) {
      const pg = multi ? idx[q.page_id] || 0 : 0;
      const last = out[out.length - 1];
      if (last && last[0] === pg) last[1].push(q); else out.push([pg, [q]]);
    }
    return out;
  }
}

// one marked question: what she wrote, the AI's note; the answer only when asked
// 請你確認: each mark the AI could not decide, shown close up with her answer and the right one
async function confirmAsks(main, start = 0) {
  const g = exam.options.grade;
  const list = exam.questions.filter((q) => g[q.id] && isAsk(g[q.id].result));
  if (!list.length) { toast('都確認好了', 'ok'); draw(main); return; }
  const q = list[Math.min(start, list.length - 1)], r = g[q.id];
  const pg = exam.pages.find((p) => p.id === q.page_id);
  modal({
    title: `請你確認：第 ${esc(q.number || '')} 題 <span class="small muted">${pg ? `第 ${pg.idx + 1} 頁・` : ''}還有 ${list.length} 題</span>`,
    body: `${q.crop_path ? `<div class="gr-crop"><img src="${mediaUrl(q.crop_path)}" alt="這一題的照片"></div>` : ''}
      <div class="gr-stem${q.vertical ? ' vstem' : ''}">${rich(q.stem)}</div>
      ${(q.options || []).length ? `<div class="small">${q.options.map((o, i) => `${'①②③④⑤⑥'[i] || i + 1} ${rich(o)}`).join('　')}</div>` : ''}
      <div class="gr-wrote">AI 認為她寫的是：<b>${rich(r.read_as || q.student_answer || '（認不出來）')}</b></div>
      <div class="gr-key">正確答案：<b>${rich(q.answer || r.answer || '（還在整理）')}</b></div>
      <div class="row gr-judge">${[['correct', '✓ 對', 'ok'], ['wrong', '✗ 錯', 'bad'], ['partial', '△ 部分對', 'soft'], ['blank', '○ 沒寫', 'ghost']]
        .map(([v, l, c]) => `<button class="btn ${c}" data-judge="${v}">${l}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn link sm" id="jskip">先跳過</button><span class="spacer"></span>
        <a class="btn link sm" href="#/q/${q.id}">看詳解</a></div>`,
    onOpen: (m, close) => {
      m.querySelectorAll('[data-judge]').forEach((b) => b.onclick = async () => {
        try {
          const res = await put(`/api/exams/${exam.id}/grade/${q.id}`, { result: b.dataset.judge });
          g[q.id] = { ...r, result: b.dataset.judge, by: 'parent' };
          exam.options.grade_summary = res.summary;
          if (['wrong', 'partial'].includes(b.dataset.judge)) gsel.add(q.id); else gsel.delete(q.id);
          close();
          setTimeout(() => confirmAsks(main, start), 200);
        } catch (e) { errToast(e); }
      });
      m.querySelector('#jskip').onclick = () => { close(); if (start + 1 < list.length) setTimeout(() => confirmAsks(main, start + 1), 200); else draw(main); };
    },
  }).then(() => {});
}

function gradeDetail(main, q) {
  const r = exam.options.grade[q.id], [ic, cls, label] = GRADE[r.result] || GRADE.unsure;
  if (isAsk(r.result) && parentNow()) {
    const list = exam.questions.filter((x) => exam.options.grade[x.id] && isAsk(exam.options.grade[x.id].result));
    return confirmAsks(main, Math.max(0, list.findIndex((x) => x.id === q.id)));
  }
  const pg = exam.pages.find((p) => p.id === q.page_id);
  const at = gOrder.indexOf(q.id);
  let closeMe;
  const go = (d) => { const id = gOrder[at + d]; if (id === undefined) return; closeMe && closeMe(); markAt(main, id); setTimeout(() => gradeDetail(main, exam.questions.find((x) => x.id === id)), 250); };
  modal({
    title: `<span class="grade-ic ${cls}">${ic}</span> 第 ${esc(q.number || '')} 題 <span class="small muted">${pg ? `第 ${pg.idx + 1} 頁・` : ''}${esc(q.qtype || '')}・${label}</span>`,
    body: `<div class="gr-stem${q.vertical ? ' vstem' : ''}">${rich(q.stem)}</div>
      <div class="gr-wrote">寫的答案：<b>${rich(r.read_as || q.student_answer || '（沒寫）')}</b></div>
      ${r.comment ? `<div class="gr-cm">${rich(r.comment)}</div>` : ''}
      <div class="gr-key hidden" id="gkey">正確答案：<b>${rich(q.answer || r.answer || '（還在整理）')}</b></div>
      <label class="gr-tick"><input type="checkbox" id="gtick" ${gsel.has(q.id) ? 'checked' : ''}> 要再做一次（加入錯題本）</label>
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn soft" id="gshow">看答案</button>
        <a class="btn ghost" href="#/q/${q.id}">看詳解、問 AI</a></div>
      ${at >= 0 && gOrder.length > 1 ? `<div class="gr-nav"><button class="btn link sm" id="gprev" ${at ? '' : 'disabled'}>‹ 上一個要訂正的</button>
        <span class="small muted">${at + 1} / ${gOrder.length}</span>
        <button class="btn link sm" id="gnext" ${at < gOrder.length - 1 ? '' : 'disabled'}>下一個要訂正的 ›</button></div>` : ''}`,
    onOpen: (m, close) => {
      closeMe = close;
      const pv = m.querySelector('#gprev'), nx = m.querySelector('#gnext');
      if (pv) pv.onclick = () => go(-1);
      if (nx) nx.onclick = () => go(1);
      m.querySelector('#gshow').onclick = (e) => { m.querySelector('#gkey').classList.remove('hidden'); e.target.remove(); };
      m.querySelector('#gtick').onchange = (e) => {
        e.target.checked ? gsel.add(q.id) : gsel.delete(q.id);
        main.querySelectorAll(`[data-gq="${q.id}"],[data-gjump="${q.id}"]`).forEach((x) => x.classList.toggle('on', e.target.checked));
        const gn = $('#gn', main); if (gn) gn.textContent = gsel.size;
      };
    },
  });
}

// scroll the page photo to a question's red mark and make it blink
function markAt(main, id) {
  const mark = main.querySelector(`[data-gq="${id}"]`);
  if (!mark) return false;
  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  mark.classList.add('flash'); setTimeout(() => mark.classList.remove('flash'), 1600);
  return true;
}

function bindGrade(main) {
  if (!(exam.options || {}).grade) return;
  progressive(main);
  const byId = (id) => exam.questions.find((q) => q.id === id);
  main.querySelectorAll('[data-gq]').forEach((b) => b.onclick = () => gradeDetail(main, byId(Number(b.dataset.gq))));
  main.querySelectorAll('[data-gjump]').forEach((b) => b.onclick = () => {
    const id = Number(b.dataset.gjump);
    if (!markAt(main, id)) gradeDetail(main, byId(id));
  });
  const all = $('#gall', main);
  if (all) all.onclick = () => { gAll = !gAll; draw(main); };
  const ga = $('#gask', main);
  if (ga) ga.onclick = () => confirmAsks(main, 0);
  const go = async (redo) => {
    const ids = [...gsel];
    if (!ids.length) { toast('沒有要訂正的題目，太棒了！🎉', 'ok'); return; }
    try {
      if (inBankNow()) await post('/api/questions/bulk', { ids, action: 'set', data: { is_wrong: 1, mastered: 0, next_review: localDay() } });
      if (!redo) { toast(`${ids.length} 題已加入錯題本`, 'ok'); return; }
      const qs = exam.questions.filter((q) => ids.includes(q.id) && q.solved);
      if (!qs.length) { toast('這幾題的答案還在整理，等一下再做'); return; }
      await quiz(qs, { mode: 'practice', title: `訂正：${exam.title}`, source: `exam:${exam.id}` });
      load(main, exam.id);
    } catch (e) { errToast(e); }
  };
  const again = $('#gagain', main);
  if (again) again.onclick = () => gradeMenu(main);
  const r = $('#gredo', main), s = $('#gsave', main);
  if (r) r.onclick = () => go(true);
  if (s) s.onclick = () => go(false);
}


// ✅ 批改 for an exam already in the bank: with the answers she wrote when it was photographed, or
// after she did the paper again (photograph the new answers; they are matched to these questions)
function gradeMenu(main) {
  if (exam.status !== 'ready' && (exam.options || {}).mode === 'grade') { toast('AI 還在看照片，看完就會自動批改，好了會通知你'); return; }
  const had = exam.questions.filter((q) => (q.student_answer || '').trim()).length;
  modal({
    title: '批改這一份',
    body: `<div class="grade-ways">
      ${had ? `<button class="btn block soft lg" id="gwold">用拍照時寫的答案批改<span class="small" style="font-weight:400;margin-left:6px">（${had} 題有作答）</span></button>` : ''}
      <label class="btn block ok lg"><input type="file" accept="image/*" capture="environment" multiple id="gwnew" hidden>📷 重新寫完，拍照批改</label>
      <label class="btn block ghost"><input type="file" accept="image/*,.heic,.heif" multiple id="gwpick" hidden>從相簿選照片批改</label>
      <p class="small muted" style="margin:6px 0 0">重寫時可以先印出「題目卷」再寫。拍照時每頁拍一張，AI 會對照這份的題目找到每一題的答案。</p></div>`,
    onOpen: (m, close) => {
      const run = async (promise) => {
        close();
        const { runJob } = await import('./common.js');
        const res = await runJob(promise, 'AI 批改中…');
        if (res) { toast(`批改好了：對 ${res.correct || 0} 題${(res.wrong || 0) + (res.partial || 0) ? `、要訂正 ${(res.wrong || 0) + (res.partial || 0)} 題` : '，全對！'}`, 'ok'); }
        load(main, exam.id);
      };
      const old = m.querySelector('#gwold');
      if (old) old.onclick = () => run(post(`/api/exams/${exam.id}/grade`));
      const photos = async (e) => {
        const files = [...e.target.files];
        if (!files.length) return;
        const { shrink } = await import('./scan.js');
        const fd = new FormData();
        for (const f of files) { const x = await shrink(f); fd.append('files', x, x.name); }
        run(api(`/api/exams/${exam.id}/grade/photos`, { method: 'POST', form: fd }));
      };
      m.querySelector('#gwnew').onchange = photos;
      m.querySelector('#gwpick').onchange = photos;
    },
  });
}
