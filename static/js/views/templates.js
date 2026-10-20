// 試卷範本: what a scanned exam turns into. Each template is previewed with a real
// scanned exam of its own kind (a kind with none yet shows nothing — no made-up
// preview; the first exam of that kind fills it), can be downloaded as a Word file, changed in
// Word and uploaded again — from then on the exam comes out in that exact layout.
import { api, del, get, post, put, state } from '../api.js';
import { $, $$, confirmBox, errToast, esc, html, icon, modal, toast } from '../ui.js';

let list = null, MAIN = null;
const chosen = {}; // template id -> exam used for its preview

const isParent = () => state.status.user && state.status.user.role === 'parent';

export async function render(main) {
  MAIN = main;
  list = await get('/api/templates');
  html(main, `
    <div class="page-head"><a href="#/scan" class="back" aria-label="返回">${icon('back', 22)}</a>
      <div class="grow"><h1>試卷範本</h1>
      <div class="sub">掃描後 AI 會照範本把考卷重新排版成可編輯的 Word／PDF。先在這裡看看會變成什麼樣子，不滿意可以下載 Word 自己改再上傳。</div></div></div>
    <div class="group tpl-bar">
      <label class="gi"><span class="t">掃描時使用</span>
        <select id="tdefault"><option value="auto">AI 自動判斷（依試卷名稱）</option>
          ${list.templates.filter((t) => !t.hidden || t.id === list.default).map((t) => `<option value="${t.id}">${esc(t.name)}${t.kind === 'custom' ? '（我的範本）' : ''}</option>`).join('')}</select></label>
    </div>
    ${isParent() ? '<div id="tlist"></div>' : ''}
    <div class="grid g3 tpl-grid" id="tgrid"></div>
    ${isParent() ? uploadHtml() : '<p class="small muted">想用自己的 Word 範本？請爸爸媽媽在這一頁上傳。</p>'}`);
  $('#tdefault').value = list.default;
  $('#tdefault').onchange = async (e) => {
    try { await put('/api/templates/default', { id: e.target.value }); toast('之後掃描的考卷都會用這個範本', 'ok'); drawGrid(); } catch (err) { errToast(err); }
  };
  drawGrid();
  if (isParent()) { bindUpload(main); drawList(); }
}

// the real exams of a template's kind (an uploaded template: the kind it was made from)
const exOf = (t) => (list.examples || {})[t.kind === 'custom' ? (t.base || t.id) : t.id] || [];
const exFor = (t) => { const xs = exOf(t); return xs.find((e) => e.id === chosen[t.id]) || xs[0] || null; };

// 整理清單: which types the 掃描後排成 menu shows, and her own types (name, base, keywords, options)
function drawList() {
  const el = $('#tlist');
  if (!el) return;
  const KIND = { builtin: '內建', type: '自己設定', custom: '我的 Word' };
  el.innerHTML = `<details class="card tpl-manage" ${list._open ? 'open' : ''}><summary><b>整理「掃描後排成」清單</b><span class="small muted">勾選要出現在選單的類型・新增自己的類型（例如補習班週考）</span></summary>
    <div class="tpl-rows">${list.templates.map((t) => `<div class="tpl-row">
      <label class="check"><input type="checkbox" data-show="${t.id}" ${t.hidden ? '' : 'checked'}> <b>${esc(t.name)}</b></label>
      <span class="tag ${t.kind === 'builtin' ? 'gray' : ''}">${KIND[t.kind]}</span>
      ${t.kind === 'type' ? `<span class="small muted">${(t.keywords || []).length ? '名稱有「' + t.keywords.map(esc).join('」「') + '」就是這類' : '沒有設定關鍵字'}</span>
        <span class="spacer"></span><button class="btn sm ghost" data-edit="${t.id}">設定</button><button class="icon-btn" data-tdel2="${t.id}" aria-label="刪除">${icon('trash', 15)}</button>` : ''}
    </div>`).join('')}</div>
    <button class="btn soft" id="addtype" style="margin-top:10px">${icon('plus', 16)} 新增類型</button></details>`;
  el.querySelector('details').ontoggle = (e) => { list._open = e.target.open; };
  el.querySelectorAll('[data-show]').forEach((c) => c.onchange = async () => {
    try { await put(`/api/templates/${c.dataset.show}/hidden`, { hidden: !c.checked }); list = { ...(await get('/api/templates')), _open: true }; drawList(); drawGrid(); } catch (e) { errToast(e); }
  });
  el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => typeForm(list.templates.find((t) => t.id === b.dataset.edit)));
  el.querySelectorAll('[data-tdel2]').forEach((b) => b.onclick = async () => {
    const { confirmBox } = await import('../ui.js');
    if (!await confirmBox('刪除這個類型？（已經拍的考卷不會被刪掉，會改用 AI 自動判斷）', '刪除', true)) return;
    try { await del(`/api/templates/types/${b.dataset.tdel2}`); render(MAIN); } catch (e) { errToast(e); }
  });
  $('#addtype').onclick = () => typeForm(null);
}

function typeForm(t) {
  const bases = list.templates.filter((x) => x.kind === 'builtin');
  const c = (t && t.config) || {};
  const seg = (k, opts, cur) => `<div class="seg mini" data-seg="${k}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  modal({
    title: t ? `設定「${esc(t.name)}」` : '新增考卷類型',
    body: `<div class="group">
      <label class="gi"><span class="t">名稱</span><input type="text" id="tyname" value="${esc(t ? t.name : '')}" placeholder="例如：補習班週考" style="width:60%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
      <label class="gi"><span class="t">排版樣式</span><select id="tybase">${bases.map((b) => `<option value="${b.id}" ${t && t.base === b.id ? 'selected' : ''}>像「${esc(b.name)}」</option>`).join('')}</select></label>
      <label class="gi"><span class="t">名稱有這些字就是這類</span><input type="text" id="tykw" value="${esc(((t && t.keywords) || []).join('、'))}" placeholder="例如：週考、誠明" style="width:50%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
    </div>
    <div class="label">解答卷</div>${seg('answer_style', [['brief', '只有答案'], ['steps', '答案＋詳解'], ['visual', '詳解＋圖解']], c.answer_style || 'steps')}
    <div class="label">題號</div>${seg('numbering', [['section', '每大題重新編號'], ['continuous', '全卷連續']], c.numbering || 'section')}
    <div class="label">字級</div>${seg('font_size', [[12, '12'], [13, '13'], [14, '14'], [16, '16']], c.font_size || 14)}
    <p class="small muted">之後掃描的考卷，名稱有這些字就會自動排成這一類；也可以在掃描頁或考卷上直接選。</p>
    <button class="btn block lg" id="tysave">${t ? '儲存' : '新增'}</button>`,
    onOpen: (m, close) => {
      m.querySelectorAll('[data-seg] button').forEach((b) => b.onclick = () => { b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); });
      if (!t) m.querySelector('#tybase').onchange = null;
      m.querySelector('#tysave').onclick = async () => {
        const cfg = {};
        m.querySelectorAll('[data-seg]').forEach((g) => { const on = g.querySelector('.on'); if (on) cfg[g.dataset.seg] = isNaN(Number(on.dataset.v)) ? on.dataset.v : Number(on.dataset.v); });
        const body = { id: t && t.id, name: m.querySelector('#tyname').value, base: m.querySelector('#tybase').value,
          keywords: m.querySelector('#tykw').value.split(/[、,，\s]+/).filter(Boolean), config: cfg };
        try { await post('/api/templates/types', body); close(); toast(t ? '已儲存' : `已新增「${body.name}」`, 'ok'); list = { ...(await get('/api/templates')), _open: true }; drawList(); drawGrid(); }
        catch (e) { errToast(e); }
      };
    },
  });
}

function drawGrid() {
  const def = $('#tdefault').value;
  $('#tgrid').innerHTML = list.templates.filter((t) => !t.hidden).map((t) => {
    const xs = exOf(t), ex = exFor(t);
    return `
    <div class="card tpl-card" data-id="${t.id}">
      <div class="seg mini tpl-side" role="group" aria-label="看題目卷或解答卷">
        <button class="on" data-side="q" data-t="${t.id}">題目卷</button><button data-side="k" data-t="${t.id}">解答卷・${esc(styleName(t))}</button></div>
      ${ex ? `<button class="tpl-thumb" data-view="${t.id}" data-key="0" aria-label="預覽「${esc(t.name)}」"><span class="spinner"></span></button>`
        : `<div class="tpl-thumb tpl-none"><span>${icon(t.icon || 'doc', 28)}<b>還沒有${esc(t.name)}的考卷</b>
            <span class="small muted">${t.id === 'wrong' ? '有錯題之後，就會用她的錯題排給你看。' : `第一次掃描${esc(t.name)}、AI 整理好之後，這裡就會用那份考卷預覽。`}</span></span></div>`}
      ${xs.length > 1 ? `<select class="tpl-ex" data-t="${t.id}" aria-label="預覽用哪一份考卷">${xs.map((e) => `<option value="${e.id}" ${ex && e.id === ex.id ? 'selected' : ''}>${esc(e.title.slice(0, 30))}（${e.n} 題）</option>`).join('')}</select>`
        : ex ? `<div class="small muted tpl-exname">預覽：${esc(ex.title.slice(0, 34))}（${ex.n} 題）</div>` : ''}
      <div class="row" style="gap:6px;margin-top:10px"><b style="font-size:16px">${icon(t.icon || 'doc', 18)} ${esc(t.name)}</b>
        ${t.kind === 'custom' ? '<span class="tag">我的範本</span>' : ''}${def === t.id ? '<span class="tag ok">掃描預設</span>' : ''}</div>
      <div class="small muted" style="margin:4px 0 10px;min-height:3em">${esc(t.desc)}</div>
      ${mapRow(t)}
      <div class="row" style="gap:6px;flex-wrap:wrap">
        ${ex ? `<button class="btn sm" data-view="${t.id}">${icon('search', 15)} 預覽</button>` : ''}
        <a class="btn sm ghost" href="/api/templates/${t.id}/docx" download>${icon('download', 15)} Word 範本</a>
        ${def !== t.id ? `<button class="btn sm ghost" data-def="${t.id}">設為預設</button>` : ''}
        ${t.kind === 'custom' && isParent() ? `<button class="icon-btn" data-del="${t.id}" aria-label="刪除">${icon('trash', 16)}</button>` : ''}
      </div>
    </div>`;
  }).join('');
  $$('.tpl-ex').forEach((sel) => sel.onchange = () => { chosen[sel.dataset.t] = Number(sel.value); drawGrid(); });
  $$('[data-usefor]').forEach((b) => b.onclick = () => useFor(b.dataset.usefor, b.dataset.tid));
  $$('[data-map]').forEach((sel) => sel.onchange = async () => {
    try {
      const r = await put('/api/templates/for', { kind: sel.dataset.map, id: sel.value });
      list.mapping = r.mapping;
      const t = list.templates.find((x) => x.id === (sel.value || sel.dataset.map));
      toast(`之後的「${list.templates.find((x) => x.id === sel.dataset.map).name}」都用「${t ? t.name : ''}」排版`, 'ok');
      drawGrid();
    } catch (e) { errToast(e); }
  });
  $$('[data-view]').forEach((b) => b.onclick = () => preview(b.dataset.view, b.dataset.key === '1'));
  $$('[data-side]').forEach((b) => b.onclick = () => {
    const card = b.closest('.tpl-card'), th = card.querySelector('.tpl-thumb');
    card.querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('on', x === b));
    if (!th.dataset.view) return;
    th.dataset.key = b.dataset.side === 'k' ? '1' : '0';
    th.innerHTML = '<span class="spinner"></span>';
    queue(th);
  });
  $$('[data-def]').forEach((b) => b.onclick = () => { $('#tdefault').value = b.dataset.def; $('#tdefault').onchange({ target: $('#tdefault') }); });
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    if (!await confirmBox('刪除這個 Word 範本？（用它排版的考卷會改回 AI 自動判斷）', '刪除', true)) return;
    try { await del(`/api/templates/${b.dataset.del}`); toast('已刪除', 'ok'); render(MAIN); } catch (e) { errToast(e); }
  });
  // thumbnails: the first page, drawn small (one at a time: the Pi renders them)
  const thumbs = [...$$('.tpl-thumb[data-view]')];
  const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); queue(en.target); } }));
  thumbs.forEach((t) => io.observe(t));
}

let busyThumb = Promise.resolve();
function queue(el) {
  busyThumb = busyThumb.then(async () => {
    if (!el.isConnected) return;
    try {
      const tok = await specFor(el.dataset.view, { key_only: el.dataset.key === '1' });
      await new Promise((res) => {
        const f = document.createElement('iframe');
        f.title = '範本縮圖'; f.tabIndex = -1; f.src = `/print.html?t=${tok}&preview=1`;
        f.onload = () => { const done = () => res(); setTimeout(done, 400); };
        el.innerHTML = ''; el.appendChild(f);
        setTimeout(res, 20000);
      });
    } catch { el.innerHTML = '<span class="small muted">無法預覽</span>'; }
  });
}

// 這類考卷都用…: a kind of exam can use the parent's own Word template every time
function mapRow(t) {
  const mine = list.templates.filter((x) => x.kind === 'custom');
  if (t.kind === 'custom') {
    const used = Object.entries(list.mapping || {}).filter(([, v]) => v === t.id).map(([k]) => (list.templates.find((x) => x.id === k) || {}).name);
    const base = list.templates.find((x) => x.id === t.base);
    return used.length ? `<div class="small ok-ink" style="margin:-4px 0 10px">${icon('check', 14)} 用在：${used.map(esc).join('、')}</div>`
      : base && isParent() ? `<button class="btn sm soft" style="margin:-4px 0 10px" data-usefor="${base.id}" data-tid="${t.id}">之後的「${esc(base.name)}」都用這個</button>` : '';
  }
  if (!mine.length || !isParent() || t.id === 'wrong') return '';
  const cur = (list.mapping || {})[t.id] || '';
  return `<label class="tpl-map"><span class="small">這類考卷都用</span>
    <select data-map="${t.id}"><option value="">內建的這個範本</option>${mine.map((x) => `<option value="${x.id}" ${cur === x.id ? 'selected' : ''}>${esc(x.name)}（我的 Word）</option>`).join('')}</select></label>`;
}

async function useFor(kind, tid) {
  try {
    const r = await put('/api/templates/for', { kind, id: tid });
    list.mapping = r.mapping;
    toast(`之後的「${list.templates.find((x) => x.id === kind).name}」都會用你的 Word 範本排版`, 'ok');
    drawGrid();
  } catch (e) { errToast(e); }
}

function styleName(t) {
  const st = (t.config || {}).answer_style || 'brief';
  return ((list.answer_styles || []).find((a) => a.id === st) || { name: '只有答案' }).name;
}

async function specFor(tid, extra = {}, exOverride = null) {
  const t = list.templates.find((x) => x.id === tid), ex = exOverride || exFor(t);
  return (await post(`/api/templates/${tid}/sample`, { exam_id: ex && ex.id, wrong: !!(ex && ex.wrong), ...extra })).token;
}

// 預覽: the question paper or its answer key (only answers / with steps / with 圖解)
// from the exam page: this exam in its template
export async function openPreview(tid, { exam = null, key = false } = {}) {
  if (!list) list = await get('/api/templates');
  return preview(tid, key, exam);
}

async function preview(tid, keyFirst = false, exOverride = null) {
  const t = list.templates.find((x) => x.id === tid) || list.templates[0];
  let side = keyFirst ? 'k' : 'q', style = (t.config || {}).answer_style || 'brief', tok = '';
  modal({
    title: `${esc(t.name)}・預覽`, wide: true,
    body: `<div class="row" style="margin-bottom:10px;gap:8px;flex-wrap:wrap;align-items:center">
        <div class="seg" style="margin:0" role="group" aria-label="題目卷或解答卷"><button data-ps="q">題目卷</button><button data-ps="k">解答卷</button></div>
        <div class="seg" style="margin:0" role="group" aria-label="解答樣式" id="pstyles">${(list.answer_styles || []).map((a) => `<button data-st="${a.id}" title="${esc(a.desc)}">${esc(a.name)}</button>`).join('')}</div>
        <span class="spacer"></span>
        <a class="btn soft sm" id="ppdf">${icon('download', 15)} PDF</a>
        <a class="btn soft sm" id="pword">${icon('download', 15)} Word</a>
        <a class="btn ghost sm" href="/api/templates/${tid}/docx" download>空白 Word 範本</a></div>
      <p class="small muted" style="margin:-4px 0 8px" id="pnote"></p>
      <div class="paper-preview"><iframe id="pframe" title="預覽"></iframe></div>`,
    onOpen: async (m) => {
      const draw = async () => {
        m.querySelectorAll('[data-ps]').forEach((b) => b.classList.toggle('on', b.dataset.ps === side));
        m.querySelectorAll('[data-st]').forEach((b) => b.classList.toggle('on', b.dataset.st === style));
        const desc = (list.answer_styles || []).find((a) => a.id === style);
        const ex = exOverride || exFor(t);
        m.querySelector('#pnote').textContent = `用「${ex ? ex.title.slice(0, 30) : ''}」排出來的樣子・解答：${desc ? desc.name + '（' + desc.desc + '）' : ''}`;
        tok = await specFor(t.id, { key_only: side === 'k', answer_style: style }, exOverride);
        m.querySelector('#pframe').src = `/print.html?t=${tok}&preview=1`;
        m.querySelector('#ppdf').href = `/api/print/pdf/${tok}`;
        m.querySelector('#pword').href = `/api/print/docx/${tok}`;
      };
      m.querySelectorAll('[data-ps]').forEach((b) => b.onclick = () => { side = b.dataset.ps; draw(); });
      m.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { style = b.dataset.st; side = 'k'; draw(); });
      draw();
    },
  });
}

function uploadHtml() {
  const marks = Object.entries({ ...list.blocks, ...list.fields });
  return `<div class="card" style="margin-top:16px">
    <h3 style="margin:0 0 6px">${icon('edit', 18)} 新增自己的考卷類型</h3>
    <p class="small" style="margin:0 0 10px"><b>只要打名稱就好</b>（例如「學校段考」「補習班週考」）：AI 會依名稱選排版，之後掃描到這類考卷會自動歸類、排好；不滿意再到上面的「整理清單」調整，或上傳自己的 Word。</p>
    <details class="small" style="margin-bottom:8px"><summary style="cursor:pointer">想要完全照自己的 Word 排版？</summary>
    <ol class="small" style="margin:0 0 10px;padding-left:1.3em;line-height:1.9">
      <li>在上面選一個最接近的範本，按「Word 範本」下載。</li>
      <li>用 Word 打開修改：字型、大小、學校名稱、Logo、頁首頁尾、表格、邊界…都可以改。</li>
      <li>保留 <code>{{題目}}</code> 等標記（AI 會把每一題放在那裡，標記的字型就是題目的字型）。</li>
      <li>存檔後在這裡上傳。之後掃描的考卷、PDF、列印都會長得和你的 Word 一模一樣。</li></ol></details>
    <details class="small"><summary style="cursor:pointer">可以用的標記</summary>
      <div class="tpl-marks">${marks.map(([k, v]) => `<span><code>${esc(k)}</code> ${esc(v)}</span>`).join('')}</div></details>
    <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
      <input type="text" id="tname" placeholder="類型名稱（例如：學校段考）" style="flex:1;min-width:180px" enterkeyhint="done">
      <button class="btn" id="tadd">${icon('plus', 16)} 新增類型</button>
      <label class="btn ghost"><input type="file" id="tfile" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>${icon('download', 16, 'style="transform:rotate(180deg)"')} 上傳 Word 範本</label>
    </div></div>`;
}

function bindUpload(main) {
  const add = async () => {
    const name = $('#tname').value.trim();
    if (!name) { toast('先打類型名稱，例如「學校段考」'); $('#tname').focus(); return; }
    try {
      const t = await post('/api/templates/types', { name });
      const base = list.templates.find((x) => x.id === t.base);
      toast(`已新增「${t.name}」：排版像「${base ? base.name : ''}」${t.keywords.length ? `，名稱有「${t.keywords.join('」「')}」的考卷會自動歸到這類` : ''}`, 'ok');
      $('#tname').value = '';
      list = { ...(await get('/api/templates')), _open: true };
      drawList(); drawGrid();
    } catch (e) { errToast(e); }
  };
  $('#tadd').onclick = add;
  $('#tname').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
  $('#tfile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f, f.name);
    fd.append('name', $('#tname').value || f.name.replace(/\.docx$/i, ''));
    try {
      const meta = await api('/api/templates', { method: 'POST', form: fd });
      toast(`已加入「${meta.name}」`, 'ok');
      await render(main);
      const base = list.templates.find((x) => x.id === meta.base);
      const { confirmBox } = await import('../ui.js');
      if (base && await confirmBox(`之後掃描的「${esc(base.name)}」都用「${esc(meta.name)}」排版嗎？（隨時可以在範本卡片上改回來）`, '好，都用這個')) await useFor(base.id, meta.id);
      preview(meta.id);
    } catch (err) { errToast(err); }
    e.target.value = '';
  };
}
