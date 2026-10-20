// Thin fetch wrapper: adds the current student / parent PIN headers and turns
// server errors into readable messages.
// The parent PIN typed on a child's device lasts while the parent is using it: 10 idle minutes,
// or until the parent pages are left (app.js), then the device is the child's again.
const PIN_IDLE = 10 * 60 * 1000;
let pinAt = 0;
function storedPin() {
  try {
    pinAt = Number(sessionStorage.getItem('parentPinAt') || 0);
    if (Date.now() - pinAt < PIN_IDLE) return sessionStorage.getItem('parentPin') || '';
    sessionStorage.removeItem('parentPin');
  } catch { /* private mode */ }
  return '';
}
export function setParentPin(pin) {
  state.parentPin = pin || '';
  pinAt = Date.now();
  try {
    if (pin) { sessionStorage.setItem('parentPin', pin); sessionStorage.setItem('parentPinAt', String(Date.now())); }
    else { sessionStorage.removeItem('parentPin'); sessionStorage.removeItem('parentPinAt'); }
  } catch { /* private mode */ }
}

export const state = {
  studentId: Number(localStorage.getItem('studentId') || 0),
  parentPin: storedPin(),
  status: null,
  me: null,
};

function headers(extra = {}) {
  const h = { ...extra };
  if (state.studentId) h['X-Student-Id'] = String(state.studentId);
  if (state.parentPin && Date.now() - pinAt > PIN_IDLE) setParentPin('');  // idle too long
  if (state.parentPin) {
    h['X-Parent-Pin'] = state.parentPin;
    pinAt = Date.now();
    try { sessionStorage.setItem('parentPinAt', String(pinAt)); } catch { /* private mode */ }
  }
  return h;
}

async function handle(res) {
  if (res.status === 401) {
    if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    throw new Error('請先登入');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = (data && data.detail) || (typeof data === 'string' ? data : '') || `錯誤 ${res.status}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function api(path, { method = 'GET', body, form, signal } = {}) {
  const opts = { method, headers: headers(), signal };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(path, opts); } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw offline();  // "Failed to fetch" / "Load failed": say what it means
  }
  return handle(res);
}

function offline() {
  const err = new Error('連不上學習站（Wi-Fi 可能斷了），請稍後再試');
  err.network = true;
  return err;
}

export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}

// Streams a text response chunk by chunk (AI tutor chat).
export async function stream(path, body, onChunk) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  } catch { throw offline(); }
  if (!res.ok) return handle(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let all = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const t = dec.decode(value, { stream: true });
    all += t;
    onChunk(t, all);
  }
  return all;
}

// Polls a background job until it finishes. onProgress(job) on every tick.
// A dropped poll (Wi-Fi blip, the router's nightly reboot, a restart) is retried for about a
// minute: the job keeps running on the Pi and its result is still there afterwards.
export async function waitJob(jobId, onProgress) {
  let lost = 0;
  for (;;) {
    let j;
    try {
      j = await get(`/api/jobs/${jobId}`);
      lost = 0;
    } catch (e) {
      if (!(e.network || e.status >= 500) || ++lost > 30) throw e;
      onProgress && onProgress({ status: 'running', message: '網路不穩，重新連線中…' });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    onProgress && onProgress(j);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.message || '處理失敗');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// a small picture for lists (the Pi makes and keeps 240 px copies)
// 家長權限: a parent's own login, or the parent PIN typed on a child's device
export const parentNow = () => (state.status && state.status.user && state.status.user.role === 'parent') || !!state.parentPin;

export function thumbUrl(rel, v, w = 240) {
  if (!rel) return '';
  return `/api/thumb/${rel}?w=${w}${v ? `&v=${v}` : ''}`;
}

export function mediaUrl(rel, v) {
  if (!rel) return '';
  return '/media/' + rel + (v ? `?v=${v}` : '');
}
