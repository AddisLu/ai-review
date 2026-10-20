// Send a print spec straight to a CUPS / AirPrint printer from the Pi.
import { del, get, post } from '../api.js';
import { $, busy, confirmBox, errToast, esc, modal, toast } from '../ui.js';

export function printerBadge(p) {
  const cls = p.state === 'idle' ? 'ok' : p.state === 'processing' ? 'warn' : 'bad';
  return `<span class="tag ${cls}">${esc(p.state_text)}${p.message ? '・' + esc(p.message) : ''}</span>`;
}

export async function sendToPrinter(getToken) {
  let info;
  try { info = await get('/api/printers'); } catch (e) { errToast(e); return; }
  if (!info.cups || !info.printers.length) {
    modal({
      title: '送到印表機',
      body: `<p>${info.cups ? '還沒有設定印表機。' : '這台樹莓派沒有安裝列印系統（CUPS）。'}</p>
        <p class="sub">請家長到「家長專區 → 設定 → 印表機」搜尋並加入網路印表機（支援 AirPrint / IPP / Mopria）。<br>
        也可以按「列印」用平板或電腦自己的列印功能（iPad / iPhone 會出現 AirPrint 印表機）。</p>`,
    });
    return;
  }
  const def = info.printers.find((p) => p.default) || info.printers[0];
  return modal({
    title: '送到印表機',
    body: `
      <label class="field"><span>印表機</span><select id="pn">${info.printers.map((p) => `<option value="${esc(p.name)}" ${p === def ? 'selected' : ''}>${esc(p.info || p.name)}</option>`).join('')}</select></label>
      <div id="pst" class="row" style="margin:-4px 0 12px"></div>
      <div class="grid g3">
        <label class="field"><span>份數</span><input type="number" id="pc" min="1" max="50" value="1"></label>
        <label class="field"><span>單雙面</span><select id="pd"><option value="one">單面</option><option value="two">雙面</option></select></label>
        <label class="field"><span>顏色</span><select id="pcol"><option value="0">黑白（省墨）</option><option value="1">彩色</option></select></label>
      </div>
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>取消</button><button class="btn" id="pgo">開始列印</button></div>`,
    onOpen: (m, close) => {
      const showState = () => {
        const p = info.printers.find((x) => x.name === $('#pn', m).value);
        $('#pst', m).innerHTML = printerBadge(p) + (p.state === 'disabled' ? '<button class="btn sm soft" id="pen">重新啟用</button>' : '');
        $('#pd', m).disabled = !p.duplex;
        if (!p.duplex) $('#pd', m).value = 'one';
        const en = $('#pen', m);
        if (en) en.onclick = async () => {
          try {
            await post(`/api/printers/${encodeURIComponent(p.name)}/enable`);
            info = await get('/api/printers');
            showState();
            toast('已重新啟用', 'ok');
          } catch (e) { errToast(e); }
        };
      };
      $('#pn', m).onchange = showState;
      showState();
      $('#pgo', m).onclick = async () => {
        const b = busy('產生 PDF 並送出列印…');
        try {
          const token = await getToken();
          const r = await post('/api/print/send', {
            token, printer: $('#pn', m).value, copies: Number($('#pc', m).value) || 1,
            duplex: $('#pd', m).value, color: $('#pcol', m).value === '1',
          });
          b.close();
          close();
          toast(`已送出列印（工作 ${r.job}）`, 'ok');
        } catch (e) { b.close(); errToast(e); }
      };
    },
  });
}

// Printer management for the parent settings page.
export async function printerSettings(el) {
  const draw = async () => {
    let info, jobs;
    try { [info, jobs] = await Promise.all([get('/api/printers'), get('/api/print/jobs')]); } catch (e) { errToast(e); return; }
    el.innerHTML = `
      <h2>印表機（AirPrint / 網路印表機）</h2>
      ${!info.cups ? '<p class="sub">這台樹莓派沒有安裝 CUPS，請執行 <span class="kbd">sudo apt install cups</span></p>' : `
      <p class="sub">在這裡加入的印表機，可以從任何手機、平板、電腦「送到印表機」直接列印。打開「AirPrint 分享」後，家裡的 iPhone / iPad 也能把這台印表機當成 AirPrint 印表機使用（USB 印表機也可以）。</p>
      ${info.printers.length ? info.printers.map((p) => `
        <div class="list-item" style="flex-wrap:wrap">
          <span style="font-size:24px"></span>
          <span class="t"><b>${esc(p.info || p.name)}</b> ${p.default ? '<span class="tag">預設</span>' : ''}<br>
            <span class="small muted">${esc(p.uri)}</span></span>
          ${printerBadge(p)}
          <div class="row" style="width:100%;justify-content:flex-end">
            ${p.state === 'disabled' ? `<button class="btn sm soft" data-a="enable" data-n="${esc(p.name)}">重新啟用</button>` : ''}
            ${p.default ? '' : `<button class="btn sm ghost" data-a="default" data-n="${esc(p.name)}">設為預設</button>`}
            <label class="check small"><input type="checkbox" data-share="${esc(p.name)}" ${p.shared ? 'checked' : ''}> AirPrint 分享</label>
            <button class="btn sm ghost" data-a="test" data-n="${esc(p.name)}">列印測試頁</button>
            <button class="btn sm ghost" data-del="${esc(p.name)}">移除</button>
          </div>
        </div>`).join('') : '<p>還沒有設定印表機。</p>'}
      <div class="row" style="margin-top:12px">
        <button class="btn soft" id="pdisc">搜尋網路印表機</button>
        <input type="text" id="pip" placeholder="或輸入印表機 IP，例如 192.168.1.50" style="flex:1;width:auto;min-width:200px">
        <button class="btn ghost" id="padd">加入</button>
      </div>
      <div id="pfound" style="margin-top:10px"></div>
      ${jobs.length ? `<h3 style="margin-top:16px">列印佇列</h3>${jobs.map((j) => `<div class="list-item"><span class="t">${esc(j.id)}・${esc(j.time)}</span>
        <button class="btn sm ghost" data-cancel="${esc(j.id)}">取消</button></div>`).join('')}` : ''}`}`;
    el.querySelectorAll('[data-a]').forEach((b) => b.onclick = async () => {
      try {
        const r = await post(`/api/printers/${encodeURIComponent(b.dataset.n)}/${b.dataset.a}`);
        toast(b.dataset.a === 'test' ? `已送出測試頁（${r.job}）` : '完成', 'ok');
        draw();
      } catch (e) { errToast(e); }
    });
    el.querySelectorAll('[data-share]').forEach((c) => c.onchange = async () => {
      try { await post(`/api/printers/${encodeURIComponent(c.dataset.share)}/share`, { on: c.checked }); toast('已更新', 'ok'); } catch (e) { errToast(e); }
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!await confirmBox('移除這台印表機？', '移除', true)) return;
      try { await del(`/api/printers/${encodeURIComponent(b.dataset.del)}`); draw(); } catch (e) { errToast(e); }
    });
    el.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async () => {
      try { await del(`/api/print/jobs/${encodeURIComponent(b.dataset.cancel)}`); draw(); } catch (e) { errToast(e); }
    });
    const add = async (name, uri) => {
      const b = busy('加入印表機中（免驅動設定，約 10-30 秒）…');
      try {
        const r = await post('/api/printers', { name, uri, default: !info.printers.length, share: true });
        b.close();
        toast(`已加入 ${r.name}`, 'ok');
        draw();
      } catch (e) { b.close(); errToast(e); }
    };
    const disc = el.querySelector('#pdisc');
    if (disc) disc.onclick = async () => {
      const f = el.querySelector('#pfound');
      f.innerHTML = '<span class="spinner"></span> 搜尋中（約 10 秒）…';
      try {
        const list = await get('/api/printers/discover');
        f.innerHTML = list.length ? list.map((p, i) => `<div class="list-item"><span class="t"><b>${esc(p.name)}</b> <span class="tag gray">${esc(p.kind)}</span></span>
          <button class="btn sm" data-add="${i}">加入</button></div>`).join('')
          : '<p class="sub">沒有找到新的網路印表機。請確認印表機已開機、連上同一個 Wi-Fi，或直接輸入 IP。</p>';
        f.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => add(list[b.dataset.add].name, list[b.dataset.add].uri));
      } catch (e) { f.innerHTML = ''; errToast(e); }
    };
    const padd = el.querySelector('#padd');
    if (padd) padd.onclick = () => {
      const ip = el.querySelector('#pip').value.trim();
      if (ip) add(`Printer_${ip.replace(/\W/g, '_')}`, ip);
    };
  };
  await draw();
}

// Inline printer panel (paper builder side bar).
export async function printerPanel(el, getToken, printLocal) {
  if (!el) return;
  let info;
  try { info = await get('/api/printers'); } catch { info = { cups: false, printers: [] }; }
  const local = `<button class="btn link block" id="pplocal">用這台裝置列印（iPad / iPhone 會出現 AirPrint）</button>`;
  if (!info.cups || !info.printers.length) {
    el.innerHTML = `<p class="small muted" style="margin:0 0 8px">還沒有設定印表機，家長可以在「家長專區 → 設定」加入網路 / AirPrint 印表機。</p>${local}`;
    el.querySelector('#pplocal').onclick = printLocal;
    return;
  }
  const def = info.printers.find((p) => p.default) || info.printers[0];
  el.innerHTML = `
    <div class="row nowrap" style="margin-bottom:10px"><span class="status-dot" id="ppdot"></span>
      <select id="ppn" aria-label="印表機" style="flex:1">${info.printers.map((p) => `<option value="${esc(p.name)}" ${p === def ? 'selected' : ''}>${esc(p.info || p.name)}</option>`).join('')}</select></div>
    <div id="ppst" class="small" style="margin:-4px 0 10px"></div>
    <div class="grid g3" style="gap:8px;margin-bottom:12px">
      <label class="field" style="margin:0"><span>份數</span><input type="number" id="ppc" min="1" max="50" value="1"></label>
      <label class="field" style="margin:0"><span>單雙面</span><select id="ppd"><option value="one">單面</option><option value="two">雙面</option></select></label>
      <label class="field" style="margin:0"><span>顏色</span><select id="ppcol"><option value="0">黑白</option><option value="1">彩色</option></select></label>
    </div>
    <button class="btn lg block" id="ppgo">列印</button>
    ${local}`;
  const $e = (s) => el.querySelector(s);
  const show = () => {
    const p = info.printers.find((x) => x.name === $e('#ppn').value);
    $e('#ppdot').className = 'status-dot ' + (p.state === 'idle' ? 'ok' : p.state === 'processing' ? 'warn' : 'bad');
    $e('#ppst').innerHTML = p.state === 'idle' ? '' : `<span style="color:var(--bad)">${esc(p.state_text)}${p.message ? '・' + esc(p.message) : ''}</span>
      ${p.state === 'disabled' ? ' <button class="btn link sm" id="ppen">重新啟用</button>' : ''}`;
    $e('#ppd').disabled = !p.duplex;
    if (!p.duplex) $e('#ppd').value = 'one';
    const en = $e('#ppen');
    if (en) en.onclick = async () => {
      try { await post(`/api/printers/${encodeURIComponent(p.name)}/enable`); info = await get('/api/printers'); show(); toast('已重新啟用', 'ok'); } catch (e) { errToast(e); }
    };
  };
  $e('#ppn').onchange = show;
  show();
  $e('#pplocal').onclick = printLocal;
  $e('#ppgo').onclick = async () => {
    const b = busy('產生 PDF 並送出列印…');
    try {
      const token = await getToken();
      const r = await post('/api/print/send', {
        token, printer: $e('#ppn').value, copies: Number($e('#ppc').value) || 1,
        duplex: $e('#ppd').value, color: $e('#ppcol').value === '1',
      });
      b.close();
      toast(`已送出列印（工作 ${r.job}）`, 'ok');
    } catch (e) { b.close(); errToast(e); }
  };
}
