// Teaching diagrams ("圖解"): the AI picks a template and fills in its
// parameters; these renderers draw them as SVG. On screen the parts animate
// in (CSS in visuals.css, replay by tapping); in print the same SVG is shown
// in its final state, so every diagram is also a static picture.
const C = {
  ink: '#1C1E21', ink2: '#4A4E55', muted: '#6B6F76', line: '#B9B5AA',
  blue: '#2F5BEA', blueSoft: '#E9EEFD', orange: '#E8590C', orangeSoft: '#FFE8CC',
  green: '#237A3B', greenSoft: '#E6F4EA', paper: '#FFFFFF',
};
const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';

// AI text sometimes carries a literal "\n" instead of a line break.
const unescapeNl = (s) => String(s ?? '').replace(/\\n/g, '\n');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// $\frac{3}{4}$ → 3/4 etc. (SVG text can't hold KaTeX)
function plain(s) {
  return unescapeNl(s)
    .replace(/(\d+)\s*\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1又$2/$3')
    .replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\times/g, '×').replace(/\\div/g, '÷').replace(/\\pi/g, 'π')
    .replace(/\\text\{([^{}]*)\}/g, '$1').replace(/\\[a-z]+/g, '')
    .replace(/[${}]/g, '').replace(/\*\*/g, '');
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// animation attribute: class + delay (seconds)
const A = (kind, delay = 0, extra = '') => ` class="va va-${kind}" style="--d:${delay.toFixed(2)}s;${extra}"`;

function text(x, y, s, { size = 14, anchor = 'middle', fill = C.ink, weight = 400, anim = '' } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}" font-weight="${weight}" font-family='${FONT}'${anim}>${esc(plain(s))}</text>`;
}

// Rough CJK-aware wrap: ASCII counts as half a character.
function wrap(s, maxUnits) {
  const out = [];
  let line = '', units = 0;
  for (const ch of plain(s)) {
    const w = ch.charCodeAt(0) < 128 ? 0.55 : 1;
    if (ch === '\n' || units + w > maxUnits) {
      out.push(line);
      line = ch === '\n' ? '' : ch;
      units = ch === '\n' ? 0 : w;
    } else { line += ch; units += w; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

function svg(w, h, body, label) {
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(plain(label))}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// ---------------------------------------------------------------- templates

function fractionBar(p) {
  const bars = (p.bars || []).slice(0, 5);
  const W = 560, labelW = 90, barW = 420, rowH = 58;
  let body = '', k = 0;
  bars.forEach((b, r) => {
    const parts = clamp(Math.round(num(b.parts, 4)), 1, 24);
    const shadedList = Array.isArray(b.shaded) ? b.shaded.map(Number) : [...Array(clamp(Math.round(num(b.shaded, 0)), 0, parts)).keys()];
    const y = 14 + r * rowH, pw = barW / parts;
    const fill = b.color === 'orange' ? C.orangeSoft : C.blueSoft;
    const stroke = b.color === 'orange' ? C.orange : C.blue;
    body += text(labelW - 12, y + 25, b.label || '', { anchor: 'end', size: 15, weight: 700 });
    for (let i = 0; i < parts; i++) {
      const on = shadedList.includes(i);
      body += `<rect x="${labelW + i * pw}" y="${y}" width="${pw}" height="36" fill="${on ? fill : C.paper}" stroke="${C.ink}" stroke-width="1.5"${on ? A('pop', 0.15 * k++) : ''}/>`;
    }
    if (b.note) body += text(labelW + barW + 8, y + 25, b.note, { anchor: 'start', size: 13, fill: stroke });
  });
  return svg(W + 60, 14 + bars.length * rowH, body, p.caption || '分數條');
}

function sectorPath(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
}

function fractionCircle(p) {
  const pies = (p.pies || []).slice(0, 4);
  const r = 58, gap = 40, W = pies.length * (2 * r + gap) + 20;
  let body = '', k = 0;
  pies.forEach((pie, i) => {
    const parts = clamp(Math.round(num(pie.parts, 4)), 1, 24);
    const shaded = clamp(Math.round(num(pie.shaded, 0)), 0, parts);
    const cx = 10 + r + i * (2 * r + gap) + gap / 2, cy = r + 10;
    for (let s = 0; s < parts; s++) {
      const a0 = -Math.PI / 2 + (s * 2 * Math.PI) / parts, a1 = a0 + (2 * Math.PI) / parts;
      const on = s < shaded;
      body += `<path d="${sectorPath(cx, cy, r, a0, a1)}" fill="${on ? (pie.color === 'orange' ? C.orangeSoft : C.blueSoft) : C.paper}" stroke="${C.ink}" stroke-width="1.5"${on ? A('pop', 0.15 * k++) : ''}/>`;
    }
    body += text(cx, cy + r + 26, pie.label || `${shaded}/${parts}`, { size: 15, weight: 700 });
  });
  return svg(W, 2 * r + 46, body, p.caption || '分數圓');
}

function numberLine(p) {
  const min = num(p.min, 0), max = num(p.max, 10);
  const span = max - min || 1;
  const step = num(p.step, span / 10) || span / 10;
  const W = 600, x0 = 30, x1 = W - 30, y = 110;
  const X = (v) => x0 + ((v - min) / span) * (x1 - x0);
  let body = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.ink}" stroke-width="2"${A('draw', 0, `--len:${x1 - x0}`)} stroke-dasharray="${x1 - x0}"/>`;
  const ticks = Math.min(60, Math.round(span / step));
  for (let i = 0; i <= ticks; i++) {
    const v = min + i * step, x = X(v);
    body += `<line x1="${x}" y1="${y - 7}" x2="${x}" y2="${y + 7}" stroke="${C.ink}" stroke-width="1.5"/>`;
    if (ticks <= 20 || i % Math.ceil(ticks / 20) === 0) body += text(x, y + 26, String(+v.toFixed(3)), { size: 12, fill: C.ink2 });
  }
  (p.jumps || []).slice(0, 8).forEach((j, i) => {
    const a = X(num(j.from)), b = X(num(j.to)), mid = (a + b) / 2, hgt = Math.min(70, Math.abs(b - a) / 2 + 20);
    const len = Math.abs(b - a) * 1.4 + 20;
    body += `<path d="M${a},${y - 4} Q${mid},${y - hgt * 1.6} ${b},${y - 4}" fill="none" stroke="${C.orange}" stroke-width="2.5" stroke-dasharray="${len}"${A('draw', 0.5 + i * 0.6, `--len:${len}`)}/>`;
    body += `<path d="M${b - 6},${y - 12} L${b},${y - 4} L${b + 3},${y - 13}" fill="none" stroke="${C.orange}" stroke-width="2.5"${A('fade', 0.9 + i * 0.6)}/>`;
    if (j.label) body += text(mid, y - hgt * 0.85 - 6, j.label, { size: 13, fill: C.orange, weight: 700, anim: A('fade', 0.8 + i * 0.6) });
  });
  (p.marks || []).slice(0, 10).forEach((m, i) => {
    const x = X(num(m.value));
    body += `<circle cx="${x}" cy="${y}" r="6" fill="${C.blue}"${A('pop', 0.3 + i * 0.25)}/>`;
    if (m.label) body += text(x, y + 46, m.label, { size: 13, fill: C.blue, weight: 700, anim: A('fade', 0.3 + i * 0.25) });
  });
  return svg(W, 170, body, p.caption || '數線');
}

function areaGrid(p) {
  const cols = clamp(Math.round(num(p.cols, 6)), 1, 20), rows = clamp(Math.round(num(p.rows, 4)), 1, 15);
  const cell = Math.min(32, Math.floor(420 / cols), Math.floor(260 / rows));
  const x0 = 70, y0 = 20, W = x0 + cols * cell + 140, H = y0 + rows * cell + 50;
  let body = '';
  for (let r = 0; r < rows; r++) {
    let row = '';
    for (let c = 0; c < cols; c++) row += `<rect x="${x0 + c * cell}" y="${y0 + r * cell}" width="${cell}" height="${cell}" fill="${C.blueSoft}" stroke="${C.blue}" stroke-width="1"/>`;
    body += `<g${A('fade', r * 0.18)}>${row}</g>`;
  }
  body += `<rect x="${x0}" y="${y0}" width="${cols * cell}" height="${rows * cell}" fill="none" stroke="${C.ink}" stroke-width="2"/>`;
  body += text(x0 + (cols * cell) / 2, y0 + rows * cell + 24, p.label_w || `${cols}`, { size: 14, weight: 700 });
  body += text(x0 - 10, y0 + (rows * cell) / 2 + 5, p.label_h || `${rows}`, { size: 14, weight: 700, anchor: 'end' });
  if (p.note) wrap(p.note, 9).forEach((l, i) => { body += text(x0 + cols * cell + 14, y0 + 20 + i * 20, l, { size: 13, anchor: 'start', fill: C.orange, weight: 700, anim: A('fade', rows * 0.18 + 0.2) }); });
  return svg(W, H, body, p.caption || '面積格子');
}

// Classic area-formula animations: pieces start where they are cut from and
// slide into the new shape (final position = printed picture).
function shapeArea(p) {
  const kind = p.kind || 'triangle';
  const b = 200, h = 120, s = 60; // base, height, slant offset
  const W = 600, H = 240, ox = 30, oy = 40, rx = 330;
  const lab = (x, y, t, o = {}) => text(x, y, t, { size: 13, ...o });
  let left = '', right = '';
  const hDash = (x, y1, y2) => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${C.orange}" stroke-width="2" stroke-dasharray="5 4"/>`;
  if (kind === 'parallelogram') {
    left = `<polygon points="${ox + s},${oy} ${ox + s + b},${oy} ${ox + b},${oy + h} ${ox},${oy + h}" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>${hDash(ox + s, oy, oy + h)}`;
    // cut the left triangle off along the height and slide it to the right end
    right = `<polygon points="${rx + s},${oy} ${rx + s + b},${oy} ${rx + b},${oy + h} ${rx + s},${oy + h}" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>
      <polygon points="${rx + b},${oy + h} ${rx + s + b},${oy} ${rx + s + b},${oy + h}" fill="${C.orangeSoft}" stroke="${C.ink}" stroke-width="2"${A('move', 0.6, `--fx:${-b}px;--fy:0px`)}/>`;
  } else if (kind === 'trapezoid') {
    const top = 110;
    left = `<polygon points="${ox + 40},${oy} ${ox + 40 + top},${oy} ${ox + b},${oy + h} ${ox},${oy + h}" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>${hDash(ox + 40, oy, oy + h)}`;
    const t = top * 0.62, bb = b * 0.62, xx = rx - 10;
    right = `<polygon points="${xx + 25},${oy} ${xx + 25 + t},${oy} ${xx + bb},${oy + h} ${xx},${oy + h}" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>
      <polygon points="${xx + 25 + t},${oy} ${xx + 25 + t + bb},${oy} ${xx + bb + t},${oy + h} ${xx + bb},${oy + h}" fill="${C.orangeSoft}" stroke="${C.ink}" stroke-width="2"${A('move', 0.6, `--fx:60px;--fy:70px;--fr:180deg`)}/>`;
  } else if (kind === 'circle') {
    const r = 70, cx = ox + r + 20, cy = oy + 80, n = 12;
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      left += `<path d="${sectorPath(cx, cy, r, a0, a0 + (2 * Math.PI) / n)}" fill="${i % 2 ? C.orangeSoft : C.blueSoft}" stroke="${C.ink}" stroke-width="1.2"/>`;
    }
    left += `<line x1="${cx}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="${C.orange}" stroke-width="2"/>`;
    // sectors laid in a strip: apex alternately up/down → almost a rectangle
    const w = (Math.PI * r) / (n / 2), top = oy + 45, bottom = top + r;
    for (let i = 0; i < n; i++) {
      const x = rx + (i * w) / 2;
      const up = i % 2 === 0;
      const pts = up ? `${x},${bottom} ${x + w / 2},${top} ${x + w},${bottom}` : `${x},${top} ${x + w / 2},${bottom} ${x + w},${top}`;
      right += `<polygon points="${pts}" fill="${up ? C.blueSoft : C.orangeSoft}" stroke="${C.ink}" stroke-width="1.2"${A('pop', 0.3 + i * 0.12)}/>`;
    }
    right += lab(rx + (n * w) / 4 + w / 4, bottom + 22, p.base_label || '圓周長的一半 = 半徑 × 3.14', { fill: C.blue, weight: 700, anim: A('fade', 2) });
    right += lab(rx - 8, (top + bottom) / 2 + 4, p.height_label || '半徑', { anchor: 'end', fill: C.orange, weight: 700, anim: A('fade', 2) });
    left += lab(cx + r / 2, cy - 8, '半徑', { fill: C.orange, weight: 700 });
  } else { // triangle
    left = `<polygon points="${ox + 70},${oy} ${ox + b},${oy + h} ${ox},${oy + h}" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>${hDash(ox + 70, oy, oy + h)}`;
    right = `<polygon points="${rx + 70},${oy} ${rx + b},${oy + h} ${rx},${oy + h}" fill="${C.blueSoft}" stroke="${C.ink}" stroke-width="2"/>
      <polygon points="${rx + 70},${oy} ${rx + 70 + b},${oy} ${rx + b},${oy + h}" fill="${C.orangeSoft}" stroke="${C.ink}" stroke-width="2"${A('move', 0.6, `--fx:40px;--fy:60px;--fr:180deg`)}/>`;
  }
  let labels = '';
  if (kind !== 'circle') {
    labels += lab(ox + b / 2, oy + h + 22, p.base_label || '底', { weight: 700 });
    labels += lab(ox - 4 + (kind === 'triangle' ? 70 : kind === 'trapezoid' ? 40 : s) + 6, oy + h / 2, p.height_label || '高', { anchor: 'start', fill: C.orange, weight: 700 });
  }
  const ay = kind === 'circle' ? oy + 10 : oy + 70;
  const arrow = `<path d="M${rx - 60},${ay} h36 m-8,-7 l8,7 l-8,7" fill="none" stroke="${C.muted}" stroke-width="2"${A('fade', 0.3)}/>`;
  const formula = p.formula ? text(W / 2, H - 14, p.formula, { size: 16, weight: 700, fill: C.blue, anim: A('fade', 1.6) }) : '';
  return svg(W, H, left + labels + arrow + right + formula, p.caption || '面積公式');
}

function barModel(p) {
  const bars = (p.bars || []).slice(0, 5);
  if (!bars.length) return '';
  const labelW = 80, noteW = 130, W = 640, rowH = 56;
  const totals = bars.map((b) => (b.segments || []).reduce((s, x) => s + (num(x.size, 1) || 1), 0));
  const unit = (W - labelW - noteW - 10) / Math.max(...totals, 1);
  let body = '', k = 0;
  bars.forEach((b, r) => {
    const y = 10 + r * rowH;
    body += text(labelW - 10, y + 24, b.label || '', { anchor: 'end', size: 15, weight: 700 });
    let x = labelW;
    (b.segments || []).forEach((sg) => {
      const w = Math.max(18, (num(sg.size, 1) || 1) * unit);
      body += `<g${A('grow', 0.25 * k++)}><rect x="${x}" y="${y + 6}" width="${w}" height="28" fill="${sg.highlight ? C.orangeSoft : C.blueSoft}" stroke="${C.ink}" stroke-width="1.5" rx="3"/>
        ${sg.label ? text(x + w / 2, y + 25, sg.label, { size: 13 }) : ''}</g>`;
      x += w;
    });
    if (b.note) body += text(x + 8, y + 25, b.note, { anchor: 'start', size: 14, fill: C.orange, weight: 700, anim: A('fade', 0.25 * k) });
  });
  return svg(W, 10 + bars.length * rowH, body, p.caption || '線段圖');
}

function steps(p) {
  const items = (p.steps || []).slice(0, 6);
  const W = 560, boxW = 480, x = 40;
  let y = 8, body = '';
  items.forEach((s, i) => {
    const lines = wrap(s, 24);
    const h = 18 + lines.length * 22;
    body += `<g${A('fade', i * 0.6)}><rect x="${x}" y="${y}" width="${boxW}" height="${h}" rx="12" fill="${i === items.length - 1 ? C.orangeSoft : C.blueSoft}" stroke="${i === items.length - 1 ? C.orange : C.blue}" stroke-width="1.5"/>
      <circle cx="${x}" cy="${y + h / 2}" r="14" fill="${C.ink}"/>${text(x, y + h / 2 + 5, String(i + 1), { size: 14, fill: '#fff', weight: 700 })}
      ${lines.map((l, j) => text(x + 28, y + 30 + j * 22, l, { anchor: 'start', size: 15 })).join('')}</g>`;
    y += h;
    if (i < items.length - 1) {
      body += `<path d="M${x + boxW / 2},${y + 3} v14 m-6,-6 l6,6 l6,-6" fill="none" stroke="${C.muted}" stroke-width="2"${A('fade', i * 0.6 + 0.4)}/>`;
      y += 22;
    }
  });
  return svg(W, y + 8, body, p.caption || '解題步驟');
}

function compare(p) {
  const cols = [p.left || {}, p.right || {}];
  const W = 600, cw = 280;
  let body = '', maxH = 0;
  cols.forEach((c, ci) => {
    const x = 10 + ci * (cw + 20);
    let y = 54, inner = '';
    (c.items || []).slice(0, 6).forEach((it, i) => {
      const lines = wrap(it, 15);
      inner += `<g${A('fade', 0.3 + i * 0.35 + ci * 0.15)}>${lines.map((l, j) => text(x + 30, y + j * 21, l, { anchor: 'start', size: 14 })).join('')}
        <circle cx="${x + 18}" cy="${y - 5}" r="4" fill="${ci ? C.orange : C.blue}"/></g>`;
      y += lines.length * 21 + 10;
    });
    maxH = Math.max(maxH, y);
    body += `<rect x="${x}" y="8" width="${cw}" height="__H__" rx="14" fill="${ci ? C.orangeSoft : C.blueSoft}"/>`;
    body += text(x + cw / 2, 34, c.title || '', { size: 16, weight: 700, fill: ci ? C.orange : C.blue });
    body += inner;
  });
  body = body.replace(/__H__/g, String(maxH - 4));
  return svg(W, maxH + 12, body, p.caption || '比較');
}

function timeline(p) {
  const ev = (p.events || []).slice(0, 8);
  const W = 640, x0 = 30, x1 = W - 30, y = 110;
  const vals = ev.map((e, i) => (Number.isFinite(Number(e.value)) ? Number(e.value) : i));
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  let body = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.ink}" stroke-width="3" stroke-dasharray="${x1 - x0}"${A('draw', 0, `--len:${x1 - x0}`)}/>`;
  ev.forEach((e, i) => {
    const x = x0 + 20 + ((vals[i] - lo) / span) * (x1 - x0 - 40);
    const up = i % 2 === 0;
    body += `<g${A('pop', 0.4 + i * 0.35)}><circle cx="${x}" cy="${y}" r="7" fill="${up ? C.blue : C.orange}"/>
      <line x1="${x}" y1="${y}" x2="${x}" y2="${up ? y - 30 : y + 30}" stroke="${C.line}" stroke-width="1.5"/>
      ${wrap(e.label, 7).slice(0, 3).map((l, j) => text(x, up ? y - 72 + j * 18 : y + 50 + j * 18, l, { size: 13, weight: j ? 400 : 700 })).join('')}</g>`;
  });
  return svg(W, 220, body, p.caption || '時間軸');
}

function speedTrack(p) {
  const hours = clamp(Math.round(num(p.hours, 2)), 1, 8);
  const W = 600, x0 = 40, x1 = W - 40, y = 90, seg = (x1 - x0) / hours;
  let body = `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" stroke="${C.ink}" stroke-width="3"/>`;
  for (let i = 0; i <= hours; i++) {
    const x = x0 + i * seg;
    body += `<line x1="${x}" y1="${y - 8}" x2="${x}" y2="${y + 8}" stroke="${C.ink}" stroke-width="2"/>`;
    body += text(x, y + 28, i === 0 ? '出發' : `${i} 小時`, { size: 12, fill: C.ink2 });
    if (i < hours && p.per_hour_label) body += text(x + seg / 2, y - 18, p.per_hour_label, { size: 12, fill: C.blue, anim: A('fade', 0.4 + i * (2.4 / hours)) });
  }
  const car = `<g${A('drive', 0.2, `--fx:${-(x1 - x0)}px;--fy:0px`)}><rect x="${x1 - 34}" y="${y - 30}" width="40" height="16" rx="5" fill="${C.orange}"/>
    <rect x="${x1 - 26}" y="${y - 40}" width="22" height="12" rx="4" fill="${C.orange}"/>
    <circle cx="${x1 - 24}" cy="${y - 12}" r="5" fill="${C.ink}"/><circle cx="${x1 - 2}" cy="${y - 12}" r="5" fill="${C.ink}"/></g>`;
  body += car;
  body += text(W / 2, y + 62, p.distance_label || '', { size: 15, weight: 700 });
  if (p.formula) body += text(W / 2, y + 88, p.formula, { size: 15, weight: 700, fill: C.blue, anim: A('fade', 2.8) });
  return svg(W, y + 100, body, p.caption || '速率');
}

function columnCalc(p) {
  const rows = (p.rows || []).slice(0, 5).map((r) => plain(r));
  const result = plain(p.result || '');
  const width = Math.max(...rows.map((r) => r.length), result.length, 1);
  const cw = 22, W = width * cw + 80, x1 = W - 30;
  let body = '', y = 34;
  rows.forEach((r, i) => {
    body += `<text x="${x1}" y="${y}" font-size="24" text-anchor="end" font-family="ui-monospace,Menlo,monospace" fill="${C.ink}"${A('fade', i * 0.3)}>${esc(r)}</text>`;
    y += 32;
  });
  body += `<line x1="${x1 - width * cw - 6}" y1="${y - 22}" x2="${x1 + 4}" y2="${y - 22}" stroke="${C.ink}" stroke-width="2"${A('fade', rows.length * 0.3)}/>`;
  [...result].reverse().forEach((ch, i) => {
    body += `<text x="${x1 - i * (cw * 0.66)}" y="${y + 8}" font-size="24" text-anchor="end" font-family="ui-monospace,Menlo,monospace" fill="${C.orange}" font-weight="700"${A('pop', rows.length * 0.3 + 0.3 + i * 0.25)}>${esc(ch)}</text>`;
  });
  if (p.note) body += text(W / 2, y + 44, p.note, { size: 13, fill: C.ink2 });
  return svg(W, y + (p.note ? 56 : 24), body, p.caption || '直式計算');
}

function balance(p) {
  const W = 560, cx = 280, y = 70;
  const body = `<polygon points="${cx - 18},${y + 110} ${cx + 18},${y + 110} ${cx},${y + 10}" fill="${C.line}"/>
    <g class="va va-tilt" style="--d:.3s;transform-origin:${cx}px ${y + 10}px">
      <line x1="${cx - 200}" y1="${y + 10}" x2="${cx + 200}" y2="${y + 10}" stroke="${C.ink}" stroke-width="4"/>
      <rect x="${cx - 260}" y="${y - 34}" width="120" height="40" rx="8" fill="${C.blueSoft}" stroke="${C.blue}" stroke-width="1.5"/>
      ${text(cx - 200, y - 8, p.left || '', { size: 16, weight: 700 })}
      <rect x="${cx + 140}" y="${y - 34}" width="120" height="40" rx="8" fill="${C.orangeSoft}" stroke="${C.orange}" stroke-width="1.5"/>
      ${text(cx + 200, y - 8, p.right || '', { size: 16, weight: 700 })}
    </g>
    ${p.step ? text(cx, y + 140, p.step, { size: 14, fill: C.ink2, anim: A('fade', 1.2) }) : ''}
    ${p.result ? text(cx, y + 166, p.result, { size: 17, fill: C.blue, weight: 700, anim: A('fade', 1.8) }) : ''}`;
  return svg(W, y + 180, body, p.caption || '等量公理');
}

// AI-drawn SVG for anything the templates don't cover, reduced to drawing
// elements only (no scripts, links, styles, foreign content or event handlers).
const SAFE_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'title',
  'animate', 'animateTransform', 'animateMotion', 'set']);  // SVG's own animation (moving, colouring, drawing step by step)
const SAFE_ATTR = /^(viewBox|width|height|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|fill|stroke|stroke-width|stroke-dasharray|stroke-dashoffset|stroke-linecap|stroke-linejoin|opacity|fill-opacity|stroke-opacity|transform|font-size|font-weight|text-anchor|dominant-baseline|id|marker-end|marker-start|markerWidth|markerHeight|refX|refY|orient|attributeName|from|to|by|values|dur|begin|end|repeatCount|keyTimes|keySplines|calcMode|type|path|rotate|additive|accumulate|restart)$/;
// what an animation may change: shapes, colours, positions — never a link or a script
const ANIM_ATTR = /^(x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|d|points|fill|stroke|stroke-width|stroke-dasharray|stroke-dashoffset|opacity|fill-opacity|stroke-opacity|transform|font-size|visibility)$/;
// a question's figure on screen: the real table, the SVG redrawn from the photo, or the picture
export function questionFigure(q, imgStyle = '') {
  const t = q.figure_table;
  if (t && (t.rows || []).length) {
    const cell = (x) => esc(plain(x));
    return `<div class="qfig-scroll"><table class="qtable">${(t.header || []).length ? `<tr>${t.header.map((x) => `<th>${cell(x)}</th>`).join('')}</tr>` : ''}${t.rows.map((r) => `<tr>${r.map((x) => `<td>${cell(x)}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }
  if (q.figure_svg) { const svg = cleanSvg(q.figure_svg); if (svg) return `<div class="qsvg">${svg}</div>`; }
  if (q.figure_path) return `<img class="fig" src="/media/${q.figure_path}" alt="附圖" loading="lazy" ${imgStyle}>`;
  return '';
}

// a question's figure redrawn as SVG (題目升級), cleaned the same way, without animation
export function cleanSvg(src) {
  const out = customSvg({ svg: src });
  return out.replace(/ class="va va-fade" style="--d:[\d.]+s"/g, '');
}

function customSvg(p) {
  const src = String(p.svg || '');
  if (!src.includes('<svg')) return '';
  let doc;
  try { doc = new DOMParser().parseFromString(src, 'image/svg+xml'); } catch { return ''; }
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'svg') return '';
  const clean = (el) => {
    [...el.children].forEach((c) => {
      if (!SAFE_TAGS.has(c.nodeName)) { c.remove(); return; }
      if (/^(animate|animateTransform|set)$/.test(c.nodeName) && c.nodeName !== 'animateTransform' && !ANIM_ATTR.test(c.getAttribute('attributeName') || '')) { c.remove(); return; }
      clean(c);
    });
    [...el.attributes].forEach((a) => {
      const v = a.value || '';
      if (!SAFE_ATTR.test(a.name) || /url\s*\(|javascript:/i.test(v) && !/^url\(#[\w-]+\)$/.test(v.trim())) el.removeAttribute(a.name);
    });
  };
  clean(root);
  root.setAttribute('role', 'img');
  if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${root.getAttribute('width') || 400} ${root.getAttribute('height') || 240}`);
  root.removeAttribute('width');
  root.removeAttribute('height');
  [...root.children].forEach((c, i) => { c.setAttribute('class', 'va va-fade'); c.setAttribute('style', `--d:${Math.min(3, i * 0.12).toFixed(2)}s`); });
  return new XMLSerializer().serializeToString(root);
}

const RENDER = {
  fraction_bar: fractionBar, fraction_circle: fractionCircle, number_line: numberLine, area_grid: areaGrid,
  shape_area: shapeArea, bar_model: barModel, steps, compare, timeline, speed_track: speedTrack,
  column_calc: columnCalc, balance, custom_svg: customSvg,
};

function params(v) {
  if (v.params && typeof v.params === 'object') return v.params;
  try { return JSON.parse(v.params_json || '{}'); } catch { return {}; }
}

// One diagram as HTML. `v` = {type, title, caption, params_json}
export function visualHtml(v) {
  if (!v || v.pending || !RENDER[v.type]) return ''; // pending: the AI has not checked it yet
  let out = '';
  try { out = RENDER[v.type]({ ...params(v), caption: v.caption }); } catch (e) { console.warn('visual failed', v, e); }
  if (!out) return '';
  return `<figure class="vis" data-vtype="${esc(v.type)}">
    ${v.title ? `<figcaption class="vis-title">${esc(plain(v.title))}</figcaption>` : ''}
    <div class="vis-box" title="點一下重播動畫">${out}</div>
    ${v.caption ? `<figcaption class="vis-cap">${esc(plain(v.caption))}</figcaption>` : ''}
  </figure>`;
}

export function visualsHtml(list) {
  return (Array.isArray(list) ? list : []).map(visualHtml).join('');
}

// Tap a diagram to play its animation again.
export function bindReplay(root) {
  (root || document).querySelectorAll('.vis-box').forEach((box) => {
    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    box.addEventListener('click', () => {
      const s = box.querySelector('svg');
      if (s) s.replaceWith(s.cloneNode(true));
    });
  });
}

// Old-style bar_model field on questions → the same renderer.
export function barModelVisual(bm) {
  if (!bm || !bm.enabled || !bm.bars || !bm.bars.length) return '';
  return visualHtml({ type: 'bar_model', title: '線段圖', caption: bm.caption, params: { bars: bm.bars } });
}
