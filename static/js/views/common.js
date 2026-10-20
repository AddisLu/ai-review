// Question card rendering, the edit dialog, and job helpers shared across views.
import { get, mediaUrl, parentNow, post, put, state, waitJob } from '../api.js';
import { visualsHtml, questionFigure } from '../visuals.js';
import {
  barModelSvg, busy, confirmBox, errToast, esc, flagTags, icon, markTag, modal, optionsHtml, rich, toast, typeset,
} from '../ui.js';

// 題組 (承上題): the shared part of the group — its instructions, option list A~F, table or picture
export function leadHtml(q, imgStyle = '') {
  const L = q && q.lead;
  if (!L || !(L.stem || L.figure_table || L.figure_svg || L.figure_path)) return '';
  return `<details class="qlead" open><summary>題組說明（承上題）</summary>
    ${L.stem ? `<div class="qlead-stem">${rich(L.stem)}</div>` : ''}${questionFigure(L, imgStyle)}</details>`;
}

export function answerBlock(q, open = false) {
  if (!q.solved) return '<div class="small muted" style="margin-top:8px">⏳ 還沒有詳解</div>';
  return `<details class="explain" ${open ? 'open' : ''}><summary>答案與詳解</summary>
    <div style="margin-top:8px">
    <div class="answer-line">答案：${rich(q.answer)}</div>
    ${q.steps && q.steps.length ? `<h4>解題步驟</h4><ol class="steps">${q.steps.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>` : ''}
    ${q.explanation ? `<h4>詳細說明</h4><div>${rich(q.explanation)}</div>` : ''}
    ${visualsHtml(q.visuals)}
    ${q.visuals && q.visuals.some((v) => v.type === 'bar_model') ? '' : barModelSvg(q.bar_model)}
    ${q.key_points && q.key_points.length ? `<h4>重點觀念</h4><div class="kp">${q.key_points.map((k) => `<span>${rich(k)}</span>`).join('')}</div>` : ''}
    ${q.qtype_tip ? `<h4>題型解析</h4><div>${rich(q.qtype_tip)}</div>` : ''}
    ${q.mistakes ? `<h4>常見錯誤</h4><div>${rich(q.mistakes)}</div>` : ''}
    </div></details>`;
}

export function questionCard(q, { selectable = false, selected = false, showAnswer = true, compact = false, index } = {}) {
  return `<div class="card q-card ${selected ? 'sel' : ''}" data-qid="${q.id}">
    <div class="q-head">
      ${selectable ? `<input type="checkbox" class="selbox" data-sel="${q.id}" ${selected ? 'checked' : ''}>` : ''}
      <span class="q-num">${index !== undefined ? index + '.' : esc(q.number || '')}</span>
      ${q.section ? `<span class="small muted">${esc(q.section)}</span>` : ''}
      <span class="small muted">${esc(q.unit || q.qtype || '')}</span>
      ${markTag(q.teacher_mark)} ${flagTags(q)}
      <span class="spacer"></span>
      <div class="flagbar">
        <button class="flag ${q.is_wrong ? 'on' : ''}" data-flag="is_wrong" title="錯題" aria-label="錯題">${icon('x', 18)}</button>
        <button class="flag ${q.is_highlighted ? 'on' : ''}" data-flag="is_highlighted" title="螢光筆" aria-label="螢光筆">${icon('marker', 18)}</button>
        <button class="flag ${q.is_marked ? 'on' : ''}" data-flag="is_marked" title="記號" aria-label="記號">${icon('star', 18)}</button>
        <button class="flag ${q.is_favorite ? 'on' : ''}" data-flag="is_favorite" title="收藏" aria-label="收藏">${icon('heart', 18)}</button>
      </div>
    </div>
    <div class="stem${q.vertical ? ' vstem' : ''}">${rich(q.stem)}</div>
    ${questionFigure(q)}
    ${optionsHtml(q)}
    ${q.student_answer ? `<div class="small muted" style="margin-top:6px">原本作答：<b style="color:var(--ink)">${rich(q.student_answer)}</b></div>` : ''}
    ${q.note ? `<div class="small muted" style="margin-top:4px">備註：${esc(q.note)}</div>` : ''}
    ${showAnswer && !compact ? answerBlock(q) : ''}
    ${compact ? '' : `<div class="q-actions">
      <a class="btn sm soft" href="#/q/${q.id}">詳解・練習</a>
      <button class="btn sm ghost" data-act="tutor">${icon('pen', 16)} ${q.subject === '數學' ? '計算紙' : '想法紙'}</button>
      <button class="btn sm ghost" data-act="similar">舉一反三</button>
      <button class="btn sm ghost" data-act="fixq" title="題目、圖、答案或詳解有錯？說明給 AI 改">題目有問題？</button>
      ${!q.solved ? '<button class="btn sm warn" data-act="solve">產生詳解</button>' : ''}
      <span class="spacer"></span>
      ${q.crop_path ? `<button class="icon-btn" data-act="crop" title="原題圖" aria-label="原題圖">${icon('image', 18)}</button>` : ''}
      ${canEdit(q) ? `<button class="icon-btn" data-act="edit" title="編輯" aria-label="編輯">${icon('edit', 18)}</button>` : ''}
    </div>`}
  </div>`;
}

// Wires flag toggles and action buttons inside `root`. `reload` re-renders.
export function bindQuestionCards(root, getQ, reload) {
  root.querySelectorAll('.q-card').forEach((card) => {
    const id = Number(card.dataset.qid);
    card.querySelectorAll('[data-flag]').forEach((b) => b.onclick = async () => {
      const q = getQ(id);
      const f = b.dataset.flag;
      const v = q[f] ? 0 : 1;
      try {
        await put(`/api/questions/${id}`, { [f]: v });
        q[f] = v;
        b.classList.toggle('on', !!v);
      } catch (e) { errToast(e); }
    });
    card.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => action(b.dataset.act, getQ(id), reload));
  });
}

// Shared bank: content can be edited by whoever added the question, or a parent.
export function canEdit(q) {
  const u = state.status && state.status.user;
  return !!u && (u.role === 'parent' || q.owner_id === u.id || q.can_edit);
}

export function reteachHtml(r) {
  if (!r) return '';
  const tabs = (r.approaches || []).map((a, i) => `<button class="${i === 0 ? 'on' : ''}" data-rt="${i}">${esc(a.name)}</button>`).join('');
  return `<div class="reteach">
    ${r.diagnosis ? `<div class="label">可能卡住的地方</div><div style="margin-bottom:10px">${rich(r.diagnosis)}</div>` : ''}
    <div class="seg" style="margin-bottom:10px">${tabs}</div>
    ${(r.approaches || []).map((a, i) => `<div class="rt-pane ${i ? 'hidden' : ''}" data-pane="${i}">
      ${a.why ? `<div class="small muted">${rich(a.why)}</div>` : ''}
      <div style="margin:6px 0">${rich(a.explanation)}</div>
      ${a.steps && a.steps.length ? `<ol class="steps">${a.steps.map((x) => `<li>${rich(x)}</li>`).join('')}</ol>` : ''}
      ${a.visual ? visualsHtml([a.visual]) : ''}
      <button class="btn link sm" data-save="${i}" style="padding:0">這個方法有幫助，收藏到我的觀念筆記</button></div>`).join('')}
    ${r.check_question && r.check_question.question ? `<div class="card tight" style="margin-top:10px"><div class="label">換你試試</div>
      <div>${rich(r.check_question.question)}</div>
      <details style="margin-top:4px"><summary style="cursor:pointer;color:var(--pri)">看答案</summary>${rich(r.check_question.answer)}</details></div>` : ''}
    ${r.prerequisite && r.prerequisite.unit ? `<p class="small">建議先複習：<b>${esc(r.prerequisite.unit)}</b>（${esc(r.prerequisite.reason)}）</p>` : ''}
    ${r.encouragement ? `<p class="small muted">${rich(r.encouragement)}</p>` : ''}
  </div>`;
}

export function bindReteach(root, q, r) {
  root.querySelectorAll('.reteach').forEach((box) => {
    box.querySelectorAll('[data-rt]').forEach((b) => b.onclick = () => {
      box.querySelectorAll('[data-rt]').forEach((x) => x.classList.toggle('on', x === b));
      box.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.rt));
    });
    box.querySelectorAll('[data-save]').forEach((b) => b.onclick = async () => {
      const rr = r || (q && q.reteach && q.reteach[0]);
      const a = rr && rr.approaches[Number(b.dataset.save)];
      if (!a || !q) return;
      await post('/api/notes', { question_id: q.id, subject: q.subject, unit: q.unit, title: a.name, source: 'reteach',
        content: { correct_idea: a.explanation, steps: a.steps, visual: a.visual, misconception: rr.diagnosis } });
      b.textContent = '已收藏 ✓';
      b.disabled = true;
    });
  });
}

// Generate (or show the latest) different-approach explanation in a dialog.
export async function openReteach(q, { fresh = false } = {}) {
  let r = !fresh && q.reteach && q.reteach[0];
  return modal({
    title: '換個方法解說',
    wide: true,
    body: `<div id="rtbody">${r ? reteachHtml(r) : '<div class="center" style="padding:30px"><span class="spinner"></span><p>AI 正在想不同的講法…</p></div>'}</div>
      <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn ghost sm" id="rtnew">再換一種</button><button class="btn sm" data-close>我懂了</button></div>`,
    onOpen: async (m) => {
      const body = m.querySelector('#rtbody');
      const gen = async () => {
        body.innerHTML = '<div class="center" style="padding:30px"><span class="spinner"></span><p>AI 正在想不同的講法…</p></div>';
        try {
          const j = await post(`/api/questions/${q.id}/reteach`);
          await waitJob(j.job_id);
          const fresh = await get(`/api/questions/${q.id}`);
          q.reteach = fresh.reteach;
          r = fresh.reteach[0];
          body.innerHTML = reteachHtml(r);
          typeset(body);
          bindReteach(body, q, r);
        } catch (e) { body.innerHTML = ''; errToast(e); }
      };
      m.querySelector('#rtnew').onclick = gen;
      if (!r) gen(); else bindReteach(body, q, r);
    },
  });
}

export async function action(act, q, reload) {
  if (act === 'edit') {
    if (await editQuestion(q)) reload && reload();
  } else if (act === 'crop') {
    modal({ title: '原題圖', wide: true, body: `<img class="crop-img" src="${mediaUrl(q.crop_path)}">` });
  } else if (act === 'tutor') {
    const { openTutor } = await import('./tutor.js');
    openTutor(q);
  } else if (act === 'similar') {
    const ids = await similarDialog(q);
    if (ids) reload && reload();
  } else if (act === 'solve') {
    await runJob(post(`/api/questions/${q.id}/solve`), 'AI 產生詳解中…');
    reload && reload();
  } else if (act === 'fixq') {
    if (await fixQuestion(q)) reload && reload();
  }
}

// An AI wait she can walk away from: if she leaves (「先去做別的」 or another page), the job
// finishes on the Pi and a toast says so — nothing pops up over whatever she is doing then.
export async function runJob(promise, msg) {
  const b = busy(msg, { leave: true });
  const what = msg.replace(/中?…$/, '');
  try {
    const r = await promise;
    if (!r.job_id) { b.close(); return null; }
    const res = await waitJob(r.job_id, (j) => b.left || b.update(j));
    if (b.left) { toast(`${what}好了`, 'ok'); return null; }
    b.close();
    return res;
  } catch (e) {
    b.close();
    errToast(b.left ? new Error(`${what}沒有成功：${e.message}`) : e);
    return null;
  }
}

export async function similarDialog(q) {
  return modal({
    title: '舉一反三',
    body: `<p>AI 會出幾題「同觀念、同題型」但情境不同的新題目，答案與詳解都會一起準備好。</p>
      <label class="field"><span>題數</span><select id="sn"><option>3</option><option selected>5</option><option>8</option></select></label>
      <label class="field"><span>難度</span><select id="sd"><option value="easy">簡單一點</option><option value="same" selected>差不多</option><option value="hard">挑戰難一點</option></select></label>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn" id="sgo">開始出題</button></div>`,
    onOpen: (m, close) => {
      m.querySelector('#sgo').onclick = async () => {
        const n = Number(m.querySelector('#sn').value);
        const difficulty = m.querySelector('#sd').value;
        close();
        const res = await runJob(post(`/api/questions/${q.id}/similar`, { n, difficulty }), 'AI 出題中…');
        if (res) {
          toast(`出好 ${res.question_ids.length} 題了！`, 'ok');
          const { startQuiz } = await import('./quiz.js');
          const qs = await Promise.all(res.question_ids.map((i) => get(`/api/questions/${i}`)));
          startQuiz(qs, { mode: 'practice', title: '舉一反三練習' });
        }
      };
    },
  });
}

const lines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

export async function editQuestion(q, { isNew = false, defaults = {} } = {}) {
  const st = state.status;
  q = { qtype: '填充題', options: [], steps: [], hints: [], key_points: [], difficulty: 2, teacher_mark: 'none', ...defaults, ...q };
  const subjects = Object.keys(st.subjects || {});
  return modal({
    title: isNew ? '新增題目' : '編輯題目',
    wide: true,
    body: `
    <div class="grid g4">
      <label class="field"><span>題號</span><input type="text" name="number" value="${esc(q.number || '')}"></label>
      <label class="field"><span>科目</span><select name="subject">${subjects.map((s) => `<option ${s === q.subject ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="field"><span>題型</span><select name="qtype">${st.qtypes.map((t) => `<option ${t === q.qtype ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field"><span>難度 (1-5)</span><input type="number" min="1" max="5" name="difficulty" value="${q.difficulty || 2}"></label>
    </div>
    <div class="grid g2">
      <label class="field"><span>單元</span><input type="text" name="unit" value="${esc(q.unit || '')}" list="unitlist"><datalist id="unitlist"></datalist></label>
      <label class="field"><span>大題標題</span><input type="text" name="section" value="${esc(q.section || '')}"></label>
    </div>
    <label class="field hidden" id="chf"><span>章節（參考書目次）</span><select name="chapter"></select></label>
    <label class="field"><span>題目（數學式用 $...$，注音用 {字|ㄓㄨˋ}，粗體 **字**）</span><textarea name="stem" rows="4">${esc(q.stem || '')}</textarea></label>
    <div class="card tight stem" id="pv" style="background:var(--bg)"></div>
    <label class="field"><span>選項（每行一個；不是選擇題就留空）</span><textarea name="options" rows="3">${esc((q.options || []).join('\n'))}</textarea></label>
    <div class="grid g3">
      <label class="field"><span>正確答案</span><input type="text" name="answer" value="${esc(q.answer || '')}"></label>
      <label class="field"><span>正確選項（第幾個，非選擇題填 0）</span><input type="number" min="0" name="choice_index" value="${q.choice_index || 0}"></label>
      <label class="field"><span>老師批改</span><select name="teacher_mark">
        ${[['none', '未批改'], ['correct', '對'], ['wrong', '錯'], ['partial', '部分給分']].map(([v, l]) => `<option value="${v}" ${q.teacher_mark === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label class="field"><span>學生原本的作答</span><input type="text" name="student_answer" value="${esc(q.student_answer || '')}"></label>
    <label class="field"><span>詳解</span><textarea name="explanation" rows="4">${esc(q.explanation || '')}</textarea></label>
    <div class="grid g2">
      <label class="field"><span>解題步驟（每行一步）</span><textarea name="steps" rows="4">${esc((q.steps || []).join('\n'))}</textarea></label>
      <label class="field"><span>三層提示（每行一層）</span><textarea name="hints" rows="4">${esc((q.hints || []).join('\n'))}</textarea></label>
      <label class="field"><span>重點觀念（每行一個）</span><textarea name="key_points" rows="3">${esc((q.key_points || []).join('\n'))}</textarea></label>
      <label class="field"><span>題型解析</span><textarea name="qtype_tip" rows="3">${esc(q.qtype_tip || '')}</textarea></label>
    </div>
    <label class="field"><span>常見錯誤</span><input type="text" name="mistakes" value="${esc(q.mistakes || '')}"></label>
    <label class="field"><span>我的備註</span><input type="text" name="note" value="${esc(q.note || '')}" placeholder="例如：粗心看錯單位、考前要再看一次"></label>
    <div class="row" style="justify-content:flex-end">
      ${isNew || !parentNow() ? '' : '<button class="btn ghost" id="qdel" style="margin-right:auto;color:var(--bad)">刪除這題</button>'}
      <button class="btn ghost" data-close>取消</button><button class="btn" id="qsave">儲存</button></div>`,
    onOpen: async (m, close) => {
      const f = (n) => m.querySelector(`[name=${n}]`);
      const pv = m.querySelector('#pv');
      const preview = () => {
        pv.innerHTML = rich(f('stem').value) + optionsHtml({ options: lines(f('options').value) });
        window.renderMathInElement && window.renderMathInElement(pv, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
      };
      f('stem').oninput = preview;
      f('options').oninput = preview;
      preview();
      const loadUnits = async () => {
        try {
          const units = await get(`/api/curriculum?subject=${encodeURIComponent(f('subject').value)}`);
          m.querySelector('#unitlist').innerHTML = units.map((u) => `<option value="${esc(u.unit)}">${u.term}</option>`).join('');
          const chs = await get(`/api/chapters?subject=${encodeURIComponent(f('subject').value)}`);
          m.querySelector('#chf').classList.toggle('hidden', !chs.length);
          f('chapter').innerHTML = '<option value="">（AI 自動判斷）</option>' + chs.map((c) =>
            `<option value="${c.key}" ${q.chapter === c.key ? 'selected' : ''}>${c.topic ? '　└ ' : `【${c.area}】`}${esc(c.label)}</option>`).join('') +
            `<option value="-" ${q.chapter === '-' ? 'selected' : ''}>不屬於任何章節</option>`;
        } catch { /* ignore */ }
      };
      f('subject').onchange = loadUnits;
      loadUnits();
      const del = m.querySelector('#qdel');
      if (del) del.onclick = async () => {
        if (!await confirmBox('確定刪除這題？', '刪除', true)) return;
        await (await import('../api.js')).del(`/api/questions/${q.id}`);
        toast('已刪除');
        close(true);
      };
      m.querySelector('#qsave').onclick = async () => {
        const body = {
          number: f('number').value, subject: f('subject').value, qtype: f('qtype').value,
          difficulty: Number(f('difficulty').value) || 2, unit: f('unit').value.trim(), section: f('section').value,
          stem: f('stem').value, options: lines(f('options').value), answer: f('answer').value,
          choice_index: Number(f('choice_index').value) || 0, teacher_mark: f('teacher_mark').value,
          student_answer: f('student_answer').value, explanation: f('explanation').value,
          steps: lines(f('steps').value), hints: lines(f('hints').value), key_points: lines(f('key_points').value),
          qtype_tip: f('qtype_tip').value, mistakes: f('mistakes').value, note: f('note').value,
        };
        if (!m.querySelector('#chf').classList.contains('hidden')) body.chapter = f('chapter').value;
        try {
          if (isNew) {
            const r = await post('/api/questions', { ...defaults, ...body });
            close(r.id);
          } else {
            await put(`/api/questions/${q.id}`, body);
            Object.assign(q, body);
            close(true);
          }
          toast('已儲存 ', 'ok');
        } catch (e) { errToast(e); }
      };
    },
  });
}

// Wrong-question papers: grouped by type, renumbered, concept lesson first.
export const WRONG_PAPER = { group_by_type: true, numbering: 'section', lesson: true, answers: 'end', explanations: true };

// Choose print / paper options, then open the paper builder with these questions.
export async function makePaper(ids, title = '複習卷', config = null) {
  if (!ids.length) { toast('請先選擇題目'); return; }
  if (!config && /錯題/.test(title)) config = WRONG_PAPER;
  const r = await post('/api/papers', { title, question_ids: ids, kind: 'custom', config: config || {} });
  location.hash = `#/paper/${r.id}`;
}

// 更正看圖: the AI read the figure wrong (or was unsure) — she or a parent says what
// it really shows, the question is solved again with that note, and the note stays
// with the question for every later AI step.
export async function fixFigure(q) {
  return fixQuestion(q, true);
}

// 這題有問題？告訴 AI 怎麼改: describe what is wrong (figure, text, answer…); the AI redoes the
// question from the photo with the description as the final word, and remembers it
export async function fixQuestion(q, figure = false) {
  const { promptBox } = await import('../ui.js');
  const note = await promptBox(figure ? '告訴 AI 圖上正確的樣子' : '這題哪裡有問題？告訴 AI 怎麼改', '',
    q.figure_unsure ? `例如：${q.figure_unsure.replace(/？$/, '').slice(0, 40)}…`
      : figure ? '例如：第一個循環有 5 個灰色；11 是 A 到最底下虛線的整段長度' : '例如：選項③少了一個字；答案應該是②；圖上第一段有 5 個灰色');
  if (note === null || note === undefined || !note.trim()) return false;
  const r = await runJob(post(`/api/questions/${q.id}/fix`, { note: note.trim() }), 'AI 依照你的說明對照原稿，重新整理題目、圖和詳解…');
  if (r) toast('已經照你的說明更新這一題（之後也會記得）', 'ok');
  return !!r;
}

export function figureNote(q) {
  if (!q.figure_path && !q.figure_svg && !q.figure_table) return '';
  return q.figure_unsure && !q.fix_note
    ? `<div class="card tight figwarn"><b>AI 看圖不太確定：</b>${esc(q.figure_unsure)}
        <button class="btn sm" data-fixfig>和考卷不一樣？告訴 AI</button></div>`
    : `<button class="btn link sm" data-fixfig style="padding:0">${q.fix_note ? `已更正：${esc(q.fix_note)}（再改）` : 'AI 看錯圖了？告訴 AI 正確的意思'}</button>`;
}
