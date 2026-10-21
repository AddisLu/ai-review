import { get, post, qs, state } from '../api.js';
import { $$, $, confirmBox, debounce, esc, html, icon, modal, subjectIcon, toast } from '../ui.js';
import { bindQuestionCards, editQuestion, makePaper, questionCard } from './common.js';

const F = {
  subject: '', unit: '', qtype: '', flags: '', flags_any: '', q: '', sort: 'new', source: '', hide_generated: '1',
  scope: '', min_grade: '', max_grade: '', level: '',
};
const LV = [['basic', '基礎', '必須會'], ['advanced', '進階', '多步驟'], ['challenge', '挑戰', '變形題']];
let gradeInit = false;
let items = [], sel = new Set(), view = 'matrix';

const PRESETS = [
  ['錯題本', { flags: 'unmastered', flags_any: '' }],
  ['已精熟', { flags: 'mastered', flags_any: '' }],
  ['螢光筆題', { flags: 'highlighted', flags_any: '' }],
  ['記號題', { flags: 'marked', flags_any: '' }],
  ['重點題', { flags: '', flags_any: 'highlighted,marked,wrong' }],
  ['收藏', { flags: 'favorite', flags_any: '' }],
  ['全部題目', { flags: '', flags_any: '' }],
];

// #/bank: 已拍的考卷 (the 書櫃) first; #/bank?view=q: 找題目; #/bank?view=analysis: 弱點分析;
// #/bank?… with filters (subject, unit, view=list…): every question, filtered
export async function render(main) {
  const hashQ = new URLSearchParams(location.hash.split('?')[1] || '');
  if (hashQ.get('view') === 'analysis') return (await import('./bankhome.js')).render(main);
  if (![...hashQ.keys()].length || hashQ.get('view') === 'exams') return (await import('./exams.js')).render(main);  // 已拍的考卷
  return (await import('./banksearch.js')).render(main);  // 題庫: search first
}

async function renderList(main, hashQ) {
  sel = new Set();
  for (const k of Object.keys(F)) if (hashQ.has(k)) F[k] = hashQ.get(k);
  if (![...hashQ.keys()].some((k) => k in F) && !F.flags && !F.flags_any) F.flags = 'unmastered';
  const subjects = Object.keys(state.status.subjects || {});
  if (!gradeInit) {
    gradeInit = true;
    // kids see their own level by default; the bank itself is shared by the family
    if (state.status.user.role !== 'parent' && state.me) { F.min_grade = String(state.me.grade - 1); F.max_grade = String(state.me.grade); }
  }
  html(main, `
  <div class="page-head"><a href="#/bank" class="back" aria-label="回到錯題">${icon('back', 22)}</a><div class="grow"><h1>錯題本・題庫</h1>
    <div class="sub">所有掃描過的題目都在這裡：依科目、單元、題型自動分類，錯題會依照「遺忘曲線」安排複習</div></div>
    <button class="btn soft" onclick="location.hash='#/practice/review'">開始複習</button>
    <button class="btn ghost" id="newq">手動新增</button>
  </div>
  <div class="card tight">
    <div class="chips" id="presets">${PRESETS.map(([l, p], i) => `<button class="chip" data-p="${i}">${l}</button>`).join('')}</div>
    <div class="grid g4" style="margin-top:10px">
      <select id="fsub"><option value="">全部科目</option>${subjects.map((s) => `<option ${F.subject === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="ftype"><option value="">全部題型</option>${state.status.qtypes.map((t) => `<option ${F.qtype === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="fsort">
        ${[['new', '最新加入'], ['wrong', '我錯最多次'], ['old', '最早加入'], ['unit', '依單元排序'], ['exam', '依考卷']].map(([v, l]) => `<option value="${v}" ${F.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input type="search" id="fq" placeholder="搜尋題目、備註" value="${esc(F.q)}">
    </div>
    <div class="row" style="margin-top:8px">
      <div class="seg" style="margin:0;width:auto"><button data-scope="" class="${F.scope ? '' : 'on'}">全家題庫</button><button data-scope="mine" class="${F.scope ? 'on' : ''}">我加入的</button></div>
      <select id="fgrade" style="width:auto">${[['', '全部年級'], ...[3, 4, 5, 6].map((g) => [`${g - 1}-${g}`, `${g} 年級程度`])].map(([v, l]) =>
        `<option value="${v}" ${(F.min_grade ? `${F.min_grade}-${F.max_grade}` : '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="row" style="margin-top:8px">
      <label class="check small"><input type="checkbox" id="fgen" ${F.hide_generated === '1' ? '' : 'checked'}> 包含 AI 出的練習題</label>
      <span class="spacer"></span>
      <div class="chips"><button class="chip ${view === 'matrix' ? 'on' : ''}" data-v="matrix">單元 × 級別</button><button class="chip ${view === 'list' ? 'on' : ''}" data-v="list">題目清單</button></div>
    </div>
    ${F.unit || F.level ? `<div style="margin-top:8px"><span class="tag">${F.unit ? '單元：' + esc(F.unit) : ''}${F.level ? '　' + (LV.find((l) => l[0] === F.level) || [])[1] : ''} <a href="javascript:void 0" id="clrunit">✕</a></span></div>` : ''}
  </div>
  <div id="content"></div>
  <div class="sticky-bar hidden" id="bar"><b></b><span class="spacer"></span>
    <button class="btn sm" id="bpaper">組卷列印</button>
    <button class="btn sm ghost" id="bquiz">練習這些題</button>
    <button class="btn sm ghost" id="bmaster">標為已精熟</button>
    <button class="btn sm ghost" id="bsolve">重新產生詳解</button>
    ${state.status.user.role === 'parent' ? '<button class="btn sm ghost" id="bshare">加入錯題本給…</button>' : ''}
    <button class="btn sm ghost" id="bdel" aria-label="刪除">${icon('trash', 16)}</button>
    <button class="btn sm ghost" id="bclear">取消</button></div>`);

  markPreset();
  $$('#presets [data-p]').forEach((b) => b.onclick = () => {
    Object.assign(F, PRESETS[b.dataset.p][1]);
    view = 'list';
    $$('[data-v]').forEach((x) => x.classList.toggle('on', x.dataset.v === 'list'));
    markPreset();
    load();
  });
  $('#fsub').onchange = (e) => { F.subject = e.target.value; F.unit = ''; load(); };
  $('#ftype').onchange = (e) => { F.qtype = e.target.value; load(); };
  $('#fsort').onchange = (e) => { F.sort = e.target.value; load(); };
  $('#fq').oninput = debounce((e) => { F.q = e.target.value; load(); });
  $$('[data-scope]').forEach((b) => b.onclick = () => { F.scope = b.dataset.scope; render(main); });
  $('#fgrade').onchange = (e) => { [F.min_grade, F.max_grade] = e.target.value ? e.target.value.split('-') : ['', '']; load(); };
  $('#fgen').onchange = (e) => { F.hide_generated = e.target.checked ? '' : '1'; load(); };
  $$('[data-v]').forEach((b) => b.onclick = () => { view = b.dataset.v; $$('[data-v]').forEach((x) => x.classList.toggle('on', x === b)); load(); });
  const cu = $('#clrunit');
  if (cu) cu.onclick = () => { F.unit = ''; F.level = ''; render(main); };
  $('#newq').onclick = async () => {
    const id = await editQuestion({}, { isNew: true, defaults: { subject: F.subject || '數學', is_wrong: 1 } });
    if (id) load();
  };
  $('#bpaper').onclick = () => makePaper([...sel], '錯題複習卷');
  $('#bquiz').onclick = async () => {
    const { startQuiz } = await import('./quiz.js');
    startQuiz(items.filter((q) => sel.has(q.id) && q.solved), { mode: 'review', title: '錯題練習' });
  };
  $('#bmaster').onclick = async () => { await post('/api/questions/bulk', { ids: [...sel], action: 'set', data: { mastered: 1 } }); toast('已標記', 'ok'); sel.clear(); load(); };
  $('#bsolve').onclick = async () => {
    const { runJob } = await import('./common.js');
    await runJob(post('/api/questions/bulk', { ids: [...sel], action: 'solve' }), 'AI 產生詳解中…');
    load();
  };
  $('#bdel').onclick = async () => {
    if (!await confirmBox(`刪除 ${sel.size} 題？`, '刪除', true)) return;
    await post('/api/questions/bulk', { ids: [...sel], action: 'delete' });
    sel.clear(); load();
  };
  $('#bclear').onclick = () => { sel.clear(); load(); };
  const share = $('#bshare');
  if (share) share.onclick = () => modal({
    title: '加入錯題本給',
    body: `<p class="sub">題庫是全家共用的；選一位孩子，把這 ${sel.size} 題放進她的錯題本，系統會安排她複習。</p>
      <div class="group">${(state.status.students || []).filter((x) => x.role !== 'parent').map((x) =>
        `<button class="gi" data-to="${x.id}" style="width:100%;background:none;border:0;border-bottom:1px solid var(--hair);text-align:left;cursor:pointer"><span style="font-size:22px">${x.avatar}</span><span class="t">${esc(x.name)}・${x.grade} 年級</span></button>`).join('')}</div>`,
    onOpen: (m, close) => m.querySelectorAll('[data-to]').forEach((b) => b.onclick = async () => {
      const r = await post('/api/questions/bulk', { ids: [...sel], action: 'add_to_wrong', student_id: Number(b.dataset.to) });
      close();
      toast(`已加入 ${r.added} 題`, 'ok');
    }),
  });
  load();
}

function markPreset() {
  $$('#presets [data-p]').forEach((b) => {
    const p = PRESETS[b.dataset.p][1];
    b.classList.toggle('on', p.flags === F.flags && p.flags_any === F.flags_any);
  });
}

async function load() {
  const el = $('#content');
  if (!el) return;
  if (view === 'tree') return loadTree(el);
  if (view === 'matrix') return loadMatrix(el);
  const r = await get('/api/questions' + qs({ ...F, limit: 300 }));
  items = r.items;
  html(el, `<div class="row" style="margin:6px 0 10px"><span class="sub">共 ${r.total} 題</span><span class="spacer"></span>
    <button class="btn sm ghost" id="selall">全選</button></div>
    ${items.length ? items.map((q) => questionCard(q, { selectable: true, selected: sel.has(q.id) })).join('')
      : '<div class="empty">這裡沒有題目</div>'}`);
  el.querySelectorAll('[data-sel]').forEach((b) => b.onchange = () => {
    const id = Number(b.dataset.sel);
    b.checked ? sel.add(id) : sel.delete(id);
    b.closest('.q-card').classList.toggle('sel', b.checked);
    bar();
  });
  $('#selall').onclick = () => { items.forEach((q) => sel.add(q.id)); load(); };
  bindQuestionCards(el, (id) => items.find((q) => q.id === id), load);
  bar();
}

function bar() {
  const b = $('#bar');
  if (!b) return;
  b.classList.toggle('hidden', !sel.size);
  b.querySelector('b').textContent = `已選 ${sel.size} 題`;
}

async function loadTree(el) {
  const rows = await get('/api/questions/groups' + qs({ ...F, unit: '' }));
  const tree = {};
  rows.forEach((r) => {
    const s = (tree[r.subject || '未分類'] ||= { n: 0, wrong: 0, units: {} });
    s.n += r.n; s.wrong += r.wrong;
    const u = (s.units[r.unit || '未分類單元'] ||= { n: 0, wrong: 0, types: [] });
    u.n += r.n; u.wrong += r.wrong;
    u.types.push(r);
  });
  html(el, Object.keys(tree).length ? `<div class="card group-tree">${Object.entries(tree).map(([s, sv]) => `
    <details open><summary>${subjectIcon(s)} ${esc(s)} <span class="tag gray">${sv.n} 題</span>${sv.wrong ? `<span class="tag bad">錯 ${sv.wrong}</span>` : ''}</summary>
      ${Object.entries(sv.units).map(([u, uv]) => `
        <details><summary style="padding-left:20px">${esc(u)} <span class="tag gray">${uv.n}</span>${uv.wrong ? `<span class="tag bad">錯 ${uv.wrong}</span>` : ''}
          <span class="spacer"></span><button class="btn sm ghost" data-unit="${esc(u)}" data-subj="${esc(s)}">看全部</button></summary>
          ${uv.types.map((t) => `<div class="sub-row" data-unit="${esc(u)}" data-subj="${esc(s)}" data-type="${esc(t.qtype)}">
            <span>• ${esc(t.qtype || '其他')}</span><span class="tag gray">${t.n}</span>
            ${t.wrong ? `<span class="tag bad">錯 ${t.wrong}</span>` : ''}${t.highlighted ? `<span class="tag hl">${t.highlighted}</span>` : ''}
            ${t.marked ? `<span class="tag warn">${t.marked}</span>` : ''}</div>`).join('')}
        </details>`).join('')}
    </details>`).join('')}</div>` : '<div class="empty">沒有符合的題目</div>');
  el.querySelectorAll('[data-unit]').forEach((r) => r.onclick = (e) => {
    e.preventDefault();
    F.subject = r.dataset.subj === '未分類' ? '' : r.dataset.subj;
    F.unit = r.dataset.unit === '未分類單元' ? '' : r.dataset.unit;
    F.qtype = r.dataset.type || '';
    view = 'list';
    render(document.getElementById('main'));
  });
}


// 題庫 as a simple grid: one row per unit, one column per level; numbers and
// the child's own progress only — open a cell to see the questions.
async function loadMatrix(el) {
  const rows = await get('/api/bank/matrix' + qs({ subject: F.subject, min_grade: F.min_grade, max_grade: F.max_grade }));
  const dot = { mastered: 'ok', good: 'ok', practice: 'warn', weak: 'bad', none: '' };
  if (!rows.length) { el.innerHTML = '<div class="empty">題庫還沒有題目。掃描考卷或在學習地圖讓 AI 出題後就會出現。</div>'; return; }
  const bySubj = {};
  rows.forEach((r) => (bySubj[r.subject] ||= []).push(r));
  html(el, Object.entries(bySubj).map(([subj, us]) => `
    <div class="label" style="margin-top:14px">${esc(subj)}</div>
    <div class="card" style="padding:6px 10px;overflow-x:auto"><table class="matrix">
      <thead><tr><th>單元</th>${LV.map(([, n, d]) => `<th>${n}<span class="small muted" style="font-weight:400">・${d}</span></th>`).join('')}<th class="hide-sm"></th></tr></thead>
      <tbody>${us.map((u) => `<tr>
        <td class="u"><span class="status-dot ${dot[u.status_key]}"></span> ${esc(u.unit)}<div class="small muted">${esc(u.status)}</div></td>
        ${LV.map(([k]) => {
          const c = u.levels[k];
          return c ? `<td><button class="cell" data-cell="${esc(u.subject)}|${esc(u.unit)}|${k}"><b>${c.n}</b> 題
            <span class="small muted">${c.mastered ? `精熟 ${c.mastered}` : ''}${c.wrong ? `${c.mastered ? '・' : ''}<span style="color:var(--bad)">錯 ${c.wrong}</span>` : ''}${!c.mastered && !c.wrong ? (c.tried ? `練過 ${c.tried}` : '未練習') : ''}</span></button></td>`
            : `<td><button class="cell empty" data-gen="${esc(u.subject)}|${esc(u.unit)}|${k}">＋ AI 出題</button></td>`;
        }).join('')}
        <td class="hide-sm"><button class="btn sm ghost" data-practice="${esc(u.subject)}|${esc(u.unit)}">練習</button></td></tr>`).join('')}
      </tbody></table></div>`).join(''));
  el.querySelectorAll('[data-cell]').forEach((b) => b.onclick = () => {
    [F.subject, F.unit, F.level] = b.dataset.cell.split('|');
    F.flags = ''; F.flags_any = ''; F.hide_generated = '';
    view = 'list';
    render(document.getElementById('main'));
  });
  el.querySelectorAll('[data-gen]').forEach((b) => b.onclick = async () => {
    const [subject, unit, level] = b.dataset.gen.split('|');
    const { runJob } = await import('./common.js');
    const r = await runJob(post('/api/generate', { subject, unit, level, grade: (state.me && state.me.grade) || 6, n: 5 }), 'AI 出題中…');
    if (r) { toast(`出好 ${r.question_ids.length} 題`, 'ok'); loadMatrix(el); }
  });
  el.querySelectorAll('[data-practice]').forEach((b) => b.onclick = async () => {
    const [subject, unit] = b.dataset.practice.split('|');
    const r = await get('/api/questions' + qs({ subject, unit, limit: 10, sort: 'wrong' }));
    const { startQuiz } = await import('./quiz.js');
    startQuiz(r.items.filter((q) => q.solved), { mode: 'review', title: unit });
  });
}
