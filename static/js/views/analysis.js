// 弱點分析 (parents): per-unit mastery, why mistakes happen, study time,
// and one-tap practice generated from the analysis.
import { get, post, put, qs, state, waitJob } from '../api.js';
import { $, $$, busy, errToast, esc, html, icon, modal, toast } from '../ui.js';

const DOT = { mastered: 'ok', good: 'ok', practice: 'warn', weak: 'bad', none: '' };
const LV = { basic: '基礎', advanced: '進階', challenge: '挑戰' };

export async function render(main) {
  // a parent's page (her own learning status is on 錯題 and 我的)
  if (!(state.status.user && state.status.user.role === 'parent') && !state.parentPin) { location.hash = '#/bank'; return; }
  const a = await get('/api/analysis');
  const st = state.status;
  const kid = (st.students || []).find((s) => s.id === state.studentId) || st.user;
  const w = a.week;
  const delta = (x, y, unit = '') => (x === null || y === null || y === undefined ? '' : x - y > 0 ? `<span style="color:var(--ok)">↑${x - y}${unit}</span>` : x - y < 0 ? `<span style="color:var(--bad)">↓${y - x}${unit}</span>` : '');
  const maxMin = Math.max(30, ...a.time.map((d) => d.minutes));
  const limit = (state.me && state.me.daily_limit) || 0;
  html(main, `
  <div class="page-head"><div class="grow"><h1>${esc(kid.name)} 的弱點分析</h1>
    <div class="sub">依最近 90 天的作答、錯題與 AI 批改結果分析</div></div>
    <button class="btn" id="plan">${icon('target', 18)} 依分析出 10 題</button></div>

  <div class="stat-tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
    <div><b>${w.this.minutes}</b><span>本週學習分鐘 ${delta(w.this.minutes, w.last.minutes)}</span></div>
    <div><b>${w.this.accuracy ?? '-'}${w.this.accuracy !== null ? '%' : ''}</b><span>本週正確率 ${delta(w.this.accuracy, w.last.accuracy, '%')}</span></div>
    <div><b>${w.this.answers}</b><span>本週作答題數</span></div>
    <div><b style="color:var(--ok)">${w.mastered_this_week}</b><span>本週精熟的錯題</span></div>
  </div>
  ${w.improved.length || w.declined.length ? `<div class="card tight small">
    ${w.improved.length ? `進步：${w.improved.map((u) => `<b>${esc(u.unit)}</b>（+${u.trend}%）`).join('、')}　` : ''}
    ${w.declined.length ? `<span style="color:var(--bad)">退步：${w.declined.map((u) => `<b>${esc(u.unit)}</b>（${u.trend}%）`).join('、')}</span>` : ''}</div>` : ''}

  <div class="card" style="padding:4px 16px">
    <div class="row" style="padding:12px 0 4px"><b style="flex:1">各單元掌握度</b><span class="small muted">由弱到強</span></div>
    ${a.units.length ? a.units.map((u, i) => `<div class="unit-a" style="border-top:1px solid var(--hair);padding:12px 0">
      <div class="row nowrap">
        <span class="status-dot ${DOT[u.status_key]}"></span>
        <b style="flex:1;min-width:0">${esc(u.unit)} <span class="small muted">${esc(u.subject)}</span></b>
        <span class="tag ${DOT[u.status_key] || 'gray'}">${esc(u.status)}</span>
      </div>
      <div class="row small muted" style="gap:14px;margin:4px 0 0 18px">
        <span>正確率 ${u.accuracy ?? '-'}${u.accuracy !== null ? '%' : ''}（${u.attempts} 題）</span>
        ${Object.entries(u.level_accuracy || {}).map(([k, v]) => `<span>${LV[k] || k} ${v}%</span>`).join('')}
        ${u.open_wrong ? `<span style="color:var(--bad)">待精熟錯題 ${u.open_wrong}</span>` : ''}
        ${u.trend !== null ? `<span>${u.trend >= 0 ? `↑${u.trend}` : `↓${-u.trend}`}%</span>` : ''}
        ${u.errors.length ? `<span>常見錯誤：${u.errors.map(([e, n]) => `${esc(e)}×${n}`).join('、')}</span>` : ''}
        ${u.reasons.length ? `<span>她自己說：${u.reasons.map(([e, n]) => `${esc(e)}×${n}`).join('、')}</span>` : ''}
      </div>
      ${u.advice ? `<div class="small" style="margin:6px 0 0 18px">${esc(u.advice)}</div>` : ''}
      <div class="row" style="margin:8px 0 0 18px">
        <button class="btn sm soft" data-plan="${i}">只練這個單元</button>
        <a class="btn sm ghost" href="#/bank?subject=${encodeURIComponent(u.subject)}&unit=${encodeURIComponent(u.unit)}&flags=">看題目</a>
      </div></div>`).join('') : '<p class="sub" style="padding:8px 0 14px">還沒有練習紀錄。先讓孩子掃描考卷或做幾次每日挑戰。</p>'}
  </div>

  <div class="grid g2">
    <div class="card"><b>為什麼會錯</b>
      ${a.errors.length || a.reasons.length ? `<div class="bars" style="margin-top:10px">${[...a.errors.map(([k, n]) => ['AI：' + k, n]), ...a.reasons.map(([k, n]) => ['她說：' + k, n])].map(([k, n]) => `<div class="bar"><span>${esc(k)}</span>
        <div class="progress"><i style="width:${Math.min(100, n * 12)}%"></i></div><b>${n}</b></div>`).join('')}</div>` : '<p class="small muted">累積手寫批改和「我覺得錯在…」後會出現。</p>'}
      ${a.guesses.fast_wrong ? `<p class="small" style="color:var(--warm-ink)">近兩週有 ${a.guesses.fast_wrong} 題不到 4 秒就答錯，可能是用猜的。</p>` : ''}
    </div>
    <div class="card"><div class="row"><b style="flex:1">每天學習時間（分鐘）</b>
      <button class="btn link sm" id="limit">每日上限：${limit ? limit + ' 分鐘' : '不限'}</button></div>
      <div class="timebars">${a.time.map((d) => `<div title="${d.day}：${d.minutes} 分鐘"><i style="height:${Math.round(d.minutes / maxMin * 100)}%;${limit && d.minutes > limit ? 'background:var(--warm)' : ''}"></i><span>${d.day.slice(8)}</span></div>`).join('')}</div>
    </div>
  </div>`);

  // one tap: 10 questions (60/30/10 mix); questions can be removed on the paper page
  const plan = async (units, title, n = 10) => {
    const b = busy('分析弱點、挑選題目中…');
    try {
      const r = await post('/api/plan', { n, units, title });
      const res = await waitJob(r.job_id, (j) => b.update(j));
      b.close();
      if (b.left) { toast(`「${title}」出好 ${res.questions} 題了`, 'ok', { label: '打開', href: `#/paper/${res.paper_id}` }); return; }
      toast(`出好 ${res.questions} 題了`, 'ok');
      location.hash = `#/paper/${res.paper_id}`;
    } catch (e) { b.close(); errToast(e); }
  };
  $('#plan').onclick = () => plan(null, `${kid.name}的弱點加強卷`);
  $$('[data-plan]', main).forEach((b) => b.onclick = () => {
    const u = a.units[Number(b.dataset.plan)];
    plan([[u.subject, u.unit]], `${u.unit} 加強卷`);
  });
  $('#limit').onclick = async () => {
    const v = await modal({
      title: '每日學習時間上限',
      body: `<p class="sub">超過時會提醒孩子休息（不會強制關閉）。</p><div class="chips">${[0, 30, 45, 60, 90].map((m) => `<button class="chip ${m === limit ? 'on' : ''}" data-m="${m}">${m ? m + ' 分鐘' : '不限'}</button>`).join('')}</div>`,
      onOpen: (m, close) => m.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => close(Number(b.dataset.m))),
    });
    if (v === undefined) return;
    try { await put(`/api/students/${state.studentId}`, { daily_limit: v }); window.dispatchEvent(new Event('me-changed')); render(main); } catch (e) { errToast(e); }
  };
}
