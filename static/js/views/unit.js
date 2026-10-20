import { get, post, qs, state, waitJob } from '../api.js';

const making = new Set();
import { $, barModelSvg, busy, errToast, esc, html, icon, rich, subjectIcon, toast } from '../ui.js';
import { visualHtml } from '../visuals.js';
import { questionCard, bindQuestionCards, makePaper, runJob } from './common.js';
import { startQuiz } from './quiz.js';

export async function render(main, [subject, grade, unit]) {
  grade = Number(grade);
  const [k, bank] = await Promise.all([
    get('/api/knowledge' + qs({ subject, unit, grade })),
    get('/api/questions' + qs({ subject, unit, limit: 100 })),
  ]);
  const c = k && k.content;
  const wrong = bank.items.filter((q) => q.is_wrong && !q.mastered);
  html(main, `
  <div class="page-head"><a href="#/learn" class="back" aria-label="返回">${icon('back', 22)}</a>
    <div class="grow"><h1>${subjectIcon(subject)} ${esc(unit)}</h1><div class="sub">${esc(subject)}・${grade} 年級</div></div>
    </div>

  <div class="level-cards" id="levels"></div>
  <div class="stat-tiles">
    <div><b>${bank.total}</b><span>題庫題數</span></div>
    <div><b style="color:var(--bad)">${wrong.length}</b><span>待精熟錯題</span></div>
    <div><b>${bank.items.filter((q) => q.mastered).length}</b><span>已精熟</span></div>
  </div>

  ${c ? knowledgeHtml(c) : state.status.ai_ready ? `<div class="card center" id="kwait"><span class="spinner"></span>
    <h2 style="margin-top:10px">AI 老師正在整理這個單元的重點</h2>
    <p class="sub">重點觀念、公式、常考題型、易錯點和口訣，大約 30–60 秒。可以先往下闖關，整理好會自動出現。</p></div>`
    : `<div class="card center"><h2>還沒有這個單元的重點整理</h2><p class="sub">AI 連線後會自動整理。</p></div>`}

  <div class="card">
    <div class="row"><h2 style="margin:0">這個單元的題目</h2><span class="spacer"></span>
      <button class="btn sm soft" id="genq">AI 出 5 題練習</button>
      ${bank.items.length ? '<button class="btn sm ghost" id="paper">組成單元卷</button>' : ''}</div>
    <div id="ulist" style="margin-top:12px">${bank.items.length ? bank.items.slice(0, 30).map((q) => questionCard(q)).join('')
      : '<p class="sub">還沒有題目：掃描考卷時 AI 會自動分類到這裡，也可以讓 AI 出題。</p>'}</div>
  </div>`);

  if (c) bindKnowledge(main);
  // no summary yet: make one in the background, nobody has to ask
  const key = `${subject}|${grade}|${unit}`;
  if (!c && state.status.ai_ready && !making.has(key)) {
    making.add(key);
    post('/api/knowledge/generate', { subject, grade, unit })
      .then((r) => waitJob(r.job_id))
      .then(() => { if (main.isConnected && location.hash.startsWith('#/learn/')) render(main, [subject, grade, unit]); })
      .catch((e) => { const w = $('#kwait'); if (w && main.isConnected) w.innerHTML = `<p class="sub">重點整理暫時失敗：${esc(e.message)}</p>`; })
      .finally(() => making.delete(key));
  }
  const regen = $('#regenk');
  if (regen) regen.onclick = async () => {
    const r = await runJob(post('/api/knowledge/generate', { subject, grade, unit }), 'AI 重新整理中…');
    if (r) render(main, [subject, grade, unit]);
  };
  $('#genq').onclick = async () => {
    const r = await runJob(post('/api/generate', { subject, grade, unit, n: 5 }), 'AI 出題中…');
    if (r) { toast(`出好 ${r.question_ids.length} 題`, 'ok'); render(main, [subject, grade, unit]); }
  };
  const pb = $('#paper');
  if (pb) pb.onclick = () => makePaper(bank.items.map((q) => q.id), `${unit} 單元複習卷`);
  bindQuestionCards($('#ulist'), (id) => bank.items.find((q) => q.id === id), () => render(main, [subject, grade, unit]));

  const here = location.hash;
  // 分級闖關: 基礎 → 進階 → 挑戰 (advanced is suggested after 2 stars on basic)
  const levels = await get('/api/units/levels' + qs({ subject, unit }));
  const starsOf = (k) => (levels.find((l) => l.level === k) || {}).stars || 0;
  const LDESC = { basic: '必須會的題目', advanced: '多步驟、綜合題', challenge: '變形題、陷阱題' };
  html($('#levels'), levels.map((l, i) => {
    const locked = i > 0 && starsOf(levels[i - 1].level) < 2;
    return `<div class="level-card ${locked ? 'locked' : ''}">
      <div class="row nowrap"><b style="flex:1;font-size:17px">${l.name}</b><span class="stars" aria-label="${l.stars} 顆星">${[1, 2, 3].map((k) => (l.stars >= k ? '★' : '☆')).join('')}</span></div>
      <span class="small muted">${LDESC[l.level]}・題庫 ${l.questions} 題</span>
      ${locked ? `<span class="small" style="color:var(--warm-ink)">建議先在「${levels[i - 1].name}」拿到 2 顆星</span>` : ''}
      <button class="btn ${i === 0 || !locked ? '' : 'ghost'}" data-level="${l.level}">${l.questions >= 5 ? '闖關 5 題' : l.questions ? `闖關 5 題（AI 補 ${5 - l.questions} 題）` : '闖關 5 題（AI 出題）'}</button></div>`;
  }).join(''));
  // start writing 基礎 questions now, while she reads the page — the tap then just picks them up
  if (state.status.ai_ready && (levels[0] || {}).questions < 5) post('/api/units/prepare', { subject, grade, unit, level: 'basic' }).catch(() => {});
  main.querySelectorAll('[data-level]').forEach((b) => b.onclick = async () => {
    const level = b.dataset.level;
    let set = await get('/api/units/practice' + qs({ subject, unit, grade, n: 5, level }));
    let more = null;
    if (set.length < 5 && state.status.ai_ready) {
      // joins the job already running for this level; starts as soon as 2 questions exist,
      // the rest arrive while she answers
      const fetchSet = () => get('/api/units/practice' + qs({ subject, unit, grade, n: 5, level }));
      const b = busy('AI 正在出第一批題目（約 20 秒）…');
      try {
        const { job_id: jid } = await post('/api/units/prepare', { subject, grade, unit, level });
        const running = async () => jid && ['queued', 'running'].includes((await get(`/api/jobs/${jid}`)).status);
        while (set.length < 2 && !b.left && await running()) {
          await new Promise((ok) => setTimeout(ok, 1500));
          set = await fetchSet();
        }
        if (set.length < 2) set = await fetchSet();
        if (jid && set.length < 5) more = async () => ({ items: await fetchSet(), done: !await running() });
      } catch (e) { errToast(e); }
      b.close();
      if (b.left) return;  // she went to another page: no quiz popping up over it
    }
    if (!set.length) { errToast(new Error('這一級還沒有題目')); return; }
    await startQuiz(set, {
      target: 5, more,
      mode: 'unit', title: `${unit}・${b.closest('.level-card').querySelector('b').textContent}`, conceptFirst: level !== 'challenge',
      onFinish: (s2) => post('/api/units/finish', { subject, grade, unit, level, correct: s2.correct, total: s2.total }),
    });
    if (location.hash === here) render(main, [subject, grade, unit]);
  });
}

export function knowledgeHtml(c) {
  return `
  <div class="card kcard">
    <div class="row"><h2 style="margin:0">${esc(c.title)}・重點整理</h2><span class="spacer"></span>
      <button class="icon-btn" id="regenk" title="重新產生" aria-label="重新產生">${icon('redo', 18)}</button>
      <button class="icon-btn" onclick="window.print()" title="列印" aria-label="列印">${icon('print', 18)}</button></div>
    <p style="font-size:17px">${rich(c.intro)}</p>
    <div class="grid g2">${(c.key_points || []).map((p, i) => `<div class="explain"><h4>${i + 1}. ${rich(p.title)}</h4><div>${rich(p.content)}</div>${p.visual ? visualHtml(p.visual) : ''}</div>`).join('')}</div>
  </div>
  ${c.formulas && c.formulas.length ? `<div class="card kcard"><h2>公式・規則卡</h2><div class="grid g2">
    ${c.formulas.map((f) => `<div class="formula"><b>${rich(f.name)}</b><div class="f">${rich(f.formula)}</div>
      <div>${rich(f.meaning)}</div><div class="small muted" style="margin-top:4px">例：${rich(f.example)}</div></div>`).join('')}</div></div>` : ''}
  ${barModelSvg(c.bar_model) ? `<div class="card">${barModelSvg(c.bar_model)}</div>` : ''}
  ${c.question_types && c.question_types.length ? `<div class="card kcard"><h2>常考題型解析</h2>
    ${c.question_types.map((t, i) => `<details class="explain" ${i === 0 ? 'open' : ''}><summary style="cursor:pointer;font-weight:800">題型 ${i + 1}：${rich(t.name)}</summary>
      <h4>怎麼認出來</h4><div>${rich(t.how_to_spot)}</div>
      <h4>解題步驟</h4><ol class="steps">${(t.steps || []).map((s) => `<li>${rich(s)}</li>`).join('')}</ol>
      <h4>例題</h4><div>${rich(t.example_question)}</div>
      <details style="margin-top:6px"><summary style="cursor:pointer">看解答</summary><div style="margin-top:6px">${rich(t.example_solution)}</div></details>
    </details>`).join('')}</div>` : ''}
  ${c.mistakes && c.mistakes.length ? `<div class="card kcard"><h2>小心這些錯誤</h2>
    ${c.mistakes.map((m) => `<div class="mist" style="margin-bottom:8px"><div class="w">${rich(m.wrong)}</div><div class="r">${rich(m.right)}</div></div>
      <div class="small muted" style="margin:-2px 0 12px">${rich(m.why)}</div>`).join('')}</div>` : ''}
  <div class="grid g2">
    ${c.mnemonics && c.mnemonics.length ? `<div class="card"><h3>記憶口訣</h3>${c.mnemonics.map((x) => `<p>「${rich(x)}」</p>`).join('')}</div>` : ''}
    ${c.real_life ? `<div class="card"><h3>生活中的應用</h3><p>${rich(c.real_life)}</p></div>` : ''}
  </div>`;
}

function bindKnowledge() { /* details elements work natively */ }
