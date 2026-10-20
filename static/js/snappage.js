// 用手機拍: the phone side of the desktop scan page. Each photo is shrunk and
// sent the moment it is taken or picked; 「完成」 (here or on the computer)
// turns them into one exam, which the AI sorts out in the background — the
// camera is ready for the next exam at once. The QR code's token is the only credential.
import { shrink } from './views/scan.js';
import { $, esc, toast } from './ui.js';
import { editCorners } from './corners.js';
import { cameraAvailable, openCamera } from './camera.js';

const token = new URLSearchParams(location.search).get('t') || '';
const base = `/api/snap/${encodeURIComponent(token)}`;
let count = 0, busy = 0, dead = false, sent = 0;
const fixed = new Set();  // pages whose corners were placed by hand

async function call(method, path = '', body) {
  const r = await fetch(base + path, { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `連線失敗（${r.status}）`);
  return j;
}

function draw() {
  $('#camlabel').textContent = count ? `拍第 ${count + 1} 頁` : '拍第 1 頁';
  $('#done').classList.toggle('hidden', !count);
  $('#done').textContent = busy ? `上傳中…（${busy}）` : `完成，開始整理 ${count} 頁`;
  $('#done').disabled = !!busy;
  $('#thumbs').innerHTML = Array.from({ length: count }, (_, i) => `<div class="thumb"><img src="${base}/thumb/${i}?v=${count}" alt="第 ${i + 1} 頁">
    <span class="n">第 ${i + 1} 頁</span><button class="x" data-i="${i}" aria-label="刪除第 ${i + 1} 頁">✕</button>
    <button class="cn-fix" data-c="${i}">${fixed.has(i) ? '已調整' : '調整四角'}</button></div>`).join('');
  $('#thumbs').querySelectorAll('[data-c]').forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.c);
    try {
      const r = await call('GET', `/corners/${i}`);
      const c = await editCorners(`${base}/view/${i}?v=${count}`, r.set || r.auto, { auto: r.auto, title: `第 ${i + 1} 頁：調整四個角` });
      if (!c) return;
      await fetch(`${base}/corners/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ corners: c }) });
      fixed.add(i); draw();
    } catch (e) { toast(e.message, 'bad'); }
  });
  $('#thumbs').querySelectorAll('.x').forEach((b) => b.onclick = async () => {
    if (!confirm(`刪除第 ${Number(b.dataset.i) + 1} 頁？`)) return;
    try { count = (await call('DELETE', `/photo/${b.dataset.i}`)).count; fixed.clear(); draw(); } catch (e) { toast(e.message, 'bad'); }
  });
}

async function send(files, spread = null, corners = null) {
  let id = null;  // of the last photo sent (the camera fixes it up after its check)
  for (const f of files) {
    busy++; draw();
    try {
      const x = await shrink(f);
      const fd = new FormData();
      fd.append('file', x, x.name || 'photo.jpg');
      if (spread !== null && spread !== undefined) fd.append('spread', spread ? '1' : '0');
      if (corners) fd.append('corners', JSON.stringify(corners));
      const r = await call('POST', '/photo', fd);
      count = r.count; id = r.id;
    } catch (e) { toast(e.message, 'bad'); }
    busy--; draw();
  }
  return id;
}

async function poll() {
  if (dead) return;
  try {
    const st = await call('GET', '?side=phone');
    const n = (st.sent || []).length;
    if (n > sent) { sent = n; if (!busy) { count = st.count; draw(); } sentNote(); } // finished from the computer
    if (!busy && st.count !== count) { count = st.count; draw(); }
    $('#link').innerHTML = `<span class="dot on"></span>已連到電腦${st.owner ? `・拍給：<b>${esc(st.owner)}</b>` : ''}`;
  } catch (e) {
    if (/結束/.test(e.message)) { fail(e.message); return; }
    $('#link').innerHTML = '<span class="dot"></span>連線不穩，重試中…';
  }
  setTimeout(poll, 2000);
}

// one exam sent: say so, and the camera is ready for the next one
function sentNote() {
  let el = $('#sentnote');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sentnote';
    el.className = 'card tight';
    el.style.cssText = 'border-color:var(--ok);background:var(--ok-soft);margin:0 0 12px';
    $('#root').prepend(el);
  }
  el.innerHTML = `<b>第 ${sent} 份已送出 ✓</b><div class="small">AI 會在背景整理，好了電腦上會通知。<b>可以直接拍下一份</b>，不用再掃 QR code。</div>`;
}

function fail(msg) {
  dead = true;
  $('#root').innerHTML = `<h1>拍照連線已結束</h1><p class="sub">${esc(msg)}</p>`;
}

$('#cam').onchange = (e) => { send([...e.target.files]); e.target.value = ''; };
if (!cameraAvailable() && location.protocol === 'http:') {
  fetch('/api/status').then((r) => r.json()).then((st) => {
    if (!st.secure_url) return;
    const b = document.createElement('div');
    b.className = 'card tight secure-tip';
    b.innerHTML = `<b>要有對準框、拍攝 NG 紅框提醒的相機？</b><span class="small">請改用安全連線開這個頁面。</span>
      <a class="btn ok sm" href="${st.secure_url}${location.pathname}${location.search}">改用安全連線開啟</a>`;
    $('#root').querySelector('.sub').after(b);
  }).catch(() => {});
}
if (cameraAvailable()) {
  $('#cam').closest('label').addEventListener('click', async (e) => {
    e.preventDefault();
    const r = await openCamera({
      count, checkUrl: `${base}/check`,
      onShot: (file, info) => send([file], info.spread, info.verified ? info.corners : null),
      // the Pi's own look at a photo already sent: its corners / 單頁雙頁, or taken back when out of focus
      onFix: (id, patch) => fetch(`${base}/p/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {}),
      onDrop: async (id) => { try { count = (await call('DELETE', `/p/${id}`)).count; fixed.clear(); draw(); } catch (e) { toast(e.message, 'bad'); } },
    });
    if (r.error) { toast(`相機打不開（${r.error}），改用手機的相機`, 'bad'); $('#cam').click(); }
  });
}
$('#pick').onchange = (e) => { send([...e.target.files]); e.target.value = ''; };
$('#done').onclick = async () => {
  if (count === 1 && !confirm('這份考卷只有 1 頁，確定拍完了嗎？（考卷有很多頁的話，請繼續拍下一頁再按完成）')) return;
  try {
    const r = await call('POST', '/done');
    sent = r.n || sent + 1;
    count = 0; fixed.clear(); draw(); sentNote();
    window.scrollTo(0, 0);
  } catch (e) { toast(e.message, 'bad'); }
};
draw();
poll();
