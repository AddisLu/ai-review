import { get, post, state } from '../api.js';
import { DRILLS, drillsFor, makeProblem, parseAnswer } from '../drills.js';
import { $, $$, confetti, errToast, esc, html, icon, modal, showReward, sound, typeset } from '../ui.js';
import { startQuiz } from './quiz.js';

let subject = '';

export async function render(main, [sub]) {
  if (sub === 'challenge') return runChallenge(main);
  if (sub === 'review') return runReview(main);
  if (sub === 'duel') return runDuel(main);
  if (sub === 'drill') return drillMenu(main);
  const { render: learn } = await import('./learn.js');
  return learn(main);
}

// Show the hub behind the full-screen runner, with the URL pointing at it.
async function backToHub(main) {
  const from = window.__fromHash || '';
  if (from && !from.startsWith('#/practice')) { location.hash = from; return; } // back where she started (今天, 錯題…)
  history.replaceState(null, '', '#/learn');
  await render(main, []);
}

// After a runner closes, refresh the hub only if the child is still on it.
function refreshHub(main) {
  if (location.hash === '#/learn') render(main, []);
}

const subjQ = () => (subject ? `?subject=${encodeURIComponent(subject)}` : '');

async function runChallenge(main) {
  const ch = await get('/api/practice/challenge' + subjQ());
  await backToHub(main);
  if (!ch.questions.length) { modal({ title: '題庫還不夠', body: '<p>先掃描幾份考卷，或到學習地圖讓 AI 出練習題，就可以開始每日挑戰囉！</p>' }); return; }
  await startQuiz(ch.questions, {
    mode: 'challenge', title: '每日挑戰',
    onFinish: (s) => post('/api/practice/challenge/finish', { correct: s.correct, total: s.total }),
  });
  refreshHub(main);
}

async function runReview(main) {
  const qs = await get('/api/practice/review' + subjQ());
  await backToHub(main);
  await startQuiz(qs, { mode: 'review', title: '錯題複習' });
  refreshHub(main);
}

async function runDuel(main) {
  const d = await get('/api/practice/duel' + subjQ());
  await backToHub(main);
  let qs = d.questions;
  // Top up with offline arithmetic so a duel is always possible.
  while (qs.length < 5) {
    const p = makeProblem('mix', (state.me && state.me.grade) || 6);
    qs.push({ id: 0, local: true, subject: '數學', unit: '心算', qtype: '計算題', stem: `$${p.tex}$ = ?`, answer: p.ans.text(), ans: p.ans, options: [], choice_index: 0, difficulty: 2 });
  }
  qs = qs.slice(0, 5);
  await modal({
    title: '找到對手了！',
    body: `<div class="center"><div style="font-size:64px">${d.bot.avatar}</div><h2>${esc(d.bot.name)}</h2>
      <p class="sub">5 題・每題 45 秒・答得越快分數越高</p><button class="btn lg block bad" data-close>開始 PK！</button></div>`,
  });
  await startQuiz(qs, {
    mode: 'duel', duel: d.bot,
    onFinish: (s) => post('/api/practice/duel/finish', { win: s.me > s.bot, score: s.me, bot_score: s.bot }),
  });
  refreshHub(main);
}

function drillMenu(main) {
  html(main, `
    <div class="page-head"><a href="#/learn" class="back" aria-label="返回">${icon('back', 22)}</a><div class="grow"><h1>心算快打</h1>
      <div class="sub">選一種題型，60 秒挑戰！分數可以輸入 3/4，帶分數輸入 2又1/3</div></div></div>
    <div class="group">${drillsFor(state.me && state.me.grade).map(([k, l]) => `<button class="task" data-k="${k}">
      <span class="ti orange">${icon('bolt')}</span><span style="flex:1"><b>${l.split(' ')[1]}</b><span class="sub">60 秒挑戰</span></span><span class="chev">${icon('chev', 18)}</span></button>`).join('')}</div>`);
  $$('[data-k]', main).forEach((b) => b.onclick = () => runDrill(main, b.dataset.k));
}

function runDrill(main, kind) {
  const label = DRILLS.find((d) => d[0] === kind)[1];
  const g = (state.me && state.me.grade) || 6;
  let cur = makeProblem(kind, g), input = '', left = 60, correct = 0, total = 0, timer = null, ended = false, onKey = null;
  const wrong = [];
  modal({
    full: true,
    body: `<div style="height:100vh;overflow:auto;padding:16px"><div class="quiz">
      <div class="quiz-top"><button class="icon-btn" data-close aria-label="結束">${icon('close', 22)}</button><b style="flex:1">${label.split(' ')[1]}</b>
        <span class="small" style="color:var(--ok);font-weight:700" id="sc">答對 0</span><span class="timer" id="tm">60</span></div>
      <div class="progress gold"><i id="tbar" style="width:100%"></i></div>
      <div id="box" style="border-radius:16px;padding-bottom:12px">
        <div class="drill-q" id="dq"></div>
        <div class="drill-in" id="din">&nbsp;</div>
        <div class="keypad">
          ${['7', '8', '9', '⌫', '4', '5', '6', '/', '1', '2', '3', '.', '0', '又', '✓'].map((k) => `<button data-key="${k}" class="${k === '✓' ? 'go' : /[⌫/.又]/.test(k) ? 'op' : ''}" ${k === '⌫' ? 'aria-label="刪除"' : ''}>${k === '✓' ? '確定' : k}</button>`).join('')}
        </div>
      </div></div></div>`,
    onOpen: (m, close) => {
      const dq = $('#dq', m), din = $('#din', m), box = $('#box', m);
      const showQ = () => { dq.innerHTML = `$${cur.tex}$`; typeset(dq); din.innerHTML = '&nbsp;'; input = ''; };
      const end = async () => {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        document.removeEventListener('keydown', onKey);
        if (correct >= 10) { confetti(); sound('win'); }
        let r = null;
        try { r = await post('/api/practice/drill/finish', { kind, correct, total, seconds: 60, wrong: wrong.slice(0, 20) }); } catch (e) { errToast(e); }
        box.innerHTML = `<div class="center" style="padding-top:8vh"><div class="result-big">${correct}</div>
          <h1>題答對${correct >= 20 ? '，太神速了！' : correct >= 10 ? '，很厲害！' : '，再接再厲！'}</h1><p>共作答 ${total} 題${r ? `・最佳紀錄 ${r.best} 題` : ''}</p>
          ${wrong.length ? `<div class="card tight" style="text-align:left"><b>錯的題目：</b>${wrong.map((w) => `<div>$${w.tex}$ = $${w.right}$ <span class="small muted">（你寫 ${esc(w.got)}）</span></div>`).join('')}</div>` : ''}
          <div class="row" style="justify-content:center"><button class="btn lg" id="again">再玩一次</button><button class="btn lg ghost" data-close>結束</button></div></div>`;
        typeset(box);
        $('#again', m).onclick = () => { close(); runDrill(main, kind); };
        if (r) showReward(r);
      };
      const submit = () => {
        if (!input || ended) return;
        const got = parseAnswer(input);
        total++;
        if (got && got.eq(cur.ans)) {
          correct++;
          sound('ok');
          box.classList.remove('flash-ok'); void box.offsetWidth; box.classList.add('flash-ok');
        } else {
          sound('bad');
          wrong.push({ tex: cur.tex, right: cur.ans.tex(), got: input });
          box.classList.remove('flash-bad'); void box.offsetWidth; box.classList.add('flash-bad');
        }
        $('#sc', m).textContent = `答對 ${correct}`;
        cur = makeProblem(kind, g);
        showQ();
      };
      const press = (k) => {
        if (ended) return;
        if (k === '✓' || k === 'Enter') return submit();
        if (k === '⌫' || k === 'Backspace') input = input.slice(0, -1);
        else if (k === 'C') input = '';
        else if (/^[0-9./又]$/.test(k)) input += k;
        din.textContent = input || ' ';
      };
      onKey = (e) => press(e.key === 'u' ? '又' : e.key);
      document.addEventListener('keydown', onKey);
      $$('[data-key]', m).forEach((b) => b.onclick = () => press(b.dataset.key));
      showQ();
      timer = setInterval(() => {
        left--;
        $('#tm', m).textContent = left;
        $('#tbar', m).style.width = left / 60 * 100 + '%';
        if (left <= 0) end();
      }, 1000);
    },
  }).then(() => { ended = true; clearInterval(timer); document.removeEventListener('keydown', onKey); });
}
