// Full-screen one-question-at-a-time runner (Duolingo-style instant feedback).
import { mediaUrl, post, state } from '../api.js';
import { $$, $, CIRCLED, barModelSvg, confetti, errToast, esc, icon, modal, rich, showReward, sound, toast, typeset } from '../ui.js';
import { answerBlock, leadHtml } from './common.js';
import { visualHtml, visualsHtml, questionFigure } from '../visuals.js';
import { bindSpeak, speakButton } from '../speech.js';
import { answerKit, bindKit, hasKit, kitHtml, oneTapMarks } from '../answerpad.js';

const LABEL = { practice: '練習', review: '錯題複習', challenge: '每日挑戰', unit: '單元闖關', duel: 'PK 對戰' };

// startQuiz(questions, {mode, title, duel:{name,avatar,accuracy,speed}, onFinish(summary) -> Promise<serverResult>,
//   target, more}) — with `more`, the round can start before every question exists: when she
//   reaches the end, more() is asked for the questions the AI has finished since (up to `target`).
export function startQuiz(questions, opts = {}) {
  const mode = opts.mode || 'practice';
  if (!questions.length) {
    modal({ title: '沒有題目', body: '<p>目前沒有可以練習的題目（題目需要先有答案與詳解）。</p>' });
    return Promise.resolve(null);
  }
  const st = { i: 0, correct: 0, combo: 0, best: 0, xp: 0, wrong: [], me: 0, bot: 0, botLog: [], miss: 0, eased: false };
  let timer = null, botTimer = null;
  // 練習任務: every round is recorded (what was right, what was wrong) so it is not asked again and
  // each round has its own score (opts.track = {source, title}; on by default for review / practice)
  // on a parent's login with a child chosen it is usually the child answering on that device: it is
  // recorded as hers, unless 家長試做 is ticked (remembered on this device)
  const parentView = state.status && state.status.user && state.status.user.role === 'parent' && state.studentId !== state.status.user.id;
  let trial = false;
  try { trial = parentView && localStorage.getItem('parentTrial') === '1'; } catch { /* private mode */ }
  const parentTry = parentView && trial;
  const track = mode === 'duel' || parentTry ? null : { source: (opts.track && opts.track.source) || mode, title: (opts.track && opts.track.title) || opts.title || LABEL[mode] || '練習' };
  let session = null;
  const sessionReady = track ? post('/api/practice/sessions', { ...track, ids: questions.map((x) => x.id).filter((x) => x > 0) })
    .then((r) => { session = r.id; }).catch(() => {}) : Promise.resolve();
  const record = (qid, correct) => { if (track && qid > 0) sessionReady.then(() => session && post(`/api/practice/sessions/${session}/result`, { qid, correct }).catch(() => {})); };
  return modal({
    full: true,
    body: `<div style="overflow:auto;height:100vh;padding:16px"><div class="quiz" id="qz"></div></div>`,
    onOpen: (m, close) => {
      const root = $('#qz', m);
      const finish = async () => {
        clearInterval(timer); clearTimeout(botTimer);
        const total = questions.length;
        root.innerHTML = '<div class="center" style="margin-top:20vh"><div class="spinner" style="width:42px;height:42px"></div><p>計算成績中…</p></div>';
        let server = null;
        try { server = opts.onFinish ? await opts.onFinish({ ...st, total }) : null; } catch (e) { errToast(e); }
        if (track) { await sessionReady; if (session) post(`/api/practice/sessions/${session}/finish`).catch(() => {}); }
        const pct = st.correct / total;
        const win = mode === 'duel' ? st.me > st.bot : pct >= 0.8;
        if (win) { confetti(); sound('win'); }
        const stars = server && server.stars !== undefined ? server.stars : null;
        root.innerHTML = `<div class="card center" style="margin-top:6vh">
          <div class="result-big">${mode === 'duel' ? `${st.me}<span class="muted" style="font-size:.5em"> : ${st.bot}</span>` : `${st.correct}<span class="muted" style="font-size:.5em"> / ${total}</span>`}</div>
          <h1>${mode === 'duel' ? (st.me > st.bot ? 'PK 獲勝！' : st.me === st.bot ? '平手！' : '差一點點，再來一場') : pct === 1 ? '全對，太厲害了！' : pct >= 0.8 ? '很棒！' : pct >= 0.5 ? '不錯，繼續加油' : '再練習一次會更好'}</h1>
          ${stars !== null ? `<div class="stars" style="justify-content:center;margin:12px 0">${[1, 2, 3].map((i) => `<i class="${stars >= i ? 'on' : ''}" style="width:22px;height:22px;border-radius:11px"></i>`).join('')}</div>` : ''}
          ${mode !== 'duel' ? `<p style="font-size:18px">這次答對率 <b>${Math.round(pct * 100)}%</b>（${st.correct}/${total} 題）</p>` : ''}
          <p>最高連續答對 <b>${st.best}</b> 題・本回合獲得 <b>${st.xp + ((server && server.reward && server.reward.xp) || 0)} XP</b></p>
          ${st.wrong.length ? `<div class="card tight" style="text-align:left"><b>這些題目再看一次：</b>${st.wrong.map((q) => `<a class="list-item" href="#/q/${q.id}" data-close>
            <span class="t">${esc(q.stem.replace(/\$[^$]*\$/g, '…').slice(0, 50))}</span><span>›</span></a>`).join('')}
            <div class="small muted">答錯的題目已經自動放進錯題本，系統會安排複習時間。</div></div>` : ''}
          <div class="row" style="justify-content:center;margin-top:14px"><button class="btn lg" data-close>完成</button></div></div>`;
        if (server) showReward(server);
      };

      // Three misses in a row: cheer her up and offer easier questions.
      const encourage = () => {
        st.eased = true;
        root.innerHTML = `<div class="quiz-top"><button class="icon-btn" data-close aria-label="結束">${icon('close', 22)}</button></div>
          <div class="card center" style="margin-top:6vh" id="cheer">
          <div class="result-big cheer" style="font-size:40px">加油！</div>
          <h2>連續錯了幾題沒關係，這代表你正在學新東西。</h2>
          <p class="sub">可以先看看觀念，或把接下來的題目換成基礎題，熱身一下再挑戰。</p>
          <div class="grid g2" style="margin-top:14px">
            <button class="btn lg" id="ease">換成基礎題</button>
            <button class="btn lg ghost" id="keep">照原本的繼續</button></div></div>`;
        root.querySelector('#keep').onclick = next;
        root.querySelector('#ease').onclick = () => {
          const rest = questions.slice(st.i + 1);
          const basic = rest.filter((x) => x.level === 'basic');
          const others = rest.filter((x) => x.level !== 'basic');
          questions.splice(st.i + 1, rest.length, ...basic, ...others);
          st.miss = 0;
          next();
        };
      };

      const next = async () => {
        st.i++;
        if (st.i >= questions.length && opts.more && questions.length < (opts.target || 0)) {
          root.innerHTML = '<div class="center" style="margin-top:20vh"><div class="spinner" style="width:42px;height:42px"></div><p>AI 正在出下一題…</p></div>';
          for (let tries = 0; tries < 45 && st.i >= questions.length; tries++) {
            let r = { items: [], done: true };
            try { r = await opts.more(); } catch { /* keep the questions she has */ }
            const seen = new Set(questions.map((x) => x.id));
            r.items.filter((x) => !seen.has(x.id)).slice(0, (opts.target || 0) - questions.length).forEach((x) => questions.push(x));
            if (r.done || !root.isConnected) break;
            if (st.i >= questions.length) await new Promise((ok) => setTimeout(ok, 2000));
          }
        }
        if (st.i >= questions.length) finish(); else show();
      };
      const planned = () => Math.max(questions.length, opts.more ? opts.target || 0 : 0);

      const show = () => {
        clearInterval(timer); clearTimeout(botTimer);
        const q = questions[st.i];
        const isChoice = q.choice_index > 0 && q.options && q.options.length;
        const kit = answerKit(q);
        const isTF = oneTapMarks(q, kit);
        const tfMarks = kit.marks.length >= 2 ? kit.marks : ['○', '✕'];
        const isMathQ = /數學/.test(q.subject || '');
        const scratch = mode !== 'duel'  // every subject: write the working out or the reasons, the AI sees how she thinks
          ? `<button class="btn soft scratch-btn" id="scratch">${icon('pen', 18)} ${/數學/.test(q.subject || '') ? '計算紙' : '想法紙'}：寫下來，AI 看你怎麼想</button>` : '';
        const t0 = Date.now();
        let answered = false, hintN = 0;
        root.innerHTML = `
          <div class="quiz-top"><button class="icon-btn" id="qquit" aria-label="結束">${icon('close', 22)}</button>
            <div class="progress"><i style="width:${st.i / planned() * 100}%"></i></div>
            <span class="combo">${st.combo >= 2 ? `${st.combo} 連對` : ''}</span>
            ${mode === 'duel' ? '<span class="timer" id="tm">45</span>' : `<span class="small muted">${st.i + 1}/${planned()}</span>`}</div>
          ${mode === 'duel' ? `<div class="card tight"><div class="duel-bar"><span>${esc(window.__meAvatar || '')} 我</span>
            <div class="progress"><i style="width:${Math.min(100, st.me / (questions.length * 150) * 100)}%"></i></div><b>${st.me}</b></div>
            <div class="duel-bar"><span>${opts.duel.avatar} ${esc(opts.duel.name)}</span><div class="progress gold"><i style="width:${Math.min(100, st.bot / (questions.length * 150) * 100)}%"></i></div><b>${st.bot}</b></div>
            <div class="small muted" id="botst">${esc(opts.duel.name)} 思考中…</div></div>` : ''}
          ${parentView && st.i === 0 ? `<label class="small row nowrap" style="gap:6px;color:var(--warm-ink);margin-bottom:4px"><input type="checkbox" id="trial" ${parentTry ? 'checked' : ''}>家長試做（不記在孩子的紀錄）</label>`
            : parentTry ? '<div class="small" style="color:var(--warm-ink);margin-bottom:4px">家長試做：答案會批改，但不會記在孩子的紀錄</div>' : ''}
          <div class="small muted">${esc(LABEL[mode] || '')}・${esc(q.subject || '')} ${esc(q.unit || '')}・${esc(q.qtype || '')}</div>
          ${(mode === 'review' || opts.conceptFirst) && (q.concept || (q.visuals && q.visuals.length) || (q.key_points && q.key_points.length) || q.bar_model) ? `
            <details class="card" style="margin:10px 0;background:var(--pri-soft);border-color:transparent" open>
              <summary style="cursor:pointer;font-weight:700">先複習觀念</summary>
              ${q.concept ? `<div style="margin-top:6px">${rich(q.concept)}</div>` : q.key_points && q.key_points.length ? `<div class="kp" style="margin-top:6px">${q.key_points.map((k) => `<span>${rich(k)}</span>`).join('')}</div>` : ''}
              ${q.visuals && q.visuals.length ? visualsHtml(q.visuals.slice(0, 2)) : barModelSvg(q.bar_model)}
            </details>` : ''}
          ${leadHtml(q)}
          <div class="row nowrap" style="align-items:flex-start"><div class="stem${q.vertical ? ' vstem' : ''}" style="font-size:20px;margin:8px 0;flex:1">${rich(q.stem)}</div>${speakButton('qstem')}</div>
          ${questionFigure(q)}
          ${q.id > 0 ? '<button class="btn link sm" id="fixq" style="padding:0;margin:2px 0 6px">題目或圖有問題？告訴 AI</button>' : ''}
          <div id="ansui">
          ${isChoice ? `<div class="choice-list">${q.options.map((o, i) => `<button class="choice" data-c="${i + 1}"><span class="k">${CIRCLED[i]}</span><span>${rich(o)}</span></button>`).join('')}</div>${scratch}`
            : isTF ? `<div class="tf">${tfMarks.map((t) => `<button class="choice" data-t="${t}">${t}</button>`).join('')}</div>${scratch}`
            : `<div class="row nowrap" style="margin-top:16px"><input type="text" id="ans" placeholder="${hasKit(kit) ? '點下面的按鈕作答，或直接打字' : isMathQ ? '輸入答案（3/4、2又1/3）' : '直接輸入答案'}" autocomplete="off"><button class="btn lg" id="send">確定</button></div>
               ${kitHtml(kit)}
               <div class="row" style="margin-top:10px">
               ${mode !== 'duel' ? `<button class="btn ${isMathQ ? 'soft' : 'ghost sm'}" id="hw">${isMathQ ? '計算紙：寫下來，AI 看你怎麼想' : '想法紙：用手寫'}</button>` : ''}
               ${mode !== 'duel' ? `<button class="btn ghost${isMathQ ? '' : ' sm'}" id="self">寫在紙上，自己對答案</button>` : ''}</div>`}
          </div>
          ${mode !== 'duel' ? `<div class="peek-row">${q.hints && q.hints.length ? '<button class="btn sm ghost" id="hintb">提示</button>' : ''}
            ${q.answer ? '<button class="btn sm ghost" id="peek">看答案</button>' : ''}</div><div id="hintbox"></div>` : ''}
          <div id="fb"></div>`;
        typeset(root);
        // ✕ in the middle of a round asks first (a palm brushing the corner must not throw it away)
        $('#qquit', root).onclick = async () => {
          if (st.i === 0 && !answered) { close(); return; }
          const { confirmBox } = await import('../ui.js');
          if (await confirmBox(`還有 ${planned() - st.i - (answered ? 1 : 0)} 題沒做，確定要離開嗎？（做過的題目會記錄下來）`, '離開')) finish();
        };
        // 「下一題」 from the writing paper: move on (skipping counts as not answered yet → shown at the end)
        const goNext = () => {
          if (!answered) { answered = true; st.wrong.push(q); }
          const nx = $('#nx', root);
          if (nx) nx.click(); else { st.i++; show(); }
        };
        const fq = $('#fixq', root);
        if (fq) fq.onclick = async () => {
          const { fixQuestion } = await import('./common.js');
          if (!await fixQuestion(q)) return;
          const { get: g } = await import('../api.js');
          Object.assign(q, await g(`/api/questions/${q.id}`));
          show();  // the corrected question, same place in the round
        };
        const sc = $('#scratch', root);  // 計算紙 for a choice question: work it out by hand, the AI checks it
        if (sc) sc.onclick = async () => {
          const { openTutor } = await import('./tutor.js');
          let res = null;
          const v = await openTutor(q, { onDone: (r) => { res = r; }, next: true });
          if (!answered && res && (res.result === 'correct' || res.result === 'wrong')) done(res.result === 'correct', { feedback: res.diagnosis });
          if (v === 'next') goNext();
        };
        bindSpeak(root, { qstem: q.stem + '。' + (q.options || []).map((o, i) => `第${i + 1}個，${o}`).join('。') });

        const done = (correct, r = {}) => {
          if (answered) return;
          answered = true;
          clearInterval(timer);
          const secs = (Date.now() - t0) / 1000;
          record(q.id, correct);
          if (correct) {
            st.correct++; st.combo++; st.best = Math.max(st.best, st.combo);
            if (mode === 'duel') st.me += 100 + Math.max(0, Math.round(50 - secs * 2));
            st.miss = 0;
          } else { st.combo = 0; st.wrong.push(q); st.miss++; }
          st.xp += (r.reward && r.reward.xp) || 0;
          sound(correct ? 'ok' : 'bad');
          if (r.reward) showReward(r);
          $$('.choice', root).forEach((c) => c.disabled = true);
          if (!correct && isChoice) $(`.choice[data-c="${q.choice_index}"]`, root)?.classList.add('right');
          const fb = $('#fb', root);
          fb.innerHTML = `<div class="feedback ${correct ? 'ok' : 'bad'}">
            <h3><span class="result-banner ${correct ? 'ok' : 'bad'}" style="padding:0;margin:0;background:none"><span class="dotc">${icon(correct ? 'check' : 'x', 18)}</span></span>${correct ? ['答對了', '太棒了', '完全正確', '好厲害'][st.i % 4] : r.peek ? '答案在這裡，看懂了再繼續' : '差一點'}<span class="spacer"></span>${r.reward && r.reward.xp ? `<span class="num" style="color:var(--warm-ink);font-size:15px">+${r.reward.xp} XP</span>` : ''}</h3>
            ${r.feedback && !correct ? `<div>${rich(r.feedback)}</div>` : ''}
            ${!correct ? `<div>正確答案：<b>${rich(q.answer)}</b></div>` : ''}
            ${!correct && !q.local ? `<div class="row" style="margin-top:6px"><span class="small">${r.wrong_count ? `這題錯 ${r.wrong_count} 次了` : ''}</span><button class="btn sm dark" id="qrt">換個方法解說</button></div>` : ''}
            ${mode !== 'duel' && !correct ? `<details style="margin-top:6px" ${r.peek ? 'open' : ''}><summary style="cursor:pointer;font-weight:700">看詳解</summary>${answerBlock({ ...q, solved: 1 }, true)}</details>` : ''}
            <button class="btn lg block ${correct ? 'ok' : 'dark'}" id="nx" style="margin-top:12px">${st.i + 1 >= planned() ? '看結果' : '繼續 ›'}</button></div>`;
          typeset(fb);
          let moved = false;
          $('#nx', root).onclick = () => { if (moved) return; moved = true; (st.miss >= 3 && !st.eased && mode !== 'duel' && st.i + 1 < questions.length ? encourage() : next()); };
          // 刷題: a right answer goes on by itself
          const nxBtn = $('#nx', root);
          if (correct && mode !== 'duel') setTimeout(() => { if (nxBtn.isConnected) nxBtn.click(); }, 900);
          if (!correct && !r.peek && (r.attempt_id || r.diagnose_job)) {
            // AI explains the likely cause above 繼續; she can just keep going
            const slot = document.createElement('div');
            $('#nx', root).before(slot);
            import('./question.js').then(({ aiCause }) => aiCause(slot, r));
          }
          const qrt = $('#qrt', root);
          if (qrt) qrt.onclick = async () => {
            const { openReteach } = await import('./common.js');
            q.wrong_count = r.wrong_count || (q.wrong_count || 0) + 1;
            openReteach(q, { fresh: true });
          };
          $('#nx', root).focus();
          fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        };

        const submit = async (val, btn) => {
          if (answered) return;
          btn && btn.classList.add('picked');
          if (q.local) {
            const { parseAnswer } = await import('../drills.js');
            const got = parseAnswer(val);
            done(!!(got && got.eq(q.ans)), {});
            return;
          }
          try {
            const r = await post(`/api/questions/${q.id}/answer`, { answer: val, mode, seconds: Math.round((Date.now() - t0) / 1000), as_child: !parentTry });
            btn && btn.classList.add(r.correct ? 'right' : 'wrong');
            done(r.correct, r);
          } catch (e) { errToast(e); btn && btn.classList.remove('picked'); }
        };
        $$('[data-c]', root).forEach((b) => b.onclick = () => submit(b.dataset.c, b));
        $$('[data-t]', root).forEach((b) => b.onclick = () => submit(b.dataset.t, b));
        const trialBox = $('#trial', root);
        if (trialBox) trialBox.onchange = () => {
          try { localStorage.setItem('parentTrial', trialBox.checked ? '1' : '0'); } catch { /* private mode */ }
          toast(trialBox.checked ? '下次開始練習時生效：家長試做不會記錄' : '下次開始練習時生效：答案會記在孩子的紀錄', 'ok');
        };
        const peek = $('#peek', root);
        if (peek) peek.onclick = async () => {  // 看答案: no getting stuck — counted as not right, asked again later
          if (answered) return;
          peek.disabled = true;
          let r = {};
          try { r = await post(`/api/questions/${q.id}/answer`, { self_correct: false, answer: '（看答案）', mode, as_child: !parentTry }); } catch { /* still show it */ }
          done(false, { ...r, peek: true, feedback: '' });
        };
        const send = $('#send', root);
        if (send) {
          const inp = $('#ans', root);
          if (!hasKit(kit)) inp.focus();
          bindKit(root, inp, (v, b) => submit(v, b));
          send.onclick = () => inp.value.trim() && submit(inp.value.trim());
          inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) send.onclick(); };
        }
        const self = $('#self', root);
        if (self) self.onclick = () => {
          $('#fb', root).innerHTML = `<div class="card tight"><div>正確答案：<b>${rich(q.answer)}</b></div>${answerBlock({ ...q, solved: 1 }, true)}
            <div class="row" style="margin-top:10px"><b>你寫對了嗎？</b><span class="spacer"></span>
            <button class="btn ok" data-s="1">對</button><button class="btn bad" data-s="0">錯</button></div></div>`;
          typeset($('#fb', root));
          $$('[data-s]', root).forEach((b) => b.onclick = async () => {
            const ok = b.dataset.s === '1';
            const r = await post(`/api/questions/${q.id}/answer`, { self_correct: ok, mode, as_child: !parentTry });
            $('#fb', root).innerHTML = '';
            done(ok, r);
          });
        };
        const hw = $('#hw', root);
        if (hw) hw.onclick = async () => {
          const { openTutor } = await import('./tutor.js');
          let res = null;
          const v = await openTutor(q, { onDone: (r) => { res = r; }, next: true });
          if (!answered && res && (res.result === 'correct' || res.result === 'wrong')) done(res.result === 'correct', { feedback: res.diagnosis });
          if (v === 'next') goNext();
        };
        const hb = $('#hintb', root);
        if (hb) hb.onclick = () => {
          if (hintN >= q.hints.length) return;
          $('#hintbox', root).insertAdjacentHTML('beforeend', `<div class="explain">${rich(q.hints[hintN])}</div>`);
          typeset($('#hintbox', root));
          hintN++;
          hb.textContent = hintN >= q.hints.length ? '沒有更多提示了' : `再一個提示（${hintN + 1}/${q.hints.length}）`;
        };

        if (mode === 'duel') {
          let left = 45;
          timer = setInterval(() => {
            left--;
            const tm = $('#tm', root);
            if (tm) tm.textContent = left;
            if (left <= 5 && left > 0) sound('tick');
            if (left <= 0) { clearInterval(timer); post(`/api/questions/${q.id}/answer`, { answer: '', mode }).catch(() => {}); done(false, {}); }
          }, 1000);
          const bt = opts.duel.speed * (0.6 + Math.random() * 0.8) * (1 + (q.difficulty || 2) * 0.15);
          botTimer = setTimeout(() => {
            const ok = Math.random() < opts.duel.accuracy;
            if (ok) st.bot += 100 + Math.max(0, Math.round(50 - bt * 2));
            const el = $('#botst', root);
            if (el) el.textContent = `${opts.duel.name} 已作答 ${ok ? '' : ''}`;
          }, bt * 1000);
        }
      };
      window.__meAvatar = (document.querySelector('.nav-avatar') || {}).textContent;
      const concepts = (opts.lesson && opts.lesson.concepts) || [];
      const showLesson = (i) => {
        const k = concepts[i];
        root.innerHTML = `
          <div class="quiz-top"><button class="icon-btn" data-close aria-label="結束">${icon('close', 22)}</button>
            <div class="progress"><i style="width:${(i + 1) / concepts.length * 100}%"></i></div>
            <span class="small muted">觀念 ${i + 1}/${concepts.length}</span></div>
          ${i === 0 && opts.lesson.intro ? `<p class="sub" style="margin-top:0">${rich(opts.lesson.intro)}</p>` : ''}
          <div class="small muted">先看懂觀念，再自己解題${k.unit ? '・' + esc(k.unit) : ''}</div>
          <h1 style="margin:4px 0 10px">${rich(k.title)}</h1>
          <div style="font-size:17px;line-height:1.8">${rich(k.explain)}</div>
          ${k.rule ? `<div class="card tight" style="margin:12px 0;font-weight:700;font-size:17px">${rich(k.rule)}</div>` : ''}
          ${k.visual ? visualHtml(k.visual) : ''}
          ${k.example_question ? `<div class="card" style="margin-top:12px"><div class="label">例題</div><div>${rich(k.example_question)}</div>
            <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--pri)">看解法</summary><div style="margin-top:6px">${rich(k.example_solution)}</div></details></div>` : ''}
          ${k.mistake ? `<p class="small" style="color:var(--bad)">小心：${rich(k.mistake)}</p>` : ''}
          <div class="row" style="margin-top:16px">
            ${i > 0 ? '<button class="btn ghost lg" id="lprev">上一個</button>' : ''}
            <button class="btn lg" id="lnext" style="flex:1">${i + 1 < concepts.length ? '我懂了，下一個' : '開始解題'}</button></div>`;
        typeset(root);
        const prev = root.querySelector('#lprev');
        if (prev) prev.onclick = () => showLesson(i - 1);
        root.querySelector('#lnext').onclick = () => (i + 1 < concepts.length ? showLesson(i + 1) : show());
      };
      if (concepts.length) showLesson(0); else show();
    },
  });
}
