// 爸媽指派的任務: one tap starts it — the concept lesson first when the task has one,
// then the questions; finishing it gives the reward and tells the parent.
import { get, post } from '../api.js';
import { $, errToast, esc, html, icon, showReward } from '../ui.js';

const KIND = { lesson: '觀念＋練習', redo: '重做錯題', similar: '舉一反三', paper: '紙本複習卷' };

export async function render(main, [id]) {
  const p = await get(`/api/papers/${id}`);
  const t = (p.config || {}).task || {};
  const qs = (p.questions || []).filter((q) => q.solved);
  const done = p.status === 'done';
  const prog = await get(`/api/practice/progress?source=${encodeURIComponent('task:' + id)}`).catch(() => ({ right: [], rounds: [] }));
  html(main, `
    <div class="page-head"><a href="#/" class="back" aria-label="返回">${icon('back', 22)}</a>
      <div class="grow"><h1>${esc(p.title)}</h1><div class="sub">爸媽指派${p.due_date ? `・${p.due_date.slice(5).replace('-', '/')} 前完成` : ''}</div></div></div>
    <div class="card" style="max-width:560px">
      ${t.message ? `<div class="card tight pri-soft" style="font-size:16px">「${esc(t.message)}」</div>` : ''}
      <div class="stat-tiles" style="margin:12px 0">
        <div><b>${prog.right.length}/${qs.length}</b><span>已答對</span></div>
        <div><b style="font-size:17px">${esc(KIND[t.kind] || '作業')}</b><span>方式</span></div>
        <div><b class="warm-ink">${t.reward || 15}</b><span>完成得金幣</span></div>
      </div>
      ${t.generating ? '<p class="small muted"><span class="spinner" style="width:14px;height:14px;border-width:2px"></span> AI 還在出類似題，先做錯題，新題目做到時就會出現。</p>' : ''}
      ${done ? '<div class="card tight ok-soft">這個任務已經完成了，很棒！可以再練一次。</div>' : ''}
      <button class="btn block lg" id="go" ${qs.length ? '' : 'disabled'}>${icon('play', 18)} ${t.kind === 'paper' ? '印出來寫' : t.kind === 'lesson' && p.lesson ? '先看觀念，再開始' : '開始'}</button>
      ${t.kind === 'paper' ? '<button class="btn ghost block" id="fin" style="margin-top:8px">我寫完了</button>' : ''}
    </div>`);
  const finish = async () => {
    try { const r = await post(`/api/papers/${id}/complete`); if (r.reward) showReward(r.reward); } catch (e) { errToast(e); }
  };
  $('#go').onclick = async () => {
    if (t.kind === 'paper') {
      const { quickPrint } = await import('./papers.js');
      quickPrint({ title: p.title, question_ids: p.question_ids, config: { ...(p.config || {}), task: undefined } });
      return;
    }
    const { startQuiz } = await import('./quiz.js');
    const fresh = t.generating ? (await get(`/api/papers/${id}`)).questions.filter((q) => q.solved) : qs;
    const right = new Set(prog.right);
    const left = fresh.filter((x) => !right.has(x.id));  // what she already got right is not asked again
    await startQuiz(left.length ? left : fresh, { mode: 'review', title: p.title, conceptFirst: true, lesson: t.kind === 'lesson' && !prog.rounds.length ? p.lesson : null,
      track: { source: 'task:' + id, title: p.title },
      onFinish: async () => { if (!done) await finish(); return null; } });
    render(main, [id]);
  };
  const fin = $('#fin');
  if (fin) fin.onclick = async () => { await finish(); render(main, [id]); };
}
