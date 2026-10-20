import { get, post, state } from '../api.js';
import { errToast, esc, html, icon, showReward, toast, localDay } from '../ui.js';

const WEEK = '日一二三四五六';

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? '早安' : h < 18 ? '午安' : '晚安';
}

export async function render(main) {
  const parent = state.status.user && state.status.user.role === 'parent';
  const [me, exams, ch, stats, league, help, rw] = await Promise.all([get('/api/me'), get('/api/exams'), get('/api/practice/challenge'),
    parent ? get('/api/stats') : null, parent ? get('/api/league') : null, get('/api/help'),
    parent ? get('/api/rewards') : null]);
  const goal = me.goals && me.goals[0];
  const goalCard = goal ? `<div class="card" style="border-color:var(--pri)">
      <div class="row nowrap"><b style="flex:1">${esc(goal.title)}倒數</b><span class="num" style="font-size:26px;color:var(--pri)">${goal.days_left}</span><span class="small">天</span></div>
      ${goal.focus ? `<div class="small" style="margin-top:4px">今天的重點單元：<a href="#/learn/${encodeURIComponent(goal.focus[0])}/${me.grade}/${encodeURIComponent(goal.focus[1])}"><b>${esc(goal.focus[1])}</b></a></div>` : ''}
      ${goal.due_wrong ? `<div class="small muted">考試範圍內還有 ${goal.due_wrong} 題錯題沒精熟</div>` : ''}</div>` : '';
  const inbox = parent && ((help && help.length) || (rw && rw.pending.length)) ? `<div class="card" style="border-color:var(--warm)">
      ${help.length ? `<div class="label">孩子請你幫忙（${help.length}）</div>${help.map((h) => `<div class="help-item">
        <div class="row nowrap"><span style="font-size:20px">${h.avatar}</span><a class="t" style="flex:1;min-width:0" href="#/q/${h.question_id}"><b>${esc(h.name)}</b>・${esc((h.stem || '').replace(/\$[^$]*\$/g, '…').slice(0, 26))}</a></div>
        ${h.message ? `<div class="small muted" style="margin:2px 0 6px 30px">${esc(h.message)}</div>` : ''}
        <div class="row nowrap" style="margin-left:30px;gap:6px"><input type="text" data-reply="${h.id}" placeholder="回覆她（可不寫）" style="flex:1;min-width:0">
          <button class="btn sm" data-helpdone="${h.id}">送出</button></div></div>`).join('')}` : ''}
      ${rw.pending.length ? `<div class="label" style="margin-top:8px">兌換獎勵待核准</div>${rw.pending.map((x) => `<div class="list-item">
        <span class="t">${esc(x.name)} 想兌換「${esc(x.title)}」（${x.cost} 金幣）</span>
        <button class="btn sm ok" data-rw="${x.id}|approved">核准</button><button class="btn sm ghost" data-rw="${x.id}|rejected">退回</button></div>`).join('')}` : ''}
    </div>` : '';
  const recent = localDay(-3);
  const replies = !parent ? (help || []).filter((h) => h.status === 'done' && h.reply && (h.updated_at || '') >= recent) : [];
  const replyCard = replies.length ? `<div class="card" style="border-color:var(--ok)"><div class="label">爸媽回覆你了</div>
    ${replies.map((h) => `<div class="list-item"><a class="t" href="#/q/${h.question_id}">${esc((h.stem || '').slice(0, 30))}…<br><b>${esc(h.reply)}</b></a></div>`).join('')}</div>` : '';
  const breakNote = me.daily_limit && me.minutes_today >= me.daily_limit ? `<div class="card tight" style="border-color:var(--warm);background:var(--warm-soft)">今天已經學習 ${me.minutes_today} 分鐘，超過爸媽設定的 ${me.daily_limit} 分鐘了，休息一下吧！</div>` : '';
  state.me = me;
  const d = new Date();
  const pct = Math.min(100, Math.round((me.xp_today / Math.max(1, me.daily_goal)) * 100));
  const left = Math.max(0, me.daily_goal - me.xp_today);
  const hw = me.homework[0];
  const nextTitle = ch.done_today ? '再挑戰一次每日挑戰' : '每日挑戰 10 題';
  const nextDesc = ch.weak_unit ? `依你的程度挑選，今天加強「${esc(ch.weak_unit.unit)}」` : '依你的程度挑選題目';

  const acc = stats ? stats.accuracy.reduce((a, r) => [a[0] + r.ok, a[1] + r.n], [0, 0]) : null;
  const parentCol = stats ? `<div>
      <div class="stat-tiles">
        <div><b style="color:var(--warm-ink)">${me.streak}</b><span>連續天數</span></div>
        <div><b>${acc[1] ? Math.round(acc[0] / acc[1] * 100) + '%' : '-'}</b><span>近 30 天正確率</span></div>
        <div><b style="color:var(--bad)">${me.due_review}</b><span>待複習錯題</span></div>
      </div>
      <div class="card"><div class="label">需要加強的單元</div>
        ${stats.units.length ? `<div class="bars">${stats.units.slice(0, 4).map((u) => `<div class="bar" style="grid-template-columns:110px 1fr 44px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.unit)}</span>
          <div class="progress ${u.pct >= 80 ? 'ok' : ''}"><i style="width:${u.pct}%"></i></div><b>${u.pct}%</b></div>`).join('')}</div>` : '<p class="small muted">還沒有足夠的練習紀錄</p>'}
        <div class="row" style="gap:8px;margin-top:8px"><a class="btn sm soft" href="#/analysis">完整弱點分析</a>
          ${me.wrong_open ? `<button class="btn sm" id="wrongpaper">${icon('print', 16)} 印錯題卷（${me.wrong_open > 30 ? '最多 30' : me.wrong_open} 題）</button>` : ''}</div></div>
      <div class="card"><div class="label">本週家庭排行</div>
        ${league.board.filter((r) => !r.bot).map((r, i) => `<div class="league-row ${r.me ? 'me' : ''}"><span class="rk">${i + 1}</span><span>${r.avatar}</span><span style="flex:1">${esc(r.name)}</span><span class="num">${r.xp}</span></div>`).join('')}</div>
    </div>` : '';

  html(main, `
  <div class="greet">
    <div class="avatar">${me.avatar}</div>
    <div style="flex:1;min-width:0">
      <div class="sub">${d.getMonth() + 1} 月 ${d.getDate()} 日・星期${WEEK[d.getDay()]}</div>
      <h1>${greeting()}，${esc(me.name)}</h1>
    </div>
    <span class="streak" title="連續學習天數">${icon('flame', 18)}${me.streak}</span>
  </div>

  ${inbox}${replyCard}${breakNote}
  <div class="home-grid ${parent ? 'with-parent' : ''}">
    <div>
      ${goalCard}
      <div class="next" id="next" role="link" tabindex="0">
        <span class="k">下一步</span>
        <span class="t">${nextTitle}</span>
        <span class="d">${nextDesc}</span>
        <span class="go">開始</span>
      </div>
      <div class="card goal">
        <div class="ring" style="--p:${pct}"><div>${pct}%</div></div>
        <div style="flex:1">
          <div style="font-weight:700">今日目標 ${me.xp_today} / ${me.daily_goal} XP</div>
          <div class="sub">${left ? `再答對 ${Math.ceil(left / 10)} 題就達標` : '今天的目標完成了！'}</div>
          <div class="row small" style="margin-top:6px;color:var(--ink-2);gap:14px"><span>Lv.${me.level.level}</span><span>金幣 ${me.coins}</span><span>今天複習 ${me.due_review} 題</span></div>
        </div>
      </div>
    </div>

    <div>
      <div class="card" style="padding:4px 16px">
        <div class="label" style="margin:12px 0 0">今天</div>
        <a class="task" href="#/practice/review">
          <span class="ti red">${icon('redo')}</span>
          <span style="flex:1"><b>錯題複習</b><span class="sub">${me.due_review ? `${me.due_review} 題到了複習時間` : me.wrong_open ? `今天不用複習・還有 ${me.wrong_open} 題錯題可以挑來練` : '目前沒有錯題'}</span></span>
          <span class="chev">${icon('chev', 18)}</span></a>
        <a class="task" href="#/practice/drill">
          <span class="ti orange">${icon('bolt')}</span>
          <span style="flex:1"><b>心算快打 60 秒</b><span class="sub">分數、小數、百分率速算</span></span>
          <span class="chev">${icon('chev', 18)}</span></a>
        ${hw ? me.homework.map((t) => `<a class="task" href="#/task/${t.id}">
          <span class="ti ${t.status === 'late' ? 'red' : ''}">${icon('doc')}</span>
          <span style="flex:1"><b>爸媽指派：${esc(t.title)}</b><span class="sub">${t.status === 'late' ? '<span class="tag bad">晚了</span> ' : t.status === 'today' ? '<span class="tag warn">今天</span> ' : ''}${t.due_date ? `${t.due_date.slice(5).replace('-', '/')} 前完成` : '作業'}${t.n ? `・做了 ${t.done}/${t.n} 題` : ''}</span></span>
          <span class="chev">${icon('chev', 18)}</span></a>`).join('') : `<a class="task" href="#/scan">
          <span class="ti green">${icon('scan')}</span>
          <span style="flex:1"><b>拍考卷</b><span class="sub">重新產生可編輯試卷、整理錯題、附詳解</span></span>
          <span class="chev">${icon('chev', 18)}</span></a>`}
      </div>

      <div class="card">
        <div class="label">今日任務</div>
        ${me.quests.map((q) => `<div class="quest">
          <span style="flex:1;min-width:0">${esc(q.name)}</span>
          ${q.claimed ? '<span class="tag ok">已領取</span>'
            : q.done ? `<button class="btn sm warn" data-claim="${q.id}">領 ${q.reward} 金幣</button>`
            : `<span class="small muted">${q.value}/${q.target}</span>`}
        </div>`).join('')}
      </div>

      ${exams.length ? `<div class="card" style="padding:4px 16px">
        <div class="row" style="margin-top:12px"><span class="label" style="margin:0">最近的考卷</span><span class="spacer"></span><a href="#/bank?view=exams" class="small tap">全部</a></div>
        ${exams.slice(0, 3).map((e) => `<a class="list-item" href="#/exam/${e.id}">
          <span class="t wrap">${esc(e.title)}</span>
          ${e.status === 'processing' ? '<span class="tag warn">處理中</span>' : ''}
        </a>`).join('')}</div>` : ''}
    </div>
    ${parentCol}
  </div>`);

  main.querySelectorAll('[data-helpdone]').forEach((b) => b.onclick = async () => {
    const reply = main.querySelector(`[data-reply="${b.dataset.helpdone}"]`).value;
    await post(`/api/help/${b.dataset.helpdone}`, { status: 'done', reply });
    toast(reply ? '已回覆，她的首頁會看到' : '已處理', 'ok');
    render(main);
  });
  main.querySelectorAll('[data-rw]').forEach((b) => b.onclick = async () => {
    const [id, status] = b.dataset.rw.split('|');
    await post(`/api/redemptions/${id}`, { status });
    toast(status === 'approved' ? '已核准' : '已退回（金幣已退還）', 'ok');
    render(main);
  });
  const wp = main.querySelector('#wrongpaper');
  if (wp) wp.onclick = async () => {
    // one tap: open wrong questions, most-missed first, grouped by type with a lesson page
    const r = await get('/api/questions?flags=unmastered&sort=wrong&limit=30');
    const { makePaper } = await import('./common.js');
    makePaper(r.items.map((q) => q.id), `${me.name}的錯題卷`);
  };
  const go = () => { location.hash = '#/practice/challenge'; };
  const next = main.querySelector('#next');
  next.onclick = go;
  next.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
  main.querySelectorAll('[data-claim]').forEach((b) => b.onclick = async () => {
    try {
      const r = await post(`/api/me/quests/${b.dataset.claim}/claim`);
      toast(`+${r.coins} 金幣`, 'gold');
      showReward({ reward: r });
      render(main);
    } catch (e) { errToast(e); }
  });
}
