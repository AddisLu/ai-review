// 錯題 (redesigned): the child sees how she is doing and picks the concepts she
// still gets wrong — then practises them at once (no browsing question by question).
// A parent sees the weaknesses behind the mistakes, strengthens a concept and
// gives the child a task, which then waits on her 今天 page.
import { get, post, qs, state, waitJob, del } from '../api.js';
import { $, $$, confirmBox, errToast, esc, html, icon, modal, toast } from '../ui.js';
import { WRONG_PAPER, makePaper } from './common.js';

let D = null, me = null, picked = new Set(), subj = '', MAIN = null, LOG = [];

const key = (c) => `${c.subject}|${c.unit}`;
const unitHref = (c) => `#/learn/${encodeURIComponent(c.subject)}/${(me && me.grade) || 6}/${encodeURIComponent(c.unit)}`;
const isParent = () => state.status.user && state.status.user.role === 'parent';
const SUBJ_CLASS = { 數學: 'blue', 國語: 'orange', 英語: 'purple', 社會: 'green', 自然: 'teal' };

export async function render(main) {
  MAIN = main;
  [D, me, LOG] = await Promise.all([get('/api/bank/overview'), get('/api/me').catch(() => ({})),
    get('/api/practice/sessions?limit=8').catch(() => [])]);
  picked = new Set([...picked].filter((k) => D.concepts.some((c) => key(c) === k)));
  if (!isParent()) { kidView(main); return; }
  const kids = (state.status.students || []).filter((x) => x.role !== 'parent');
  if (state.studentId === state.status.user.id && kids.length) { chooseKid(main, kids); return; }
  parentView(main);
}

// a parent looking at her own (empty) record: whose weaknesses?
function chooseKid(main, kids) {
  html(main, `<div class="page-head"><div class="grow"><h1>錯題・弱點分析</h1><div class="sub">要看哪個孩子的弱點和任務？</div></div></div>
    <div class="grid g3">${kids.map((k) => `<button class="card bk-kidpick" data-kid="${k.id}"><span class="av" aria-hidden="true">${k.avatar}</span><b>${esc(k.name)}</b><span class="small muted">${k.grade ? k.grade + ' 年級' : ''}</span></button>`).join('')}
      <a class="card bk-kidpick" href="#/bank?view=list&flags="><span class="av" aria-hidden="true">${icon('book', 34)}</span><b>全家題庫</b><span class="small muted">所有拍過的題目</span></a></div>`);
  $$('.bk-kidpick', main).forEach((b) => b.onclick = () => {
    const chip = document.querySelector(`.kidbar [data-kid="${b.dataset.kid}"]`);
    if (chip) chip.click();
  });
}

// --- child -------------------------------------------------------------------------------------

function ring(pct) {
  const c = 2 * Math.PI * 31, on = (c * pct) / 100;
  return `<svg width="76" height="76" viewBox="0 0 76 76" role="img" aria-label="已學會 ${pct}%" class="bk-ring">
    <circle cx="38" cy="38" r="31" fill="none" stroke="var(--line)" stroke-width="9"/>
    <circle cx="38" cy="38" r="31" fill="none" stroke="var(--pri)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 38 38)"/>
    <text x="38" y="43" text-anchor="middle" class="num" font-size="18" font-weight="800" fill="currentColor">${pct}%</text></svg>`;
}

function conceptCard(c) {
  const on = picked.has(key(c));
  const pct = Math.round((100 * c.mastered) / Math.max(1, c.total));
  return `<label class="bk-concept ${on ? 'on' : ''}">
    <input type="checkbox" data-pick="${esc(key(c))}" ${on ? 'checked' : ''} aria-label="選擇 ${esc(c.unit)}">
    <span class="bd">
      <span class="hd"><b>${esc(c.unit)}</b><span class="tag ${SUBJ_CLASS[c.subject] || ''}">${esc(c.subject)}</span>
        ${c.wrong_times >= 2 ? `<span class="small bad-ink" style="margin-left:auto">錯 ${c.wrong_times} 次</span>` : ''}</span>
      <span class="bar"><span class="progress ${pct >= 50 ? '' : 'warm'}"><i style="width:${Math.max(4, pct)}%"></i></span><span class="small">會了 ${c.mastered}/${c.total} 題</span></span>
      ${c.cause || c.error ? `<span class="small muted">常錯：${esc(c.cause || c.error)}</span>` : ''}
    </span>
    <a class="bk-learn" href="${unitHref(c)}" aria-label="看「${esc(c.unit)}」的觀念">${icon('bulb', 18)}</a>
  </label>`;
}

function kidView(main) {
  const s = D.stats;
  const subjects = [...new Set(D.concepts.map((c) => c.subject))];
  const list = D.concepts.filter((c) => !subj || c.subject === subj);
  html(main, `
  <div class="page-head"><a href="#/bank" class="back" aria-label="回到題庫">${icon('back', 22)}</a><div class="grow"><h1>我的弱點</h1><div class="sub">勾選要加強的觀念，馬上練</div></div></div>
  <div class="bk-kid">
    <div class="bk-side">
      <div class="card bk-status">
        ${ring(s.pct)}
        <div style="flex:1;min-width:0">
          <div class="label" style="margin:0 0 4px">我的學習狀況</div>
          <div class="bk-nums">
            <div><b class="num bad-ink">${s.open}</b><span>待加強</span></div>
            <div><b class="num warm-ink">${s.due}</b><span>今天複習</span></div>
            <div><b class="num ok-ink">+${s.week_mastered}</b><span>本週學會</span></div>
          </div>
          ${s.top_error ? `<div class="small" style="margin-top:6px">最常錯：<b>${esc(s.top_error.name)}</b>（${s.top_error.n} 次）</div>` : ''}
        </div>
      </div>
      ${s.due ? `<a class="bk-go" href="#/practice/review">
        <span class="pl">${icon('play', 18)}</span>
        <span style="flex:1"><b>今天的 ${s.due} 題</b><span>約 ${Math.max(1, Math.round(s.due * 0.8))} 分鐘・快忘記的先練</span></span>${icon('chev', 20)}</a>`
      : `<div class="card tight ok-soft">今天要複習的都做完了！可以挑下面的觀念再加強。</div>`}
      <button class="btn ghost block" id="other">其他挑題方式（錯很多次、螢光筆、最近考卷…）</button>
      <a class="btn link block" href="#/bank?view=list">一題一題看・管理題目 ›</a>
      ${logHtml()}
    </div>
    <div>
      <div class="row" style="align-items:center;margin-bottom:8px"><b style="font-size:16px;flex:1">需要加強的觀念</b>
        ${list.length ? `<button class="btn link sm" id="pickall">${list.every((c) => picked.has(key(c))) ? '全部取消' : '全選'}</button>` : ''}</div>
      ${subjects.length > 1 ? `<div class="chips" style="margin-bottom:10px">
        <button class="chip ${subj ? '' : 'on'}" data-subj="">全部 ${D.concepts.length}</button>
        ${subjects.map((x) => `<button class="chip ${subj === x ? 'on' : ''}" data-subj="${esc(x)}">${esc(x)} ${D.concepts.filter((c) => c.subject === x).length}</button>`).join('')}</div>` : ''}
      <div class="bk-list">${list.length ? list.map(conceptCard).join('') : `<div class="empty">${D.stats.wrong ? '全部都學會了，太厲害了！' : '還沒有錯題。掃描考卷後，錯的題目會依觀念整理在這裡。'}</div>`}</div>
    </div>
  </div>
  <div class="bk-bar hidden" id="bkbar"><span class="t" id="bkcount"></span>
    <button class="btn dark2" id="bklearn">先看觀念</button><button class="btn" id="bkgo">馬上練</button></div>`);
  bindKid(main);
}

// 練習紀錄: every practice round with its score
function logHtml(parent = false) {
  if (!LOG.length) return parent ? '<b style="font-size:16px">練習紀錄</b><p class="small muted">還沒有練習紀錄。</p>' : '';
  return `<div class="${parent ? '' : 'card'} bk-log"><b style="font-size:${parent ? 16 : 15}px">練習紀錄</b>
    ${LOG.map((r) => `<div class="bk-logrow"><span class="t">${esc(r.title)}<span class="small muted">${r.created_at.slice(5, 16).replace('T', ' ')}・${r.done}${r.done < r.n ? `/${r.n}` : ''} 題${r.finished ? '' : '・沒做完'}</span></span>
      <b class="num ${r.pct >= 80 ? 'ok-ink' : r.pct >= 60 ? '' : 'bad-ink'}">${r.pct ?? '-'}%</b></div>`).join('')}</div>`;
}

function selection() {
  const cs = D.concepts.filter((c) => picked.has(key(c)));
  return { cs, ids: [...new Set(cs.flatMap((c) => c.ids))] };
}

function bindKid(main) {
  const bar = () => {
    const { cs, ids } = selection();
    $('#bkbar').classList.toggle('hidden', !cs.length);
    $('#bkcount').innerHTML = `<b>已選 ${cs.length} 個觀念</b><br>共 ${ids.length} 題`;
  };
  $$('[data-pick]', main).forEach((b) => b.onchange = () => {
    if (b.checked) picked.add(b.dataset.pick); else picked.delete(b.dataset.pick);
    b.closest('.bk-concept').classList.toggle('on', b.checked);
    bar();
  });
  $$('[data-subj]', main).forEach((b) => b.onclick = () => { subj = b.dataset.subj; kidView(main); });
  const all = $('#pickall');
  if (all) all.onclick = () => {
    const list = D.concepts.filter((c) => !subj || c.subject === subj);
    const every = list.every((c) => picked.has(key(c)));
    list.forEach((c) => (every ? picked.delete(key(c)) : picked.add(key(c))));
    kidView(main);
  };
  $('#other').onclick = () => practiceSheet(null);
  $('#bkgo').onclick = () => practiceSheet(selection());
  $('#bklearn').onclick = () => { const { cs, ids } = selection(); go('lesson', ids, cs); };
  bar();
}

async function questions(ids) {
  if (!ids.length) return [];
  const r = await get('/api/questions' + qs({ ids: ids.join(','), limit: 300 }));
  const by = new Map(r.items.map((q) => [q.id, q]));
  return ids.map((i) => by.get(i)).filter((q) => q && q.solved);
}

// how to practise the chosen concepts (or, with nothing chosen, other ways to pick)
function practiceSheet(sel) {
  const p = D.picks;
  const names = sel ? sel.cs.map((c) => c.unit).join('、') : '';
  const opt = (k, ic, cls, t, sub, rec = false) => `<button class="bk-opt ${rec ? 'rec' : ''}" data-go="${k}">
    <span class="ti ${cls}">${icon(ic, 20)}</span><span style="flex:1"><b>${t}${rec ? '<span class="tag pri">推薦</span>' : ''}</b><span class="sub">${sub}</span></span></button>`;
  const pick = (k, t, n) => n ? `<button class="bk-pick" data-pk="${k}"><span>${t}</span><b class="num">${n > 20 ? `練 20 題・共 ${n}` : `${n} 題`}</b></button>` : '';
  modal({
    title: sel ? '怎麼練？' : '用其他方式挑題',
    body: `${sel ? `<p class="small muted" style="margin:-6px 0 12px">${esc(names)}・${sel.ids.length} 題</p>
      <div class="stack" style="gap:8px">
        ${opt('redo', 'redo', '', '重做錯題', `${sel.ids.length} 題・答錯會先教觀念再給提示`, true)}
        ${opt('similar', 'star', 'orange', '錯題＋舉一反三', `${sel.ids.length + Math.min(8, sel.ids.length)} 題・換數字再練，確定真的會了`)}
        ${opt('lesson', 'bulb', 'green', '先看觀念教學，再練', '圖解＋重點，再做錯題')}
        ${opt('print', 'print', 'gray', '印成紙本寫', '錯題複習卷・卷首有觀念重點')}
      </div><div class="label" style="margin-top:16px">或用其他方式挑題</div>` : ''}
      <div class="bk-picks">
        ${pick('wrong2', '錯 2 次以上', p.wrong2)}${pick('marks', '螢光筆・記號', p.marks)}
        ${p.exam && p.exam.n ? pick('exam', `最近考卷的錯題`, p.exam.n) : ''}${pick('mastered', '已學會・回顧', p.mastered)}
      </div>
      ${!p.wrong2 && !p.marks && !(p.exam && p.exam.n) && !p.mastered ? '<p class="small muted">還沒有可以挑的題目。</p>' : ''}
      <a class="btn link block" href="#/bank?view=list" data-close>一題一題看・管理題目 ›</a>`,
    onOpen: (m, close) => {
      $$('[data-go]', m).forEach((b) => b.onclick = () => { close(); go(b.dataset.go, sel.ids, sel.cs); });
      $$('[data-pk]', m).forEach((b) => b.onclick = async () => {
        close();
        const k = b.dataset.pk;
        const f = k === 'wrong2' ? { flags: 'unmastered', min_wrong: 2, sort: 'wrong' }
          : k === 'marks' ? { flags_any: 'highlighted,marked', flags: 'unmastered' }
          : k === 'exam' ? { exam_id: p.exam.id, flags: 'unmastered' } : { flags: 'mastered', sort: 'old' };
        const r = await get('/api/questions' + qs({ ...f, limit: 20 }));
        startReview(r.items.filter((q) => q.solved), b.querySelector('span').textContent, { track: { source: `pick:${k}`, title: b.querySelector('span').textContent } });
      });
    },
  });
}

async function startReview(list, title, extra = {}) {
  const { startQuiz } = await import('./quiz.js');
  await startQuiz(list, { mode: 'review', title, conceptFirst: true, ...extra });
  render(MAIN);
}

async function go(kind, ids, cs) {
  const title = cs.map((c) => c.unit).join('、').slice(0, 30);
  if (kind === 'print') { makePaper(ids, `${title}－錯題複習卷`, { ...WRONG_PAPER, template: 'wrong' }); return; }
  const list = await questions(ids);
  if (kind === 'similar') {
    let job = null;
    try { job = (await post('/api/bank/similar', { ids: list.map((q) => q.id) })).job_id; } catch (e) { errToast(e); }
    return startReview(list, title, {
      target: list.length + Math.min(8, list.length),
      more: async () => {
        if (!job) return { items: [] };
        const r = await waitJob(job);
        return { items: await questions(r.question_ids || []) };
      },
    });
  }
  return startReview(list, title, { track: { source: 'concepts', title }, ...(kind === 'lesson' ? { lesson: await lessonFor(cs) } : {}) });
}

// 先看觀念: each concept's key points (the unit card the AI wrote), then her wrong questions
async function lessonFor(cs) {
  const grade = (me && me.grade) || 6;
  const cards = await Promise.all(cs.slice(0, 4).map((c) => get('/api/knowledge' + qs({ subject: c.subject, unit: c.unit, grade })).catch(() => null)));
  const concepts = [];
  cs.slice(0, 4).forEach((c, i) => {
    const k = cards[i] && cards[i].content;
    if (!k) return;
    const pts = (k.key_points || []).slice(0, 2);
    concepts.push({ unit: c.unit, title: `${c.unit}${pts[0] ? '：' + pts[0].title : ''}`,
      explain: pts.map((p) => p.content).join('<br><br>') || k.intro || '',
      rule: (k.formulas || [])[0] ? `${k.formulas[0].name}：${k.formulas[0].formula}` : '',
      visual: (pts.find((p) => p.visual && !p.visual.pending) || {}).visual,
      mistake: c.cause || (k.mistakes || [])[0]?.mistake || '' });
  });
  if (!concepts.length) toast('這些觀念還沒有重點卡，直接練習（每題會先看觀念）');
  return concepts.length ? { intro: '先把觀念弄懂，再來做錯題！', concepts } : null;
}

// --- parent --------------------------------------------------------------------------------------

function parentView(main) {
  const name = (me && me.name) || '孩子';
  const s = D.stats;
  const weak = D.weaknesses || [];
  const tasks = D.tasks || [];
  const ST = { done: ['完成', 'ok'], late: ['晚了', 'bad'], today: ['今天到期', 'warn'], open: ['進行中', 'gray'] };
  html(main, `
  <div class="page-head"><a href="#/bank" class="back" aria-label="回到題庫">${icon('back', 22)}</a><div class="grow"><h1>${esc(name)}的弱點分析</h1>
    <div class="sub">依最近 ${D.attempts_30 || 0} 次作答整理：待加強 ${s.open} 題、已學會 ${s.mastered} 題${D.report_at ? `・AI 報告 ${esc(D.report_at.slice(5, 10).replace('-', '/'))}` : ''}</div></div>
    ${s.open ? `<button class="btn ghost" id="wpaper">${icon('print', 16)} 印錯題卷</button>` : ''}
    <button class="btn" id="assign">${icon('plus', 16)} 指派任務</button></div>
  <div class="bk-par">
    <section class="card">
      <div class="row" style="align-items:baseline;gap:8px"><b style="font-size:16px">AI 找到的弱點</b><span class="small muted">先處理第 1 個，效果最大</span>
        <span class="spacer"></span><button class="btn link sm" id="report">${D.report_at ? '重新分析' : '讓 AI 深入分析'}</button></div>
      ${weak.length ? weak.map((w, i) => `<div class="bk-weak">
        <b class="rk ${i ? '' : 'first'}">${i + 1}</b>
        <div style="min-width:0"><b>${esc(w.subject ? w.subject + '・' : '')}${esc(w.unit)}</b>
          <span class="small bad-ink" style="margin-left:6px">${w.accuracy != null ? `正確率 ${w.accuracy}%・` : ''}${w.open ? `待加強 ${w.open} 題` : ''}</span>
          ${w.issue || w.advice ? `<div class="small" style="margin-top:3px">${esc(w.issue || '')}${w.issue && w.advice ? ' ' : ''}${esc(w.advice || '')}</div>` : ''}</div>
        <div class="row" style="gap:6px;flex-wrap:nowrap"><a class="btn sm soft" href="${unitHref(w)}">加強觀念</a><button class="btn sm ghost" data-assign="${esc(w.subject)}|${esc(w.unit)}">指派</button></div>
      </div>`).join('') : '<p class="small muted">還沒有足夠的作答紀錄。孩子多練習幾次，這裡就會出現她的弱點。</p>'}
    </section>
    <section class="card">
      <b style="font-size:16px">為什麼會錯</b>
      ${(D.errors || []).length ? `<div class="bars" style="margin-top:10px">${D.errors.map((e, i) => `<div class="bar" style="grid-template-columns:96px 1fr 40px"><span>${esc(e.name)}</span>
        <div class="progress ${i ? '' : 'warm'}"><i style="width:${e.pct}%"></i></div><b>${e.pct}%</b></div>`).join('')}</div>`
      : '<p class="small muted">答錯後 AI 會判斷原因，累積後顯示在這裡。</p>'}
      <div class="bk-week">
        <div><b class="num">${D.week.this.accuracy != null ? D.week.this.accuracy + '%' : '-'}</b><span>本週正確率${D.week.this.accuracy != null && D.week.last.accuracy != null ? `<i class="${D.week.this.accuracy >= D.week.last.accuracy ? 'ok-ink' : 'bad-ink'}"> ${D.week.this.accuracy >= D.week.last.accuracy ? '+' : ''}${D.week.this.accuracy - D.week.last.accuracy}</i>` : ''}</span></div>
        <div><b class="num">${D.week.mastered_this_week}</b><span>本週學會的題目</span></div>
      </div>
    </section>
    <section class="card bk-table">
      <div class="row" style="align-items:center"><b style="font-size:16px;flex:1">各觀念的精熟度</b><span class="small muted">勾選後可以印卷或指派</span></div>
      <div class="bk-tr head"><span></span><span>觀念</span><span>科目</span><span>精熟度</span><span>待加強</span><span>最近練習</span></div>
      ${D.table.length ? D.table.map((u) => `<label class="bk-tr">
        <input type="checkbox" data-tpick="${esc(u.subject)}|${esc(u.unit)}" ${picked.has(`${u.subject}|${u.unit}`) ? 'checked' : ''} aria-label="選擇 ${esc(u.unit)}">
        <span class="u">${esc(u.unit)}</span><span class="small">${esc(u.subject)}</span>
        <span class="bar"><span class="progress ${u.score != null && u.score < 50 ? 'warm' : ''}"><i style="width:${Math.max(3, u.score || 0)}%"></i></span><b class="small">${u.score != null ? u.score + '%' : '-'}</b></span>
        <span class="${u.open ? 'bad-ink' : 'muted'}">${u.open} 題</span><span class="small muted">${u.last ? ago(u.last) : '還沒練'}</span></label>`).join('')
      : '<p class="small muted">還沒有資料</p>'}
      <div class="bk-bar inline hidden" id="pbar"><span class="t" id="pcount"></span>
        <button class="btn dark2" id="pprint">印成複習卷</button><button class="btn" id="passign">指派給${esc(name)}</button></div>
    </section>
    <section class="card">${logHtml(true)}</section>
    <section class="card">
      <b style="font-size:16px">指派的任務</b>
      ${tasks.length ? tasks.map((t) => `<div class="bk-task">
        <div class="row" style="gap:6px;align-items:center"><b style="flex:1;min-width:0">${esc(t.title)}</b><span class="tag ${ST[t.status][1]}">${ST[t.status][0]}</span>
          <button class="icon-btn" data-tdel="${t.id}" aria-label="刪除任務">${icon('trash', 15)}</button></div>
        ${t.status !== 'done' ? `<div class="progress" style="margin:6px 0"><i style="width:${Math.round((100 * t.done) / Math.max(1, t.n))}%"></i></div>` : ''}
        <span class="small muted">${t.generating ? 'AI 正在出類似題…・' : ''}${t.status === 'done' ? `完成：${t.n} 題對 ${t.ok} 題` : `做了 ${t.done}/${t.n} 題・對 ${t.ok} 題`}${t.due_date ? `・期限 ${t.due_date.slice(5).replace('-', '/')}` : ''}${t.reward ? `・獎勵 ${t.reward} 金幣` : ''}</span>
      </div>`).join('') : `<p class="small muted">還沒有指派任務。勾選上面的觀念，按「指派給${esc(name)}」。</p>`}
    </section>
  </div>`);
  bindParent(main, name);
}

function ago(d) {
  const n = Math.round((Date.now() - new Date(d).getTime()) / 864e5);
  return n <= 0 ? '今天' : n === 1 ? '昨天' : `${n} 天前`;
}

function bindParent(main, name) {
  const tsel = () => D.table.filter((u) => picked.has(`${u.subject}|${u.unit}`));
  const bar = () => {
    const us = tsel();
    $('#pbar').classList.toggle('hidden', !us.length);
    $('#pcount').innerHTML = `<b>已選 ${us.length} 個觀念</b>・${us.reduce((a, u) => a + u.open, 0)} 題錯題`;
  };
  $$('[data-tpick]', main).forEach((b) => b.onchange = () => { if (b.checked) picked.add(b.dataset.tpick); else picked.delete(b.dataset.tpick); bar(); });
  bar();
  const units = (list) => list.map((k) => k.split('|'));
  $('#assign').onclick = () => assignSheet(name, picked.size ? units([...picked]) : (D.weaknesses || []).slice(0, 1).map((w) => [w.subject, w.unit]));
  $('#passign').onclick = () => assignSheet(name, units([...picked]));
  $$('[data-assign]', main).forEach((b) => b.onclick = () => assignSheet(name, units([b.dataset.assign])));
  $('#pprint').onclick = () => {
    const ids = [...new Set(tsel().flatMap((u) => u.ids))];
    if (!ids.length) { toast('這些觀念目前沒有待加強的錯題'); return; }
    makePaper(ids, `${tsel().map((u) => u.unit).join('、').slice(0, 24)}－錯題複習卷`, { ...WRONG_PAPER, template: 'wrong' });
  };
  const wp = $('#wpaper');
  if (wp) wp.onclick = async () => {
    const r = await get('/api/questions' + qs({ flags: 'unmastered', sort: 'wrong', limit: 30 }));
    makePaper(r.items.map((q) => q.id), '錯題複習卷', { ...WRONG_PAPER, template: 'wrong' });
  };
  $('#report').onclick = async () => {
    const b = $('#report'); b.disabled = true; b.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> AI 分析中…';
    try { const r = await post('/api/report'); await waitJob(r.job_id); toast('分析完成', 'ok'); render(MAIN); } catch (e) { errToast(e); b.disabled = false; b.textContent = '重新分析'; }
  };
  $$('[data-tdel]', main).forEach((b) => b.onclick = async () => { if (!await confirmBox('刪除這個任務？（孩子已經做過的紀錄會留著）', '刪除', true)) return; try { await del(`/api/tasks/${b.dataset.tdel}`); render(MAIN); } catch (e) { errToast(e); } });
}

const KINDS = [['lesson', '觀念＋練習', '先看圖解教學，再做錯題'], ['redo', '重做錯題', '直接作答'], ['similar', '舉一反三', '錯題＋AI 換數字出的新題'], ['paper', '紙本複習卷', '印出來寫']];

function assignSheet(name, units) {
  if (!units.length) { toast('先勾選要加強的觀念'); return; }
  const info = units.map(([s, u]) => D.table.find((x) => x.subject === s && x.unit === u) || D.concepts.find((x) => x.subject === s && x.unit === u) || { subject: s, unit: u, open: 0 });
  const open = info.reduce((a, u) => a + (u.open || 0), 0);
  const day = (n) => { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // local date (not UTC)
  const weekend = (() => { const d = new Date(); const add = (6 - d.getDay() + 7) % 7 || 7; return day(add); })();
  let n = Math.max(5, Math.min(15, open || 10)), kind = 'lesson', due = day(0);
  modal({
    title: `指派任務給${esc(name)}`,
    body: `<div class="chips" style="margin-bottom:12px">${info.map((u) => `<span class="chip on">${esc(u.unit)}${u.open ? `・${u.open} 題` : ''}</span>`).join('')}</div>
      <div class="label">要她做什麼</div>
      <div class="bk-kinds">${KINDS.map(([k, t, d], i) => `<label class="bk-kind ${i ? '' : 'on'}"><span><input type="radio" name="kind" value="${k}" ${i ? '' : 'checked'}> <b>${t}</b></span><span class="small muted">${d}</span></label>`).join('')}</div>
      <div class="group" style="margin-top:12px">
        <div class="gi"><span class="t">題數</span><span class="row" style="gap:6px;align-items:center"><button class="btn sm ghost" id="nminus" aria-label="減少">−</button><b class="num" id="nval" style="min-width:28px;text-align:center">${n}</b><button class="btn sm ghost" id="nplus" aria-label="增加">＋</button></span></div>
        <div class="gi"><span class="t">期限</span><span class="chips" id="dues"><button class="chip on" data-due="${day(0)}">今天</button><button class="chip" data-due="${day(1)}">明天</button><button class="chip" data-due="${weekend}">週末</button></span></div>
        <label class="gi"><span class="t">完成獎勵</span><select id="reward"><option value="10">10 金幣</option><option value="20" selected>20 金幣</option><option value="40">40 金幣</option></select></label>
        <label class="gi"><span class="t">留言</span><input type="text" id="msg" placeholder="例如：這兩個弄懂，期中考就穩了！" style="width:62%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
      </div>
      <div class="card tight pri-soft small" style="margin-top:12px">${icon('home', 16)} ${esc(name)}打開「今天」就會看到這個任務，按一下就開始；做完這裡會顯示結果。</div>
      <button class="btn block lg" id="doassign" style="margin-top:12px">指派</button>`,
    onOpen: (m, close) => {
      $$('input[name=kind]', m).forEach((r) => r.onchange = () => { kind = r.value; $$('.bk-kind', m).forEach((l) => l.classList.toggle('on', l.contains(m.querySelector('input[name=kind]:checked')))); });
      const setN = (v) => { n = Math.max(1, Math.min(30, v)); m.querySelector('#nval').textContent = n; };
      m.querySelector('#nminus').onclick = () => setN(n - 1);
      m.querySelector('#nplus').onclick = () => setN(n + 1);
      $$('[data-due]', m).forEach((b) => b.onclick = () => { due = b.dataset.due; $$('[data-due]', m).forEach((x) => x.classList.toggle('on', x === b)); });
      m.querySelector('#doassign').onclick = async () => {
        const b = m.querySelector('#doassign'); b.disabled = true;
        try {
          const body = { units, kind, n, due_date: due, reward: Number(m.querySelector('#reward').value), message: m.querySelector('#msg').value };
          try { await post('/api/tasks', body); } catch (e) {
            // the same concepts already assigned and not done yet: ask before giving her a second copy
            if (e.status !== 409 || !await confirmBox(esc(e.message) + '<br>還是要再指派一份嗎？', '再指派一份')) throw e;
            await post('/api/tasks', { ...body, force: true });
          }
          close(); toast(`已指派給${name}`, 'ok'); picked.clear(); render(MAIN);
        } catch (e) { errToast(e); b.disabled = false; }
      };
    },
  });
}
