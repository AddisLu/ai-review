import { get, post, put, state } from '../api.js';
import { $$, confetti, confirmBox, errToast, esc, html, icon, showReward, toast } from '../ui.js';

let tab = null; // first visit: rewards when the parents set some, else the league
const THEMES = { sky: '藍色（預設）', strawberry: '草莓', mint: '薄荷', lavender: '薰衣草', night: '夜間' };

export async function render(main) {
  const [me, badges, shop, league, rw] = await Promise.all([get('/api/me'), get('/api/me/badges'), get('/api/shop'), get('/api/league'), get('/api/rewards')]);
  if (!tab) tab = rw.rewards.length ? 'rewards' : 'league';
  const earned = badges.filter((b) => b.earned_at).length;
  const lv = me.level;
  html(main, `
  <div class="greet">
    <div class="avatar" style="width:64px;height:64px;border-radius:32px;font-size:32px">${me.avatar}</div>
    <div style="flex:1"><h1 style="font-size:20px">${esc(me.name)}</h1>
      <div class="sub">${me.grade} 年級${me.title ? '・' + esc(me.title) : ''}</div></div>
  </div>
  <div class="stat-tiles">
    <div><b style="color:var(--warm-ink)">${me.streak}</b><span>連續天數（最高 ${me.best_streak}）</span></div>
    <div><b>Lv.${lv.level}</b><span>${me.xp} XP</span></div>
    <div><b>${me.coins}</b><span>金幣</span></div>
  </div>
  <div class="progress" style="margin:-4px 0 18px"><i style="width:${Math.round(lv.cur / lv.need * 100)}%"></i></div>

  <div class="seg">${[['league', '排行'], ['badges', `徽章 ${earned}`], ['rewards', '兌換獎勵'], ['shop', '商店'], ['closet', '換裝'], ['goal', '目標']]
    .map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
  <div id="tb"></div>

  <div class="label" style="margin-top:18px">更多</div>
  <div class="group">
    <a class="gi" href="#/notes"><span class="t">我的觀念筆記本</span><span class="chev">${icon('chev', 18)}</span></a>
    <a class="gi" href="#/papers"><span class="t">組卷列印</span><span class="chev">${icon('chev', 18)}</span></a>
    <a class="gi" href="#/parent"><span class="t">家長專區</span>${icon('lock', 16)}<span class="chev">${icon('chev', 18)}</span></a>
    <button class="gi" id="mute" style="width:100%;background:none;border:0;border-bottom:1px solid var(--hair);text-align:left;cursor:pointer">
      <span class="t">音效</span><span class="muted">${localStorage.getItem('mute') === '1' ? '關' : '開'}</span></button>
    <button class="gi" id="logout" style="width:100%;background:none;border:0;text-align:left;cursor:pointer">
      <span class="t">切換使用者（登出）</span><span class="chev">${icon('chev', 18)}</span></button>
  </div>`);
  main.querySelector('#logout').onclick = async () => {
    await post('/api/auth/logout');
    location.hash = '#/login';
  };
  $$('[data-tab]', main).forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(main); });
  main.querySelector('#mute').onclick = () => {
    localStorage.setItem('mute', localStorage.getItem('mute') === '1' ? '0' : '1');
    render(main);
  };
  const tb = main.querySelector('#tb');

  if (tab === 'league') {
    html(tb, `<div class="card">
      <div class="row" style="margin-bottom:8px"><b style="flex:1">本週排行</b><span class="sub">還剩 ${league.days_left} 天・前 ${league.promote} 名晉級</span></div>
      ${league.board.map((r) => `<div class="league-row ${r.me ? 'me' : ''} ${r.rank <= league.promote ? 'promo' : ''}">
        <span class="rk">${r.rank}</span><span style="font-size:20px">${r.avatar}</span>
        <span style="flex:1">${esc(r.name)}${r.me ? '（我）' : ''}</span><span class="num">${r.xp}</span></div>`).join('')}
      <p class="small muted" style="margin:10px 0 0">每週一重新開始，練習得到的 XP 就是分數。</p></div>`);
  } else if (tab === 'rewards') {
    const ST = { pending: ['等爸媽核准', 'warn'], approved: ['已核准', 'ok'], rejected: ['已退回', 'gray'], given: ['已兌換', 'ok'] };
    html(tb, `<p class="sub" style="margin-top:0">爸媽設定的真實獎勵，用金幣兌換（目前 <b>${me.coins}</b> 枚）。</p>
      ${rw.rewards.length ? `<div class="group">${rw.rewards.map((r) => `<div class="gi"><span class="t">${esc(r.title)}</span>
        <button class="btn sm ${me.coins >= r.cost ? '' : 'ghost'}" data-redeem="${r.id}" ${me.coins >= r.cost ? '' : 'disabled'}>${r.cost} 金幣</button></div>`).join('')}</div>`
        : '<p class="small muted">爸媽還沒有設定獎勵。可以請爸媽到家長專區新增喔！</p>'}
      ${rw.mine.length ? `<div class="label" style="margin-top:12px">我的兌換紀錄</div>${rw.mine.map((x) => `<div class="list-item"><span class="t">${esc(x.title)}</span>
        <span class="tag ${(ST[x.status] || [])[1]}">${(ST[x.status] || [x.status])[0]}</span></div>`).join('')}` : ''}`);
    $$('[data-redeem]', tb).forEach((b) => b.onclick = async () => {
      const r = rw.rewards.find((x) => String(x.id) === b.dataset.redeem);
      if (!await confirmBox(`用 ${r.cost} 金幣兌換「${esc(r.title)}」？`, '兌換')) return;
      try { await post(`/api/rewards/${b.dataset.redeem}/redeem`); toast('已送出，等爸媽核准！', 'ok'); confetti(30); showReward({}); render(main); } catch (e) { errToast(e); }
    });
  } else if (tab === 'badges') {
    html(tb, `<div class="badge-grid">${badges.map((b) => `<div class="badge ${b.earned_at ? '' : 'locked'}">
      <div class="i">${b.icon}</div><b>${esc(b.name)}</b><div class="small muted">${esc(b.desc)}</div></div>`).join('')}</div>`);
  } else if (tab === 'shop') {
    html(tb, `<p class="sub" style="margin-top:0">用練習賺到的金幣換獎勵，目前有 <b>${shop.coins}</b> 枚。</p>
      <div class="badge-grid">${shop.items.map((i) => {
        const owned = i.kind !== 'freeze' && shop.owned.includes(i.id);
        const pic = i.kind === 'avatar' ? i.value : icon(i.kind === 'theme' ? 'image' : i.kind === 'freeze' ? 'flame' : 'trophy', 30);
        return `<div class="badge shop-item"><div class="i">${pic}</div><b>${esc(i.name)}</b>
          <button class="btn sm block ${owned ? 'ghost' : ''}" style="margin-top:8px" data-buy="${i.id}" ${owned ? 'disabled' : ''}>${owned ? '已擁有' : `${i.price} 金幣`}</button></div>`;
      }).join('')}</div>`);
    $$('[data-buy]', tb).forEach((b) => b.onclick = async () => {
      try { await post('/api/shop/buy', { item: b.dataset.buy }); toast('買到了！到「換裝」使用吧', 'ok'); confetti(30); showReward({}); render(main); } catch (e) { errToast(e); }
    });
  } else if (tab === 'closet') {
    const mine = (kind, free) => [free, ...shop.items.filter((i) => i.kind === kind && shop.owned.includes(i.id)).map((i) => i.value)];
    html(tb, `<div class="label">頭像</div><div class="chips" style="margin-bottom:16px">${mine('avatar', '🐱').map((a) => `<button class="chip ${me.avatar === a ? 'on' : ''}" data-av="${a}" style="font-size:22px">${a}</button>`).join('')}</div>
      <div class="label">主題顏色</div><div class="chips" style="margin-bottom:16px">${mine('theme', 'sky').map((t) => `<button class="chip ${me.theme === t ? 'on' : ''}" data-th="${t}">${THEMES[t] || t}</button>`).join('')}</div>
      <div class="label">稱號</div><div class="chips">${mine('title', '').map((t) => `<button class="chip ${me.title === t ? 'on' : ''}" data-tt="${esc(t)}">${t ? esc(t) : '不顯示'}</button>`).join('')}</div>`);
    const eq = async (body) => { try { await post('/api/me/equip', body); showReward({}); render(main); } catch (e) { errToast(e); } };
    $$('[data-av]', tb).forEach((b) => b.onclick = () => eq({ avatar: b.dataset.av }));
    $$('[data-th]', tb).forEach((b) => b.onclick = () => eq({ theme: b.dataset.th }));
    $$('[data-tt]', tb).forEach((b) => b.onclick = () => eq({ title: b.dataset.tt }));
  } else {
    html(tb, `<div class="card"><b>每天想得到多少 XP？</b><p class="sub">答對一題約 10 XP，完成每日挑戰 30 XP</p>
      <div class="chips">${[[30, '輕鬆 30'], [50, '一般 50'], [100, '認真 100'], [200, '衝刺 200']].map(([v, l]) => `<button class="chip ${me.daily_goal === v ? 'on' : ''}" data-goal="${v}">${l}</button>`).join('')}</div></div>`);
    $$('[data-goal]', tb).forEach((b) => b.onclick = async () => { await put(`/api/students/${state.studentId}`, { daily_goal: Number(b.dataset.goal) }); toast('已設定', 'ok'); render(main); });
  }
}
