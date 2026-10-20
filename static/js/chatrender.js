// An AI reply in a conversation: text, plus
// - <visual>{…}</visual>: a teaching diagram (the animated SVG templates or the AI's own animated
//   SVG; tap to replay)
// - <qfig/>: the question's own figure, to point at
// - <steps>["…","…"]</steps>: an explanation shown one step at a time (「下一步」)
// - <check>{"q":"…","options":["…"],"answer":1,"right":"…","wrong":"…"}</check>: a small question
//   she answers by tapping, with feedback at once, then 「繼續」 tells the AI what she chose
// While the reply is still streaming in, a half-written block shows as 「畫圖中…」.
import { esc, rich } from './ui.js';
import { questionFigure, visualHtml } from './visuals.js';

const BLOCK = /<visual>([\s\S]*?)<\/visual>|<steps>([\s\S]*?)<\/steps>|<check>([\s\S]*?)<\/check>|<qfig\s*\/?>/g;
const json = (t) => JSON.parse(String(t).trim().replace(/^```(json)?|```$/g, ''));

export function chatHtml(text, q = {}) {
  let s = String(text || '');
  let tail = '';
  for (const tag of ['visual', 'steps', 'check']) {
    const open = s.lastIndexOf(`<${tag}`);
    if (open >= 0 && s.indexOf(`</${tag}>`, open) < 0) { // still being written
      s = s.slice(0, open);
      tail = `<div class="small muted chat-drawing"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span> ${tag === 'visual' ? 'AI 正在畫圖…' : 'AI 正在準備…'}</div>`;
    }
  }
  const out = [];
  let last = 0;
  let m;
  BLOCK.lastIndex = 0;
  while ((m = BLOCK.exec(s))) {
    if (m.index > last) out.push(rich(s.slice(last, m.index)));
    try {
      if (m[1] !== undefined) {
        const v = json(m[1]);
        if (v && typeof v.params_json !== 'string' && v.params) v.params_json = JSON.stringify(v.params);
        out.push(visualHtml(v) || '');
      } else if (m[2] !== undefined) {
        const st = json(m[2]).filter((x) => typeof x === 'string' && x.trim()).slice(0, 8);
        if (st.length) {
          out.push(`<div class="chat-steps">${st.map((x, i) => `<div class="cs-step${i ? ' hidden' : ''}"><span class="cs-n">${i + 1}</span><div>${rich(x)}</div></div>`).join('')}
            ${st.length > 1 ? `<button class="chip cs-next">下一步 ›（1/${st.length}）</button>` : ''}</div>`);
        }
      } else if (m[3] !== undefined) {
        const c = json(m[3]);
        const opts = (c.options || []).slice(0, 5);
        if (c.q && opts.length) {
          out.push(`<div class="chat-check" data-answer="${Number(c.answer) || 0}" data-right="${esc(c.right || '答對了！')}" data-wrong="${esc(c.wrong || '再想想看～')}">
            <div class="cc-q">🤔 ${rich(c.q)}</div>
            <div class="cc-opts">${opts.map((o, i) => `<button class="cc-opt" data-i="${i + 1}">${rich(String(o))}</button>`).join('')}</div>
            <div class="cc-fb hidden"></div></div>`);
        }
      } else {
        out.push(questionFigure(q));
      }
    } catch { /* a block it could not write properly is left out */ }
    last = BLOCK.lastIndex;
  }
  if (last < s.length) out.push(rich(s.slice(last)));
  return out.join('') + tail;
}

// The text of a reply without its blocks (for reading it aloud)
export function chatSpeech(text) {
  return String(text || '').replace(/<visual>[\s\S]*?<\/visual>|<qfig\s*\/?>/g, '')
    .replace(/<steps>([\s\S]*?)<\/steps>/g, (_, x) => { try { return json(x).join('。'); } catch { return ''; } })
    .replace(/<check>([\s\S]*?)<\/check>/g, (_, x) => { try { const c = json(x); return `${c.q}${(c.options || []).map((o, i) => `，第${i + 1}個，${o}`).join('')}`; } catch { return ''; } })
    .replace(/[*#`$\\]/g, '');
}

// Taps on 下一步 and on a check's options, for every reply inside `root` (bind once).
// onSay(text): she answered a check — what to tell the AI so the conversation goes on.
export function bindChat(root, onSay) {
  if (root._chatBound) return;
  root._chatBound = true;
  root.addEventListener('click', (e) => {
    const nx = e.target.closest('.cs-next');
    if (nx) {
      const box = nx.closest('.chat-steps');
      const all = [...box.querySelectorAll('.cs-step')];
      const hid = all.find((x) => x.classList.contains('hidden'));
      if (hid) hid.classList.remove('hidden');
      const shown = all.filter((x) => !x.classList.contains('hidden')).length;
      if (shown >= all.length) nx.remove(); else nx.textContent = `下一步 ›（${shown}/${all.length}）`;
      return;
    }
    const op = e.target.closest('.cc-opt');
    if (op) {
      const box = op.closest('.chat-check');
      if (box.dataset.done) return;
      box.dataset.done = '1';
      const ok = Number(op.dataset.i) === Number(box.dataset.answer);
      box.querySelectorAll('.cc-opt').forEach((b) => {
        b.disabled = true;
        if (Number(b.dataset.i) === Number(box.dataset.answer)) b.classList.add('right');
      });
      op.classList.add(ok ? 'right' : 'wrong');
      const fb = box.querySelector('.cc-fb');
      fb.classList.remove('hidden');
      fb.classList.add(ok ? 'ok' : 'bad');
      fb.innerHTML = `${ok ? '🎉 ' : '💡 '}${rich(ok ? box.dataset.right : box.dataset.wrong)}
        ${onSay ? '<div><button class="chip cc-go">繼續 ›</button></div>' : ''}`;
      const go = fb.querySelector('.cc-go');
      if (go) go.onclick = () => { go.remove(); onSay(`我選「${op.textContent.trim()}」（${ok ? '答對了' : '答錯了'}）。`); };
    }
  });
}
