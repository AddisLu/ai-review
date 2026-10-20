// Rendering helpers shared by every view.
import { state } from './api.js';
import { barModelVisual, bindReplay } from './visuals.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 注音 the way Taiwanese books print it: the symbols stacked in a column on the right of the
// character, the tone mark (ˊˇˋ) beside the last symbol, 輕聲 ˙ above the first. A □ is a box to
// write the character in. Works in 橫書 and 直書 (the cell keeps itself upright).
const TONES = { 'ˊ': 2, 'ˇ': 3, 'ˋ': 4 };
export function zhuyin(base, py) {
  const chars = [...String(py).replace(/\s+/g, '')];
  let light = '', tone = '';
  const syms = [];
  for (const ch of chars) {
    if (ch === '˙') light = ch;
    else if (TONES[ch]) tone = ch;
    else syms.push(ch);
  }
  if (!syms.length || syms.length > 4 || syms.some((c) => !/[\u3105-\u3129\u31A0-\u31BA]/.test(c))) {
    return `<ruby>${base}<rt>${py}</rt></ruby>`;  // not 注音 (pinyin, a note…): plain ruby
  }
  const n = syms.length;
  const col = (light ? `<i class="zy-l">${light}</i>` : '') + syms.map((c) => `<i>${c}</i>`).join('');
  return `<span class="zy zy${n}${light ? ' zyl' : ''}${base === '□' ? ' zyb' : ''}"><span class="zy-c${base === '□' ? ' zy-box' : ''}">${base === '□' ? '' : base}</span>`
    + `<span class="zy-r"><span class="zy-p">${col}</span><span class="zy-t">${tone ? `<i style="grid-row:${n + (light ? 1 : 0)}">${tone}</i>` : ''}</span></span></span>`;
}

// Text markup used everywhere: $latex$, {字|注音} ruby, **bold**, newlines.
export function rich(text) {
  const parts = String(text ?? '').split(/(\$[^$]+\$)/g);
  return parts.map((p) => {
    if (/^\$[^$]+\$$/.test(p)) return esc(p);
    let s = esc(p.replace(/\\n/g, '\n'));
    s = s.replace(/\{([^{}|]+)\|([^{}]+)\}/g, (_, base, rt) => {
      const bs = [...base], ps = rt.trim().split(/\s+/);  // {窗戶|ㄔㄨㄤ ㄏㄨˋ}: one cell per character
      if (bs.length === ps.length) return bs.map((b, i) => zhuyin(b, ps[i])).join('');
      return `<ruby>${base === '□' ? '<span class="box-blank"></span>' : base}<rt>${rt}</rt></ruby>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }).join('');
}

export function typeset(root) {
  if (!root) return;
  bindReplay(root);
  const go = () => window.renderMathInElement && window.renderMathInElement(root, {
    delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false,
  });
  if (window.renderMathInElement) go();
  else window.addEventListener('load', go, { once: true });
}

export function html(el, markup) {
  el.innerHTML = markup;
  typeset(el);
  return el;
}

export function toast(msg, kind = '', action = null) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  if (action) {  // e.g. { label: '打開', href: '#/exam/12' }: a way straight to what the message is about
    const a = document.createElement('a');
    a.className = 'toast-act';
    a.href = action.href;
    a.textContent = action.label;
    a.onclick = () => t.remove();
    t.appendChild(a);
  }
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), action ? 7000 : kind === 'bad' ? 5000 : 2800);
}

export function errToast(e) {
  console.error(e);
  toast(e.message || String(e), 'bad');
}

// modal({title, body (html string), wide, full, onOpen(el, close)}) -> Promise resolved on close
const openModals = new Set();

// Called on every route change so a dialog never outlives its page.
export function closeAllModals() {
  [...openModals].forEach((close) => close());
}

export function modal({ title = '', body = '', wide = false, full = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg' + (full ? ' full' : '');
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${full ? 'full' : ''}">
      ${title ? `<div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="關閉">✕</button></div>` : ''}
      <div class="modal-body">${body}</div></div>`;
    const close = (v) => {
      if (!openModals.has(close)) return;
      openModals.delete(close);
      bg.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    openModals.add(close);
    const onKey = (e) => { if (e.key === 'Escape' && !full) close(); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', (e) => {
      if ((e.target === bg && !full) || e.target.closest('[data-close]')) close();
    });
    document.getElementById('modal-root').appendChild(bg);
    typeset(bg);
    onOpen && onOpen(bg.querySelector('.modal'), close);
  });
}

export function confirmBox(msg, ok = '確定', danger = false) {
  return modal({
    title: '請確認',
    body: `<p>${msg}</p><div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>取消</button>
      <button class="btn ${danger ? 'bad' : ''}" data-ok>${ok}</button></div>`,
    onOpen: (m, close) => m.querySelector('[data-ok]').onclick = () => close(true),
  });
}

export function promptBox(title, value = '', placeholder = '') {
  return modal({
    title,
    body: `<input type="text" value="${esc(value)}" placeholder="${esc(placeholder)}">
      <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-close>取消</button><button class="btn" data-ok>確定</button></div>`,
    onOpen: (m, close) => {
      const i = m.querySelector('input');
      i.focus(); i.select();
      const done = () => close(i.value.trim());
      m.querySelector('[data-ok]').onclick = done;
      i.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) done(); };
    },
  });
}

// Busy overlay with a message that can be updated while a job runs. With leave: true it has a
// 「先去做別的」 button; it also goes away when she moves to another page (b.left is then true and
// the work carries on on the Pi).
export function busy(msg = '處理中…', { leave = false } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal center" role="status" aria-live="polite" style="width:min(380px,100%)"><div class="spinner" style="width:42px;height:42px"></div>
    <p class="msg" style="font-weight:700;margin:16px 0 8px">${esc(msg)}</p>
    <div class="progress"><i style="width:3%"></i></div>
    ${leave ? '<button class="btn ghost sm" data-leave style="margin-top:14px">先去做別的，好了再通知我</button>' : ''}</div>`;
  document.getElementById('modal-root').appendChild(bg);
  const b = {
    left: false,
    update(j) {
      if (j.message) bg.querySelector('.msg').textContent = j.message;
      if (j.progress != null) bg.querySelector('.progress i').style.width = Math.max(3, j.progress || 0) + '%';
    },
    close() { openModals.delete(leaveNow); bg.remove(); },
  };
  const leaveNow = () => { b.left = true; b.close(); };
  openModals.add(leaveNow);
  const lb = bg.querySelector('[data-leave]');
  if (lb) lb.onclick = leaveNow;
  return b;
}

// --- celebration -------------------------------------------------------------
let audio;
export function sound(kind) {
  if (localStorage.getItem('mute') === '1') return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const notes = { ok: [660, 880], bad: [300, 220], win: [523, 659, 784, 1047], tick: [900] }[kind] || [600];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = kind === 'bad' ? 'triangle' : 'sine';
      o.frequency.value = f;
      const t = audio.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + 0.2);
    });
  } catch { /* audio not available */ }
}

export function confetti(n = 80) {
  const colors = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#fde047'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 1.6 + Math.random() * 1.8 + 's';
    c.style.animationDelay = Math.random() * 0.4 + 's';
    c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

export function showReward(res) {
  if (!res) return;
  const r = res.reward || {};
  // right after a wrong answer, keep the news but skip the party
  const party = res.correct !== false && res.result !== 'wrong';
  if (r.level_up) { toast(`升級了！現在是等級 ${r.level_up}`, 'gold'); if (party) { confetti(); sound('win'); } }
  if (r.goal_reached) toast('達成今日目標！+10 金幣', 'gold');
  (res.new_badges || []).forEach((b) => { toast(`獲得新徽章：${b}`, 'gold'); if (party) confetti(40); });
  window.dispatchEvent(new Event('me-changed'));
}

// --- domain helpers --------------------------------------------------------------
export const SUBJECT_META = () => (state.status && state.status.subjects) || {};
export function subjectIcon() { return ''; }
export function subjectColor(s) { return (SUBJECT_META()[s] || {}).color || '#64748b'; }

export const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

export function optionsHtml(q, cls = '') {
  if (!q.options || !q.options.length) return '';
  const two = q.options.every((o) => String(o).length < 14);
  return `<div class="options ${two ? 'cols2' : ''} ${cls}">${q.options.map((o, i) =>
    `<div class="opt"><span>${CIRCLED[i] || i + 1}</span><span>${rich(o)}</span></div>`).join('')}</div>`;
}

export function markTag(m) {
  return { correct: '<span class="tag ok">老師打勾</span>', wrong: '<span class="tag bad">老師打叉</span>',
    partial: '<span class="tag warn">部分給分</span>' }[m] || '';
}

export function flagTags(q) {
  const t = [];
  if (q.is_wrong) t.push(q.mastered ? '<span class="tag ok">已精熟</span>' : `<span class="tag bad">錯題${q.wrong_count > 1 ? `・錯 ${q.wrong_count} 次` : ''}</span>`);
  else if (q.wrong_count) t.push(`<span class="tag gray">錯過 ${q.wrong_count} 次</span>`);
  if (q.is_highlighted) t.push('<span class="tag hl">螢光筆</span>');
  if (q.is_marked) t.push('<span class="tag warn">記號</span>');
  if (q.source === 'similar') t.push('<span class="tag gray">舉一反三</span>');
  if (q.source === 'ai') t.push('<span class="tag gray">AI 出題</span>');
  return t.join(' ');
}

// Bar model (線段圖) SVG from the AI's JSON description.
export function barModelSvg(bm) {
  return barModelVisual(bm);
}

// YYYY-MM-DD in local time (toISOString is UTC: before 8 am in Taiwan it gives yesterday)
// the first day of this school term (上學期 from August, 下學期 from February) — 期中、期末 cover it
export function termStart(d = new Date()) {
  const y = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 8 ? `${y}-08-01` : m === 1 ? `${y - 1}-08-01` : `${y}-02-01`;
}

export function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(s) {
  if (!s) return '';
  return s.slice(0, 10).replace(/-/g, '/');
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Line icons (24px grid, stroke = currentColor) used across the UI.
const ICONS = {
  minus: '<path d="M5 12h14"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.7-2.3L4.4 14.6a1.5 1.5 0 0 1 2.3-1.9L8 14"/>',
  lasso: '<path d="M7 17c-2-1-3-3-3-5 0-4 4-7 8-7s8 3 8 7-4 7-8 7c-1 0-2 0-3-.4"/><path d="M7 17c0 2-1 3-2 4"/><circle cx="8" cy="17.5" r="1.5"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  newpage: '<path d="M6 3h8l4 4v14H6z"/><path d="M12 11v6M9 14h6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  map: '<path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-9z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  redo: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4h4"/>',
  doc: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 16h6"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  marker: '<path d="m9 15 6-6 3 3-6 6H9z"/><path d="M4 20h7"/>',
  x: '<path d="M7 7l10 10M17 7 7 17"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  swords: '<path d="M4 4l9 9M20 4l-9 9M5 15l4 4M15 19l4-4M7 17l-3 3M17 17l3 3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M12 9v11M4 13h16M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  eraser: '<path d="m4 16 9-9 7 7-6 6H8z"/><path d="M14 20h6"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
};

export function icon(name, size = 20, extra = '') {
  return `<svg class="ico-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name] || ''}</svg>`;
}
