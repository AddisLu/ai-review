// 直接在題目上作答: questions answered with 代號 (ㄅㄆㄇ、A~F、甲乙丙) or marks (✓ ✗ △ ○) get buttons to
// tap — no keyboard (ㄅ is hard to type on a tablet) and no writing paper. A one-mark question is
// answered with one tap; several marks / codes go into the answer box in order.

const MARKS = [
  ['✓', /[✓✔√ˇ∨]|打勾|打\s*[vV]/],
  ['✗', /[✗✘]|打叉/],
  ['╳', /[╳×✕]/],
  ['△', /[△▲]/],
  ['○', /[○◯]|畫圈|圈圈/],
];
const MARK_CH = /[✓✔√ˇ∨✗✘╳×✕△▲○◯〇]/g;
const BOPO = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒ';
const LETTERS = 'ABCDEFGHIJ';
const STEMS = '甲乙丙丁戊己庚辛';

function svgText(svg) {
  return String(svg || '').replace(/<[^>]+>/g, ' ');
}

// {marks: ['✓','✗'] | [], codes: ['ㄅ',…] | [], items: how many marks the answer has}
export function answerKit(q) {
  if (q.choice_index > 0 && (q.options || []).length) return { marks: [], codes: [], items: 1 };
  const stem = q.stem || '';
  const L = q.lead || {};
  const text = `${L.stem || ''}\n${svgText(L.figure_svg)}\n${L.figure_table ? JSON.stringify(L.figure_table) : ''}\n${stem}\n${svgText(q.figure_svg)}\n${q.figure_table ? JSON.stringify(q.figure_table) : ''}`;
  const key = String(q.answer || '').replace(/[（(][^（）()]*[）)]/g, '');
  const at = (re) => { const s = `${L.stem || ''}\n${stem}`; const m = s.match(re); return m ? m.index : 1e9; };
  let marks = MARKS.filter(([, re]) => re.test(stem) || re.test(L.stem || '')).sort((a, b) => at(a[1]) - at(b[1])).map(([m]) => m);
  const keyMarks = key.match(MARK_CH) || [];
  if (!marks.length && keyMarks.length) {  // the stem does not say which marks: the ones the key uses, and their opposite
    const fam = new Set(keyMarks.map((c) => MARKS.find(([, re]) => re.test(c))?.[0]).filter(Boolean));
    if (fam.has('✓') || fam.has('✗')) { fam.add('✓'); fam.add('✗'); }
    if (fam.has('○') || fam.has('╳')) { fam.add('○'); fam.add('╳'); }
    marks = [...fam];
  }
  if (!marks.length && q.qtype === '是非題') marks = ['○', '╳'];
  let codes = [];
  const fam = (chars, re) => {
    const seen = [...text.matchAll(re)].map((m) => m[1]);
    const inKey = [...key].filter((c) => chars.includes(c.toUpperCase())).map((c) => c.toUpperCase());
    const all = [...seen, ...inKey];
    if (!all.length) return [];
    const last = Math.max(...all.map((c) => chars.indexOf(c)));
    return [...chars.slice(0, Math.max(last + 1, seen.length ? 0 : 4))];
  };
  if (/[ㄅ-ㄩ]/.test(key) || /[ㄅㄆㄇㄈ][\.．、:：]/.test(text)) codes = fam(BOPO, /([ㄅ-ㄒ])[\.．、:：]/g);
  if (!codes.length && (/(^|[^A-Za-z])[A-J]([^A-Za-z]|$)/.test(key) && !/[a-z]{2}/i.test(key) || /(^|[^A-Za-z])[A-H][\.．、:：]/.test(text)))
    codes = fam(LETTERS, /(?:^|[^A-Za-z])([A-H])[\.．、:：]/g);
  if (!codes.length && /[甲乙丙丁戊]/.test(key) && /[甲乙丙丁戊][\.．、:：]/.test(text)) codes = fam(STEMS, /([甲-癸])[\.．、:：]/g);
  // ① ② ③ … chosen (not a choice question with buttons): the circled numbers in the stem
  if (!codes.length && /[①-⑩]/.test(key)) {
    const seen = [...new Set(text.match(/[①-⑩]/g) || [])];
    if (seen.length >= 2) codes = seen.sort();
  }
  const items = keyMarks.length || 1;
  return { marks, codes, items };
}

// one mark answers it (○/✕, △/╳, ✓/✗): big buttons, no answer box
export function oneTapMarks(q, k) {
  return k.items === 1 && !k.codes.length && (k.marks.length >= 2 || q.qtype === '是非題');
}

export function hasKit(k) {
  return !!(k.marks.length || k.codes.length);
}

// buttons under the answer box; one-tap marks are submitted at once (data-mark-go)
export function kitHtml(k) {
  if (!hasKit(k)) return '';
  const oneTap = k.marks.length && k.items === 1 && !k.codes.length;
  return `<div class="ans-kit">
    ${k.marks.length ? `<div class="kit-row">${k.marks.map((m) => `<button class="kit-btn mark" ${oneTap ? 'data-mark-go' : 'data-kit'}="${m}">${m}</button>`).join('')}</div>` : ''}
    ${k.codes.length ? `<div class="kit-row">${k.codes.map((c) => `<button class="kit-btn" data-kit="${c}" data-code>${c}</button>`).join('')}</div>` : ''}
    ${oneTap ? '' : `<div class="kit-row small muted">${k.items > 1 ? `依照題號順序點 ${k.items} 個符號，` : ''}點錯可以按 <button class="kit-btn sm" data-kit-back>⌫</button> <button class="kit-btn sm" data-kit-clear>清除</button></div>`}
  </div>`;
}

// wires the buttons to the answer box: codes are joined with 、, marks with a space
export function bindKit(root, input, submit) {
  root.querySelectorAll('[data-mark-go]').forEach((b) => b.onclick = () => submit(b.dataset.markGo, b));
  root.querySelectorAll('[data-kit]').forEach((b) => b.onclick = () => {
    const v = input.value.trim();
    const code = b.hasAttribute('data-code');
    if (code && v.split(/[、\s]+/).includes(b.dataset.kit)) {  // tapping a chosen code again takes it out
      input.value = v.split(/[、\s]+/).filter((x) => x && x !== b.dataset.kit).join('、');
    } else {
      input.value = v ? `${v}${code ? '、' : ' '}${b.dataset.kit}` : b.dataset.kit;
    }
    sync(root, input);
  });
  const back = root.querySelector('[data-kit-back]');
  if (back) back.onclick = () => { input.value = input.value.trim().replace(/[、\s]*[^、\s]$/, ''); sync(root, input); };
  const clr = root.querySelector('[data-kit-clear]');
  if (clr) clr.onclick = () => { input.value = ''; sync(root, input); };
  input.addEventListener('input', () => sync(root, input));
}

function sync(root, input) {
  const chosen = new Set(input.value.split(/[、\s]+/).filter(Boolean));
  root.querySelectorAll('[data-code]').forEach((b) => b.classList.toggle('on', chosen.has(b.dataset.kit)));
}
