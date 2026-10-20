import { get, post, setParentPin, state } from './api.js';
import { $, closeAllModals, esc, errToast, icon, modal, toast, localDay } from './ui.js';

const MY_BUILD = (import.meta.url.match(/\/v\/(\d+)\//) || [])[1] || '';  // this page's version (see checkBuild)
let newBuild = false;

const NAV = [
  { href: '#/', ico: 'home', label: '今天', match: /^#\/?$/ },
  { href: '#/scan', ico: 'scan', label: '掃描', match: /^#\/(scan|templates)/ },
  { href: '#/bank', ico: 'book', label: '題庫', match: /^#\/(bank|q\/|exam\/)/, badge: 'due' },
  { href: '#/learn', ico: 'map', label: '學習', match: /^#\/(learn|practice)/ },
  { href: '#/analysis', ico: 'chart', label: '分析', match: /^#\/analysis/, desk: true, parentOnly: true },
  { href: '#/papers', ico: 'print', label: '列印', match: /^#\/paper/, desk: true },
  { href: '#/me', ico: 'user', label: '我的', match: /^#\/(me|parent)/ },
];

const ROUTES = [
  [/^#\/?$/, () => import('./views/home.js')],
  [/^#\/scan$/, () => import('./views/scan.js')],
  [/^#\/exam\/(\d+)(?:\?v=(\w+))?$/, () => import('./views/exam.js')],
  [/^#\/templates$/, () => import('./views/templates.js')],
  [/^#\/task\/(\d+)$/, () => import('./views/task.js')],
  [/^#\/bank/, () => import('./views/bank.js')],
  [/^#\/q\/(\d+)$/, () => import('./views/question.js')],
  [/^#\/learn$/, () => import('./views/learn.js')],
  [/^#\/learn\/([^/]+)\/(\d+)\/(.+)$/, () => import('./views/unit.js')],
  [/^#\/practice$/, () => import('./views/practice.js')],
  [/^#\/practice\/(\w+)$/, () => import('./views/practice.js')],
  [/^#\/papers$/, () => import('./views/papers.js')],
  [/^#\/paper\/(\w+)$/, () => import('./views/papers.js')],
  [/^#\/me$/, () => import('./views/me.js')],
  [/^#\/analysis$/, () => import('./views/analysis.js')],
  [/^#\/notes$/, () => import('./views/notes.js')],
  [/^#\/parent$/, () => import('./views/parent.js')],
  [/^#\/login$/, () => Promise.resolve({ render: () => { history.replaceState(null, '', '#/'); start(); } })],
];

let cleanup = null;

function renderNav() {
  const me = state.me || {};
  $('#nav').innerHTML = `
    <div class="brand">AI</div>
    ${NAV.filter((n) => !n.parentOnly || (state.status && state.status.user && state.status.user.role === 'parent')).map((n) => `<a class="nav-item ${n.desk ? 'desk' : ''}" href="${n.href}">
      ${icon(n.ico, 24)}<span>${n.label}</span>
      ${n.badge === 'due' && me.due_review ? `<span class="dot">${me.due_review > 99 ? '99+' : me.due_review}</span>` : ''}
    </a>`).join('')}
    <div class="nav-foot">
      <button class="nav-avatar" id="switch-student" title="${esc(me.name || '')}">${me.avatar || '🐱'}</button>
    </div>`;
  markActive();
  const sw = $('#switch-student');
  if (sw) sw.onclick = switchStudent;
}

function markActive() {
  const h = location.hash || '#/';
  document.querySelectorAll('.nav-item').forEach((a) => {
    const n = NAV.find((x) => x.href === a.getAttribute('href'));
    a.classList.toggle('active', !!(n && n.match.test(h)));
  });
}

// Avatar menu: parent can look at any child's records; everyone can switch user.
async function switchStudent() {
  const st = state.status;
  const user = st.user;
  const isParent = user.role === 'parent';
  const kids = (st.students || []).filter((s) => s.role !== 'parent');
  await modal({
    title: esc(user.name),
    body: `${isParent ? `<div class="label">要看誰的資料？</div><div class="group">
        ${[user, ...kids].map((s) => `<button class="gi" data-sid="${s.id}" style="width:100%;background:none;border:0;border-bottom:1px solid var(--hair);text-align:left;cursor:pointer">
          <span style="font-size:22px">${s.avatar}</span><span class="t">${esc(s.name)}${s.id === user.id ? '（我自己）' : `・${s.grade} 年級`}</span>
          ${s.id === state.studentId ? icon('check', 18) : ''}</button>`).join('')}</div>` : ''}
      <button class="btn ghost block" id="logout">切換使用者（登出）</button>`,
    onOpen: (m, close) => {
      m.querySelectorAll('[data-sid]').forEach((b) => b.onclick = () => {
        setStudent(Number(b.dataset.sid));
        close();
        route();
      });
      m.querySelector('#logout').onclick = async () => {
        await post('/api/auth/logout');
        close();
        state.me = null;
        location.hash = '#/';
        await start();
      };
    },
  });
}

export function setStudent(id) {
  state.studentId = id;
  localStorage.setItem('studentId', String(id));
  refreshMe();
}

export async function refreshMe() {
  try {
    state.me = await get('/api/me');
    document.documentElement.dataset.theme = state.me.theme || 'sky';
    renderNav();
  } catch (e) { /* not logged in yet */ }
}

async function renderLogin(main) {
  $('#nav').style.display = 'none';
  main.innerHTML = `<div class="login"><div class="brand" style="margin:0 auto 16px">AI</div>
    <h1>AI 總複習學習站</h1><p class="sub">請輸入家庭密碼</p>
    <input type="password" id="pw" placeholder="家庭密碼" autofocus style="margin-top:16px">
    <button class="btn block lg" id="go" style="margin-top:12px">進入</button></div>`;
  const go = async () => {
    try {
      await post('/api/login', { password: $('#pw').value });
      await start();
    } catch (e) { errToast(e); }
  };
  $('#go').onclick = go;
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
}

// Parent looking at a child's records: make that obvious on every page.
// Parents: whose data am I looking at? One row of chips on every page, every
// screen size (the avatar menu is hidden on phones), one tap to switch.
function viewingBanner(main) {
  const st = state.status;
  if (!st || !st.user || st.user.role !== 'parent' || !main.isConnected) return;
  const kids = (st.students || []).filter((s) => s.role !== 'parent');
  if (!kids.length) return;
  const b = document.createElement('div');
  b.className = 'kidbar';
  b.setAttribute('role', 'group');
  b.setAttribute('aria-label', '正在看誰的資料');
  b.innerHTML = [...kids, st.user].map((s) => `<button type="button" class="chip ${s.id === state.studentId ? 'on' : ''}" data-kid="${s.id}">
    <span aria-hidden="true">${s.avatar}</span>${esc(s.name)}${s.id === st.user.id ? '（我）' : ''}</button>`).join('');
  b.querySelectorAll('[data-kid]').forEach((x) => x.onclick = () => {
    if (Number(x.dataset.kid) === state.studentId) return;
    setStudent(Number(x.dataset.kid));
    route();
  });
  main.prepend(b);
}

async function route() {
  const h = location.hash || '#/';
  if (newBuild) { location.reload(); return; }  // a newer version is on the Pi: switch to it between pages
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  closeAllModals();
  // a PIN typed on the child's device ends when the parent pages are left
  if (state.parentPin && state.status && state.status.user && state.status.user.role !== 'parent' && !/^#\/(parent|templates|analysis|printer)/.test(h)) {
    setParentPin('');
    toast('已離開家長模式', 'ok');
  }
  parentBar();
  // A fresh container per navigation: async work still running for the
  // previous page then renders into a detached node instead of this one.
  const old = $('#main');
  const main = old.cloneNode(false);
  old.replaceWith(main);
  for (const [re, loader] of ROUTES) {
    const m = h.match(re);
    if (m) {
      markActive();
      try {
        const mod = await loader();
        main.scrollTop = 0;
        window.scrollTo(0, 0);
        cleanup = (await mod.render(main, m.slice(1).map(decodeURIComponent), h)) || null;
        viewingBanner(main);
      } catch (e) {
        if (!main.isConnected) return; // she already moved on; a page left half-drawn is not an error
        console.error(e);
        main.innerHTML = `<div class="empty"><div class="big">${e.network ? '📶' : '😵'}</div><p>${esc(e.message)}</p>
          <button class="btn" id="reroute">再試一次</button></div>`;
        main.querySelector('#reroute').onclick = () => route();
      }
      return;
    }
  }
  location.hash = '#/';
}

// Login state machine: family password → first-run setup → pick profile → app.
async function boot() {
  state.status = await get('/api/status');
  const st = state.status;
  const main = $('#main');
  if (st.needs_login) { await renderLogin(main); return false; }
  if (st.setup_needed || !st.user) {
    $('#nav').style.display = 'none';
    const { renderSetup, renderProfiles } = await import('./views/login.js');
    if (st.setup_needed) await renderSetup(main, start);
    else await renderProfiles(main, st.profiles || [], start);
    return false;
  }
  $('#nav').style.display = '';
  const user = st.user;
  const ids = (st.students || []).map((s) => s.id);
  if (user.role !== 'parent' || !ids.includes(state.studentId)) setStudent(user.id);
  await refreshMe();
  return true;
}

async function start() {
  try {
    if (await boot()) {
      await route();
      if (!state.status.ai_ready && state.status.user.role === 'parent' && !sessionStorage.getItem('warned')) {
        sessionStorage.setItem('warned', '1');
        toast('AI 還沒連線：請到「我的 → 家長專區 → 設定」確認 Claude 登入', 'bad');
      }
    }
  } catch (e) {
    // the Pi is unreachable at start (Wi-Fi, the nightly router reboot): say so, with a way to retry
    console.error(e);
    const main = $('#main');
    main.innerHTML = `<div class="empty"><div class="big">📶</div><p>${esc(e.message)}</p><button class="btn" id="restart">再試一次</button></div>`;
    main.querySelector('#restart').onclick = () => { main.innerHTML = '<div class="empty"><span class="spinner"></span></div>'; start(); };
  }
}

// where she came from (the practice runner returns there instead of always to 學習)
window.addEventListener('hashchange', (e) => { try { window.__fromHash = new URL(e.oldURL).hash || '#/'; } catch { /* old browser */ } });
window.addEventListener('hashchange', route);
// exams sent off for the AI to sort out: a notice when each one is ready, on any page
import('./views/scan.js').then((m) => m.startWatcher()).catch(() => {});
window.addEventListener('me-changed', refreshMe);

// Break reminder (kids only): after 25 minutes of active use, suggest a
// 5-minute rest; once past the parent's daily limit, a gentle note per day.
let lastInput = Date.now();
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true }));
setInterval(async () => {
  const u = state.status && state.status.user;
  if (!u || u.role === 'parent' || document.hidden || Date.now() - lastInput > 120000) return;
  let active = 0;
  try { active = Number(sessionStorage.getItem('activeMin') || 0) + 1; sessionStorage.setItem('activeMin', String(active)); } catch { /* private mode */ }
  if (active >= 25) {
    try { sessionStorage.setItem('activeMin', '0'); } catch { /* ignore */ }
    modal({ title: '休息一下吧', body: `<p>已經專心學習 25 分鐘了，起來喝口水、看看遠方 5 分鐘，眼睛和腦袋都會更清楚！</p>
      <button class="btn block" data-close>好，我休息一下</button>` });
    return;
  }
  const me = state.me;
  const day = localDay();
  if (me && me.daily_limit && active % 5 === 0) {
    try {
      const m = await get('/api/me');
      state.me = m;
      if (m.minutes_today >= m.daily_limit && localStorage.getItem('limitNote') !== day) {
        localStorage.setItem('limitNote', day);
        toast(`今天已經學 ${m.minutes_today} 分鐘了，超過爸媽設定的 ${m.daily_limit} 分鐘，記得休息喔`, 'bad');
      }
    } catch { /* offline */ }
  }
}, 60000);

// A tablet logged in as the same child: when the computer opens 「用 iPad 寫」,
// offer to jump straight to the paper — no QR code needed.
const touchDevice = window.matchMedia('(pointer: coarse)').matches;
let padOffered = '';
setInterval(async () => {
  const u = state.status && state.status.user;
  if (!touchDevice || !u || u.role === 'parent' || document.hidden || document.getElementById('padarea')) return;
  try {
    const p = await get('/api/pads/active');
    const old = document.getElementById('padcall');
    if (!p.token) { if (old) old.remove(); return; }
    if (p.token === padOffered || old) return;
    padOffered = p.token;
    const b = document.createElement('div');
    b.id = 'padcall';
    b.className = 'padcall';
    b.innerHTML = `<span style="flex:1;min-width:0"><b>電腦上的計算紙在等你</b><br><span class="small">${esc((p.stem || '').replace(/\$[^$]*\$/g, '…').slice(0, 30))}</span></span>
      <a class="btn" href="/pad.html?t=${encodeURIComponent(p.token)}">開始寫</a><button class="icon-btn" aria-label="關閉">${icon('close', 18)}</button>`;
    b.querySelector('button').onclick = () => b.remove();
    document.body.appendChild(b);
  } catch { /* offline */ }
}, 4000);

start();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Wi-Fi gone (the router reboots every night): say so once, and when it is back
window.addEventListener('offline', () => {
  if (document.getElementById('offbar')) return;
  const d = document.createElement('div');
  d.id = 'offbar';
  d.className = 'offbar';
  d.textContent = '📶 網路斷了：寫好的不會不見，連回來後再按一次就好';
  document.body.appendChild(d);
});
window.addEventListener('online', () => {
  const d = document.getElementById('offbar');
  if (d) { d.remove(); toast('網路恢復了', 'ok'); }
});

// 家長模式中: visible while a PIN unlocks parent powers on a child's profile
function parentBar() {
  let bar = document.getElementById('pinbar');
  const on = state.parentPin && state.status && state.status.user && state.status.user.role !== 'parent';
  if (!on) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pinbar';
    bar.className = 'pinbar';
    bar.innerHTML = '🔓 家長模式中 <button class="btn sm ghost">鎖定</button>';
    bar.querySelector('button').onclick = () => { setParentPin(''); bar.remove(); location.hash = '#/'; };
    document.body.appendChild(bar);
  }
}

// A tablet keeps its page open for days: when the Pi has a newer version, the page switches to
// it at the next page change (or when it comes back to the screen) — never in the middle of
// writing on the paper or answering.
async function checkBuild() {
  if (!MY_BUILD || newBuild) return;
  try {
    const st = await get('/api/status');
    if (st.build && st.build !== MY_BUILD) {
      newBuild = true;
      if (document.visibilityState === 'visible' && !document.querySelector('#modal-root .modal-bg')) location.reload();
    }
  } catch { /* offline: next time */ }
}
setInterval(checkBuild, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkBuild(); });
