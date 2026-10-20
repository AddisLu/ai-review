import { get, post, state } from '../api.js';
import { $$, esc, html, icon, promptBox, toast } from '../ui.js';

let subject = '數學', grade = null;
const CN = '一二三四五六';
const TERM = (t) => (/^\d[上下]$/.test(t) ? `${CN[Number(t[0]) - 1]}年級${t[1]}學期` : t);

export async function render(main) {
  const subjects = Object.keys(state.status.subjects || {});
  if (!subjects.includes(subject)) subject = subjects[0];
  if (grade === null) grade = (state.me && state.me.grade) || 0;
  const units = await get(`/api/curriculum?subject=${encodeURIComponent(subject)}${grade ? `&grade=${grade}` : ''}`);
  const terms = {};
  units.forEach((u) => (terms[u.term] ||= []).push(u));
  let n = 0;
  html(main, `
    <div class="page-head"><div class="grow"><h1>學習</h1><div class="sub">每個單元都有重點整理、公式、常考題型、易錯點和闖關練習</div></div></div>

    <div class="grid g4" style="margin-bottom:20px">
      <a class="card task" href="#/practice/challenge" style="margin:0;border:1px solid var(--line);padding:14px;flex-direction:column;align-items:flex-start;gap:8px">
        <span class="ti">${icon('target')}</span><span><b>每日挑戰</b><span class="sub">10 題・依程度挑選</span></span></a>
      <a class="card task" href="#/practice/review" style="margin:0;border:1px solid var(--line);padding:14px;flex-direction:column;align-items:flex-start;gap:8px">
        <span class="ti red">${icon('redo')}</span><span><b>錯題複習</b><span class="sub">間隔重複</span></span></a>
      <a class="card task" href="#/practice/drill" style="margin:0;border:1px solid var(--line);padding:14px;flex-direction:column;align-items:flex-start;gap:8px">
        <span class="ti orange">${icon('bolt')}</span><span><b>心算快打</b><span class="sub">60 秒速算</span></span></a>
      <a class="card task" href="#/practice/duel" style="margin:0;border:1px solid var(--line);padding:14px;flex-direction:column;align-items:flex-start;gap:8px">
        <span class="ti green">${icon('swords')}</span><span><b>PK 對戰</b><span class="sub">5 題比快比準</span></span></a>
    </div>

    <div class="row" style="margin-bottom:12px">
      <div class="subject-tabs" style="margin:0;flex:1">${subjects.map((s) => `<button class="subject-tab ${s === subject ? 'on' : ''}" data-s="${s}">${s}</button>`).join('')}</div>
      <select id="grade" style="width:auto">${[[0, '全部年級'], [3, '三年級'], [4, '四年級'], [5, '五年級'], [6, '六年級']].map(([g, l]) => `<option value="${g}" ${grade === g ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>

    ${Object.entries(terms).map(([term, us]) => `
      <div class="label" style="margin-top:8px">${esc(TERM(term))}</div>
      <div class="group">${us.map((u) => {
        n++;
        const cls = u.stars >= 1 ? 'done' : u.wrong ? 'weak' : u.questions || u.plays ? 'prog' : '';
        const meta = u.wrong ? `<span style="color:var(--bad)">錯題 ${u.wrong}・需要加強</span>`
          : u.accuracy !== null && u.accuracy !== undefined ? `正確率 ${u.accuracy}%${u.questions ? `・題庫 ${u.questions} 題` : ''}`
          : u.questions ? `題庫 ${u.questions} 題` : '還沒開始';
        return `<a class="unit-row" data-u="${esc(u.unit)}" data-g="${u.grade}" href="#/learn/${encodeURIComponent(subject)}/${u.grade}/${encodeURIComponent(u.unit)}">
          <span class="badge-num ${cls}">${u.stars >= 1 ? icon('check', 18) : u.wrong ? '!' : n}</span>
          <span style="flex:1;min-width:0"><span style="font-size:15px">${esc(u.unit)}</span><br><span class="small muted">${meta}${u.has_knowledge ? '・有重點卡' : ''}</span></span>
          <span class="stars">${[1, 2, 3].map((i) => `<i class="${u.stars >= i ? 'on' : ''}"></i>`).join('')}</span>
        </a>`;
      }).join('')}</div>`).join('')}
    <button class="btn ghost" id="addunit">${icon('plus', 18)} 自訂單元</button>`);
  $$('[data-s]', main).forEach((b) => b.onclick = () => { subject = b.dataset.s; render(main); });
  main.querySelector('#grade').onchange = (e) => { grade = Number(e.target.value); render(main); };
  main.querySelector('#addunit').onclick = async () => {
    const u = await promptBox(`新增「${subject}」單元名稱`, '', '例如：雞兔同籠');
    if (!u) return;
    await post('/api/units', { subject, grade: grade || 6, unit: u });
    toast('已新增', 'ok');
    render(main);
  };
}
