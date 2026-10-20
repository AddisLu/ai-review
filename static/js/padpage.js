// 用平板寫: the tablet side. Full-screen paper (same toolbar as the computer);
// each finished stroke goes to the computer, which mirrors it and runs the AI
// grading. The token in the URL (from the QR code) is the only credential.
import { Pad } from './canvas.js';
import { bindShell, bindToolbar, writingShell } from './padui.js';
import { $, esc, icon, rich, toast, typeset } from './ui.js';

const token = new URLSearchParams(location.search).get('t') || '';
const api = async (method, path, body) => {
  const r = await fetch(`/api/pad/${encodeURIComponent(token)}${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `連線失敗（${r.status}）`);
  return j;
};

const RESULT = { correct: ['全部正確！', 'ok'], wrong: ['有地方要訂正', 'bad'], incomplete: ['還沒寫完喔', 'warn'], unreadable: ['看不太清楚，字寫大一點', 'warn'] };
let pad, ui, tb, sentV = 0, lastStatus = '', resultV = 0, dead = false;

function setLink(ok, text) {
  const el = $('#link');
  if (el) el.innerHTML = `<span class="dot ${ok ? 'on' : ''}"></span><span class="hide-sm">${text}</span>`;
}

async function start() {
  let st;
  try { st = await api('GET', '?v=-1&side=tablet'); } catch (e) { fail(e.message); return; }
  const q = st.question || {};
  const root = $('#root');
  root.innerHTML = writingShell({
    title: `計算紙${q.unit ? `・${q.unit}` : ''}`,
    question: {
      line: rich((q.stem || '').replace(/\n/g, ' ')),
      html: `<div class="stem${q.vertical ? ' vstem' : ''}">${rich(q.stem)}</div>
        ${q.figure ? `<img class="fig" src="/api/pad/${encodeURIComponent(token)}/figure" style="max-height:180px;display:block;margin-top:6px">` : ''}
        ${(q.options || []).length ? `<div class="options">${q.options.map((o, i) => `<div class="opt"><span>${'①②③④⑤⑥'[i] || i + 1}</span><span>${rich(o)}</span></div>`).join('')}</div>` : ''}`,
    },
    actions: `<span class="small" id="link"><span class="dot"></span>連線中…</span>
      <button class="btn ok" id="send">寫好了，送到電腦批改</button>`,
  });
  root.querySelector('[data-close]').remove(); // nothing to close on the tablet: the computer ends it
  typeset(root);
  pad = new Pad($('#padarea'));
  tb = bindToolbar(root, pad);
  ui = bindShell(root, pad);
  if (st.strokes && st.strokes.length) pad.setStrokes(st.strokes, st.w);
  sentV = st.v;
  lastStatus = st.status;
  pad.onpen = () => { tb.syncPenOnly(); toast('偵測到觸控筆：手掌不會畫到紙上，手指可以移動紙張', 'ok'); };
  // every finished stroke (and erase / undo / new page) goes to the computer
  let timer = null;
  const prev = pad.onchange;
  pad.onchange = () => { prev && prev(); clearTimeout(timer); timer = setTimeout(push, 200); };
  $('#send').onclick = async () => {
    if (pad.isEmpty()) { toast('先在紙上寫下你的算式喔！'); return; }
    clearTimeout(timer);
    if (!await push()) { toast('還沒連上電腦，等一下再按一次', 'bad'); return; }
    try {
      await api('POST', '/submit');
      $('#send').disabled = true;
      $('#send').innerHTML = '<span class="spinner"></span> 電腦正在批改…';
    } catch (e) { toast(e.message, 'bad'); }
  };
  setLink(true, '已連到電腦');
  poll();
}

// one upload at a time; anything written meanwhile goes in the next one (never an older
// copy landing after a newer one). Resolves true once the computer has the latest writing.
let pushing = null, dirty = false, retry = 0;
function push() {
  dirty = true;
  if (pushing) return pushing;
  pushing = (async () => {
    let ok = true;
    while (dirty) {
      dirty = false;
      try {
        const r = await api('PUT', '', { strokes: pad.exportStrokes(), w: pad.W, h: pad.H });
        sentV = r.v;
        setLink(true, '已連到電腦');
      } catch (e) {
        ok = false;
        setLink(false, '連不到電腦，寫的內容還在，稍後會再送');
        clearTimeout(retry);
        retry = setTimeout(push, 3000);
        break;
      }
    }
    pushing = null;
    return ok;
  })();
  return pushing;
}

async function poll() {
  if (dead) return;
  try {
    const st = await api('GET', `?v=${sentV}&side=tablet`);
    if (st.status === 'graded' && st.result && st.result_v !== resultV) { resultV = st.result_v; showResult(st.result); }
    lastStatus = st.status;
    setLink(true, '已連到電腦');
  } catch (e) {
    if (/結束/.test(e.message)) { fail(e.message); return; }
    setLink(false, '連線不穩，重試中…');
  }
  setTimeout(poll, 1500);
}

function showResult(r) {
  const [title, cls] = RESULT[r.result] || RESULT.wrong;
  $('#send').disabled = !!r.partial;
  $('#send').textContent = r.partial ? '電腦正在批改…' : r.result === 'correct' ? '寫好了，送到電腦批改' : '訂正好了，再送一次';
  $('#out').innerHTML = `<div class="result-banner ${cls === 'ok' ? 'ok' : 'bad'}"><span class="dotc">${icon(cls === 'ok' ? 'check' : 'x', 18)}</span><b>${title}</b></div>
    ${r.diagnosis ? `<div style="margin:-4px 0 8px">${rich(r.diagnosis)}</div>` : ''}
    ${r.next_hint && r.result !== 'correct' ? `<div class="small" style="margin-bottom:8px">下一步：${rich(r.next_hint)}</div>` : ''}
    ${r.result !== 'correct' ? `<div class="row" style="gap:8px;margin-bottom:8px"><button class="btn" id="fixnew">${icon('newpage', 16)} 換一張新的計算紙訂正</button>
      <button class="btn ghost" id="fixred">在這頁用紅筆訂正</button></div>` : ''}
    <div class="small muted">${r.partial ? '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> 電腦正在逐行批改…' : '逐行的詳細批改在電腦上。'}</div>`;
  typeset($('#out'));
  ui.show('批改結果');
  const fn = $('#fixnew');
  if (fn) fn.onclick = () => { pad.newPage(); pad.setPen('black'); tb.show(); ui.hide(); toast('新的一頁！前一頁還在「‹」可以看', 'ok'); };
  const fr = $('#fixred');
  if (fr) fr.onclick = () => { pad.setPen('red'); tb.show(); ui.hide(); };
}

function fail(msg) {
  dead = true;
  document.body.innerHTML = `<div class="login"><h1>手寫連線已結束</h1><p class="sub">${esc(msg)}</p>
    <p class="small muted">回到電腦上的題目，重新按「用 iPad 寫」並再掃一次 QR code。</p></div>`;
}

start();
