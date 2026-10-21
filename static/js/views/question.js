import { del, get, mediaUrl, parentNow, post, put, state, stream, waitJob } from '../api.js';
import { visualsHtml, questionFigure } from '../visuals.js';
import { bindChat, chatHtml } from '../chatrender.js';
import { bindMic, bindSpeak, micButton, speakButton } from '../speech.js';
import { $, $$, CIRCLED, errToast, esc, flagTags, html, icon, markTag, optionsHtml, rich, showReward, sound, subjectIcon, toast, typeset } from '../ui.js';
import { answerKit, bindKit, hasKit, kitHtml, oneTapMarks } from '../answerpad.js';
import { leadHtml } from './common.js';
import { action, answerBlock, bindReteach, figureNote, fixFigure, openReteach, reteachHtml } from './common.js';

let q;

export async function render(main, [id]) {
  q = await get(`/api/questions/${id}`);
  draw(main);
}

function draw(main) {
  const isChoice = q.choice_index > 0 && q.options.length;
  const kit = answerKit(q);
  const isTF = oneTapMarks(q, kit);
  const tfMarks = kit.marks.length >= 2 ? kit.marks : ['○', '✕'];
  html(main, `
  <div class="page-head" style="margin-bottom:12px">
    <a href="#/bank?view=q" class="back" id="qback" aria-label="返回">${icon('back', 22)}</a>
    <div class="grow sub" style="margin:0">${esc(q.subject)}・${esc(q.unit || '未分類')}・${esc(q.qtype)}${q.exam_title ? `・<a href="#/exam/${q.exam_id}">${esc(q.exam_title)}</a> 第 ${esc(q.number)} 題` : ''}</div>
    <button class="icon-btn" id="fav" aria-label="收藏" title="收藏" style="${q.is_favorite ? 'color:var(--pri)' : ''}">${icon('heart', 20)}</button>
    ${q.can_edit ? `<button class="icon-btn" data-act="edit" aria-label="編輯" title="編輯">${icon('edit', 20)}</button>` : ''}
    ${parentNow() ? `<button class="icon-btn" id="qtrash" aria-label="刪除這題" title="刪除這題（家長）" style="color:var(--bad)">${icon('trash', 20)}</button>` : ''}
  </div>
  <div class="q-layout">
    <div>
      <div class="q-head">${markTag(q.teacher_mark)} ${flagTags(q)}
        ${q.attempts ? `<span class="small muted">練習 ${q.attempts} 次・答對 ${q.correct_count} 次</span>` : ''}</div>
      ${leadHtml(q)}
      <div class="row nowrap" style="align-items:flex-start"><div class="stem${q.vertical ? ' vstem' : ''}" style="font-size:19px;font-weight:500;flex:1">${rich(q.stem)}</div>${speakButton('stem')}</div>
      ${q.figure_path || q.figure_svg || q.figure_table ? `${questionFigure(q)}${figureNote(q)}` : ''}
      <button class="btn link sm" data-fixq style="padding:0;margin-top:4px">題目、圖或答案有問題？告訴 AI 怎麼改</button>
      ${!isChoice ? optionsHtml(q) : ''}
      ${q.student_answer ? `<div class="small muted" style="margin-top:8px">當時的作答：<b style="color:var(--ink)">${rich(q.student_answer)}</b></div>` : ''}
      <div id="concept"></div>
      <div id="reteach"></div>

      <div id="answer-area" style="margin-top:16px">
        ${isChoice ? `<div class="choice-list">${q.options.map((o, i) => `<button class="choice" data-c="${i + 1}"><span class="k">${i + 1}</span><span>${rich(o)}</span></button>`).join('')}</div>`
          : isTF ? `<div class="tf">${tfMarks.map((t) => `<button class="choice" data-t="${t}">${t}</button>`).join('')}</div>`
          : `<div class="row nowrap"><input type="text" id="ans" placeholder="${hasKit(kit) ? '點下面的按鈕作答，或直接打字' : q.subject === '數學' ? '輸入答案（3/4、2又1/3）' : '直接輸入答案'}" aria-label="答案" style="min-height:50px;font-size:16px"><button class="btn" id="send" style="height:50px">送出</button></div>
            ${kitHtml(kit)}`}
        <div class="grid g2" style="margin-top:10px;gap:8px">
          <button class="btn soft" data-act="tutor">${icon('pen', 18)} ${q.subject === '數學' ? '計算紙' : '想法紙'}：寫下來，AI 看你怎麼想</button>
          <button class="btn ghost" id="stuck">我卡住了</button>
        </div>
        <details class="more-ways"><summary class="btn link sm">其他作答方式</summary>
          <div class="row" style="gap:8px;margin-top:6px">
            <button class="btn ghost sm" id="selfcheck">寫在紙上，自己對答案</button>
            ${q.subject === '數學' ? '<button class="btn ghost sm" id="typesteps">打字寫步驟，請 AI 檢查</button>' : ''}
            <button class="btn ghost sm" id="askhelp">請爸媽幫忙</button>
          </div></details>
        <div id="stepsbox" class="hidden" style="margin-top:10px">
          <textarea id="stepstxt" rows="4" placeholder="一行寫一步，例如：&#10;1 - 3/5 = 2/5&#10;120 × 2/5 = 48"></textarea>
          <button class="btn sm" id="stepsgo" style="margin-top:6px">分析我的步驟</button>
          <div id="stepsout" style="margin-top:10px"></div>
        </div>
      </div>
      <div id="fb"></div>

      <div class="card" style="margin-top:16px" id="hintcard">
        <div class="row nowrap" style="margin-bottom:6px"><b style="flex:1">提示</b><span class="hint-meter" id="hmeter"><i></i><i></i><i></i><i></i><i></i></span></div>
        <div id="hints" class="stack"><p class="small muted" style="margin:0">卡住了嗎？提示會一層一層變清楚，但不會直接告訴你答案。</p></div>
        <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="hintnext">給我提示</button>
          <button class="btn ghost sm" id="hintex">看一題類似的例題</button><span class="spacer"></span><button class="btn link sm" id="showsol">直接看詳解</button></div>
      </div>
      <div id="sol"></div>

      <div class="card">
        <div class="row"><b style="flex:1">舉一反三</b><button class="btn sm soft" data-act="similar">AI 出幾題類似的</button></div>
        ${q.similar.length ? `<div style="margin-top:6px">${q.similar.map((x, i) => `<a class="list-item" href="#/q/${x.id}">
          <span class="num muted">${i + 1}</span><span class="t">${esc(x.stem.replace(/\$[^$]*\$/g, '…').slice(0, 60))}</span>
          ${x.attempts ? `<span class="tag ${x.correct_count ? 'ok' : 'bad'}">${x.correct_count ? '答對過' : '還沒對'}</span>` : '<span class="tag gray">未練習</span>'}</a>`).join('')}
          <button class="btn sm" id="practice-similar" style="margin-top:8px">一次練習這 ${q.similar.length} 題</button></div>`
          : '<p class="small muted" style="margin:6px 0 0">讓 AI 根據這題出同觀念、不同情境的新題目。</p>'}
      </div>
    </div>

    <div>
      <div class="card">
        <b>這題考什麼</b>
        ${q.key_points.length ? `<div class="kp" style="margin-top:8px">${q.key_points.map((k) => `<span>${rich(k)}</span>`).join('')}</div>` : '<p class="small muted">產生詳解後會顯示</p>'}
        ${q.qtype_tip ? `<div class="label" style="margin:12px 0 4px">題型解析</div><div>${rich(q.qtype_tip)}</div>` : ''}
        ${q.unit ? `<a class="btn sm ghost" style="margin-top:12px" href="#/learn/${encodeURIComponent(q.subject)}/${q.grade || 6}/${encodeURIComponent(q.unit)}">「${esc(q.unit)}」重點整理 ${icon('chev', 16)}</a>` : ''}
      </div>

      <div class="card" id="chatcard">
        <div class="row"><b style="flex:1">AI 小老師</b><button class="icon-btn" id="clearchat" title="清除對話" aria-label="清除對話">${icon('trash', 18)}</button></div>
        <div class="chat" id="chat" style="margin:8px 0"></div>
        <div class="chips" id="quickask" style="margin:8px 0">
          ${['我說說我的想法，幫我檢查觀念', '這題在問什麼？', '我不懂第一步', '為什麼要這樣算？', '舉個生活的例子', '請直接告訴我答案'].map((t) => `<button class="chip">${t}</button>`).join('')}
        </div>
        <div class="askbar"><input type="text" id="chatin" placeholder="問 AI 小老師…（也可以用鍵盤的麥克風說話）" aria-label="問 AI 小老師">${micButton('chatin')}<button class="btn dark" id="chatgo" aria-label="送出">${icon('send', 16)}</button></div>
        <button class="btn link sm" id="chatnote" style="margin-top:6px;padding:0">把這段討論整理成我的觀念筆記</button>
      </div>

      <div class="card">
        <b>我的備註</b>
        <textarea id="note" aria-label="我的筆記" rows="2" placeholder="例如：這題我看錯單位了" style="margin-top:8px"></textarea>
        <button class="btn sm ghost" id="savenote" style="margin-top:8px">儲存備註</button>
      </div>

      ${state.status.user.role === 'parent' ? `<div class="card" id="coach"><div class="row nowrap"><b style="flex:1">家長陪伴指南</b>
        ${q.coach ? '' : '<button class="btn sm soft" id="mkcoach">產生</button>'}</div>
        <div id="coachbody">${q.coach ? coachHtml(q.coach) : '<p class="small muted" style="margin:6px 0 0">教你怎麼引導孩子想這題、可以問她什麼、不要說什麼。</p>'}</div></div>` : ''}
      ${q.family && q.family.length ? `<div class="card"><b>家人的錯題紀錄</b>${q.family.map((f) => `<div class="list-item small"><span class="t">${esc(f.name)}</span>
        ${f.mastered ? '<span class="tag ok">已精熟</span>' : ''}<span class="tag bad">錯 ${f.wrong_count || 1} 次</span></div>`).join('')}</div>` : ''}
      ${q.history.length ? `<div class="card"><b>練習紀錄</b>${q.history.map((h) => `
        <div class="list-item small"><span class="status-dot ${h.correct === 1 ? 'ok' : h.correct === 0 ? 'bad' : ''}"></span>
          <span class="t">${h.created_at.slice(5, 16).replace('T', ' ')}・${{ tutor: '手寫批改', review: '複習', challenge: '每日挑戰', practice: '練習', unit: '闖關', duel: 'PK' }[h.mode] || h.mode}
          ${h.error_type && h.error_type !== '無' ? `・<span style="color:var(--bad)">${esc(h.error_type)}</span>` : ''}</span>
          ${h.image_path ? `<a class="tap" href="${mediaUrl(h.image_path)}" target="_blank">看計算紙</a>` : ''}</div>`).join('')}</div>` : ''}
    </div>
  </div>`);
  main.querySelector('#note').value = q.note || '';
  bind(main);
  loadChat();
  loadConcept(main);
  loadReteach(main);
  const mk = main.querySelector('#mkcoach');
  if (mk) mk.onclick = async () => {
    mk.disabled = true;
    mk.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>';
    try {
      const j = await post(`/api/questions/${q.id}/coach`);
      await waitJob(j.job_id);
      const fresh = await get(`/api/questions/${q.id}`);
      q.coach = fresh.coach;
      html(main.querySelector('#coachbody'), coachHtml(q.coach));
      mk.remove();
    } catch (e) { errToast(e); mk.disabled = false; mk.textContent = '產生'; }
  };
}

function coachHtml(c) {
  if (!c) return '';
  return `<div class="small" style="margin-top:6px">${rich(c.summary)}</div>
    <div class="label" style="margin:10px 0 2px">可以這樣開口</div><div>「${rich(c.how_to_start)}」</div>
    <div class="label" style="margin:10px 0 2px">一步步問她</div><ol class="steps">${(c.questions_to_ask || []).map((x) => `<li>${rich(x)}</li>`).join('')}</ol>
    <div class="label" style="margin:10px 0 2px">還是不會時</div><div>${rich(c.if_stuck)}</div>
    <div class="label" style="margin:10px 0 2px">生活例子</div><div>${rich(c.everyday_example)}</div>
    <div class="label" style="margin:10px 0 2px;color:var(--bad)">避免</div><ul style="margin:0;padding-left:18px">${(c.avoid || []).map((x) => `<li>${rich(x)}</li>`).join('')}</ul>
    <div class="label" style="margin:10px 0 2px">確認她懂了</div><div>${rich(c.check)}</div>`;
}

// Missed more than once → explain it a different way, using her own wrong answers.
// Phones: teaching cards start folded so the answer box is on the first screen.
const wide = () => window.matchMedia('(min-width: 700px)').matches;

function loadReteach(main) {
  const el = main.querySelector('#reteach');
  if (!el || !q.solved) return;
  const latest = q.reteach && q.reteach[0];
  const draw = (r) => {
    // folded everywhere so the answer box stays in view; the header already says where she gets stuck
    html(el, `<details class="card fold" style="margin-top:14px;border-color:var(--warm)">
      <summary class="row nowrap"><span style="flex:1;min-width:0"><b>換個方法解說</b>
        ${r.diagnosis ? `<span class="small muted" style="display:block">${esc(r.diagnosis.replace(/\$[^$]*\$/g, '…').slice(0, 40))}</span>` : ''}</span>
        <span class="tag bad">錯過 ${q.wrong_count} 次</span></summary>
      ${reteachHtml(r)}
      <button class="btn ghost sm" id="rtmore" style="margin-top:6px">再換一種講法</button></details>`);
    bindReteach(el, q, r);
    el.querySelector('#rtmore').onclick = () => openReteach(q, { fresh: true }).then(() => q.reteach && q.reteach[0] && draw(q.reteach[0]));
  };
  if (latest && latest.wrong_count >= q.wrong_count) { draw(latest); return; }
  if (q.wrong_count >= 2 && state.status.ai_ready) {
    el.innerHTML = `<div class="card" style="margin-top:14px"><span class="spinner"></span> 這題錯過 ${q.wrong_count} 次，AI 正在換個方法解說…</div>`;
    (async () => {
      try {
        const j = await post(`/api/questions/${q.id}/reteach`);
        await waitJob(j.job_id);
        const fresh = await get(`/api/questions/${q.id}`);
        q.reteach = fresh.reteach;
        if (el.isConnected && q.reteach[0]) draw(q.reteach[0]);
      } catch (e) { if (el.isConnected) el.innerHTML = ''; errToast(e); }
    })();
  } else if (latest) {
    draw(latest);
  } else if (q.wrong_count >= 1) {
    el.innerHTML = '<button class="btn ghost sm" style="margin-top:12px" id="rtbtn">看不懂？換個方法解說</button>';
    el.querySelector('#rtbtn').onclick = () => openReteach(q, { fresh: true }).then(() => q.reteach && q.reteach[0] && draw(q.reteach[0]));
  }
}

// 先看觀念: short concept reminder + animated diagram before solving.
async function loadConcept(main) {
  const el = main.querySelector('#concept');
  if (!el) return;
  const draw = () => {
    // folded on every screen: the one-line idea is in the header, the animated diagram one tap away
    html(el, `<details class="card fold" style="margin-top:14px;background:var(--pri-soft);border-color:transparent">
      <summary class="row nowrap"><span style="flex:1;min-width:0"><b>先看觀念</b>
        ${q.concept ? `<span class="small" style="display:block">${rich(q.concept)}</span>` : ''}</span>
        <span class="small muted">${q.visuals && q.visuals.length ? '看圖解' : ''}</span></summary>
      ${visualsHtml(q.visuals)}</details>`);
  };
  if ((q.visuals && q.visuals.length) || q.concept) { draw(); return; }
  if (!q.solved || !state.status.ai_ready) return;
  const gen = async () => {
    el.innerHTML = '<div class="card" style="margin-top:14px"><span class="spinner"></span> AI 正在畫觀念圖解…</div>';
    try {
      const r = await post(`/api/questions/${q.id}/visualize`);
      await waitJob(r.job_id);
      const fresh = await get(`/api/questions/${q.id}`);
      q.visuals = fresh.visuals; q.concept = fresh.concept;
      if (el.isConnected) draw();
    } catch (e) { if (el.isConnected) el.innerHTML = ''; errToast(e); }
  };
  if (q.is_wrong && !q.mastered) gen();
  else {
    el.innerHTML = '<button class="btn ghost sm" style="margin-top:12px" id="mkvis">先看觀念圖解</button>';
    el.querySelector('#mkvis').onclick = gen;
  }
}

function bind(main) {
  main.querySelectorAll('[data-fixfig]').forEach((b) => b.onclick = async () => { if (await fixFigure(q)) render(main, [q.id]); });
  main.querySelectorAll('[data-fixq]').forEach((b) => b.onclick = async () => {
    const { fixQuestion } = await import('./common.js');
    if (await fixQuestion(q)) render(main, [q.id]);
  });
  if (!wide()) { const c = $('#chatcard'), h = $('#hintcard'); if (c && h) h.after(c); }
  const t0 = Date.now();
  $$('[data-act]', main).forEach((b) => b.onclick = () => action(b.dataset.act, q, () => render(main, [q.id])));
  const submit = async (val, btn) => {
    try {
      const r = await post(`/api/questions/${q.id}/answer`, { answer: val, mode: q.is_wrong ? 'review' : 'practice', seconds: Math.round((Date.now() - t0) / 1000), as_child: true });
      feedback(r);
      if (btn) {
        $$('.choice').forEach((c) => c.disabled = true);
        btn.classList.add(r.correct ? 'right' : 'wrong');
        if (!r.correct && q.choice_index) $(`.choice[data-c="${q.choice_index}"]`)?.classList.add('right');
      }
    } catch (e) { errToast(e); }
  };
  $$('[data-c]').forEach((b) => b.onclick = () => submit(b.dataset.c, b));
  $$('[data-t]').forEach((b) => b.onclick = () => submit(b.dataset.t, b));
  const send = $('#send');
  if (send) {
    send.onclick = () => $('#ans').value.trim() && submit($('#ans').value.trim());
    $('#ans').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) send.onclick(); };
    bindKit(main, $('#ans'), (v, b) => submit(v, b));
  }
  $('#selfcheck').onclick = () => {
    showSolution();
    $('#fb').innerHTML = `<div class="card tight row" style="margin-top:12px"><b>對照答案後，你寫對了嗎？</b><span class="spacer"></span>
      <button class="btn ok sm" data-self="1">答對了</button><button class="btn bad sm" data-self="0">答錯了</button></div>`;
    $$('[data-self]').forEach((b) => b.onclick = async () => {
      const r = await post(`/api/questions/${q.id}/answer`, { self_correct: b.dataset.self === '1', mode: q.is_wrong ? 'review' : 'practice', as_child: true });
      feedback(r, true);
    });
  };
  let level = 0;
  $('#hintnext').onclick = async (e) => {
    const b = e.currentTarget;
    if (level >= 5) return;
    const l = level + 1;
    b.disabled = true;
    b.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>';
    try {
      const r = await post(`/api/questions/${q.id}/hint`, { level: l });
      if (l === 1) $('#hints').innerHTML = '';
      $('#hints').insertAdjacentHTML('beforeend', `<div><span class="small muted">提示 ${l}</span><div>${rich(r.hint)}</div>
        ${r.guiding_question ? `<div class="small" style="margin-top:2px">想想看：${rich(r.guiding_question)}</div>` : ''}
        ${r.look_at ? `<div class="small muted">注意：${rich(r.look_at)}</div>` : ''}</div>`);
      typeset($('#hints'));
      level = l;
      $$('#hmeter i').forEach((x, i) => x.classList.toggle('on', i < level));
    } catch (err) { errToast(err); }
    b.disabled = level >= 5;
    b.textContent = level >= 5 ? '沒有更多提示了' : `再給一個提示（${level + 1}/5）`;
  };
  $('#hintex').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>';
    try {
      const r = await post(`/api/questions/${q.id}/hint`, { example: true });
      if (!level) $('#hints').innerHTML = '';
      $('#hints').insertAdjacentHTML('beforeend', `<div class="card tight" style="background:var(--sunk);border:0">
        <div class="label">類似例題（先看懂這題，再回去做原題）</div><div>${rich(r.example_question)}</div>
        <ol class="steps" style="margin-top:6px">${(r.worked_steps || []).map((x) => `<li>${rich(x)}</li>`).join('')}</ol>
        ${r.connect ? `<div class="small" style="color:var(--pri)">${rich(r.connect)}</div>` : ''}</div>`);
      typeset($('#hints'));
    } catch (err) { errToast(err); }
    b.disabled = false;
    b.textContent = '再看一題例題';
  };
  $('#showsol').onclick = showSolution;
  bindSpeak(main, { stem: q.stem + '。' + (q.options || []).map((o, i) => `第${i + 1}個，${o}`).join('。') });
  bindMic(main);
  const ts = $('#typesteps');
  if (ts) ts.onclick = () => { $('#stepsbox').classList.toggle('hidden'); $('#stepstxt').focus(); };
  const sg = $('#stepsgo');
  if (sg) sg.onclick = async () => {
    const text = $('#stepstxt').value.trim();
    if (!text) return;
    sg.disabled = true;
    sg.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> 分析中…';
    try {
      const r = await post(`/api/questions/${q.id}/steps`, { text });
      const { renderResult } = await import('./tutor.js');
      renderResult($('#stepsout'), r, q);
      // the step analysis already names the error type; no need to ask her
      showReward(r);
    } catch (e) { errToast(e); }
    sg.disabled = false;
    sg.textContent = '再分析一次';
  };
  $('#askhelp').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await post(`/api/questions/${q.id}/help`, {});
      b.textContent = '已告訴爸媽';
      toast('已經告訴爸媽了（你寫過的答案和 AI 的判斷也一起傳過去）', 'ok');
    } catch (err) { b.disabled = false; errToast(err); }
  };
  // 我卡住了 = next hint, right where she is looking
  $('#stuck').onclick = () => {
    $('#hintcard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#hintnext').click();
  };
  $('#chatnote').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const n = await post(`/api/questions/${q.id}/chat/note`);
      toast(`已存到觀念筆記：${n.title}`, 'ok');
    } catch (err) { errToast(err); }
    b.disabled = false;
  };
  // 返回: back where she came from inside the app; opened straight from a link, to 錯題
  $('#qback').onclick = (e) => { if (window.__fromHash) { e.preventDefault(); history.back(); } };
  const tr = $('#qtrash');
  if (tr) tr.onclick = async () => {
    const { confirmBox } = await import('../ui.js');
    if (!await confirmBox(`從題庫刪除這一題？<br><span class="small muted">${q.exam_title ? `（${esc(q.exam_title)} 第 ${esc(q.number)} 題）` : ''}題目、詳解和每個孩子的作答紀錄都會刪掉，不能復原。</span>`, '刪除', true)) return;
    try {
      await del(`/api/questions/${q.id}`);
      toast('已刪除', 'ok');
      if (window.__fromHash) history.back(); else location.hash = '#/bank?view=q';
    } catch (err) { errToast(err); }
  };
  $('#fav').onclick = async (e) => {
    q.is_favorite = q.is_favorite ? 0 : 1;
    await put(`/api/questions/${q.id}`, { is_favorite: q.is_favorite });
    e.currentTarget.style.color = q.is_favorite ? 'var(--pri)' : '';
    toast(q.is_favorite ? '已收藏' : '已取消收藏');
  };
  $('#savenote').onclick = async () => { await put(`/api/questions/${q.id}`, { note: $('#note').value }); toast('已儲存', 'ok'); };
  const ps = $('#practice-similar');
  if (ps) ps.onclick = async () => {
    const { startQuiz } = await import('./quiz.js');
    const qs = await Promise.all(q.similar.map((s) => get(`/api/questions/${s.id}`)));
    startQuiz(qs.filter((x) => x.solved), { mode: 'practice', title: '舉一反三練習' });
  };
  $('#chatgo').onclick = () => ask($('#chatin').value);
  $('#chatin').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) ask($('#chatin').value); };
  $$('#quickask .chip').forEach((c) => c.onclick = () => ask(c.textContent));
  $('#clearchat').onclick = async () => { if (!await (await import('../ui.js')).confirmBox('清除和 AI 小老師的對話？', '清除', true)) return; await del(`/api/questions/${q.id}/chat`); loadChat(); };
}

function showSolution() {
  html($('#sol'), answerBlock(q, true));
}

function feedback(r, self = false) {
  sound(r.correct ? 'ok' : 'bad');
  html($('#fb'), `<div class="feedback ${r.correct ? 'ok' : 'bad'}">
    <h3>${icon(r.correct ? 'check' : 'x', 22)} ${r.correct ? '答對了' : '再想想看'}<span class="spacer"></span><span class="num" style="color:var(--warm-ink);font-size:15px">+${r.reward?.xp || 0} XP</span></h3>
    ${r.feedback ? `<div>${rich(r.feedback)}</div>` : ''}
    ${!r.correct && !self ? `<div>正確答案：<b>${rich(r.answer)}</b></div>` : ''}
    ${!r.correct ? `<div class="row" style="margin-top:8px"><span class="small">這題你已經錯 ${r.wrong_count || 1} 次了</span><button class="btn sm dark" id="fbrt">換個方法解說</button></div>` : ''}
    <div class="small" style="margin-top:4px">${r.reward?.coins ? `金幣 +${r.reward.coins}` : ''}
    ${!r.correct ? '・已加入錯題本，明天會再提醒你複習' : q.is_wrong ? '・錯題複習進度 +1' : ''}</div></div>`);
  showSolution();
  showReward(r);
  if (!r.correct) aiCause($('#fb'), r);
  if (r.correct && q.reteach && q.reteach[0] && !q._noteSaved) autoNote();
  const rt = $('#fbrt');
  if (rt) rt.onclick = () => { q.wrong_count = r.wrong_count || q.wrong_count + 1; openReteach(q, { fresh: true }); };
}

async function loadChat() {
  if ($('#chat')) bindChat($('#chat'), (t) => ask(t));  // 下一步 / the small checks inside AI replies
  const msgs = await get(`/api/questions/${q.id}/chat`);
  const el = $('#chat');
  if (!el) return;
  el.innerHTML = msgs.length ? msgs.map(msgHtml).join('')
    : '<div class="msg assistant">嗨！我是 AI 小老師 這題哪裡不懂都可以問我喔！</div>';
  typeset(el);
  el.scrollTop = el.scrollHeight;
}

function msgHtml(m) {
  return `<div class="msg ${m.role}">${m.image ? `<img src="${mediaUrl(m.image)}">` : ''}${m.role === 'user' ? esc(m.text) : chatHtml(m.text, q)}</div>`;
}

async function ask(text, image) {
  text = (text || '').trim();
  if (!text && !image) return;
  $('#chatin').value = '';
  const el = $('#chat');
  el.insertAdjacentHTML('beforeend', msgHtml({ role: 'user', text }) + '<div class="msg assistant" id="streaming"><span class="spinner" style="width:16px;height:16px;border-width:2px"></span></div>');
  el.scrollTop = el.scrollHeight;
  const out = $('#streaming');
  try {
    await stream(`/api/questions/${q.id}/chat`, { message: text, image }, (_, all) => {
      out.innerHTML = chatHtml(all, q);
      el.scrollTop = el.scrollHeight;
    });
    typeset(out);
  } catch (e) {
    // her question is not lost: back in the box, and one tap sends it again
    if (!$('#chatin').value) $('#chatin').value = text;
    out.innerHTML = `AI 小老師暫時沒回應（${esc(e.message)}）<br><button class="chip" data-resend>${icon('redo', 14)} 重送</button>`;
    const mine = out.previousElementSibling;
    out.querySelector('[data-resend]').onclick = () => { out.remove(); if (mine) mine.remove(); $('#chatin').value = ''; ask(text, image); };
  }
  out.removeAttribute('id');
}

export { ask as askTutor };


// 「我覺得錯在…」: the child's own reason, counted next to the AI's analysis.
const REASONS = [['careless', '粗心'], ['misread', '看錯題目'], ['concept', '觀念不懂'], ['calc', '算錯'], ['unit', '單位'], ['unknown', '不知道']];

// 答錯後 AI 自動找錯因: the child never has to classify the mistake herself.
// Shows the AI's guess with 對 / 不是; only "不是" brings up the reason chips.
export async function aiCause(root, r) {
  if (!root) return;
  if (!r.diagnose_job) { if (r.attempt_id) { root.insertAdjacentHTML('beforeend', reasonChips(r.attempt_id)); bindReasons(root); } return; }
  const box = document.createElement('div');
  box.className = 'card tight cause';
  box.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> <span class="small">AI 在看你為什麼會寫這個答案…</span>';
  root.appendChild(box);
  try {
    const d = await waitJob(r.diagnose_job);
    if (!box.isConnected) return;
    box.innerHTML = `<div class="label">AI 找到的原因</div><div>${rich(d.likely_cause)}</div>
      ${d.tip ? `<div class="small" style="margin-top:4px">下次注意：${rich(d.tip)}</div>` : ''}
      ${r.attempt_id ? `<div class="row" style="margin-top:8px;gap:8px"><span class="small muted">說對了嗎？</span>
        <button class="btn sm soft" data-yes>對，就是這樣</button><button class="btn sm ghost" data-no>不是</button></div>` : ''}`;
    typeset(box);
    const yes = box.querySelector('[data-yes]');
    if (yes) {
      yes.onclick = async () => {
        if (d.reason) await post(`/api/attempts/${r.attempt_id}/reason`, { reason: d.reason });
        box.querySelector('.row').innerHTML = '<span class="small">記下來了，下次會特別注意</span>';
      };
      box.querySelector('[data-no]').onclick = () => {
        box.querySelector('.row').remove();
        box.insertAdjacentHTML('afterend', reasonChips(r.attempt_id));
        bindReasons(root);
      };
    }
  } catch { box.remove(); if (r.attempt_id) { root.insertAdjacentHTML('beforeend', reasonChips(r.attempt_id)); bindReasons(root); } }
}

// Answered right after reading 換個方法解說: keep that explanation in the notebook automatically.
async function autoNote() {
  const rr = q.reteach[0];
  const pane = document.querySelector('#reteach [data-rt].on');
  const a = rr && rr.approaches && rr.approaches[pane ? Number(pane.dataset.rt) : 0];
  if (!a) return;
  q._noteSaved = true;
  try {
    await post('/api/notes', { question_id: q.id, subject: q.subject, unit: q.unit, title: a.name, source: 'reteach',
      content: { correct_idea: a.explanation, steps: a.steps, visual: a.visual, misconception: rr.diagnosis } });
    toast(`「${a.name}」幫你答對了，已收進觀念筆記本`, 'ok');
  } catch { /* the note is a bonus */ }
}

export function reasonChips(attemptId) {
  return `<div class="card tight reasons" data-att="${attemptId}" style="margin-top:10px"><div class="label">我覺得我錯在…</div>
    <div class="chips">${REASONS.map(([k, l]) => `<button class="chip" data-reason="${k}">${l}</button>`).join('')}</div></div>`;
}

export function bindReasons(root) {
  root.querySelectorAll('.reasons').forEach((box) => box.querySelectorAll('[data-reason]').forEach((b) => b.onclick = async () => {
    await post(`/api/attempts/${box.dataset.att}/reason`, { reason: b.dataset.reason });
    box.querySelectorAll('[data-reason]').forEach((x) => x.classList.toggle('on', x === b));
    toast('記下來了，下次會特別注意這個', 'ok');
  }));
}
