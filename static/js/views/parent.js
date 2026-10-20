import { del, get, post, put, setParentPin, state, waitJob } from '../api.js';
import { $, $$, busy, confirmBox, errToast, esc, html, icon, modal, subjectIcon, toast, localDay } from '../ui.js';

let tab = 'report';

async function unlock() {
  if (state.status.user && state.status.user.role === 'parent') return true;
  if (state.parentPin) {
    try { await post('/api/parent/verify', { pin: state.parentPin }); return true; } catch { setParentPin(''); }
  }
  return modal({
    title: '家長專區',
    body: `<p class="sub">請輸入家長帳號的密碼（或切換成家長帳號登入）</p>
      <input type="password" inputmode="numeric" id="pin" placeholder="家長密碼" autofocus>
      <button class="btn block" id="ok" style="margin-top:12px">進入</button>`,
    onOpen: (m, close) => {
      const go = async () => {
        try {
          const r = await post('/api/parent/verify', { pin: m.querySelector('#pin').value });
          setParentPin(m.querySelector('#pin').value);
          if (r.default_pin) toast('提醒：家長密碼還是預設的 0000，請到設定修改', 'bad');
          close(true);
        } catch (e) { errToast(e); }
      };
      m.querySelector('#ok').onclick = go;
      m.querySelector('#pin').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) go(); };
    },
  });
}

export async function render(main) {
  if (!await unlock()) { if (main.isConnected) location.hash = '#/'; return; }  // Back pressed: leave her where she went
  html(main, `
    <div class="page-head"><div class="grow"><h1>家長專區</h1><div class="sub">學習報告、指派作業、學生與系統設定</div></div>
      <button class="btn ghost sm" id="lock">鎖定</button></div>
    <div class="tabs">${[['report', '學習報告'], ['goals', '考試目標'], ['rewards', '獎勵'], ['help', '求救信箱'], ['homework', '指派作業'], ['students', '帳號'], ['settings', '設定']]
      .map(([k, l]) => `<button class="tab ${tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="pb"></div>`);
  $$('[data-tab]', main).forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(main); });
  $('#lock').onclick = () => { setParentPin(''); location.hash = '#/'; };
  const pb = $('#pb');
  ({ report, goals, rewards, help, homework, students, settings })[tab](pb, main);
}

function bars(rows, label, val, max = 100, suffix = '%', cls = '') {
  if (!rows.length) return '<p class="sub">還沒有資料</p>';
  return `<div class="bars">${rows.map((r) => `<div class="bar"><span title="${esc(label(r))}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label(r))}</span>
    <div class="progress ${typeof cls === 'function' ? cls(r) : cls}"><i style="width:${Math.min(100, val(r) / max * 100)}%"></i></div><b>${val(r)}${suffix}</b></div>`).join('')}</div>`;
}

async function report(pb, main) {
  const s = await get('/api/stats');
  const totalQ = s.subjects.reduce((a, r) => a + r.n, 0);
  const totalW = s.subjects.reduce((a, r) => a + (r.wrong || 0), 0);
  const fixed = s.subjects.reduce((a, r) => a + (r.fixed || 0), 0);
  const acc = s.accuracy.reduce((a, r) => [a[0] + r.ok, a[1] + r.n], [0, 0]);
  const maxCal = Math.max(1, ...s.calendar.map((d) => d.xp));
  const rep = s.report && s.report.report;
  html(pb, `
    <div class="grid g4" style="margin-bottom:16px">
      <div class="card kpi"><b>${s.exams}</b><span>掃描考卷</span></div>
      <div class="card kpi"><b>${totalQ}</b><span>題庫題數</span></div>
      <div class="card kpi"><b style="color:var(--bad)">${totalW - fixed}</b><span>待加強錯題（已精熟 ${fixed}）</span></div>
      <div class="card kpi"><b>${acc[1] ? Math.round(acc[0] / acc[1] * 100) : '-'}%</b><span>近 30 天正確率（${acc[1]} 題）</span></div>
    </div>
    <div class="card">
      <div class="row"><h2 style="margin:0">AI 學習分析報告</h2><span class="spacer"></span>
        <span class="small muted">${s.report ? '更新於 ' + s.report.at.replace('T', ' ').slice(0, 16) : ''}</span>
        <button class="btn sm" id="genrep">${rep ? '重新分析' : '產生報告'}</button></div>
      ${rep ? `<p style="margin-top:12px">${esc(rep.summary)}</p>
        <div class="grid g2"><div><h3>做得好的地方</h3><ul>${rep.strengths.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><h3>需要加強</h3>${rep.weaknesses.map((w) => `<div class="explain" style="margin-bottom:8px"><b>${esc(w.unit)}</b>：${esc(w.issue)}<div class="small">${esc(w.advice)}</div></div>`).join('')}</div></div>
        <h3>7 天總複習計畫</h3>${rep.plan.map((p) => `<div class="list-item"><b style="width:60px">${esc(p.day)}</b><span class="t" style="white-space:normal">${esc(p.task)}</span></div>`).join('')}
        <div class="explain" style="margin-top:12px">給孩子的話：${esc(rep.message_to_child)}</div>`
        : '<p class="sub" style="margin-top:8px">累積一些練習紀錄後，AI 會分析孩子的強弱項、錯誤類型，並給出一週複習計畫。</p>'}
    </div>
    <div class="grid g2">
      <div class="card"><h3>各科題目與錯題</h3>${bars(s.subjects, (r) => `${subjectIcon(r.subject)} ${r.subject || '未分類'}`, (r) => r.n, Math.max(1, ...s.subjects.map((r) => r.n)), ' 題')}
        <div class="small muted">錯題：${s.subjects.map((r) => `${r.subject} ${r.wrong || 0}`).join('、')}</div></div>
      <div class="card"><h3>各科正確率（近 30 天）</h3>${bars(s.accuracy, (r) => r.subject, (r) => Math.round(r.ok / r.n * 100), 100, '%', (r) => (r.ok / r.n >= 0.8 ? 'ok' : ''))}</div>
      <div class="card"><h3>最需要加強的單元</h3>${bars(s.units.slice(0, 8), (r) => `${r.subject}・${r.unit}`, (r) => r.pct, 100, '%', (r) => (r.pct >= 80 ? 'ok' : ''))}</div>
      <div class="card"><h3>錯誤類型分析（手寫批改）</h3>${bars(s.errors, (r) => r.error_type, (r) => r.n, Math.max(1, ...s.errors.map((r) => r.n)), ' 次')}</div>
    </div>
    ${s.top_wrong && s.top_wrong.length ? `<div class="card"><h3>最常錯的題目</h3>${s.top_wrong.map((q) => `<a class="list-item" href="#/q/${q.id}">
      <span class="tag bad" style="width:64px;justify-content:center">錯 ${q.wrong_count} 次</span>
      <span class="t">${esc(q.unit || q.subject)}・${esc(q.stem.replace(/\$[^$]*\$/g, '…').slice(0, 40))}</span>
      ${q.mastered ? '<span class="tag ok">已精熟</span>' : ''}</a>`).join('')}</div>` : ''}
    <div class="card"><h3>近 12 週學習日曆</h3>
      <div class="calendar">${s.calendar.map((d) => `<i title="${d.day}：${d.xp} XP" class="${d.xp ? 'l' + Math.min(3, Math.ceil(d.xp / maxCal * 3)) : ''}"></i>`).join('')}</div>
      <p class="small muted">連續學習 ${s.me.streak} 天・最高紀錄 ${s.me.best_streak} 天・近 30 天作答 ${s.attempts_30d} 次</p></div>
    <div class="card"><h3>AI 使用量（近 30 天）</h3>
      <p>呼叫 ${s.usage.calls} 次・輸入 ${(s.usage.inp / 1000).toFixed(0)}K tokens・輸出 ${(s.usage.outp / 1000).toFixed(0)}K tokens・約 <b>US$ ${s.usage.usd}</b></p></div>`);
  $('#genrep').onclick = async () => {
    const b = busy('AI 分析中…');
    try {
      const r = await post('/api/report');
      await waitJob(r.job_id, (j) => b.update(j));
      b.close();
      render(main);
    } catch (e) { b.close(); errToast(e); }
  };
}

// 考試目標: exam date + range per child; the child's home shows a countdown
// and today's focus unit (the weakest unit in range, rotating daily).
async function goals(pb) {
  const st = await get('/api/status');
  const kids = (st.profiles || st.students).filter((s) => s.role !== 'parent');
  const lists = await Promise.all(kids.map((k) => get(`/api/goals?student_id=${k.id}`)));
  html(pb, `<div class="card"><h2>考試目標</h2>
    <p class="sub">設定段考日期和範圍，孩子首頁會倒數，並每天挑一個範圍內最弱的單元當「今天的重點」。</p>
    ${kids.map((k, i) => `<div class="label" style="margin-top:12px">${k.avatar} ${esc(k.name)}</div>
      ${lists[i].length ? lists[i].map((g) => `<div class="list-item"><span class="t wrap"><b>${esc(g.title)}</b>　${g.exam_date}（還有 ${g.days_left} 天）
        <br><span class="small muted">${(g.units || []).map((u) => esc(u[1])).join('、') || '全部單元'}</span></span>
        <button class="icon-btn" data-delg="${g.id}" aria-label="刪除">${icon('trash', 18)}</button></div>`).join('') : '<p class="small muted">還沒有設定</p>'}
      <button class="btn sm soft" data-addg="${k.id}">新增考試</button>`).join('') || '<p class="sub">先到「帳號」新增孩子。</p>'}</div>`);
  $$('[data-delg]', pb).forEach((b) => b.onclick = async () => { if (!await confirmBox('刪除這場考試的目標？', '刪除', true)) return; await del(`/api/goals/${b.dataset.delg}`); goals(pb); });
  $$('[data-addg]', pb).forEach((b) => b.onclick = async () => {
    const kid = kids.find((k) => k.id === Number(b.dataset.addg));
    // AI-free but automatic: title by season, date in two weeks, range = units from recent scans + open wrong questions
    const [sug, cur] = await Promise.all([
      get(`/api/goals/suggest?student_id=${kid.id}`),
      Promise.all(['數學', '國語', '自然', '社會', '英語'].map((sub) => get(`/api/curriculum?subject=${encodeURIComponent(sub)}&grade=${kid.grade}`).then((r) => [sub, r]).catch(() => [sub, []]))),
    ]);
    const seen = new Set();
    const units = [...sug.units, ...cur.flatMap(([sub, r]) => (Array.isArray(r) ? r : r.units || []).filter((u) => !u.grade || u.grade === kid.grade).map((u) => [sub, u.unit]))]
      .filter((u) => { const k = u.join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
    const picked = new Set(sug.units.map((u) => u.join('|')));
    const ok = await modal({
      title: `${esc(kid.name)} 的考試`,
      body: `<label class="field"><span>考試日期</span><input type="date" id="gd" value="${sug.exam_date}"></label>
        <label class="field"><span>名稱</span><input type="text" id="gt" value="${esc(sug.title)}"></label>
        <div class="label">考試範圍${sug.reason ? `<span class="small muted">（${esc(sug.reason)}，可再點選調整）</span>` : '（不選＝全部）'}</div>
        <div class="chips" style="max-height:260px;overflow:auto">${units.map((u, i) => `<button class="chip ${picked.has(u.join('|')) ? 'on' : ''}" data-u="${i}">${esc(u[0])}・${esc(u[1])}</button>`).join('')}</div>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-close>取消</button><button class="btn" id="gs">儲存</button></div>`,
      onOpen: (m, close) => {
        m.querySelectorAll('[data-u]').forEach((c) => c.onclick = () => c.classList.toggle('on'));
        m.querySelector('#gs').onclick = async () => {
          const sel = [...m.querySelectorAll('[data-u].on')].map((c) => units[Number(c.dataset.u)]);
          try {
            await post('/api/goals', { student_id: kid.id, title: m.querySelector('#gt').value, exam_date: m.querySelector('#gd').value, units: sel });
            close(true);
          } catch (e) { errToast(e); }
        };
      },
    });
    if (ok) { toast('已設定', 'ok'); goals(pb); }
  });
}

// 獎勵: real-world rewards the children buy with coins; parents approve.
const SUGGEST = [['多看 30 分鐘卡通', 150], ['週末選一個點心', 200], ['晚睡 30 分鐘', 250], ['去公園玩', 300], ['挑一本新書', 500], ['和爸媽玩桌遊', 200]];
async function rewards(pb) {
  const rw = await get('/api/rewards');
  html(pb, `<div class="card"><h2>獎勵兌換</h2>
    <p class="sub">設定孩子可以用金幣兌換的真實獎勵（例如：多看 30 分鐘卡通、週末去公園）。每答對一題約得 5～10 金幣。</p>
    ${rw.pending.length ? `<div class="label">等你核准</div>${rw.pending.map((x) => `<div class="list-item"><span class="t">${esc(x.name)} 想兌換「${esc(x.title)}」（${x.cost} 金幣）</span>
      <button class="btn sm ok" data-rw="${x.id}|approved">核准</button><button class="btn sm ghost" data-rw="${x.id}|rejected">退回</button></div>`).join('')}` : ''}
    <div class="label" style="margin-top:12px">獎勵清單</div>
    ${rw.rewards.length ? `<div class="group">${rw.rewards.map((r) => `<div class="gi"><span class="t">${esc(r.title)}</span><span class="tag">${r.cost} 金幣</span>
      <button class="icon-btn" data-delr="${r.id}" aria-label="刪除">${icon('trash', 18)}</button></div>`).join('')}</div>` : '<p class="small muted">還沒有獎勵</p>'}
    <div class="label" style="margin-top:12px">常見獎勵（點一下就加入）</div>
    <div class="chips">${SUGGEST.filter(([t]) => !rw.rewards.some((r) => r.title === t)).map(([t, c]) => `<button class="chip" data-sug="${esc(t)}|${c}">${esc(t)}・${c}</button>`).join('')}</div>
    <div class="row nowrap" style="margin-top:12px"><input type="text" id="rt" placeholder="或自己寫一個" style="flex:1;min-width:0">
      <input type="number" id="rc" value="200" min="1" style="width:90px"><button class="btn" id="radd">新增</button></div></div>`);
  $('#radd').onclick = async () => {
    const title = $('#rt').value.trim();
    if (!title) return;
    try { await post('/api/rewards', { title, cost: Number($('#rc').value) || 100 }); rewards(pb); } catch (e) { errToast(e); }
  };
  $$('[data-sug]', pb).forEach((b) => b.onclick = async () => {
    const [title, cost] = b.dataset.sug.split('|');
    try { await post('/api/rewards', { title, cost: Number(cost) }); rewards(pb); } catch (e) { errToast(e); }
  });
  $$('[data-delr]', pb).forEach((b) => b.onclick = async () => { if (!await confirmBox('刪除這個獎勵？', '刪除', true)) return; await del(`/api/rewards/${b.dataset.delr}`); rewards(pb); });
  $$('[data-rw]', pb).forEach((b) => b.onclick = async () => {
    const [id, status] = b.dataset.rw.split('|');
    await post(`/api/redemptions/${id}`, { status });
    toast(status === 'approved' ? '已核准' : '已退回（金幣已退還）', 'ok');
    window.dispatchEvent(new Event('me-changed'));
    rewards(pb);
  });
}

// 求救信箱: questions a child flagged with 「請爸媽幫忙」; reply appears on the child's home page.
async function help(pb) {
  const hs = await get('/api/help');
  html(pb, `<div class="card"><h2>求救信箱</h2>
    <p class="sub">孩子在題目頁按「請爸媽幫忙」會出現在這裡。回覆會顯示在孩子的首頁。</p>
    ${hs.length ? hs.map((h) => `<div class="card tight" style="margin:8px 0">
      <div class="row nowrap"><span style="font-size:22px">${h.avatar}</span><b style="flex:1">${esc(h.name)}</b><span class="small muted">${h.created_at.slice(5, 16).replace('T', ' ')}</span></div>
      <div class="small muted" style="margin:4px 0">${esc(h.subject || '')}・${esc(h.unit || '')}</div>
      <a href="#/q/${h.question_id}">${esc((h.stem || '').slice(0, 80))}</a>
      ${h.message ? `<div style="margin-top:6px">「${esc(h.message)}」</div>` : ''}
      <div class="row nowrap" style="margin-top:8px"><input type="text" placeholder="回覆給孩子（可不寫）" data-reply="${h.id}" style="flex:1;min-width:0">
        <button class="btn sm" data-hdone="${h.id}">完成</button></div></div>`).join('') : '<p class="sub">目前沒有求救。</p>'}</div>`);
  $$('[data-hdone]', pb).forEach((b) => b.onclick = async () => {
    const reply = pb.querySelector(`[data-reply="${b.dataset.hdone}"]`).value;
    await post(`/api/help/${b.dataset.hdone}`, { status: 'done', reply });
    toast('已回覆', 'ok');
    help(pb);
  });
}

async function homework(pb) {
  const papers = await get('/api/papers');
  const hw = papers.filter((p) => p.kind === 'homework');
  html(pb, `<div class="card"><h2>指派作業給孩子</h2>
    <p class="sub">1. 到「錯題本・題庫」或任一份考卷，勾選題目 → 按「組卷列印」<br>2. 在組卷頁按「指派為作業」，設定期限<br>3. 孩子首頁會出現作業提醒，可以直接在平板上作答或印出來寫</p>
    <a class="btn" href="#/bank?view=list">前往題庫挑題</a></div>
    <div class="card"><h3>已指派的作業</h3>${hw.length ? hw.map((p) => `<div class="list-item"><span>${p.status === 'done' ? '' : ''}</span>
      <a class="t" href="#/paper/${p.id}">${esc(p.title)}（${p.question_ids.length} 題）</a>
      ${p.due_date ? `<span class="tag ${p.status === 'done' ? 'ok' : 'warn'}">${p.due_date}</span>` : ''}
      <button class="icon-btn" data-del="${p.id}" aria-label="刪除">${icon('trash', 18)}</button></div>`).join('') : '<p class="sub">目前沒有作業</p>'}</div>`);
  $$('[data-del]', pb).forEach((b) => b.onclick = async () => { if (!await confirmBox('刪除這份作業？（題目不會被刪除）', '刪除', true)) return; await del(`/api/papers/${b.dataset.del}`); homework(pb); });
}

async function students(pb, main) {
  const st = await get('/api/status');
  state.status.students = st.students;
  state.status.profiles = st.profiles;
  const all = st.profiles || st.students;
  html(pb, `<div class="card"><h2>帳號</h2>
    <p class="sub">每個人用自己的帳號登入，錯題本、練習紀錄、獎勵都分開；題庫重點卡等資料大家共用。家長帳號可以查看所有孩子的資料。</p>
    <div class="group">${all.map((s) => `<div class="gi"><span style="font-size:26px">${s.avatar}</span>
      <span class="t"><b>${esc(s.name)}</b><br><span class="small muted">${s.role === 'parent' ? '家長' : `${s.grade} 年級`}</span></span>
      <button class="btn sm ghost" data-edit="${s.id}">編輯</button>
      <button class="icon-btn" data-del="${s.id}" aria-label="刪除">${icon('trash', 18)}</button></div>`).join('')}</div>
    <div class="row"><button class="btn soft" id="add">新增孩子</button><button class="btn ghost" id="addp">新增家長</button></div></div>`);
  const edit = (s = {}, role = 'student') => modal({
    title: s.id ? `編輯 ${esc(s.name)}` : role === 'parent' ? '新增家長' : '新增孩子',
    body: `<label class="field"><span>名字</span><input type="text" id="nm" value="${esc(s.name || '')}"></label>
      ${(s.role || role) === 'parent' ? '' : `<label class="field"><span>年級</span><select id="gr">${[1, 2, 3, 4, 5, 6].map((g) => `<option ${g === (s.grade || 6) ? 'selected' : ''}>${g}</option>`).join('')}</select></label>`}
      <label class="field"><span>${(s.role || role) === 'parent' ? '密碼（至少 4 個字）' : '登入密碼（4~6 位數字）'}${s.id ? '・不改請留空' : ''}</span>
        <input type="password" id="pw" ${(s.role || role) === 'parent' ? '' : 'inputmode="numeric"'} autocomplete="new-password"></label>
      <button class="btn block" id="sv">儲存</button>`,
    onOpen: (m, close) => m.querySelector('#sv').onclick = async () => {
      const gr = m.querySelector('#gr');
      const body = { name: m.querySelector('#nm').value, grade: gr ? Number(gr.value) : 6 };
      const pw = m.querySelector('#pw').value;
      if (pw) body.pin = pw;
      try {
        if (s.id) await put(`/api/students/${s.id}`, body);
        else await post('/api/students', { ...body, role });
        close(); students(pb, main); window.dispatchEvent(new Event('me-changed'));
      } catch (e) { errToast(e); }
    },
  });
  $('#add').onclick = () => edit({}, 'student');
  $('#addp').onclick = () => edit({}, 'parent');
  $$('[data-edit]', pb).forEach((b) => b.onclick = () => edit(all.find((s) => s.id === Number(b.dataset.edit))));
  $$('[data-del]', pb).forEach((b) => b.onclick = async () => {
    if (!await confirmBox('刪除這個帳號？（題目與紀錄會留在資料庫中）', '刪除', true)) return;
    try { await del(`/api/students/${b.dataset.del}`); students(pb, main); } catch (e) { errToast(e); }
  });
}

async function settings(pb) {
  const s = await get('/api/settings');
  const EFF = ['low', 'medium', 'high', 'xhigh', 'max'];
  const effSel = (k, label) => `<label class="field"><span>${label}</span><select name="${k}">${EFF.map((e) => `<option ${s[k] === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>`;
  html(pb, `
    <div class="card"><h2>各設備連線網址</h2>
      <p class="sub">手機、平板、電腦連上同一個 Wi-Fi 後，用瀏覽器打開下面任一個網址即可使用（iPad/手機可「加入主畫面」當 App 用）。</p>
      ${(s.urls || []).map((u) => `<div class="list-item"><span class="kbd t">${esc(u)}</span></div>`).join('')}</div>
    <div class="card"><h2>AI 設定（Claude）</h2>
      <label class="field"><span>使用方式</span><select name="ai_provider">
        <option value="auto" ${s.ai_provider === 'auto' ? 'selected' : ''}>自動（有 API 金鑰就用金鑰，否則用 claude.ai 帳號）</option>
        <option value="subscription" ${s.ai_provider === 'subscription' ? 'selected' : ''}>用我的 claude.ai 帳號（網頁登入的訂閱方案）</option>
        <option value="api" ${s.ai_provider === 'api' ? 'selected' : ''}>用 API 金鑰</option></select></label>
      <div class="card tight" style="background:var(--sunk);border:0">
        ${s.subscription_ready
          ? '<span class="status-dot ok"></span> 樹莓派上的 Claude Code 已登入 claude.ai 帳號，可以直接使用（會算在你訂閱方案的使用額度內）。'
          : s.claude_cli
            ? '<span class="status-dot bad"></span> 樹莓派上的 Claude Code 尚未登入。請在樹莓派的終端機輸入 <span class="kbd">claude</span>，再輸入 <span class="kbd">/login</span>，用你的 claude.ai 帳號登入。'
            : '<span class="status-dot bad"></span> 樹莓派上沒有安裝 Claude Code。'}
        <div class="small muted" style="margin-top:4px">目前使用：${s.provider_effective === 'subscription' ? 'claude.ai 帳號' : 'API 金鑰'}</div>
      </div>
      <details style="margin:12px 0"><summary class="small" style="cursor:pointer">API 金鑰（選用）</summary>
      <label class="field" style="margin-top:8px"><span>Claude API 金鑰 ${s.api_key_set ? '（已設定：' + esc(s.api_key) + '）' : '（尚未設定）'}</span>
        <input type="password" name="api_key" placeholder="sk-ant-...（console.anthropic.com）" autocomplete="off"></label></details>
      <div class="grid g2">
        <label class="field"><span>模型（出題、詳解、重點整理）</span><input type="text" name="model" value="${esc(s.model)}"></label>
        <label class="field"><span>互動用的快速模型（聊天、提示、手寫批改、換方法解說）</span>
          <select name="model_fast">${[['claude-sonnet-5-5', 'Sonnet 5.5（快，建議）'], ['', '和上面相同（最高品質，較慢）'], ['claude-haiku-5-5', 'Haiku 5.5（最快）']]
            .map(([v, l]) => `<option value="${v}" ${(s.model_fast || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>API 位址（通常留空）</span><input type="text" name="base_url" value="${esc(s.base_url || '')}" placeholder="https://api.anthropic.com"></label>
      </div>
      <div class="grid g3">
        ${effSel('effort_extract', '試卷辨識 精細度')}${effSel('effort_solve', '詳解 精細度')}${effSel('effort_tutor', '手寫批改 精細度')}
        ${effSel('effort_content', '重點整理/出題 精細度')}${effSel('effort_chat', 'AI 小老師聊天 精細度')}
      </div>
      <label class="check"><input type="checkbox" name="use_fallbacks" ${s.use_fallbacks ? 'checked' : ''}> AI 拒絕回答時自動改用備援模型</label>
      <div class="row" style="margin-top:12px"><button class="btn" id="save1">儲存</button><button class="btn ghost" id="test">測試連線</button></div>
    </div>
    <div class="card"><h2>安全</h2>
      <div class="grid g2">
        <label class="field"><span>家庭密碼（在每台裝置第一次開啟時輸入一次；留空＝不需要。若開放外網請務必設定）</span><input type="text" name="site_password" value="${esc(s.site_password)}"></label>
      </div>
      <button class="btn" id="save2">儲存</button></div>
    <div class="card"><h2>掃描預設</h2>
      <label class="field"><span>使用的教科書版本（參考用）</span><select name="textbook">${['康軒', '南一', '翰林', '其他'].map((t) => `<option ${s.textbook === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <button class="btn" id="save3">儲存</button></div>
    <div class="card" id="nascard"><span class="spinner"></span></div>
    <div class="card" id="printers"><span class="spinner"></span></div>
    <div class="card"><h2>備份</h2><p class="sub">下載整個資料庫與所有照片（zip），可在新的樹莓派還原。</p>
      <button class="btn soft" id="backup">下載備份</button></div>`);
  import('./printer.js').then(({ printerSettings }) => printerSettings(pb.querySelector('#printers')));
  nasCard(pb.querySelector('#nascard'));
  const val = (n) => {
    const el = pb.querySelector(`[name=${n}]`);
    return el.type === 'checkbox' ? el.checked : el.value;
  };
  const save = async (keys) => {
    const body = {};
    keys.forEach((k) => { body[k === 'remove_color' ? 'remove_color_ink' : k] = val(k); });
    try {
      await put('/api/settings', body);
      if (body.parent_pin && state.parentPin) setParentPin(body.parent_pin);
      state.status = await get('/api/status');
      toast('已儲存 ', 'ok');
    } catch (e) { errToast(e); }
  };
  $('#save1').onclick = () => save(['ai_provider', 'api_key', 'model', 'model_fast', 'base_url', 'effort_extract', 'effort_solve', 'effort_tutor', 'effort_content', 'effort_chat', 'use_fallbacks']);
  $('#save2').onclick = () => save(['site_password']);
  $('#save3').onclick = () => save(['textbook']);
  $('#test').onclick = async () => {
    const b = busy('測試連線中…');
    try { const r = await post('/api/settings/test'); b.close(); toast('' + r.reply, 'ok'); } catch (e) { b.close(); errToast(e); }
  };
  $('#backup').onclick = async () => {
    const b = busy('打包備份中…');
    try {
      const res = await fetch('/api/backup', { headers: { 'X-Parent-Pin': state.parentPin } });
      if (!res.ok) throw new Error('備份失敗');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ai-review-backup-${localDay()}.zip`;
      a.click();
    } catch (e) { errToast(e); }
    b.close();
  };
}


// NAS: automatic copy of everyone's data (database, photos, per-child CSVs).
async function nasCard(el) {
  const n = await get('/api/nas');
  const stats = n.last_stats || {};
  el.innerHTML = `<h2>NAS 自動同步</h2>
    <p class="sub">所有人的資料（資料庫、考卷照片、每位孩子的錯題本與練習紀錄）會自動同步到 NAS：掃描後立刻同步，平常每 10 分鐘檢查一次。資料庫本體仍放在樹莓派上，速度快也不怕網路斷線。</p>
    <label class="field"><span>NAS 資料夾</span><input type="text" id="nasp" value="${esc(n.path)}"></label>
    <div class="grid g2">
      <label class="field"><span>NAS 帳號</span><input type="text" id="nasu" value="${esc(n.user)}" autocomplete="off"></label>
      <label class="field"><span>NAS 密碼 ${n.password_set ? '（已設定，不改請留空）' : ''}</span><input type="password" id="naspw" autocomplete="new-password"></label>
    </div>
    <label class="check"><input type="checkbox" id="nase" ${n.enabled ? 'checked' : ''}> 啟用自動同步</label>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="nassave">儲存並測試連線</button>
      <button class="btn ghost" id="nasnow" ${n.enabled ? '' : 'disabled'}>立即同步</button>
    </div>
    <p class="small" style="margin-top:10px">${n.last_error ? `<span style="color:var(--bad)">${esc(n.last_error)}</span>`
      : n.last_sync ? `<span class="status-dot ok"></span> 上次同步：${n.last_sync.replace('T', ' ').slice(0, 16)}${stats.exams != null ? `・NAS 上有 ${stats.exams} 份考卷（「考卷」資料夾，每份有 Word 試卷、解答與照片）、${stats.photos || 0} 個圖檔` : ''}（這次新上傳 ${stats.files || 0} 個）` : '還沒有同步過'}</p>`;
  const $e = (s) => el.querySelector(s);
  $e('#nassave').onclick = async () => {
    const b = busy('連線到 NAS…');
    try {
      await put('/api/nas', { path: $e('#nasp').value, user: $e('#nasu').value, password: $e('#naspw').value, enabled: $e('#nase').checked });
      await post('/api/nas/test');
      if ($e('#nase').checked) { b.update({ message: '第一次同步中（照片較多時需要一點時間）…', progress: 50 }); await post('/api/nas/sync'); }
      b.close();
      toast('NAS 連線成功 ✓', 'ok');
    } catch (e) { b.close(); errToast(e); }
    nasCard(el);
  };
  $e('#nasnow').onclick = async () => {
    const b = busy('同步中…');
    try { const r = await post('/api/nas/sync'); b.close(); toast(`同步完成：NAS 上有 ${r.exams ?? '?'} 份考卷（這次新上傳 ${r.files} 個圖檔）`, 'ok'); } catch (e) { b.close(); errToast(e); }
    nasCard(el);
  };
}
