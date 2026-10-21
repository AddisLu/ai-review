import { esc, rich } from './ui.js';
import { barModelVisual, cleanSvg, visualHtml, visualsHtml } from './visuals.js';

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
const P = new URLSearchParams(location.search);
const sheet = document.getElementById('sheet');

function pageCss(orient) {
  const land = orient === 'landscape';
  const [pw, ph] = land ? ['297mm', '210mm'] : ['210mm', '297mm'];
  document.documentElement.style.setProperty('--pw', pw);
  document.documentElement.style.setProperty('--ph', `calc(${ph} - 24mm)`);
  document.getElementById('pagecss').textContent = `
    @page { size: A4 ${land ? 'landscape' : 'portrait'}; margin: 12mm; }
    @page land { size: A4 landscape; margin: 8mm; }
    @page port { size: A4 portrait; margin: 8mm; }`;
}

// how wide an option looks on paper (math, ruby and markup do not count)
const optLen = (o) => String(o || '').replace(/\$[^$]*\$/g, 'xx').replace(/\{([^|}]*)\|[^}]*\}/g, '$1').replace(/\*\*/g, '').length;
const isChoice = (q) => (q.options || []).length > 0 || /選擇|是非/.test(q.qtype || '');
const LEAD_BRACKET = /^\s*[（(]\s*[　 ]*\s*[)）]\s*/;

// the figure: a real table, the SVG redrawn from the photo, or the (cleaned) picture
function figureHtml(q, c) {
  if (!c.show_figures) return '';
  const t = q.figure_table;
  if (t && (t.rows || []).length) {
    return `<table class="qtable">${(t.header || []).length ? `<tr>${t.header.map((x) => `<th>${rich(x)}</th>`).join('')}</tr>` : ''}
      ${t.rows.map((r) => `<tr>${r.map((x) => `<td>${rich(x)}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  // a whole exam printed like the paper: each figure as big as it is on the original (fig_frac of the width)
  const w = q.fig_frac ? ` style="width:${Math.max(18, Math.round(q.fig_frac * 100))}%"` : '';
  if (q.figure_svg) { const svg = cleanSvg(q.figure_svg); if (svg) return `<div class="qsvg"${w}>${svg}</div>`; }
  if (q.figure_path) return `<img class="fig" src="/media/${q.figure_path}"${w}>`;
  return '';
}

// 出題軟體 layout: （　）1. for choice questions, options in 4 / 2 / 1 columns by length,
// a 「右圖」 figure beside the question, tables as tables, room to write only where it is needed
function questionHtml(q, n, c) {
  const opts = q.options || [];
  const choice = isChoice(q);
  const longest = Math.max(0, ...opts.map(optLen));
  const cols = longest <= 7 && opts.length >= 3 ? 'c4' : longest <= 16 ? 'c2' : 'c1';
  const stem = choice ? String(q.stem || '').replace(LEAD_BRACKET, '') : q.stem;
  const fig = figureHtml(q, c);
  const right = fig && q.figure_pos === 'right' && !q.figure_table;
  let body = `<div class="stem">${rich(stem)}${c.show_source && q.unit ? ` <span class="src">（${esc(q.unit)}）</span>` : ''}</div>`;
  if (fig && !right) body += `<div class="qfig">${fig}</div>`;
  if (opts.length) body += `<div class="opts ${cols}">${opts.map((o, i) => `<span><b>${CIRCLED[i] || i + 1}</b> ${rich(o)}</span>`).join('')}</div>`;
  let h = `<div class="q ${choice ? 'choice' : ''}">${choice ? '<span class="br">（　　）</span>' : ''}<span class="n">${esc(q.number || n)}.</span><div class="b">`;
  h += right ? `<div class="qrow"><div class="qtext">${body}</div><div class="qfig side">${fig}</div></div>` : body;
  if (c.answers === 'inline') {
    h += `<div class="ans">答：${rich(q.answer)}</div>`;
    if (c.explanations) h += explain(q);
  } else if (!choice) {
    for (let i = 0; i < Number(c.answer_space); i++) h += '<div class="space"></div>';
  }
  return h + '</div></div>';
}

function explain(q) {
  let h = '<div class="exp">';
  if (q.steps && q.steps.length) h += `<ol>${q.steps.map((s) => `<li>${rich(s)}</li>`).join('')}</ol>`;
  else if (q.explanation) h += rich(q.explanation);
  if ((q.option_notes || []).length) h += `<div class="onotes">${q.option_notes.map((x) => `<div>${rich(x)}</div>`).join('')}</div>`;
  if (q.bar_model && q.bar_model.enabled) h += `<div class="bm">${barModelVisual(q.bar_model)}</div>`;
  if (CFG.visuals && q.visuals && q.visuals.length) h += `<div class="qvis">${visualsHtml(q.visuals.slice(0, CFG.answer_style === 'visual' ? 2 : 1))}</div>`;
  return h + '</div>';
}

function header(spec, c) {
  const lay = spec.layout || {};
  const style = c.header ? (lay.header_style || 'simple') : 'none';
  let h = `<div class="title">${esc(spec.title)}</div>${spec.subtitle ? `<div class="subtitle">${esc(spec.subtitle)}</div>` : ''}`;
  if (style === 'school') {
    h += '<table class="form"><tr><th>班級</th><td></td><th>座號</th><td></td><th>姓名</th><td class="w"></td><th>得分</th><td></td></tr></table>';
  } else if (style === 'simple') {
    h += '<div class="info"><span>班級：＿＿＿＿</span><span>座號：＿＿＿</span><span>姓名：＿＿＿＿＿＿</span><span>日期：＿＿＿＿＿</span><span class="score">得分</span></div>';
  }
  if (lay.instructions) h += `<div class="instr"><b>作答說明：</b>${esc(lay.instructions)}</div>`;
  if (lay.score_table && lay.score_table.length) {
    h += `<table class="form scores"><tr><th>大題</th>${lay.score_table.map((x) => `<th>${esc(x)}</th>`).join('')}<th>總分</th></tr>
      <tr><th>得分</th>${lay.score_table.map(() => '<td></td>').join('')}<td></td></tr></table>`;
  }
  return h;
}

// a parent's own Word template: the pages come from that Word file (converted on the Pi),
// so the preview and the print are exactly what Word shows
async function wordPages(tok) {
  const dpi = P.get('auto') ? 200 : 110;
  const r = await fetch(`/api/print/pages/${tok}?dpi=${dpi}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || '轉換失敗');
  return j.pages.map((u) => `<div class="imgpage" style="page:port"><img src="${u}"></div>`).join('');
}

let CFG = {};

function lessonHtml(les, c) {
  return `<section class="lesson"><h2>${esc(les.title || '觀念教學重點')}</h2>
    <div class="intro">${rich(les.intro || '先把觀念弄懂，再來解題！')}</div>
    ${(les.concepts || []).map((k, i) => {
      const vis = c.visuals && k.visual ? visualHtml(k.visual) : '';
      return `<div class="concept"><h3>${i + 1}. ${rich(k.title)}${k.unit ? `<span class="refs">（${esc(k.unit)}）</span>` : ''}</h3>
        <div class="${vis ? 'two' : ''}"><div>
          <div>${rich(k.explain)}</div>
          ${k.rule ? `<div class="rule">${rich(k.rule)}</div>` : ''}
          ${k.example_question ? `<div class="ex"><b>例題：</b>${rich(k.example_question)}</div>` : ''}
          ${k.example_solution ? `<div class="ex"><b>解法：</b>${rich(k.example_solution)}</div>` : ''}
          ${k.mistake ? `<div class="ex"><b>小心：</b>${rich(k.mistake)}</div>` : ''}
          ${k.question_numbers && k.question_numbers.length ? `<div class="refs">對應題目：第 ${k.question_numbers.join('、')} 題</div>` : ''}
        </div>${vis ? `<div>${vis}</div>` : ''}</div></div>`;
    }).join('')}
    ${les.tips && les.tips.length ? `<div class="tips"><b>作答前提醒：</b>${les.tips.map((t) => rich(t)).join('　')}</div>` : ''}
  </section>`;
}

async function main() {
  const tok = P.get('t');
  const res = await fetch(`/api/print/spec/${tok}`);
  if (!res.ok) { document.getElementById('msg').textContent = '列印設定已過期，請回到上一頁重新產生'; return; }
  const spec = await res.json();
  const c = spec.config;
  CFG = c;
  document.body.classList.add('static');
  document.title = spec.title;
  document.documentElement.style.setProperty('--fs', `${c.font_size}pt`);
  if (P.get('preview')) document.body.classList.add('preview');
  pageCss(c.orientation);
  let h = '';
  if (spec.layout && spec.layout.custom) {
    document.getElementById('msg').textContent = '用你的 Word 範本排版中…（第一次約 10～20 秒）';
    try { h = await wordPages(tok); } catch (e) { document.getElementById('msg').textContent = e.message; return; }
  } else if (c.writing_mode === 'vertical' && !c.key_only) {
    // 直書 like the original: the pages are laid out one by one below (verticalPages)
    document.body.classList.add('vertical');
    h = '<div id="vpages"></div>' + answerKeyHtml(spec, c);
  } else {
    let section = null, body = '';
    const vset = new Set(c.vertical_ids || []);  // questions from 直書 originals: a 直書 part of their own
    spec.questions.forEach((q, i) => {
      if (vset.has(q.id)) return;
      if (q.section && q.section !== section) { section = q.section; body += `<div class="section">${rich(section)}</div>`; }
      body += questionHtml(q, i + 1, c);
    });
    if (vset.size && !c.key_only) body += '<div id="vpart"></div>';
    h = c.key_only ? '' : (spec.lesson ? lessonHtml(spec.lesson, c) : '') + header(spec, c) + `<div class="content">${body}</div>`; // A4: one column
    if (c.answers === 'end' || c.answers === 'separate') {
      let ksec = null;
      const key = spec.questions.map((q, i) => {
        let pre = '';
        if (q.section && q.section !== ksec) { ksec = q.section; pre = `<div class="section">${rich(ksec.replace(/（共.*$/, ''))}</div>`; }
        return `${pre}<div class="q"><span class="n">${esc(q.number || i + 1)}.</span><div class="b"><span class="ans">${rich(q.answer)}</span>${c.explanations ? explain(q) : ''}</div></div>`;
      }).join('');
      // 只有答案: a grid of five per row, quick to check against — one block per section, labelled,
      // because numbering restarts in each section
      const groups = [];
      spec.questions.forEach((q) => {
        const sec = (q.section || '').replace(/（.*$/, '');
        if (!groups.length || groups[groups.length - 1].sec !== sec) groups.push({ sec, qs: [] });
        groups[groups.length - 1].qs.push(q);
      });
      const grid = !c.explanations
        ? `<table class="keygrid">${groups.map((g) => `${g.sec ? `<tr><th colspan="5">${rich(g.sec)}</th></tr>` : ''}${Array.from({ length: Math.ceil(g.qs.length / 5) }, (_, r) => `<tr>${g.qs.slice(r * 5, r * 5 + 5).map((q, i) => `<td><b>${esc(q.number || r * 5 + i + 1)}.</b> ${rich(q.answer)}</td>`).join('')}${'<td></td>'.repeat(Math.max(0, 5 - g.qs.slice(r * 5, r * 5 + 5).length))}</tr>`).join('')}`).join('')}</table>`
        : `<div>${key}</div>`;
      h += `<div class="keyhead ${c.key_only ? 'first' : ''}">${esc(spec.title)}${c.answers === 'separate' ? '　解答卷' : '　參考答案'}</div>${grid}`;
    }
  }
  document.getElementById('msg').remove();
  sheet.innerHTML = h;
  if (document.getElementById('vpages')) await verticalPages(spec, c, document.getElementById('vpages'));
  const vpart = document.getElementById('vpart');
  if (vpart) {
    const vset = new Set(c.vertical_ids || []);
    await verticalPages({ ...spec, title: '國語（直書）', subtitle: '', questions: spec.questions.filter((q) => vset.has(q.id)) },
      { ...c, orientation: 'landscape', part: true }, vpart);
  }
  window.renderMathInElement(sheet, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
  await Promise.all([...sheet.querySelectorAll('img')].map((im) => im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })));
  if (document.fonts) await document.fonts.ready;
  if (P.get('preview')) {
    // Fit the A4 sheet into the preview panel — on a phone (a narrow frame) the sheet is laid out
    // again at that width instead (直書 pages keep their fixed boxes, shrunk). The page holding the
    // preview is told how tall it is, so the frame needs no scrollbar of its own.
    const fit = () => {
      // clientWidth: the room there really is (innerWidth grows with the sheet on a phone that overflows)
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const narrow = vw < 600 && !document.body.classList.contains('vertical');
      document.body.classList.toggle('narrow', narrow);
      document.body.style.zoom = narrow ? '' : Math.min(1, (vw - 24) / sheet.offsetWidth);
      if (window.parent !== window) {
        const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
        window.parent.postMessage({ type: 'paper-size', t: tok, h }, location.origin);
      }
    };
    fit();
    window.addEventListener('resize', fit);
    setTimeout(fit, 400);  // fonts and pictures that came in a moment later
  }
  document.body.dataset.ready = '1';
  if (P.get('auto')) setTimeout(() => window.print(), 300);
}

// the answer key (also after 直書 pages: it stays 橫書, quick to check against)
function answerKeyHtml(spec, c) {
  if (!(c.answers === 'end' || c.answers === 'separate')) return '';
  const groups = [];
  spec.questions.forEach((q) => {
    const sec = (q.section || '').replace(/（.*$/, '');
    if (!groups.length || groups[groups.length - 1].sec !== sec) groups.push({ sec, qs: [] });
    groups[groups.length - 1].qs.push(q);
  });
  const body = !c.explanations
    ? `<table class="keygrid">${groups.map((g) => `${g.sec ? `<tr><th colspan="5">${rich(g.sec)}</th></tr>` : ''}${Array.from({ length: Math.ceil(g.qs.length / 5) }, (_, r) => `<tr>${g.qs.slice(r * 5, r * 5 + 5).map((q, i) => `<td><b>${esc(q.number || r * 5 + i + 1)}.</b> ${rich(q.answer)}</td>`).join('')}${'<td></td>'.repeat(Math.max(0, 5 - g.qs.slice(r * 5, r * 5 + 5).length))}</tr>`).join('')}`).join('')}</table>`
    : groups.map((g) => `${g.sec ? `<div class="section">${rich(g.sec)}</div>` : ''}${g.qs.map((q) => `<div class="q"><span class="n">${esc(q.number)}.</span><div class="b"><span class="ans">${rich(q.answer)}</span>${explain(q)}</div></div>`).join('')}`).join('');
  return `<div class="keyhead">${esc(spec.title)}${c.answers === 'separate' ? '　解答卷' : '　參考答案'}</div>${body}`;
}

// 直書 (國語 printed top to bottom, columns right to left, often on a landscape page): each page is a
// fixed A4 box; questions go in until the page is full, then the next page starts. A question too
// long for one page is split at its paragraphs. Numbers of one or two digits stand upright.
async function verticalPages(spec, c, root) {
  const land = c.orientation === 'landscape';
  const W = land ? 297 : 210, H = land ? 210 : 297;
  let page = null, body = null, n = 0;
  const newPage = () => {
    n++;
    page = document.createElement('div');
    page.className = 'vpage';
    page.style.width = `${W - 24}mm`; page.style.height = `${H - 24}mm`;
    if (c.part) page.style.page = 'land';  // 直書 pages inside a portrait paper: landscape sheets
    page.innerHTML = `<div class="vbody"></div><div class="vfoot">第 ${n} 頁</div>`;
    root.appendChild(page);
    body = page.firstElementChild;
  };
  const fits = () => body.scrollWidth <= body.clientWidth + 1;
  const prep = (el) => {
    window.renderMathInElement(el, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
    upright(el);
  };
  const place = (html) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    const block = el.firstElementChild || el;
    body.appendChild(block);
    grid = null;
    prep(block);
    if (fits()) return true;
    if (body.children.length === 1) return false;  // alone on a page and still too long
    block.remove();
    newPage();
    body.appendChild(block);
    return fits() || false;
  };
  // questions of a section flow top to bottom, then on to the next column — two short ones share a
  // column (upper and lower half), like the school's own 直書 papers
  let grid = null;
  const placeQ = (html) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    const block = el.firstElementChild || el;
    if (!grid || grid.parentElement !== body) { grid = document.createElement('div'); grid.className = 'vgrid'; body.appendChild(grid); }
    grid.appendChild(block);
    prep(block);
    if (fits()) return true;
    const alone = body.children.length === 1 && grid.children.length === 1;
    block.remove();
    // a section heading never stays alone at the end of a page: it goes with its first question
    const head = !grid.children.length && grid.previousElementSibling && grid.previousElementSibling.classList.contains('vsec')
      && body.children.length > 2 ? grid.previousElementSibling : null;
    if (!grid.children.length) grid.remove();
    if (alone) return false;
    if (head) head.remove();
    newPage();
    if (head) body.appendChild(head);
    grid = document.createElement('div'); grid.className = 'vgrid'; body.appendChild(grid);
    grid.appendChild(block);
    return fits() || false;
  };
  newPage();
  if (c.part) place(`<div class="vhead"><div class="vtitle">${esc(spec.title)}</div></div>`);
  else if (c.header) {
    place(`<div class="vhead"><div class="vtitle">${esc(spec.title)}</div>${spec.subtitle ? `<div class="vsub">${esc(spec.subtitle)}</div>` : ''}
      <div class="vinfo">班級：＿＿＿　座號：＿＿＿　姓名：＿＿＿＿＿　得分：＿＿＿</div></div>`);
  }
  let section = null;
  for (const [i, q] of spec.questions.entries()) {
    if (q.section && q.section !== section) { section = q.section; place(`<div class="vsec">${rich(section)}</div>`); }
    if (!placeQ(vQuestion(q, i + 1, c))) {
      // too long for a page: paragraph by paragraph (the number on the first)
      const parts = String(q.stem || '').split('\n');
      parts.forEach((t, k) => {
        const qq = { ...q, stem: t, options: k === parts.length - 1 ? q.options : [] };
        if (!place(vQuestion(qq, i + 1, c, k > 0))) { /* one paragraph longer than a page: let it be */ }
      });
    }
    if (c.answers === 'inline') placeQ(`<div class="vans">答：${rich(q.answer)}</div>`);
  }
}

function vQuestion(q, n, c, cont = false) {
  const choice = isChoice(q);
  const stem = choice ? String(q.stem || '').replace(LEAD_BRACKET, '') : String(q.stem || '');
  const opts = (q.options || []).map((o, i) => `<span class="vopt">${CIRCLED[i] || i + 1}${rich(o)}</span>`).join('');
  const fig = figureHtml(q, c);
  // 「一-1」 under 「一、國字注音」 prints as 1, the way the paper numbers it
  const num = q.section ? String(q.number || n).replace(/^[一二三四五六七八九十]+[-－–]\s*/, '') : (q.number || n);
  return `<div class="vq">${cont ? '' : `<span class="vn">${choice ? '（　　）' : ''}${esc(num)}.</span>`}${rich(stem)}${opts ? `<div class="vopts">${opts}</div>` : ''}${fig ? `<div class="vfig">${fig}</div>` : ''}</div>`;
}

// in 直書, 1–2 digit numbers stand upright in one character's space (縱中橫); longer ones upright
function upright(root) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement.closest('.katex, rt, .zy-r, .vfig, svg') ? NodeFilter.FILTER_REJECT : /\d/.test(t.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const t of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    t.data.replace(/\d+/g, (m, at) => {
      if (at > last) frag.append(t.data.slice(last, at));
      const s = document.createElement('span');
      s.className = m.length <= 2 ? 'tcy' : 'upr';
      s.textContent = m;
      frag.append(s);
      last = at + m.length;
      return m;
    });
    if (last < t.data.length) frag.append(t.data.slice(last));
    t.replaceWith(frag);
  }
}

main();
