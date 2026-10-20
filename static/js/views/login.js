// Family login: pick your profile, then a PIN (kids) or password (parent).
// First run creates the parent account and the first child.
import { post, state } from '../api.js';
import { $, $$, errToast, esc, html, icon } from '../ui.js';

export async function renderSetup(main, onDone) {
  html(main, `
  <div class="login" style="text-align:left;max-width:420px">
    <div class="brand" style="margin:0 auto 16px">AI</div>
    <h1 class="center">歡迎使用 AI 總複習</h1>
    <p class="sub center" style="margin-bottom:20px">第一次使用，請先建立家長帳號和第一個孩子的帳號。之後可以再新增其他孩子。</p>
    <div class="label">家長</div>
    <div class="group">
      <label class="gi"><span class="t">稱呼</span><input type="text" id="pn" value="爸爸" style="width:55%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
      <label class="gi"><span class="t">家長密碼</span><input type="password" id="pp" placeholder="至少 4 個字" style="width:55%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
    </div>
    <div class="label">第一個孩子</div>
    <div class="group">
      <label class="gi"><span class="t">名字</span><input type="text" id="cn" placeholder="例如：小晴" style="width:55%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
      <label class="gi"><span class="t">年級</span><select id="cg">${[3, 4, 5, 6].map((g) => `<option value="${g}" ${g === 6 ? 'selected' : ''}>${g} 年級</option>`).join('')}</select></label>
      <label class="gi"><span class="t">登入密碼（4~6 位數字）</span><input type="password" inputmode="numeric" id="cp" placeholder="例如 1234" style="width:40%;border:0;min-height:0;text-align:right;padding:0;box-shadow:none"></label>
    </div>
    <button class="btn lg block" id="go">開始使用</button>
  </div>`);
  $('#go').onclick = async () => {
    try {
      await post('/api/setup', {
        parent_name: $('#pn').value, parent_password: $('#pp').value,
        child: { name: $('#cn').value, grade: Number($('#cg').value), pin: $('#cp').value },
      });
      onDone();
    } catch (e) { errToast(e); }
  };
}

export async function renderProfiles(main, profiles, onDone) {
  const kids = profiles.filter((p) => p.role !== 'parent');
  const parents = profiles.filter((p) => p.role === 'parent');
  const tile = (p) => `<button class="profile-tile" data-id="${p.id}">
      <span class="pt-av">${p.avatar}</span><b>${esc(p.name)}</b>
      <span class="small muted">${p.role === 'parent' ? '家長' : `${p.grade} 年級`}</span></button>`;
  html(main, `
  <div class="login" style="max-width:640px">
    <div class="brand" style="margin:0 auto 16px">AI</div>
    <h1>誰要使用？</h1>
    <p class="sub" style="margin-bottom:24px">每個人的錯題本、練習紀錄和獎勵都是分開的</p>
    <div class="profile-grid">${kids.map(tile).join('')}</div>
    ${parents.length ? `<div class="profile-grid" style="margin-top:14px">${parents.map(tile).join('')}</div>` : ''}
  </div>`);
  $$('.profile-tile', main).forEach((b) => b.onclick = () => askPin(main, profiles.find((p) => p.id === Number(b.dataset.id)), profiles, onDone));
}

function askPin(main, p, profiles, onDone) {
  const isParent = p.role === 'parent';
  let pin = '';
  html(main, `
  <div class="login" style="max-width:360px">
    <button class="back" id="pback" aria-label="返回" style="margin:0 0 8px -10px">${icon('back', 22)}</button>
    <div class="pt-av" style="margin:0 auto">${p.avatar}</div>
    <h1 style="margin-top:10px">${esc(p.name)}</h1>
    <p class="sub">${isParent ? '請輸入家長密碼' : '請輸入你的密碼'}</p>
    ${isParent
      ? `<input type="password" id="ppw" placeholder="家長密碼" autocomplete="current-password" style="margin:16px 0 12px">
         <button class="btn lg block" id="pgo">登入</button>`
      : `<div class="pin-dots" id="dots">${'<i></i>'.repeat(4)}</div>
         <div class="keypad pinpad">
           ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((k) => `<button data-k="${k}" class="${k === '✓' ? 'go' : k === '⌫' ? 'op' : ''}" style="${k === '✓' ? 'grid-column:auto;font-size:20px' : ''}" ${k === '⌫' ? 'aria-label="刪除"' : ''}>${k === '✓' ? '登入' : k}</button>`).join('')}
         </div>`}
  </div>`);
  $('#pback').onclick = () => renderProfiles(main, profiles, onDone);
  const submit = async (secret) => {
    try {
      await post('/api/auth/login', { id: p.id, pin: secret });
      state.studentId = 0;
      localStorage.removeItem('studentId');
      onDone();
    } catch (e) {
      errToast(e);
      pin = '';
      drawDots();
    }
  };
  const drawDots = () => {
    const d = $('#dots');
    if (!d) return;
    const n = Math.max(4, pin.length);
    d.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  };
  if (isParent) {
    $('#ppw').focus();
    $('#pgo').onclick = () => submit($('#ppw').value);
    $('#ppw').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) submit($('#ppw').value); };
    return;
  }
  const press = (k) => {
    if (k === '⌫' || k === 'Backspace') pin = pin.slice(0, -1);
    else if (k === '✓' || k === 'Enter') { if (pin.length >= 4) submit(pin); return; }
    else if (/^\d$/.test(k) && pin.length < 6) pin += k;
    drawDots();
  };
  $$('[data-k]', main).forEach((b) => b.onclick = () => press(b.dataset.k));
  const onKey = (e) => { if (!document.getElementById('dots')) { document.removeEventListener('keydown', onKey); return; } press(e.key); };
  document.addEventListener('keydown', onKey);
}
