import { del, get, post, put, qs, setParentPin, state, waitJob } from '../api.js';
import { WRONG_PAPER } from './common.js';
import { $, $$, confirmBox, debounce, errToast, esc, fmtDate, html, icon, modal, rich, subjectIcon, toast, localDay } from '../ui.js';

const DEFAULTS = {
  orientation: 'portrait', columns: 1, font_size: 14, answer_space: 2, answers: 'end', explanations: false,
  header: true, writing_mode: 'horizontal', show_figures: true, mode: 'questions', bw: false,
};

export async function render(main, [id]) {
  if (id) return builder(main, Number(id));
  const papers = await get('/api/papers');
  html(main, `
    <div class="page-head"><div class="grow"><h1>組卷列印</h1>
      <div class="sub">從題庫挑題組成 A4 試卷：直印/橫印、A4 單欄、附答案或詳解，可直接列印、下載 PDF 或 Word</div></div>
      <button class="btn" id="new">新試卷</button></div>
    <div class="grid g3" style="margin-bottom:16px">
      <button class="task" id="qwrong"><div class="ti">${icon('x')}</div><div><b>錯題卷</b><span class="sub">所有未精熟的錯題</span></div></button>
      <button class="task" id="qhl"><div class="ti">${icon('marker')}</div><div><b>螢光筆＋記號題</b><span class="sub">畫過重點的題目</span></div></button>
      <button class="task" id="qbank"><div class="ti">${icon('book')}</div><div><b>自己挑題</b><span class="sub">到題庫勾選</span></div></button>
    </div>
    <div class="card">${papers.length ? papers.map((p) => `<div class="list-item">
      <span>${p.kind === 'homework' ? '' : ''}</span><a class="t" href="#/paper/${p.id}"><b>${esc(p.title)}</b>
      <span class="small muted">・${p.question_ids.length} 題・${fmtDate(p.created_at)}</span></a>
      ${p.kind === 'homework' ? `<span class="tag ${p.status === 'done' ? 'ok' : 'warn'}">${p.status === 'done' ? '已完成' : '作業'}</span>` : ''}
      <button class="icon-btn" data-del="${p.id}" aria-label="刪除">${icon('trash', 18)}</button></div>`).join('') : '<div class="empty">還沒有組過試卷</div>'}</div>`);
  const make = async (title, params) => {
    const r = await get('/api/questions' + qs({ ...params, limit: 200 }));
    if (!r.items.length) { toast('沒有符合的題目'); return; }
    const p = await post('/api/papers', { title, question_ids: r.items.map((q) => q.id), config: /錯題/.test(title) ? WRONG_PAPER : {} });
    location.hash = `#/paper/${p.id}`;
  };
  $('#new').onclick = async () => { const p = await post('/api/papers', { title: '複習卷', question_ids: [] }); location.hash = `#/paper/${p.id}`; };
  $('#qwrong').onclick = () => make('錯題複習卷', { flags: 'unmastered', sort: 'unit' });
  $('#qhl').onclick = () => make('重點題複習卷', { flags_any: 'highlighted,marked', sort: 'unit' });
  $('#qbank').onclick = () => { location.hash = '#/bank?view=list'; };
  $$('[data-del]', main).forEach((b) => b.onclick = async () => {
    if (!await confirmBox('刪除這份試卷？（題目不會被刪除）', '刪除', true)) return;
    await del(`/api/papers/${b.dataset.del}`);
    render(main, []);
  });
}

async function builder(main, id) {
  const p = await get(`/api/papers/${id}`);
  let qsList = p.questions;
  const cfg = { ...DEFAULTS, ...(p.config || {}) };
  let token = null;
  const isHw = p.kind === 'homework';
  const seg = (k, opts) => `<div class="seg" style="margin:0">${opts.map(([v, l]) => `<button data-seg="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
  html(main, `
    <div class="page-head"><a href="#/papers" class="back" aria-label="返回">${icon('back', 22)}</a>
      <div class="grow"><input type="text" id="ttl" value="${esc(p.title)}" aria-label="試卷名稱" style="font-size:20px;font-weight:700;border-color:transparent;background:transparent;padding-left:0"></div>
      ${isHw ? `<span class="tag warn">作業${p.due_date ? '・期限 ' + p.due_date : ''}</span>` : ''}
      <button class="btn ghost sm" id="pdf">${icon('download', 16)} PDF</button>
      <button class="btn ghost sm" id="word">Word</button>
    </div>
    <div class="builder">
      <div class="paper-preview"><iframe id="pv" title="預覽"></iframe></div>
      <div>
        <div class="label">範本 <a href="#/templates" class="small" style="font-weight:400">看全部範本・用自己的 Word</a></div>
        <select id="tplsel" style="margin-bottom:12px"><option value="">不套範本（自己設定）</option></select>
        <div class="small muted hidden" id="tplnote" style="margin:-6px 0 12px">這是你的 Word 範本：字型、邊界、表頭照你的 Word；下面的設定只影響題目和答案。</div>
        <div class="label">方向</div>${seg('orientation', [['portrait', '直印'], ['landscape', '橫印']])}

        <div class="label" style="margin-top:14px">先教再練</div>
        <div class="group">
          <label class="gi"><span class="t">卷首附「觀念教學重點」</span><input type="checkbox" class="selbox" data-k="lesson"></label>
          <div class="gi" id="lessonrow"><span class="t small muted" id="lessonst"></span><button class="btn sm soft" id="mklesson">產生</button></div>
          <label class="gi"><span class="t">依題型分大題</span><input type="checkbox" class="selbox" data-k="group_by_type"></label>
          <label class="gi"><span class="t">題號</span><select data-k="numbering"><option value="section">每大題重新編號</option><option value="continuous">全卷連續編號</option></select></label>
          <label class="gi"><span class="t">圖解（列印為圖片）</span><input type="checkbox" class="selbox" data-k="visuals"></label>
        </div>
        <div class="group">
          <label class="gi"><span class="t">答案</span><select data-k="answers"><option value="none">不附</option><option value="end">附在最後</option><option value="separate">另一份解答卷</option><option value="inline">每題下方</option></select></label>
          <label class="gi"><span class="t">附詳解</span><input type="checkbox" class="selbox" data-k="explanations"></label>
          <label class="gi"><span class="t">字級</span><select data-k="font_size">${[12, 13, 14, 16, 18, 20].map((x) => `<option value="${x}">${x} pt</option>`).join('')}</select></label>
          <label class="gi"><span class="t">作答空間</span><select data-k="answer_space">${[[0, '不留'], [1, '少'], [2, '一般'], [4, '多'], [7, '很多']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label class="gi"><span class="t">文字方向</span><select data-k="writing_mode"><option value="horizontal">橫書</option><option value="vertical">直書</option></select></label>
          <label class="gi"><span class="t">姓名、日期、分數欄</span><input type="checkbox" class="selbox" data-k="header"></label>
          <label class="gi"><span class="t">顯示附圖</span><input type="checkbox" class="selbox" data-k="show_figures"></label>
          <label class="gi"><span class="t">標示出處單元</span><input type="checkbox" class="selbox" data-k="show_source"></label>
        </div>
        <div class="label">印表機</div>
        <div id="printerPanel" class="card"><span class="spinner"></span></div>
        <details class="card">
          <summary style="cursor:pointer;font-weight:700"><span id="qcount">題目（${qsList.length}）</span></summary>
          <div class="row" style="margin-top:10px"><button class="btn sm soft" id="add">${icon('plus', 16)} 加題目</button><button class="btn sm ghost" id="sortu">依單元排序</button></div>
          <div id="list" style="margin-top:8px;max-height:360px;overflow:auto"></div>
        </details>
        <div class="grid g2">
          <button class="btn ghost" id="online">線上作答</button>
          ${isHw ? `<button class="btn warn" id="done" ${p.status === 'done' ? 'disabled' : ''}>作業完成</button>` : '<button class="btn ghost" id="assign">指派為作業</button>'}
        </div>
        <button class="btn link" id="save" style="margin-top:8px">儲存設定</button>
      </div>
    </div>`);

  const markSeg = () => $$('[data-seg]', main).forEach((b) => b.classList.toggle('on', String(cfg[b.dataset.seg]) === b.dataset.v));
  $$('[data-seg]', main).forEach((b) => b.onclick = () => {
    cfg[b.dataset.seg] = isNaN(Number(b.dataset.v)) ? b.dataset.v : Number(b.dataset.v);
    markSeg();
    refresh();
  });
  markSeg();

  const syncControls = () => $$('[data-k]', main).forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!cfg[k]; else el.value = String(cfg[k]);
  });
  get('/api/templates').then((t) => {
    const sel = $('#tplsel');
    sel.innerHTML += t.templates.filter((x) => !x.hidden || x.id === cfg.template).map((x) => `<option value="${x.id}">${esc(x.name)}${x.kind === 'custom' ? '（我的範本）' : ''}</option>`).join('');
    sel.value = cfg.template || '';
    const note = () => $('#tplnote').classList.toggle('hidden', !(t.templates.find((x) => x.id === sel.value) || {}).kind?.includes('custom'));
    note();
    sel.onchange = () => {
      const tpl = t.templates.find((x) => x.id === sel.value);
      if (tpl) Object.assign(cfg, tpl.config, { template: tpl.id }); else cfg.template = '';
      syncControls(); markSeg(); note(); refresh();
    };
  }).catch(() => {});
  $$('[data-k]', main).forEach((el) => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!cfg[k]; else el.value = String(cfg[k]);
    el.onchange = () => {
      cfg[k] = el.type === 'checkbox' ? el.checked : (isNaN(Number(el.value)) ? el.value : Number(el.value));
      refresh();
    };
  });

  const drawList = () => {
    $('#list').innerHTML = qsList.length ? qsList.map((q, i) => `<div class="list-item">
      <b style="width:26px">${i + 1}.</b><span class="t" title="${esc(q.stem)}">${subjectIcon(q.subject)} ${esc(q.stem.replace(/\$[^$]*\$/g, '…').replace(/\{([^|}]*)\|[^}]*\}/g, '$1').slice(0, 40))}</span>
      <span class="tag gray">${esc(q.qtype)}</span>
      <button class="icon-btn" data-up="${i}">↑</button><button class="icon-btn" data-dn="${i}">↓</button><button class="icon-btn" data-rm="${i}">✕</button></div>`).join('')
      : '<div class="empty">按「加題目」從題庫挑選</div>';
    $$('[data-up]').forEach((b) => b.onclick = () => { const i = +b.dataset.up; if (i > 0) [qsList[i - 1], qsList[i]] = [qsList[i], qsList[i - 1]]; drawList(); refresh(); });
    $$('[data-dn]').forEach((b) => b.onclick = () => { const i = +b.dataset.dn; if (i < qsList.length - 1) [qsList[i + 1], qsList[i]] = [qsList[i], qsList[i + 1]]; drawList(); refresh(); });
    $$('[data-rm]').forEach((b) => b.onclick = () => { qsList.splice(+b.dataset.rm, 1); drawList(); refresh(); });
    $('#qcount').textContent = `題目（${qsList.length}）`;
  };

  const spec = async () => {
    const r = await post('/api/print/spec', { title: $('#ttl').value, question_ids: qsList.map((q) => q.id), config: cfg, paper_id: id });
    token = r.token;
    return token;
  };
  const refresh = debounce(async () => {
    try { $('#pv').src = `/print.html?t=${await spec()}&preview=1`; } catch (e) { errToast(e); }
  }, 400);
  const save = async (extra = {}) => put(`/api/papers/${id}`, { title: $('#ttl').value, config: cfg, question_ids: qsList.map((q) => q.id), ...extra });

  $('#ttl').onchange = refresh;
  $('#sortu').onclick = () => { qsList.sort((a, b) => (a.subject + a.unit + a.qtype).localeCompare(b.subject + b.unit + b.qtype)); drawList(); refresh(); };
  $('#add').onclick = async () => {
    const picked = await pickQuestions(new Set(qsList.map((q) => q.id)));
    if (picked && picked.length) { qsList = qsList.concat(picked); drawList(); refresh(); }
  };
  $('#pdf').onclick = async () => { toast('產生 PDF 中…'); await save(); location.href = `/api/print/pdf/${await spec()}`; };
  $('#word').onclick = async () => { await save(); location.href = `/api/print/docx/${await spec()}`; };
  $('#save').onclick = async () => { await save(); toast('已儲存', 'ok'); };
  $('#online').onclick = async () => {
    const { startQuiz } = await import('./quiz.js');
    await startQuiz(qsList.filter((q) => q.solved), {
      mode: 'review', title: $('#ttl').value, lesson: cfg.lesson ? lesson : null,
    });
  };
  // Concept lesson (先教再練) for this paper, generated once by the AI.
  let lesson = p.lesson || null;
  const lessonState = () => {
    $('#lessonst').textContent = lesson ? `已產生 ${lesson.concepts.length} 個觀念重點` : '還沒有教學重點';
    $('#mklesson').textContent = lesson ? '重新產生' : 'AI 產生';
  };
  const makeLesson = async () => {
    if (!qsList.length) return;
    await save();
    $('#mklesson').disabled = true;
    $('#lessonst').innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> AI 整理觀念中…';
    try {
      const r = await post(`/api/papers/${id}/lesson`);
      await waitJob(r.job_id);
      if (!main.isConnected) return;
      lesson = (await get(`/api/papers/${id}`)).lesson;
      refresh();
    } catch (e) { if (main.isConnected) errToast(e); }
    if (!main.isConnected) return;
    $('#mklesson').disabled = false;
    lessonState();
  };
  $('#mklesson').onclick = makeLesson;
  lessonState();
  if (cfg.lesson && !lesson && qsList.length && state.status.ai_ready) makeLesson();
  const done = $('#done');
  if (done) done.onclick = async () => { await post(`/api/papers/${id}/complete`); toast('作業完成！+30 XP', 'gold'); builder(main, id); };
  const assign = $('#assign');
  if (assign) assign.onclick = () => {
    const isParent = state.status.user && state.status.user.role === 'parent';
    const due = localDay(3);
    return modal({
      title: '指派為作業',
      body: `<p class="sub">孩子的首頁會出現作業提醒。</p>
        ${isParent ? '' : `<label class="field"><span>家長密碼</span><input type="password" id="apin" value="${esc(state.parentPin)}"></label>`}
        <label class="field"><span>完成期限</span><input type="date" id="adue" value="${due}"></label><button class="btn block" id="ago">指派</button>`,
      onOpen: (m, close) => m.querySelector('#ago').onclick = async () => {
        try {
          const pin = m.querySelector('#apin');
          if (pin) {
            await post('/api/parent/verify', { pin: pin.value });
            setParentPin(pin.value);
          }
          await save({ kind: 'homework', status: 'assigned', due_date: m.querySelector('#adue').value });
          close();
          toast('已指派 ', 'ok');
          builder(main, id);
        } catch (e) { errToast(e); }
      },
    });
  };
  drawList();
  refresh();
  import('./printer.js').then(({ printerPanel }) => printerPanel($('#printerPanel'), async () => { await save(); return spec(); }, () => window.open(`/print.html?t=${token}&auto=1`, '_blank')));
}

async function pickQuestions(exclude) {
  const subjects = Object.keys(state.status.subjects || {});
  const F = { subject: '', flags: 'unmastered', q: '' };
  const chosen = new Map();
  return modal({
    title: '從題庫加題目', wide: true,
    body: `<div class="row"><select id="ps" style="width:auto"><option value="">全部科目</option>${subjects.map((s) => `<option>${s}</option>`).join('')}</select>
      <select id="pf" style="width:auto"><option value="unmastered">錯題</option><option value="highlighted">螢光筆</option><option value="marked">記號</option><option value="favorite">收藏</option><option value="">全部</option></select>
      <input type="search" id="pq" placeholder="搜尋" style="flex:1;width:auto"></div>
      <div id="pl" style="max-height:55vh;overflow:auto;margin:10px 0"></div>
      <div class="row"><span id="pc" class="sub">已選 0 題</span><span class="spacer"></span><button class="btn ghost" data-close>取消</button><button class="btn" id="pok">加入</button></div>`,
    onOpen: (m, close) => {
      const load = async () => {
        const r = await get('/api/questions' + qs({ ...F, limit: 200 }));
        const pl = m.querySelector('#pl');
        pl.innerHTML = r.items.filter((q) => !exclude.has(q.id)).map((q) => `<label class="list-item" style="cursor:pointer">
          <input type="checkbox" class="selbox" value="${q.id}" ${chosen.has(q.id) ? 'checked' : ''}>
          <span class="t" style="white-space:normal">${subjectIcon(q.subject)} ${rich(q.stem.slice(0, 90))}</span><span class="tag gray">${esc(q.qtype)}</span></label>`).join('') || '<div class="empty">沒有題目</div>';
        window.renderMathInElement && window.renderMathInElement(pl, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
        pl.querySelectorAll('input').forEach((c) => c.onchange = () => {
          const q = r.items.find((x) => x.id === Number(c.value));
          c.checked ? chosen.set(q.id, q) : chosen.delete(q.id);
          m.querySelector('#pc').textContent = `已選 ${chosen.size} 題`;
        });
      };
      m.querySelector('#ps').onchange = (e) => { F.subject = e.target.value; load(); };
      m.querySelector('#pf').onchange = (e) => { F.flags = e.target.value; load(); };
      m.querySelector('#pq').oninput = debounce((e) => { F.q = e.target.value; load(); });
      m.querySelector('#pok').onclick = () => close([...chosen.values()]);
      load();
    },
  });
}

// One-off print dialog (e.g. an answer book) without saving a paper.
export async function quickPrint({ title, question_ids, exam_id = 0, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const mk = async () => (await post('/api/print/spec', { title, question_ids, exam_id, config: cfg })).token;
  let tok = await mk();
  modal({
    title: `${esc(title)}`, wide: true,
    body: `<div class="row" style="margin-bottom:10px">
      <select id="qo" style="width:auto"><option value="portrait">直印</option><option value="landscape">橫印</option></select>
      <span class="spacer"></span><button class="btn" id="qs">送到印表機</button><button class="btn soft" id="qp">本機列印</button><button class="btn soft" id="qd">PDF</button>
      <button class="btn soft" id="qw">Word</button></div>
      <div class="paper-preview"><iframe id="qv" src="/print.html?t=${tok}&preview=1"></iframe></div>`,
    onOpen: (m) => {
      const upd = async () => { tok = await mk(); m.querySelector('#qv').src = `/print.html?t=${tok}&preview=1`; };
      m.querySelector('#qo').value = cfg.orientation;
      m.querySelector('#qo').onchange = (e) => { cfg.orientation = e.target.value; upd(); };
      m.querySelector('#qp').onclick = () => window.open(`/print.html?t=${tok}&auto=1`, '_blank');
      m.querySelector('#qs').onclick = async () => {
        const { sendToPrinter } = await import('./printer.js');
        sendToPrinter(async () => tok);
      };
      m.querySelector('#qd').onclick = () => { toast('產生 PDF 中…'); location.href = `/api/print/pdf/${tok}`; };
      const w = m.querySelector('#qw');
      if (w) w.onclick = () => { location.href = `/api/print/docx/${tok}`; };
    },
  });
}
