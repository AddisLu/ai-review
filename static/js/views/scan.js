import { api, get, post, put, state } from '../api.js';
import { cornersSvg, editCorners, photoForCorners } from '../corners.js';
import { cameraAvailable, checkImage, openCamera } from '../camera.js';
import { $, $$, busy, confirmBox, errToast, esc, html, icon, showReward, toast, localDay } from '../ui.js';

export async function shrink(file) {
  // Phones produce 4-12 MB photos; 3000px JPEG keeps text sharp and uploads fast.
  if (!/image\/(jpeg|png|webp)/.test(file.type) || file.size < 2.5e6) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);  // a transparent PNG: on white, not black
    x.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

// 讀檔: PDF (each one its own exam, every page read) and image files of any kind
export const FILE_ACCEPT = 'application/pdf,.pdf,image/*,.png,.jpg,.jpeg,.webp,.heic,.heif,.tif,.tiff,.bmp,.gif';
export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

// pages photographed on this tablet/phone, not sent yet (kept while she moves around the app)
const tray = [];
// 整理考卷 (an exam the teacher marked) or 批改功課 (homework she wrote: the AI checks every answer)
let phoneToken = '';
const scanMode = () => { try { return localStorage.getItem('scanMode') || (state.status.user.role === 'parent' ? 'exam' : 'grade'); } catch { return 'exam'; } };
// 加入題庫: homework photographed only to be graded (and the wrong ones redone) can stay out of the 題庫
const inBank = (m = scanMode()) => { try { const v = localStorage.getItem(`inBank:${m}`); return v === null ? m !== 'grade' : v === '1'; } catch { return m !== 'grade'; } };
const MODE_HINT = {
  exam: '老師改過的考卷：AI 會重新產生格式一樣、圖形重畫的可編輯電子試卷，被打叉的題目放進錯題本。',
  grade: '寫好的功課：AI 幫你一題一題改，告訴你哪裡要再想想，錯的可以馬上再做一次。',
};

// the exams photographed are listed in 題庫 → 已拍的考卷 (views/exams.js), not here
export const EXAMS_HREF = '#/bank?view=exams';
const EXAMS_LINK = `<div class="group" style="margin-top:12px"><a class="gi" href="${EXAMS_HREF}"><span class="t">已拍的考卷（在「題庫」裡）</span>${icon('chev', 16)}</a></div>`;

// a parent scanning: whose exam is it? (a parent's own record never holds a scanned exam)
function scanKids() {
  const u = state.status.user;
  if (!u || u.role !== 'parent') return null;
  return (state.status.students || []).filter((x) => x.role !== 'parent');
}

export async function render(main) {
  const kids = scanKids();
  if (kids && kids.length === 1 && state.studentId !== kids[0].id) {  // one child: no need to ask
    const chip = document.querySelector(`.kidbar [data-kid="${kids[0].id}"]`);
    if (chip) { chip.click(); return; }
  }
  if (kids && kids.length && !kids.some((k) => k.id === state.studentId)) {
    html(main, `<div class="page-head"><div class="grow"><h1>掃描試卷</h1><div class="sub">先選這是誰的考卷，錯題才會放進她的錯題本</div></div></div>
      <div class="card"><b style="font-size:17px">這是誰的考卷？</b>
        <div class="grid g3" style="margin-top:12px">${kids.map((k) => `<button class="card bk-kidpick" data-kid="${k.id}"><span class="av" aria-hidden="true">${k.avatar}</span><b>${esc(k.name)}</b><span class="small muted">${k.grade ? k.grade + ' 年級' : ''}</span></button>`).join('')}</div></div>
      ${EXAMS_LINK}`);
    main.querySelectorAll('[data-kid]').forEach((b) => b.onclick = () => {
      const chip = document.querySelector(`.kidbar [data-kid="${b.dataset.kid}"]`);
      if (chip) chip.click();
    });
    return;
  }
  const owner = kids && kids.find((k) => k.id === state.studentId);
  const subjects = Object.keys(state.status.subjects || {});
  const desktop = window.matchMedia('(pointer: fine)').matches;
  const dflt = state.status.scan_defaults || {};
  html(main, `
  <div class="page-head"><div class="grow"><h1>掃描試卷</h1>
    <div class="sub">拍下考卷，重新產生可編輯的電子試卷（圖形重畫）與詳解</div></div></div>
  <div class="scan-one">
    ${owner ? `<div class="card tight scan-owner">${owner.avatar} 這是 <b>${esc(owner.name)}</b> 的考卷${kids.length > 1 ? '<span class="small muted">（要換人：點最上面的名字）</span>' : ''}</div>` : ''}
    <div class="seg scanmode" id="scanmode" role="tablist">${[['exam', '📄 整理考卷'], ['grade', '✅ 批改功課']].map(([m, l]) => `<button data-m="${m}" class="${scanMode() === m ? 'on' : ''}">${l}</button>`).join('')}</div>
    <p class="small muted" id="modehint" style="margin:6px 2px 6px">${MODE_HINT[scanMode()]}</p>
    <label class="inbank"><input type="checkbox" class="selbox" id="inbank" ${inBank() ? 'checked' : ''}>
      <span><b>加入題庫</b><span class="small muted" id="inbankhint">${inBank() ? '題目會放進題庫，可以搜尋、組卷、每日練習' : '只批改、錯的重寫，不放進題庫（之後在考卷頁也能改）'}</span></span></label>
    <div class="drop" id="drop">
      ${desktop ? `<div id="phonepanel" style="width:100%"></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;justify-content:center">
          <label class="btn ghost"><input type="file" accept="image/*,.heic,.heif" multiple id="pick" hidden>${icon('image', 18)} 從電腦選照片</label>
          <label class="btn ghost"><input type="file" accept="${FILE_ACCEPT}" multiple id="readfile" hidden>${icon('doc', 18)} 讀檔（PDF、圖片）</label></div>
        <input type="file" id="cam" hidden>`
      : `<label class="btn lg snap"><input type="file" accept="image/*" capture="environment" id="cam" hidden>${icon('scan', 26)} <span id="camlabel">拍考卷</span></label>
        <div class="row" style="gap:4px;flex-wrap:wrap;justify-content:center">
          <label class="btn link"><input type="file" accept="image/*,.heic,.heif" multiple id="pick" hidden>從相簿選照片</label>
          <label class="btn link"><input type="file" accept="${FILE_ACCEPT}" multiple id="readfile" hidden>讀檔（PDF、圖片）</label></div>
        <div id="tray" class="hidden" style="width:100%">
          <div class="thumbs" id="traythumbs"></div>
          <button class="btn ok lg block" id="traygo">完成，開始整理</button>
          <button class="btn link sm" id="traycancel" style="margin-top:4px">不要了，清掉這幾張</button>
        </div>`}
      <div class="small muted">讀檔：一個 PDF 是一份考卷（每一頁都會讀）；一次選的幾張圖片是同一份考卷的各頁。電子檔不用校正，直接辨識。</div>
      <div class="small muted">${desktop ? '拍完就會自動開始整理：AI 會辨識科目、命名、重新產生電子試卷，並把被打叉的題目放進錯題本。下一頁可以在試卷裡按「再拍一頁」。'
        : '一頁拍一張，同一份考卷的每一頁都拍完再按「完成」。AI 會在背景辨識科目、命名、重新產生電子試卷，並把被打叉的題目放進錯題本，可以直接拍下一份。'}</div>
    </div>
    <div class="group">
      <label class="gi"><span class="t">掃描後排成</span><select id="tpl"><option value="auto">AI 自動判斷</option></select></label>
      <a class="gi" href="#/templates"><span class="t small">先看看各種範本會變成什麼樣子、用自己的 Word 範本</span>${icon('chev', 16)}</a>
    </div>
    <p class="small muted" style="margin:-4px 4px 10px">這個設定會套用到之後掃描的每一份考卷。「AI 自動判斷」會依考卷名稱分成小考、期中考、模擬考…各用適合的範本。已經拍好的考卷要換，請到「題庫 → 已拍的考卷」按「依範本重新產生」，或在考卷頁裡改。</p>
    <details class="group fold-opts">
      <summary class="gi"><span class="t">進階設定</span><span class="small muted">通常不用改</span></summary>
      <label class="gi"><span class="t">試卷名稱</span><input type="text" id="title" placeholder="AI 自動命名" style="width:55%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
      <label class="gi"><span class="t">科目</span><select id="subject"><option value="">自動判斷</option>${subjects.map((x) => `<option>${x}</option>`).join('')}</select></label>
      <label class="gi"><span class="t">學校考卷（期中、期末複習用）</span><select id="school"><option value="">AI 自動判斷（有班級、姓名、座號）</option><option value="1">是學校考卷</option><option value="0">不是</option></select></label>
      <label class="gi"><span class="t">考試日期</span><input type="date" id="date" value="${localDay()}" style="width:auto;border:0;min-height:0;padding:0;box-shadow:none"></label>
    </details>
    <p class="small muted">拍照小技巧：光線充足、紙張放平、整張入鏡。螢光筆畫過、打星號、被老師打叉的題目會自動標記。</p>
    ${EXAMS_LINK}
  </div>`);

  // Photos go up as soon as they are chosen: no "start" button, no form to fill.
  const send = async (list, corners = null, spreads = null, sources = null) => {
    if (!list || !list.length) return;
    const pdf = list.some(isPdf);
    const b = busy(pdf ? '上傳 PDF 中…（頁數多要等一下）' : '上傳照片中…');
    try {
      const fd = new FormData();
      for (const f of list) { const x = await shrink(f); fd.append('files', x, x.name); }
      if (corners && corners.some((c) => c)) fd.append('corners', JSON.stringify(corners));
      if (spreads && spreads.some((x) => x !== null && x !== undefined)) fd.append('spreads', JSON.stringify(spreads));
      if (sources) fd.append('sources', JSON.stringify(sources));
      fd.append('title', $('#title').value);
      fd.append('subject', $('#subject').value);
      fd.append('exam_date', $('#date').value);
      fd.append('mode', scanMode() === 'grade' ? 'grade' : '');
      fd.append('in_bank', inBank() ? '1' : '0');
      fd.append('school', $('#school').value);
      if (owner) fd.append('student_id', owner.id);
      const r = await api('/api/exams', { method: 'POST', form: fd });
      b.close();
      showReward({});
      // the AI works on it in the background: stay here, ready for the next exam
      watchExam(r.exam_id);
      toast(`收到了（${r.pages || list.length} 頁）！AI 在背景整理，好了會通知你。可以直接拍下一份`, 'ok');
      $('#title').value = '';
    } catch (e) {
      b.close();
      errToast(e);
    }
  };
  get('/api/templates').then((t) => {
    const sel = $('#tpl');
    if (!sel) return;
    sel.innerHTML += t.templates.filter((x) => !x.hidden || x.id === t.default).map((x) => `<option value="${x.id}">${esc(x.name)}${x.kind === 'custom' ? '（我的範本）' : ''}</option>`).join('');
    sel.value = t.default;
    sel.onchange = () => put('/api/templates/default', { id: sel.value }).then(() => toast('之後掃描的考卷會用這個範本排版', 'ok')).catch(errToast);
  }).catch(() => {});
  if (desktop && state.status.ai_ready) phoneSession(main); // a computer's camera is no use: offer the phone at once
  $$('#scanmode [data-m]').forEach((b) => b.onclick = () => {
    try { localStorage.setItem('scanMode', b.dataset.m); } catch { /* private mode */ }
    $$('#scanmode [data-m]').forEach((x) => x.classList.toggle('on', x === b));
    $('#modehint').textContent = MODE_HINT[b.dataset.m];
    if ($('#camlabel') && !tray.length) $('#camlabel').textContent = b.dataset.m === 'grade' ? '拍功課' : '拍考卷';
    $('#inbank').checked = inBank(b.dataset.m);
    showInBank();
    if (phoneToken) put(`/api/photo-sessions/${encodeURIComponent(phoneToken)}`, { mode: b.dataset.m === 'grade' ? 'grade' : '', in_bank: inBank(b.dataset.m) }).catch(() => {});
  });
  const showInBank = () => { $('#inbankhint').textContent = inBank() ? '題目會放進題庫，可以搜尋、組卷、每日練習' : '只批改、錯的重寫，不放進題庫（之後在考卷頁也能改）'; };
  $('#inbank').onchange = (e) => {
    try { localStorage.setItem(`inBank:${scanMode()}`, e.target.checked ? '1' : '0'); } catch { /* private mode */ }
    showInBank();
    if (phoneToken) put(`/api/photo-sessions/${encodeURIComponent(phoneToken)}`, { mode: scanMode() === 'grade' ? 'grade' : '', in_bank: inBank() }).catch(() => {});
  };
  // files read in: each PDF is one exam; the images chosen together are the pages of one exam
  const sendFiles = async (files, toTray = null) => {
    const pdfs = files.filter(isPdf), imgs = files.filter((f) => !isPdf(f));
    if (imgs.length) { if (toTray) await toTray(imgs); else await send(imgs, null, null, imgs.map(() => 'file')); }
    for (const f of pdfs) await send([f], null, null, ['file']);
  };
  let addToTray = null;  // a tablet / phone: images read in join the pages taken (the tray)
  const fromFiles = (fs) => sendFiles(fs, addToTray && ((imgs) => addToTray(imgs, { source: 'file' })));
  $('#readfile').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; fromFiles(fs); };
  if (desktop) {
    $('#cam').onchange = (e) => send([...e.target.files]);
    $('#pick').onchange = (e) => send([...e.target.files]);
  } else {
    // a tablet or phone camera: one page per photo, kept here until 完成 (like the phone QR flow),
    // so an exam of many pages becomes one exam
    const drawTray = () => {
      const n = tray.length;
      $('#camlabel').textContent = n ? `拍第 ${n + 1} 頁` : scanMode() === 'grade' ? '拍功課' : '拍考卷';
      $('#tray').classList.toggle('hidden', !n);
      $('#traygo').textContent = `完成，開始整理 ${n} 頁`;
      $('#traythumbs').innerHTML = tray.map((t, i) => `<div class="thumb ${t.ng && !t.set ? 'ng' : ''}"><div class="cn-box" style="aspect-ratio:${t.w || 3}/${t.h || 4}">
          <img src="${t.url}" alt="第 ${i + 1} 頁">${t.corners ? cornersSvg(t.set || t.corners) : ''}</div><span class="n">第 ${i + 1} 頁</span>
        <button class="x" data-i="${i}" aria-label="刪除第 ${i + 1} 頁">✕</button>
        ${t.digital ? '<span class="cn-fix" style="pointer-events:none">電子檔</span>' : `<button class="cn-fix" data-c="${i}">${t.set ? '已調整' : '調整四角'}</button>`}
        ${t.ng && !t.set ? `<div class="ng-tag">拍攝 NG：${esc(t.ng)}<label class="ng-re"><input type="file" accept="image/*" capture="environment" data-re="${i}" hidden>重拍</label></div>` : ''}</div>`).join('');
      $('#traythumbs').querySelectorAll('[data-re]').forEach((inp) => inp.onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const i = Number(inp.dataset.re); URL.revokeObjectURL(tray[i].url); tray.splice(i, 1);
        await add([f], { at: i });
      });
      $('#traythumbs').querySelectorAll('[data-c]').forEach((b) => b.onclick = async () => {
        const t = tray[Number(b.dataset.c)];
        const c = await editCorners(t.url, t.set || t.corners, { auto: t.corners, title: `第 ${Number(b.dataset.c) + 1} 頁：調整四個角` });
        if (c) { t.set = c; drawTray(); }
      });
      $('#traythumbs').querySelectorAll('.x').forEach((b) => b.onclick = async () => {
        if (!await confirmBox(`刪除第 ${Number(b.dataset.i) + 1} 頁？`, '刪除', true)) return;
        URL.revokeObjectURL(tray[b.dataset.i].url);
        tray.splice(Number(b.dataset.i), 1);
        drawTray();
      });
    };
    const add = async (files, extra = {}) => {
      const made = [];
      for (const f of files) {
        const x = await shrink(f);
        const t = { file: x, url: URL.createObjectURL(x), corners: null, set: extra.verified ? extra.corners : null, spread: extra.spread ?? null, ng: '', source: extra.source || 'photo' };
        made.push(t);
        if (extra.at !== undefined) tray.splice(extra.at, 0, t); else tray.push(t);
        // the page outline found right away (shown on the thumbnail; tap 調整四角 to fix it)
        photoForCorners(x).then(async (small) => {
          const bmp = await createImageBitmap(small); t.w = bmp.width; t.h = bmp.height;
          URL.revokeObjectURL(t.url); t.url = URL.createObjectURL(small);
          if (extra.verified) {  // from the live camera: checked there (the Pi's corners follow through onFix)
            t.corners = extra.corners;
            if (tray.includes(t)) drawTray();
            return;
          }
          const fd = new FormData(); fd.append('file', small, 'p.jpg');
          // the same checks as the guiding camera, on the photo taken: NG shown on the thumbnail
          const [r, live] = await Promise.all([api('/api/scan/check', { method: 'POST', form: fd }), checkImage(small)]);
          if (t.source === 'file' && r.digital) {
            // a computer-made page (screenshot, scanner, exported image): read as it is, nothing to check
            t.digital = true; t.spread = false;
            if (tray.includes(t)) drawTray();
            return;
          }
          t.corners = extra.corners || (r.corners && r.corners.length ? r.corners : [[0, 0], [1, 0], [1, 1], [0, 1]]);
          if (t.spread === null && !extra.verified) t.spread = !!r.spread;
          if (!extra.verified) {
            const d = live.quad && r.corners && r.corners.length ? Math.max(...r.corners.map((p, k) => Math.hypot(p[0] - live.quad[k][0], p[1] - live.quad[k][1]))) : 1;
            t.ng = live.problem || (r.blurry ? '照片模糊（沒對到焦）' : !r.corners || !r.corners.length ? '找不到考卷的邊' : d > 0.08 ? '四個角不確定' : '');
            if (t.ng) toast(`第 ${tray.indexOf(t) + 1} 頁拍攝 NG：${t.ng}（可以重拍，或按「調整四角」）`, 'bad');
          }
          if (tray.includes(t)) drawTray();
        }).catch(() => {});
      }
      drawTray();
      if (files.length) toast(`已拍 ${tray.length} 頁：還有就繼續拍，拍完按「完成」`, 'ok');
      return made;
    };
    addToTray = add;
    $('#cam').onchange = (e) => { add([...e.target.files]); e.target.value = ''; };
    $('#pick').onchange = (e) => { add([...e.target.files]); e.target.value = ''; };
    // the live camera (guide frame, the paper found as you aim, 單頁／雙頁・直拍／橫拍): https only;
    // otherwise the phone's own camera app
    if (cameraAvailable()) {
      $('#cam').closest('label').addEventListener('click', async (e) => {
        if ($('#cam').dataset.native) { delete $('#cam').dataset.native; return; }
        e.preventDefault();
        const r = await openCamera({
          count: tray.length,
          onShot: (file, info) => add([file], { spread: info.spread, corners: info.corners, verified: info.verified }).then((ts) => ts[0]),
          // the Pi's own look at a page already in the tray: its corners (hers, when she placed them) / 單頁雙頁
          onFix: (t, patch) => {
            if (patch.corners) { t.corners = patch.corners; t.set = patch.manual ? patch.corners : t.set; }
            if ('spread' in patch) t.spread = patch.spread;
            if (tray.includes(t)) drawTray();
          },
          onDrop: (t) => {  // out of focus after all: taken back
            const i = tray.indexOf(t);
            if (i < 0) return;
            URL.revokeObjectURL(t.url); tray.splice(i, 1); drawTray();
          },
        });
        if (r.error) { toast(`相機打不開（${r.error}），改用手機的相機`, 'bad'); $('#cam').dataset.native = '1'; $('#cam').click(); }
      });
    } else if (state.status.secure_url && location.protocol === 'http:') {
      // plain http: the browser does not allow the guiding camera — the https address does
      const b = document.createElement('div');
      b.className = 'card tight secure-tip';
      b.innerHTML = `<b>要有對準框、即時抓四角、拍攝 NG 紅框提醒的相機？</b>
        <span class="small">請改用安全連線開這個網站（第一次要重新選人登入）。用手機相機也可以，拍完一樣會檢查、有問題標紅框。</span>
        <a class="btn ok sm" href="${esc(state.status.secure_url)}/#/scan">改用安全連線開啟</a>`;
      $('#drop').before(b);
    }
    $('#traygo').onclick = async () => {
      if (tray.length === 1 && !await confirmBox('這份考卷只有 1 頁，確定拍完了嗎？（很多頁的話，繼續拍下一頁再按完成）', '確定，開始整理')) return;
      const files = tray.map((t) => t.file);
      const corners = tray.map((t) => t.set);  // only the ones fixed by hand; the rest found again on the Pi
      const spreads = tray.map((t) => t.spread);
      const sources = tray.map((t) => t.source);
      tray.forEach((t) => URL.revokeObjectURL(t.url));
      tray.length = 0;
      drawTray();
      await send(files, corners, spreads, sources);
    };
    $('#traycancel').onclick = async () => {
      if (!await confirmBox(`清掉已拍的 ${tray.length} 頁？`, '清掉', true)) return;
      tray.forEach((t) => URL.revokeObjectURL(t.url));
      tray.length = 0;
      drawTray();
    };
    drawTray();  // pages taken before leaving this page are still here
  }
  const drop = $('#drop');
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); fromFiles([...e.dataTransfer.files]); };
}


// 用手機拍: a computer has no camera worth using — show a QR code; the phone
// takes or picks the photos and they arrive here live.
async function phoneSession(main) {
  const panel = $('#phonepanel');
  panel.className = 'phone-recv';
  panel.innerHTML = '<span class="spinner"></span>';
  let r;
  try { r = await post('/api/photo-sessions', { origin: location.origin, student_id: state.studentId, mode: scanMode() === 'grade' ? 'grade' : '', in_bank: inBank() }); } catch (e) { panel.innerHTML = ''; errToast(e); return; }
  phoneToken = r.token;
  const base = `/api/snap/${encodeURIComponent(r.token)}`;
  panel.innerHTML = `<b style="font-size:18px">用手機相機掃這個 QR code 拍考卷</b>${r.qr}
    <div class="small muted">手機上可以一頁一頁拍，也可以從相簿一次選很多張；拍好的照片會出現在這裡。按「完成」後 AI 在背景整理，手機可以直接拍下一份。</div>
    <div class="small" id="phst" style="margin-top:6px"><span class="dot"></span>等待手機連線…</div>
    <div class="thumbs" id="phthumbs"></div>
    <button class="btn block hidden" id="phgo" style="margin-top:8px">開始整理</button>`;
  let shown = -1;
  let sent = 0;
  const gotOne = (n, examId, pages) => {
    sent = n;
    watchExam(examId);
    toast(`收到第 ${n} 份（${pages} 頁）！AI 在背景整理，好了會通知你。手機可以直接拍下一份`, 'ok');
    shown = -1;
  };
  $('#phgo').onclick = async () => {
    if (shown === 1 && !await confirmBox('這份考卷只有 1 頁，確定拍完了嗎？', '確定，開始整理')) return;
    try { const d = await post(`${base}/done`); gotOne(d.n, d.exam_id, shown); } catch (e) { errToast(e); }
  };
  const tick = async () => {
    if (!panel.isConnected) return;
    try {
      const st = await get(base);
      const list = st.sent || [];
      if (list.length > sent) { const last = list[list.length - 1]; if (sent) showReward({}); gotOne(list.length, last.exam_id, last.pages); }
      $('#phst').innerHTML = `<span class="dot ${st.phone_online ? 'on' : ''}"></span>${st.phone_online ? (st.count ? `已收到 ${st.count} 頁，手機按「完成」或這裡按「開始整理」` : '手機已連線，拍照吧！') : '等待手機連線…'}`;
      if (st.count !== shown) {
        shown = st.count;
        $('#phthumbs').innerHTML = Array.from({ length: st.count }, (_, i) => `<img src="${base}/thumb/${i}?v=${st.v}" alt="第 ${i + 1} 頁">`).join('');
        $('#phgo').classList.toggle('hidden', !st.count);
        $('#phgo').textContent = `開始整理 ${st.count} 頁`;
        const qr = panel.querySelector('svg');
        if (qr) qr.style.display = st.count ? 'none' : ''; // back again for the next exam
      }
    } catch (e) {
      if (/結束/.test(e.message)) { panel.innerHTML = `<p class="small">${esc(e.message)}</p>`; return; }
    }
    setTimeout(tick, 1500);
  };
  tick();
}

// --- 整理好了: exams the AI is still working on are watched from any page ---------------------

const WKEY = 'pendingExams';
const watched = () => { try { return JSON.parse(localStorage.getItem(WKEY) || '[]'); } catch { return []; } };
const saveWatched = (ids) => { try { localStorage.setItem(WKEY, JSON.stringify(ids)); } catch { /* private mode */ } };

export function watchExam(id) {
  saveWatched([...new Set([...watched(), id])]);
  startWatcher();
}

export function checkWatched(exams) {
  const ids = watched();
  if (!ids.length) return;
  const left = [];
  for (const id of ids) {
    const e = exams.find((x) => x.id === id);
    if (!e) continue;
    if (e.status === 'processing' || e.status === 'solving') { left.push(id); continue; }
    const open = { label: '打開', href: `#/exam/${e.id}` };
    if (e.status === 'error') toast(`「${e.title}」整理失敗，請打開這份考卷重試`, 'bad', open);
    else {
      const gs = (e.options || {}).grade_summary;
      if (gs) toast(`「${e.title}」批改好了：對 ${gs.correct || 0} 題${(gs.wrong || 0) + (gs.partial || 0) ? `、要訂正 ${(gs.wrong || 0) + (gs.partial || 0)} 題` : '，全對！'}`, 'ok', open);
      else toast(`「${e.title}」整理好了：${e.n_questions} 題${e.n_wrong ? `、錯 ${e.n_wrong} 題` : ''}（在「題庫 → 已拍的考卷」裡）`, 'ok', open);
      get(`/api/exams/${e.id}/gaps`).then((r) => {
        const g = r.gaps || [];
        if (g.length) toast(`「${e.title}」${g.some((x) => x.kind === 'missed_page') ? '可能漏拍了' : '題號不連續'}：${g[0].text}${g.length > 1 ? `（還有 ${g.length - 1} 處）` : ''}`, 'gold', { label: '看看', href: `#/exam/${e.id}` });
      }).catch(() => {});
      const twin = exams.find((x) => x.id !== e.id && x.student_id === e.student_id && x.title === e.title && (x.exam_date || '') === (e.exam_date || ''));
      if (twin) toast(`「${e.title}」好像之前已經拍過了（同名、同日期），不需要的話可以刪掉其中一份`, 'gold', { label: '看看', href: EXAMS_HREF });
    }
  }
  saveWatched(left);
}

let watcher = 0;
export function startWatcher() {
  if (watcher || !watched().length) return;
  watcher = setInterval(async () => {
    if (!watched().length) { clearInterval(watcher); watcher = 0; return; }
    try { checkWatched(await get('/api/exams')); } catch { /* offline: try again */ }
  }, 8000);
}
