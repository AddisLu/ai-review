// 電子計算紙 + AI 逐步批改 (feature c): the child writes the working out by
// hand; the AI reads each line, finds the first wrong step, names the error
// type, re-teaches the concept and gives a next-step hint without the answer.
import { api, del, get, mediaUrl, post, stream } from '../api.js';
import { Pad } from '../canvas.js';
import { bindShell, bindToolbar, writingShell } from '../padui.js';
import { $, $$, confetti, confirmBox, errToast, esc, icon, modal, optionsHtml, rich, showReward, sound, toast, typeset } from '../ui.js';
import { answerBlock, leadHtml } from './common.js';
import { cleanSvg, questionFigure } from '../visuals.js';
import { bindChat, chatHtml, chatSpeech } from '../chatrender.js';
import { canListen, canSpeak, speak } from '../speech.js';

// next: opened from a quiz — after grading, 「下一題」 closes the paper and the quiz moves on
export function openTutor(q, { onDone, next = false } = {}) {
  let pad, hintLevel = 0, result = null, pair = null;
  const desktop = window.matchMedia('(pointer: fine)').matches;
  return modal({
    full: true,
    body: writingShell({
      title: `${isMath(q) ? '計算紙' : '想法紙'}・${q.unit || q.qtype || ''}`,
      question: { line: rich((q.stem || '').replace(/\n/g, ' ')), html: `${leadHtml(q, 'style="max-height:200px"')}<div class="stem${q.vertical ? ' vstem' : ''}">${rich(q.stem)}</div>
        ${questionFigure(q, 'style="max-height:200px"')}
        ${hasFigure(q) ? `<button class="btn sm soft" id="copyfig" style="margin:6px 0 8px">${icon('image', 16)} 把圖放到紙上，在圖上畫畫看</button>`
          : '<button class="btn sm soft" id="sketchfig" style="margin:6px 0 8px">✨ AI 幫我畫一張圖放到紙上</button>'}${optionsHtml(q)}` },
      actions: `${desktop ? `<button class="btn sm soft" id="pairbtn" title="用 iPad／手機寫">${icon('pen', 16)}<span class="hide-sm"> 用 iPad／手機寫</span></button>` : ''}
        <button class="btn sm ghost" id="askai">✋<span class="hide-sm"> 我不懂，</span>問 AI</button>
        <button class="btn sm ghost" id="hint">提示</button>
        <button class="btn ok" id="check">寫好了，批改</button>`,
    }),
    onOpen: (m, close) => {
      pad = new Pad(m.querySelector('#padarea'));
      const tb = bindToolbar(m, pad);
      const ui = bindShell(m, pad);
      pad.onpen = () => { tb.syncPenOnly(); toast('偵測到觸控筆：手掌不會畫到紙上，手指可以移動紙張', 'ok'); };
      const out = $('#out', m);
      // 把圖放到紙上: the figure goes onto the paper under her pen, so she can mark it up while
      // she reasons (colour the hexagons, draw the missing part, count by circling…)
      const cf = $('#copyfig', m);
      if (cf) cf.onclick = async () => {
        const f = await figureImage($('#qbody', m)).catch(() => null);
        if (!f) { toast('這張圖現在沒辦法放到紙上'); return; }
        pad.addPicture(f.src, f.w, f.h);
        pad.setTool('pen');
        tb.show && tb.show();
        toast('圖放到紙上了！直接在圖上畫線、塗色、圈起來；要移動它就用「圈選」把它圈起來拖', 'ok');
      };
      // AI 幫我畫圖: a question with no figure gets one drawn (what the question describes, the
      // unknown marked ?) and put on the paper the same way
      const sk = $('#sketchfig', m);
      if (sk) sk.onclick = async () => {
        const again = !!sk.dataset.done;
        sk.disabled = true;
        sk.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> AI 正在畫圖…';
        try {
          const r = await post(`/api/questions/${q.id}/sketch`, { again });
          const f = await sketchImage(r.svg);
          if (!f) throw new Error('這張圖畫不出來，再按一次試試看');
          pad.addPicture(f.src, f.w, f.h);
          pad.setTool('pen');
          tb.show && tb.show();
          toast(`${r.caption || '圖畫好了'}：直接在圖上畫畫看！`, 'ok');
          sk.dataset.done = '1';
          sk.textContent = '↻ 換一張圖';
        } catch (e) {
          errToast(e);
          sk.textContent = sk.dataset.done ? '↻ 換一張圖' : '✨ AI 幫我畫一張圖放到紙上';
        }
        sk.disabled = false;
      };
      const pb = $('#pairbtn', m);
      if (pb) pb.onclick = () => { if (!pair) { ui.show('用 iPad／手機寫'); startPairing(m, q, pad, () => pair, (p) => { pair = p; }); } else ui.show(); };

      // ✋ 我不懂，問 AI: say it, circle it, write it or type it — the AI teaches with pictures,
      // animations, steps and small checks, and never just hands over the answer
      const openAsk = () => {
        ui.show(result ? '批改結果・問 AI' : '問 AI');
        let box = $('#askbox', m);
        if (box) { box.scrollIntoView({ block: 'nearest' }); return box; }
        box = document.createElement('div');
        box.id = 'askbox';
        out.prepend(box);
        box.innerHTML = `<div class="card tight talk ask">
          <b class="ask-head">哪裡不懂？用你最方便的方式問 👇</b>
          <div class="ask-ways">
            <button class="ask-way" id="askmic"><span class="ask-ico">🎤</span><span>用說的</span></button>
            <button class="ask-way" id="asklasso"><span class="ask-ico">⭕</span><span>圈起來問</span></button>
            <button class="ask-way" id="talkpad"><span class="ask-ico">✏️</span><span>傳紙上寫的</span></button>
          </div>
          <div class="chips ask-chips">${ASK_CHIPS.map((c) => `<button class="chip" data-askq>${c}</button>`).join('')}</div>
          <div id="talklog"></div>
          <div class="row nowrap" style="gap:6px;margin-top:8px"><input type="text" id="talkin" placeholder="或打字問…" enterkeyhint="send" style="flex:1">
            <button class="btn" id="talksend">問</button></div></div>`;
        bindTalk(box, { follow_up_question: '' }, q, pad, true, { ui, tb, m });
        return box;
      };
      $('#askai', m).onclick = () => openAsk();
      // a normal lasso selection can be asked about too (問 AI on the selection bar)
      const selbar = m.querySelector('.selbar');
      if (selbar) {
        selbar.insertAdjacentHTML('afterbegin', '<button class="btn sm soft" data-sel="ask">✋ 問 AI</button>');
        selbar.querySelector('[data-sel=ask]').onclick = async () => {
          const sel = pad.selection;
          if (!sel) return;
          const img = await pad.regionToDataURL(sel.bb);
          pad.clearSelection();
          const box = openAsk();
          box._ask && box._ask('我圈起來的這裡看不懂', img);
        };
      }
      $('#hint', m).onclick = async (e) => {
        const btn = e.currentTarget;
        hintLevel = Math.min(3, hintLevel + 1);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
        ui.show('提示');
        try {
          const image = pad.isEmpty() ? null : await pad.toDataURL();
          const r = await post(`/api/questions/${q.id}/hint`, { level: hintLevel, image });
          out.insertAdjacentHTML('afterbegin', `<div class="explain" style="margin-bottom:10px"><b>提示 ${hintLevel}/3</b><div>${rich(r.hint)}</div>
            ${r.guiding_question ? `<div style="margin-top:4px">${rich(r.guiding_question)}</div>` : ''}
            ${r.look_at ? `<div class="small">注意：${rich(r.look_at)}</div>` : ''}</div>`);
          typeset(out);
        } catch (err) { errToast(err); hintLevel--; }
        btn.disabled = false;
        btn.textContent = hintLevel >= 3 ? '再一次提示' : `提示 ${hintLevel + 1}`;
        if (hintLevel >= 3) hintLevel = 2;
      };

      // 先對答案: one quick look reads her answer and checks it (counted at once). Right → just 「答對了」
      // and on to the next one; the line-by-line AI grading only runs when she asks for it.
      let attempt = 0;
      const fixButtons = () => `<div class="row" style="gap:8px;margin:10px 0">
        <button class="btn" id="fixnew">${icon('newpage', 16)} 換一張新的紙訂正</button>
        <button class="btn ghost" id="fixred">在這頁用紅筆訂正</button></div>`;
      const bindFix = () => {
        const fn = $('#fixnew', m), fr = $('#fixred', m);
        if (fn) fn.onclick = () => { pad.newPage(); pad.setPen('black'); tb.show(); ui.hide(); toast('新的一頁！前一頁還在「‹」可以看', 'ok'); };
        if (fr) fr.onclick = () => { pad.setPen('red'); tb.show(); ui.hide(); };
      };
      const nextBtn = (ok) => {
        if (!next) return;
        out.insertAdjacentHTML('afterbegin', ok
          ? '<button class="btn ok lg block" id="tnext" style="margin-bottom:12px">下一題 ›</button>'
          : '<button class="btn ghost sm" id="tnext" style="margin-bottom:10px">先跳過，下一題 ›</button>');
        $('#tnext', m).onclick = () => close('next');
      };
      const showAnswer = (el) => {
        const row = el.parentElement;
        el.remove();
        row.insertAdjacentHTML('afterend', `<div class="card tight" style="margin:10px 0"><div>正確答案：<b>${rich(q.answer || '')}</b></div>
          <details style="margin-top:6px"><summary style="cursor:pointer">看詳解</summary>${answerBlock({ ...q, solved: 1 }, true)}</details></div>`);
        typeset(out);
      };
      // the full line-by-line grading (AI 看哪裡錯): fills in this try's attempt, nothing is counted twice
      const fullGrade = async (btn) => {
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> AI 正在逐行看…'; }
        try {
          const blob = await pad.toBlob();
          const fd = new FormData(); fd.append('image', blob, 'work.png'); if (attempt) fd.append('attempt', String(attempt));
          result = await api(`/api/questions/${q.id}/tutor`, { method: 'POST', form: fd });
          const asked = $('#askbox', m);  // a conversation she already started stays
          renderResult(out, result, q, pad);
          if (asked) out.append(asked);
          if (result.result !== 'correct') {
            const anchor = out.querySelector('.explain') || out.lastElementChild;
            anchor.insertAdjacentHTML('beforebegin', fixButtons());
            bindFix();
            if (q.figure_path) {
              // she may be right and the AI misread the figure: correct it, then grade again
              out.insertAdjacentHTML('beforeend', '<button class="btn link sm" id="fixfig" style="padding:0;margin-top:8px">我覺得我是對的（AI 是不是看錯圖了？）</button>');
              $('#fixfig', m).onclick = async () => {
                const { fixFigure } = await import('./common.js');
                if (!await fixFigure(q)) return;
                Object.assign(q, await get(`/api/questions/${q.id}`));
                attempt = 0;
                fullGrade(null);
              };
            }
          }
          nextBtn(result.result === 'correct');
          ui.show(result.result === 'correct' ? '批改結果' : '批改結果・可以訂正');
          if (pair) post(`/api/pad/${pair.token}/result`, result).catch(() => {});
          onDone && onDone(result);
        } catch (err) { errToast(err); if (btn) { btn.disabled = false; btn.textContent = 'AI 幫我看哪裡錯'; } }
      };

      $('#check', m).onclick = async (e) => {
        if (pad.isEmpty()) { toast(isMath(q) ? '先在紙上寫下你的算式喔！' : '先在紙上寫下你的想法喔！'); return; }
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 對答案中…';
        try {
          const blob = await pad.toBlob();
          const fd = new FormData(); fd.append('image', blob, 'work.png'); fd.append('record', '1');
          const qk = await api(`/api/questions/${q.id}/tutor/quick`, { method: 'POST', form: fd });
          attempt = qk.attempt_id || 0;
          result = { ...qk, diagnosis: qk.headline };
          const ok = qk.result === 'correct', decided = ok || qk.result === 'wrong';
          const [t, cls] = RESULT[qk.result] || RESULT.wrong;
          const asked = $('#askbox', m);
          out.innerHTML = `<div class="result-banner ${cls === 'ok' ? 'ok' : 'bad'}"><span class="dotc">${icon(cls === 'ok' ? 'check' : 'x', 18)}</span><b>${ok ? '答對了！' : t}</b>
              ${qk.reward && qk.reward.xp ? `<span class="num" style="color:var(--warm-ink)">+${qk.reward.xp} XP</span>` : ''}</div>
            ${qk.final_answer ? `<div class="small muted" style="margin:-4px 0 6px">AI 看到你的答案：<b style="color:var(--ink)">${esc(qk.final_answer)}</b></div>` : ''}
            ${!ok && qk.headline ? `<p style="margin:0 0 10px">${rich(qk.headline)}</p>` : ''}
            ${ok ? `<details><summary class="small" style="cursor:pointer">看標準詳解</summary>${answerBlock({ ...q, solved: 1 }, true)}</details>`
              : `<div class="row" style="gap:8px;margin:8px 0">
                  <button class="btn soft" id="tfull">AI 幫我看哪裡錯</button>
                  ${q.answer ? '<button class="btn ghost" id="tans">看答案</button>' : ''}</div>
                ${decided ? fixButtons() : ''}
                ${ok || decided ? '' : '<p class="small muted">AI 看不太清楚你寫的：可以寫大一點再按一次，或按「AI 幫我看哪裡錯」讓 AI 仔細看。</p>'}`}`;
          if (asked) out.append(asked);
          typeset(out);
          bindFix();
          const tf = $('#tfull', m);
          if (tf) tf.onclick = () => fullGrade(tf);
          const ta = $('#tans', m);
          if (ta) ta.onclick = () => showAnswer(ta);
          nextBtn(ok);
          ui.show(ok ? '批改結果' : '批改結果・可以訂正');
          if (pair) post(`/api/pad/${pair.token}/result`, { result: qk.result, diagnosis: qk.headline }).catch(() => {});
          if (ok) { sound('win'); confetti(40); } else if (decided) sound('bad');
          if (qk.reward) showReward(qk);
          onDone && onDone(result);
          // in a round, a right answer moves on by itself (she can still tap 下一題 sooner)
          if (ok && next) setTimeout(() => { if (m.isConnected && $('#tnext', m)) close('next'); }, 1400);
        } catch (err) { errToast(err); }
        btn.disabled = false;
        btn.textContent = result && result.result !== 'correct' ? '訂正好了，再批改' : '寫好了，批改';
      };
    },
  }).then((v) => {
    pad && pad.destroy();
    if (pair) { pair.stop = true; del(`/api/pads/${pair.token}`).catch(() => {}); }
    return v; // e.g. 'next': the quiz moves on
  });
}

// 用 iPad／手機寫: show a QR code; the tablet's strokes appear here live and
// 「寫好了」 on the tablet grades them on this screen.
async function startPairing(m, q, pad, getPair, setPair) {
  const out = $('#out', m);
  const box = document.createElement('div');
  box.className = 'card tight pairing';
  out.prepend(box);
  let r;
  try { r = await post('/api/pads', { question_id: q.id, origin: location.origin }); } catch (e) { box.remove(); errToast(e); return; }
  const pair = { token: r.token, v: -2, submitted: 0, stop: false };
  setPair(pair);
  box.innerHTML = `<b>用 iPad 或手機的相機掃描</b>${r.qr}
    <div class="small muted">掃描後直接在平板上寫，這裡會同步顯示；平板按「寫好了」就會在這裡批改。<br>平板已用同一個帳號登入的話，打開網站就會自動跳出。</div>
    <div class="small" id="pairst" style="margin-top:6px"><span class="dot"></span>等待平板連線…</div>
    <button class="btn link sm" id="pairstop">改回在這台電腦上寫</button>`;
  const note = document.createElement('div');
  note.className = 'mirror-note hidden';
  note.textContent = '正在同步平板上的筆跡';
  $('#padarea', m).appendChild(note);
  $('#pairstop', box).onclick = () => {
    pair.stop = true; setPair(null); pad.readOnly = false; note.remove(); box.remove();
    m.querySelector('.wpad').classList.remove('mirroring');
    del(`/api/pads/${pair.token}`).catch(() => {});
  };
  const tick = async () => {
    if (pair.stop || !m.isConnected) return;
    try {
      const st = await get(`/api/pad/${pair.token}?v=${pair.v}`);
      if (st.strokes && st.v > 0) {
        // the tablet's writing goes onto its own page here: whatever she already wrote on
        // the computer stays on the page before it
        if (pair.page == null) {
          pad.readOnly = false;
          if (pad.strokes.length) pad.newPage();
          pair.page = pad.page;
        }
        pad.setStrokes(st.strokes, st.w, pair.page);
        pair.v = st.v;
      } else if (st.v === 0) pair.v = 0;
      const online = st.tablet_online;
      pad.readOnly = online || pair.page != null;
      m.querySelector('.wpad').classList.toggle('mirroring', pad.readOnly);
      note.classList.toggle('hidden', !pad.readOnly);
      const stEl = $('#pairst', box);
      if (stEl) stEl.innerHTML = `<span class="dot ${online ? 'on' : ''}"></span>${online ? '平板已連線，正在寫…' : pair.v > 0 ? '平板暫時離線，筆跡已保留' : '等待平板連線…'}`;
      const svg = box.querySelector('svg');
      if (svg) svg.style.display = online ? 'none' : '';
      if (st.status === 'submit' && st.submit_v > pair.submitted) {
        pair.submitted = st.submit_v;
        if (pair.page != null && pad.page !== pair.page) { const ro = pad.readOnly; pad.readOnly = false; pad.gotoPage(pair.page); pad.readOnly = ro; }
        if (st.strokes && st.v > 0) pad.setStrokes(st.strokes, st.w, pair.page ?? pad.page);
        $('#check', m).click();
      }
    } catch (e) {
      if (/結束/.test(e.message)) { pair.stop = true; return; }
    }
    setTimeout(tick, 1000);
  };
  tick();
}

const RESULT = {
  correct: ['全部正確！', 'ok'], wrong: ['有地方要訂正', 'bad'],
  incomplete: ['還沒寫完喔', 'warn'], unreadable: ['看不太清楚', 'warn'],
};

const isMath = (q) => /數學/.test(q.subject || '');

export function renderResult(out, r, q, pad = null) {
  const [title, cls] = RESULT[r.result] || RESULT.wrong;
  out.innerHTML = `
    <div class="result-banner ${cls === 'ok' ? 'ok' : 'bad'}">
      <span class="dotc">${icon(cls === 'ok' ? 'check' : 'x', 18)}</span><b>${title}</b>
      <span class="num" style="color:var(--warm-ink)">+${r.reward?.xp || 0} XP</span>
    </div>
    ${r.error_type && r.error_type !== '無' ? `<div style="margin:-6px 0 10px"><span class="tag bad">${esc(r.error_type)}</span></div>` : ''}
    ${r.her_thinking ? `<div class="explain think"><div class="label">AI 覺得你是這樣想的</div><div>${rich(r.her_thinking)}</div></div>` : ''}
    <div class="label">${isMath(q) ? 'AI 看到的算式' : 'AI 看到你寫的'}</div>
    ${(r.recognized_steps || []).map((x, i) => `<div class="analysis-step ${x.status}">
      <span class="mk">${i + 1}</span>
      <div style="flex:1"><div>${rich(x.text)}</div>${x.comment ? `<div class="small">${rich(x.comment)}</div>` : ''}</div>
      <span class="small" style="white-space:nowrap">${x.status === 'ok' ? '正確' : x.status === 'error' ? '要訂正' : '可以更好'}</span></div>`).join('')}
    ${r.diagnosis ? `<div class="label" style="margin-top:14px">問題在哪裡</div><div>${rich(r.diagnosis)}</div>` : ''}
    ${r.concept ? `<div class="explain"><div class="label">觀念小教室</div><div>${rich(r.concept)}</div></div>` : ''}
    ${r.next_hint ? `<div class="explain" style="background:var(--warm-soft)"><div class="label">${r.result === 'correct' ? '挑戰一下' : '下一步試試看'}</div><div>${rich(r.next_hint)}</div></div>` : ''}
    ${r.encouragement ? `<p>${rich(r.encouragement)}</p>` : ''}
    ${r.review_units && r.review_units.length ? `<p class="small">建議複習：${r.review_units.map((u) => `<a href="#/learn/${encodeURIComponent(q.subject)}/${q.grade || 6}/${encodeURIComponent(u)}" data-close>${esc(u)}</a>`).join('、')}</p>` : ''}
    ${r.result === 'correct' ? `<details><summary>看標準詳解</summary>${answerBlock(q, true)}</details>` : ''}
    ${r.follow_up_question ? `<div class="card tight talk" style="margin-top:12px">
      <div class="label" style="margin:0 0 6px">AI 想問你</div><div style="font-size:16px"><b>${rich(r.follow_up_question)}</b></div>
      <div id="talklog"></div>
      <div class="row nowrap" style="gap:6px;margin-top:8px"><input type="text" id="talkin" placeholder="打字或用語音回答（鍵盤上的麥克風）" enterkeyhint="send" style="flex:1">
        <button class="btn" id="talksend">回答</button></div>
      ${pad ? '<button class="btn link sm" id="talkpad" style="padding:0;margin-top:6px">或在紙上寫下回答，再按這裡傳給 AI</button>' : ''}</div>` : ''}`;
  typeset(out);
  bindTalk(out, r, q, pad);
}

// 和 AI 聊她的想法: she answers the AI's question (typing, voice keyboard or writing on the paper);
// the AI keeps asking until it understands how she thinks (the 小老師 chat of this question)
const ASK_CHIPS = ['這題在問什麼？', '這個詞是什麼意思？', '可以畫圖給我看嗎？', '第一步要做什麼？', '我算到一半卡住了'];

function bindTalk(out, r, q, pad, asking = false, { ui, tb, m } = {}) {
  const send = out.querySelector('#talksend');
  if (!send) return;
  const input = out.querySelector('#talkin'), log = out.querySelector('#talklog');
  let asked = r.follow_up_question, talked = false;
  const ask = async (text, image) => {
    if (!text && !image) { input.focus(); return; }
    log.insertAdjacentHTML('beforeend', `<div class="talk-me">${image ? '<span class="small muted">（附上紙上的圖）</span> ' : ''}${text ? esc(text) : ''}</div>
      <div class="talk-ai"><span class="spinner" style="width:14px;height:14px;border-width:2px"></span> <span class="small muted">AI 小老師想一想…</span></div>`);
    const bubble = log.lastElementChild;
    bubble.scrollIntoView({ block: 'nearest' });
    input.value = ''; send.disabled = true;
    const msg = asking
      ? (talked ? (text || '我把回答寫在紙上了，請看圖。') : `我不懂的地方：${text || '請看我圈起來／寫在紙上的地方'}${image ? '（我附上紙上的圖，紅色虛線是我圈的）' : ''}`)
      : `（AI 剛才問我：「${asked}」）${text ? `我的回答：${text}` : '我把回答寫在紙上了，請看圖。'}\n請先說說你從我的回答看出我是怎麼想的，再用一個問題引導我（不要直接給答案）。`;
    try {
      const all = await stream(`/api/questions/${q.id}/chat`, { message: msg, image, mode: asking ? 'ask' : '' }, (_, a) => { bubble.innerHTML = chatHtml(a, q); });
      bubble.innerHTML = chatHtml(all, q);
      if (canSpeak()) {
        bubble.insertAdjacentHTML('beforeend', '<div><button class="chip talk-say">🔊 唸給我聽</button></div>');
        const sb = bubble.querySelector('.talk-say');
        sb.onclick = () => speak(chatSpeech(all), sb);
      }
      typeset(bubble);
      asked = all.slice(-120);
      talked = true;
    } catch (e) {
      if (!input.value) input.value = text;  // her question is not lost
      bubble.innerHTML = `AI 小老師暫時沒回應（${esc(e.message || '連線失敗')}）<br><button class="chip talk-retry">↻ 再問一次</button>`;
      bubble.querySelector('.talk-retry').onclick = () => { bubble.previousElementSibling?.remove(); bubble.remove(); input.value = ''; ask(text, image); };
    }
    send.disabled = false;
  };
  out._ask = ask;
  bindChat(log, (t) => ask(t, null));  // she answered a check in the reply: tell the AI and go on
  send.onclick = () => ask(input.value.trim(), null);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send.click(); } });
  out.querySelectorAll('[data-askq]').forEach((c) => c.onclick = () => ask(c.textContent, null));
  const tp = out.querySelector('#talkpad');
  if (tp && pad) tp.onclick = async () => { if (pad.isEmpty()) { toast(asking ? '先在紙上寫下你的問題（或圈起看不懂的地方）' : '先在紙上寫下你的回答'); return; } ask(input.value.trim(), await pad.toDataURL()); };
  // 🎤 用說的: the browser's speech recognition where it is allowed (https); otherwise the
  // keyboard's own microphone key does the same
  const mic = out.querySelector('#askmic');
  if (mic) mic.onclick = () => listen(mic, input, (t) => ask(t, null));
  // ⭕ 圈起來問: the next circle she draws is sent to the AI (her writing and the copied figure in it)
  const lb = out.querySelector('#asklasso');
  if (lb && pad && ui) lb.onclick = () => {
    pad.setTool('lasso');
    tb && tb.show && tb.show();
    ui.hide();
    toast('用筆把看不懂的地方圈起來 ⭕（題目的圖可以先按「把圖放到紙上」）', 'ok');
    pad.onlasso = (poly) => {
      pad.onlasso = null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      pad.regionToDataURL([x0, y0, x1, y1], poly).then((img) => {
        pad.setTool('pen');
        tb && tb.show && tb.show();
        ui.show('問 AI');
        ask(input.value.trim() || '我圈起來的這裡看不懂', img);
      });
      return true;
    };
  };
}

// Speech to text: where the browser allows it (a secure page), tap and speak; the words go in
// the box and are sent when she stops. Elsewhere the keyboard opens for its microphone key.
function listen(btn, input, onDone) {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!canListen() || !R) {
    input.focus();
    toast('按鍵盤上的 🎤 麥克風就可以用說的，說完按「問」', 'ok');
    return;
  }
  if (btn._rec) { btn._rec.stop(); return; }
  const rec = new R();
  rec.lang = 'zh-TW';
  rec.interimResults = true;
  btn._rec = rec;
  btn.classList.add('on');
  btn.querySelector('span:last-child').textContent = '我在聽…（再按一次停）';
  let text = '';
  rec.onresult = (e) => { text = [...e.results].map((x) => x[0].transcript).join(''); input.value = text; };
  rec.onerror = (e) => {  // not allowed / no speech service here: the keyboard's microphone still works
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    input.focus();
    toast(e.error === 'not-allowed' ? '瀏覽器沒有允許麥克風：可以按鍵盤上的 🎤 用說的' : '語音辨識現在不能用：可以按鍵盤上的 🎤 用說的', 'bad');
  };
  rec.onend = () => {
    btn._rec = null;
    btn.classList.remove('on');
    btn.querySelector('span:last-child').textContent = '用說的';
    if (text.trim()) onDone(text.trim());
  };
  try { rec.start(); } catch { btn._rec = null; btn.classList.remove('on'); input.focus(); }
}

function hasFigure(q) {
  return !!(q.figure_svg || q.figure_path || (q.figure_table && (q.figure_table.rows || []).length));
}

// The question's figure as a picture for the paper — whichever form it has on screen (the
// redrawn SVG, the photo crop or a table) — {src: PNG data URL or same-site URL, w, h in screen px}.
async function figureImage(root) {
  const grow = 1.3;  // a little bigger than in the question panel: room to draw on it
  const img = root.querySelector('img.fig');
  if (img) {
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    const r = img.getBoundingClientRect();
    const w = r.width || Math.min(400, img.naturalWidth), h = r.height || w * img.naturalHeight / Math.max(1, img.naturalWidth);
    return { src: img.src, w: w * grow, h: h * grow };
  }
  const svg = root.querySelector('.qsvg svg');
  if (svg) {
    const r = svg.getBoundingClientRect();
    const cl = svg.cloneNode(true);
    // styles that come from the page's CSS are written onto the copy (an image has no CSS)
    const from = [...svg.querySelectorAll('*')], to = [...cl.querySelectorAll('*')];
    const KEYS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity',
      'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline'];
    from.forEach((el, i) => { const cs = getComputedStyle(el); for (const k of KEYS) { const v = cs.getPropertyValue(k); if (v) to[i].style.setProperty(k, v); } });
    cl.removeAttribute('style');
    cl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!cl.getAttribute('viewBox')) cl.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    cl.setAttribute('width', String(Math.round(r.width * 2)));
    cl.setAttribute('height', String(Math.round(r.height * 2)));
    cl.setAttribute('font-family', getComputedStyle(svg).fontFamily);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(cl));
    return { src: await toPng(url, r.width * 2, r.height * 2), w: r.width * grow, h: r.height * grow };
  }
  const t = root.querySelector('table.qtable');
  if (t) {
    const R = t.getBoundingClientRect(), k = 2;
    const c = document.createElement('canvas');
    c.width = Math.ceil(R.width * k); c.height = Math.ceil(R.height * k);
    const g = c.getContext('2d');
    g.scale(k, k);
    g.fillStyle = '#fff'; g.fillRect(0, 0, R.width, R.height);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const cell of t.querySelectorAll('th, td')) {
      const b = cell.getBoundingClientRect(), x = b.left - R.left, y = b.top - R.top;
      if (cell.tagName === 'TH') { g.fillStyle = '#f2f2f2'; g.fillRect(x, y, b.width, b.height); }
      g.strokeStyle = '#333'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, b.width, b.height);
      const cs = getComputedStyle(cell);
      g.fillStyle = '#111'; g.font = `${cell.tagName === 'TH' ? 700 : 400} ${cs.fontSize} ${cs.fontFamily}`;
      g.fillText(cell.textContent.trim(), x + b.width / 2, y + b.height / 2, b.width - 6);
    }
    return { src: c.toDataURL('image/png'), w: R.width * grow, h: R.height * grow };
  }
  return null;
}

// the AI's drawing (cleaned like every SVG shown here) as a picture for the paper
async function sketchImage(src) {
  const svg = cleanSvg(src);
  if (!svg) return null;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const vb = (root.getAttribute('viewBox') || '0 0 480 300').split(/[\s,]+/).map(Number);
  const vw = vb[2] || 480, vh = vb[3] || 300;
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  root.setAttribute('width', String(vw * 2));
  root.setAttribute('height', String(vh * 2));
  root.setAttribute('font-family', getComputedStyle(document.body).fontFamily);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
  const w = Math.min(520, vw * 1.1);
  return { src: await toPng(url, vw * 2, vh * 2), w, h: w * vh / vw };
}

// an SVG drawn once into a PNG (the same on every device and when sent to the AI)
function toPng(url, w, h) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(im, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch { resolve(url); }  // a browser that will not turn it into PNG: the SVG itself
    };
    im.onerror = () => resolve(url);
    im.src = url;
  });
}
