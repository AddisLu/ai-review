// 選題: a compact list of questions to pick from (題庫 search, one exam's questions), with a bar
// for what to do with the picked ones — 直接練習, 列印, 指派 (parents). Tapping a row picks it; the
// › on the right opens the question itself.
import { get, parentNow, post, state } from '../api.js';
import { confirmBox, errToast, esc, icon, localDay, modal, rich, toast } from '../ui.js';
import { WRONG_PAPER, makePaper } from './common.js';

const SHORT = 90;
// the start of a question, cut without breaking a $formula$ or a {字|注音} in half
export function shortStem(s, n = SHORT) {
  s = String(s || '').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
  if (s.length <= n) return s;
  let cut = s.slice(0, n);
  if ((cut.match(/\$/g) || []).length % 2) cut = cut.slice(0, cut.lastIndexOf('$'));
  const open = cut.lastIndexOf('{');
  if (open > cut.lastIndexOf('}')) cut = cut.slice(0, open);
  return cut + '…';
}

function tags(q) {
  const t = [];
  if (q.is_wrong && !q.mastered) t.push(`<span class="pk-tag bad">錯${q.wrong_count > 1 ? ` ×${q.wrong_count}` : ''}</span>`);
  else if (q.mastered) t.push('<span class="pk-tag ok">已學會</span>');
  if (q.teacher_mark === 'wrong' || q.teacher_mark === 'partial') t.push('<span class="pk-tag red" title="考卷上老師打叉">老師✗</span>');
  if (q.is_highlighted) t.push('<span class="pk-tag hl">螢光筆</span>');
  if (q.is_marked) t.push('<span class="pk-tag warn">記號</span>');
  if (q.is_favorite) t.push('<span class="pk-tag">♥</span>');
  if (q.source === 'similar' || q.source === 'ai') t.push('<span class="pk-tag gray">AI 出的</span>');
  return t.join('');
}

export function rowHtml(q, exams = {}, sel = new Set()) {
  const ex = exams[q.exam_id];
  return `<div class="pk-row ${sel.has(q.id) ? 'on' : ''}" data-pk="${q.id}" role="checkbox" aria-checked="${sel.has(q.id)}" tabindex="0">
    <span class="pk-box">${sel.has(q.id) ? icon('check', 16) : ''}</span>
    <span class="pk-sub" data-subj="${esc(q.subject || '')}" title="${esc(q.subject || '')}">${esc((q.subject || '？').slice(0, 1))}</span>
    <span class="pk-main">
      <span class="pk-stem${q.vertical ? ' pk-v' : ''}">${q.number ? `<b>${esc(q.number)}.</b> ` : ''}${rich(shortStem(q.stem))}</span>
      <span class="pk-meta">${ex ? `<span class="pk-ex">${esc(ex.title)}</span>` : q.source === 'manual' ? '<span class="pk-ex">自己加的題目</span>' : ''}
        <span>${esc(q.qtype || '')}${q.chapter_label || q.unit ? '・' + esc(q.chapter_label || q.unit) : ''}</span>${tags(q)}</span>
    </span>
    <a class="pk-open" href="#/q/${q.id}" aria-label="打開這一題" title="打開這一題">${icon('chev', 18)}</a>
  </div>`;
}

// Selection + the action bar. `get()` → the current list; `title` names a paper made from them.
export function bindPicker(root, { list, sel, title, onChange, extra = [], onDelete = null }) {
  // drawn again into the same root (a tab redrawn): drop the old bar and handlers first
  if (root._pk) { root._pk.bar.remove(); root.removeEventListener('click', root._pk.click); root.removeEventListener('keydown', root._pk.key); }
  const bar = document.createElement('div');
  bar.className = 'pk-bar hidden';
  bar.innerHTML = `<span class="pk-count"></span>
    <button class="btn ok" data-pa="practice">${icon('play', 16)} 直接練習</button>
    <button class="btn soft" data-pa="print">${icon('print', 16)} 列印</button>
    ${state.status.user.role === 'parent' ? `<button class="btn soft" data-pa="assign">${icon('send', 16)} 指派</button>` : ''}
    ${extra.map((x, i) => `<button class="btn soft sm" data-px="${i}">${x.label}</button>`).join('')}
    ${onDelete && parentNow() ? `<button class="btn ghost sm" data-pa="delete" style="color:var(--bad)">${icon('trash', 15)} 刪除</button>` : ''}
    <button class="btn link sm" data-pa="clear">取消選取</button>`;
  root.appendChild(bar);
  const draw = () => {
    bar.classList.toggle('hidden', !sel.size);
    bar.querySelector('.pk-count').textContent = `已選 ${sel.size} 題`;
    onChange && onChange();
  };
  const click = (e) => {
    if (e.target.closest('.pk-open') || e.target.closest('.pk-bar')) return;
    const row = e.target.closest('[data-pk]');
    if (!row) return;
    const id = Number(row.dataset.pk);
    sel.has(id) ? sel.delete(id) : sel.add(id);
    row.classList.toggle('on', sel.has(id));
    row.setAttribute('aria-checked', String(sel.has(id)));
    row.querySelector('.pk-box').innerHTML = sel.has(id) ? icon('check', 16) : '';
    draw();
  };
  const key = (e) => { if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-pk]')) { e.preventDefault(); e.target.click(); } };
  root.addEventListener('click', click);
  root.addEventListener('keydown', key);
  root._pk = { bar, click, key };
  bar.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-px]');
    if (x) return extra[Number(x.dataset.px)].run([...sel]);
    const a = e.target.closest('[data-pa]');
    if (!a) return;
    const ids = [...sel];
    if (a.dataset.pa === 'clear') { sel.clear(); root.querySelectorAll('.pk-row.on').forEach((r) => { r.classList.remove('on'); r.querySelector('.pk-box').innerHTML = ''; }); draw(); return; }
    if (a.dataset.pa === 'practice') return practise(ids, title());
    if (a.dataset.pa === 'print') return makePaper(ids, title(), list().some((q) => q.is_wrong) ? { ...WRONG_PAPER, template: 'wrong' } : null);
    if (a.dataset.pa === 'assign') return assign(ids, title());
    if (a.dataset.pa === 'delete') {
      if (!await confirmBox(`從題庫刪除選取的 ${ids.length} 題？<br><span class="small muted">題目、詳解和每個孩子的作答紀錄都會刪掉，不能復原。</span>`, '刪除', true)) return;
      try {
        const r = await post('/api/questions/bulk', { ids, action: 'delete' });
        toast(`已刪除 ${r.deleted ?? ids.length} 題`, 'ok');
        sel.clear(); draw();
        onDelete(ids);
      } catch (err) { errToast(err); }
    }
  });
  draw();
  return { draw };
}

export async function practise(ids, title = '練習') {
  const qs = (await get(`/api/questions?ids=${ids.join(',')}&limit=300`)).items.filter((q) => q.solved);
  if (!qs.length) { toast('這些題目的答案還在整理中，等一下再試'); return; }
  if (qs.length < ids.length) toast(`${ids.length - qs.length} 題答案還在整理，先練 ${qs.length} 題`);
  const { startQuiz } = await import('./quiz.js');
  await startQuiz(qs, { mode: 'practice', title });
}

export async function assign(ids, title) {
  const kid = (state.status.students || []).find((s) => s.id === state.studentId);
  modal({
    title: `指派給${kid ? kid.name : '孩子'}`,
    body: `<p class="small muted" style="margin-top:0">「${esc(title)}」・${ids.length} 題，會出現在孩子的「今天」。</p>
      <label class="field"><span>什麼時候前完成</span><input type="date" id="pkdue" value="${localDay(2)}"></label>
      <label class="field"><span>給孩子的話（可不寫）</span><input type="text" id="pkmsg" placeholder="例如：這幾題再做一次，加油！"></label>
      <button class="btn block lg" id="pkgo">指派</button>`,
    onOpen: (m, close) => {
      m.querySelector('#pkgo').onclick = async () => {
        try {
          await post('/api/tasks', { ids, title, n: Math.min(30, ids.length), kind: 'redo', due_date: m.querySelector('#pkdue').value, message: m.querySelector('#pkmsg').value, reward: 20 });
          close(); toast('已指派', 'ok');
        } catch (err) { toast(err.message, 'bad'); }
      };
    },
  });
}
