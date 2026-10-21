// 拍照掃描 (live camera, like a scanner app): a guide frame for 單頁／雙頁 and 直拍／橫拍, the paper
// found live and outlined (green = got it, hold still), 自動 picks the mode from what it sees, and
// 自動拍 takes the photo once the paper has been still for a moment. The live finding runs here in
// the browser on a small copy of each frame (~10 times a second), so it keeps up with the camera;
// the full scan is done on the Pi afterwards (the corners found here go with the photo).
import { esc } from './ui.js';

const W0 = 200; // analysis width (px)
// the white guide frame's size (of the camera picture): not full — held that close, the phone shades the
// paper; the camera has resolution to spare
const GUIDE = 0.72;

export const cameraAvailable = () => !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// --- finding the paper in a small frame -------------------------------------------------------
// guide: the white guide frame (tl, tr, br, bl, 0..1 of the frame) when 單頁／雙頁 was chosen — she lines
// the sheet up with it, so its edges are looked for near the frame's sides (自動: found anywhere)
function analyse(px, w, h, guide = null) {
  const n = w * h;
  const white = new Uint8Array(n);
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const v = mx - (mx - mn); // brightness minus saturation (paper: bright and colourless)
    white[i] = v < 0 ? 0 : v;
    lum[i] = (r * 77 + g * 150 + b * 29) >> 8;
    hist[white[i]]++;
  }
  // Otsu threshold (over the levels from `from` up): paper apart from what is darker
  const otsu = (from) => {
    let tot = 0, sum = 0;
    for (let t = from; t < 256; t++) { tot += hist[t]; sum += t * hist[t]; }
    let sB = 0, wB = 0, best = 0, thr = Math.max(from, 128);
    for (let t = from; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = tot - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  };
  const morph = (src, grow) => {
    const out = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let v = grow ? 0 : 1;
      for (let dy = -1; dy <= 1 && v === (grow ? 0 : 1); dy++) for (let dx = -1; dx <= 1; dx++) {
        const s = src[i + dy * w + dx];
        if (grow ? s : !s) { v = grow ? 1 : 0; break; }
      }
      out[i] = v;
    }
    return out;
  };
  // the biggest paper area at a threshold: text holes filled by a small closing, then a flood fill
  const paperAt = (thr) => {
    let m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = white[i] > thr ? 1 : 0;
    m = morph(morph(morph(morph(m, true), true), false), false);
    const lab = new Int32Array(n), stack = new Int32Array(n);
    let bestLab = 0, bestSize = 0, cur = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (!m[s0] || lab[s0]) continue;
      cur++; let top = 0, size = 0; stack[top++] = s0; lab[s0] = cur;
      while (top) {
        const i = stack[--top]; size++;
        const x = i % w;
        if (x > 0 && m[i - 1] && !lab[i - 1]) { lab[i - 1] = cur; stack[top++] = i - 1; }
        if (x < w - 1 && m[i + 1] && !lab[i + 1]) { lab[i + 1] = cur; stack[top++] = i + 1; }
        if (i >= w && m[i - w] && !lab[i - w]) { lab[i - w] = cur; stack[top++] = i - w; }
        if (i < n - w && m[i + w] && !lab[i + w]) { lab[i + w] = cur; stack[top++] = i + w; }
      }
      if (size > bestSize) { bestSize = size; bestLab = cur; }
    }
    // how many sides of the view it runs along (a light desk merged with the sheet runs along them)
    let sides = 0;
    const run = (get, len) => { let k = 0; for (let t = 0; t < len; t++) if (lab[get(t)] === bestLab) k++; return k > 0.25 * len; };
    if (run((x) => 4 * w + x, w)) sides++;
    if (run((x) => (h - 5) * w + x, w)) sides++;
    if (run((y) => y * w + 4, h)) sides++;
    if (run((y) => y * w + w - 5, h)) sides++;
    return { thr, lab, bestLab, bestSize, sides };
  };
  const A = paperAt(Math.max(otsu(0), 100));
  const { thr, lab, bestLab, bestSize } = A;
  if (bestSize < 0.15 * n) return null;
  // the 4 corners: the paper points furthest along the 4 diagonals
  const c = [[0, 0, -1e9], [0, 0, -1e9], [0, 0, -1e9], [0, 0, -1e9]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lab[y * w + x] !== bestLab) continue;
    const s = [-x - y, x - y, x + y, -x + y];
    for (let k = 0; k < 4; k++) if (s[k] > c[k][2]) c[k] = [x, y, s[k]];
  }
  // the far points are only rough: a cut, folded or stapled corner, or the pages of a stapled stack
  // turned over and sticking out behind, moves them. Each side's straight edge is found instead (the
  // edge points along its middle, a line through the most of them), and two neighbouring sides meet
  // at the true corner — even where the corner itself is missing or covered.
  // Two starts: the far points, and the 4 edge lines that best make a sheet (when other pages stick
  // out, the far points are on those) — whichever outline the edges and the paper fit best wins.
  const edge = edgeMap(lab, bestLab, w, h, lum);
  const g = guide && guide.map(([x, y]) => [x * (w - 1), y * (h - 1)]);
  const starts = g ? [g, c.map(([x, y]) => [x, y])] : [c.map(([x, y]) => [x, y])];
  const hq = houghQuad(edge, lab, bestLab, w, h);
  if (hq) starts.push(hq);
  const size = Math.min(w, h);
  let win = null, winScore = -1;
  for (const s0 of starts) {
    let q = s0;
    for (let pass = 0; pass < 2; pass++) {
      const fit = sideLines(edge, w, h, q);
      if (!fit) break;
      q = fit;
    }
    let sc = quadScore(edge, lab, bestLab, w, h, q);
    // 單頁／雙頁: an outline far from the guide frame is most likely something else (the desk, another sheet)
    if (g && Math.max(...q.map((p, k) => Math.hypot(p[0] - g[k][0], p[1] - g[k][1]))) > size * 0.15) sc *= 0.5;
    if (sc > winScore) { winScore = sc; win = q; }
  }
  c.forEach((p, k) => { p[0] = win[k][0]; p[1] = win[k][1]; });
  const quad = c.map(([x, y]) => [Math.min(1, Math.max(0, x / (w - 1))), Math.min(1, Math.max(0, y / (h - 1)))]);
  const area = Math.abs(quad.reduce((a, p, i) => { const q = quad[(i + 1) % 4]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  if (area > 0.985) return { quad: null, full: true };
  // checks learned from the family's own photos (what made the outline fail): the sheet touching the
  // frame (a corner cut off), other paper around it, a light background, a tilted phone, shadow
  const P = c.map(([x, y]) => [x, y]);
  const inQuad = (x, y) => { let s0 = 0; for (let k = 0; k < 4; k++) { const [ax, ay] = P[k], [bx, by] = P[(k + 1) % 4]; const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (cr < 0) s0 |= 1; else if (cr > 0) s0 |= 2; } return s0 !== 3; };
  const inW = [], outW = [], inL = [], outIdx = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = y * w + x;
    if (inQuad(x, y)) { inW.push(white[i]); inL.push(lum[i]); } else { outW.push(white[i]); outIdx.push(i); }
  }
  const med = (a) => { if (!a.length) return 0; const b = [...a].sort((p, q) => p - q); return b[Math.floor(b.length / 2)]; };
  // other paper: outside the sheet, as white as the sheet itself (a light table is not)
  const paperLevel = med(inW) - 22;
  let otherPaper = 0;
  for (const i of outIdx) if (white[i] > paperLevel && lab[i] !== bestLab) otherPaper++;
  const outN = outIdx.length;
  // the sheet on the frame's edge (a corner cut off): paper-white pixels of the sheet along the frame
  // (row/column 4: the closing leaves the outermost empty); a light table merged with it does not count
  // only the sheet itself counts — not pages of a stapled stack turned over behind it (outside its outline)
  const cxq = (P[0][0] + P[1][0] + P[2][0] + P[3][0]) / 4, cyq = (P[0][1] + P[1][1] + P[2][1] + P[3][1]) / 4;
  const sides = P.map((a, k) => { const b = P[(k + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; if (nx * (cxq - a[0]) + ny * (cyq - a[1]) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny, nx * a[0] + ny * a[1]]; });
  const inSheet = (i) => { const x = i % w, y = (i / w) | 0; return sides.every(([nx, ny, o]) => nx * x + ny * y - o > -3); };
  let touch = 0;
  const onEdge = (i) => lab[i] === bestLab && white[i] > paperLevel && inSheet(i);
  for (let x = 0; x < w; x++) { if (onEdge(4 * w + x)) touch++; if (onEdge((h - 5) * w + x)) touch++; }
  for (let y = 0; y < h; y++) { if (onEdge(y * w + 4)) touch++; if (onEdge(y * w + w - 5)) touch++; }
  const pct = (a, p) => { if (!a.length) return 0; const b = [...a].sort((u, v) => u - v); return b[Math.floor((b.length - 1) * p)]; };
  const contrast = med(inW) - med(outW);
  const light = pct(inL, 0.15) / Math.max(1, pct(inL, 0.9));
  let angleDev = 0;
  for (let k = 0; k < 4; k++) {
    const p0 = P[(k + 3) % 4], p1 = P[k], p2 = P[(k + 1) % 4];
    const ux = p0[0] - p1[0], uy = p0[1] - p1[1], vx = p2[0] - p1[0], vy = p2[1] - p1[1];
    const cs = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9);
    angleDev = Math.max(angleDev, Math.abs(Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI - 90));
  }
  const fill = bestSize / Math.max(1, area * n);  // the sheet fills its outline (no corner folded or covered)
  const checks = { touch: touch / (2 * (w + h)), contrast, other: outN ? otherPaper / outN : 0, area, angleDev, light, fill };
  // shape: wider than tall → 橫; two pages → a blank, often shaded band in the middle
  const dist = (a, b) => Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
  const qw = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2, qh = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  const landscape = qw > qh * 1.12;
  let spread = false;
  if (landscape) {
    const xs = Math.round(w * Math.min(quad[0][0], quad[3][0])), xe = Math.round(w * Math.max(quad[1][0], quad[2][0]));
    const ys = Math.round(h * Math.max(quad[0][1], quad[1][1])), ye = Math.round(h * Math.min(quad[3][1], quad[2][1]));
    const cols = [];
    for (let x = xs; x < xe; x++) {
      let ink = 0, cnt = 0;
      for (let y = ys; y < ye; y += 2) { cnt++; if (lum[y * w + x] < 110) ink++; }
      cols.push(cnt ? ink / cnt : 0);
    }
    if (cols.length > 40) {
      const L = cols.length, mid = cols.slice(Math.floor(L * 0.35), Math.floor(L * 0.65));
      const sorted = [...cols].sort((a, b) => a - b), med = sorted[Math.floor(L / 2)];
      // a blank band between two pages; the fold itself may show as a thin dark line inside it
      let run = 0, miss = 0, bestRun = 0;
      for (const v of mid) {
        if (v < 0.25 * med) { run++; miss = 0; } else if (run && ++miss <= 2) { run++; } else { run = 0; miss = 0; }
        bestRun = Math.max(bestRun, run - miss);
      }
      spread = med > 0.01 && bestRun >= L * 0.025;
    }
  }
  return { quad, area, landscape, spread, checks };
}

// edge points: where the brightness steps (Sobel, thinned to the strongest pixel across the edge), on
// or near the paper — the sheet's edge against the desk, and against the pages of a stack behind it
// (merged with it in the paper area, but a step darker); `lum` is kept to tell steps from printed lines
function edgeMap(lab, id, w, h, lum) {
  const n = w * h, near = new Uint8Array(n), mag = new Float32Array(n), gxs = new Float32Array(n), gys = new Float32Array(n);
  for (let i = 0; i < n; i++) if (lab[i] === id) {
    const x = i % w, y = (i / w) | 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
    }
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!near[i]) continue;
    const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
    const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
    gxs[i] = gx; gys[i] = gy; mag[i] = Math.hypot(gx, gy);
  }
  const pts = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, m = mag[i];
    if (m < 28) continue;
    const st = Math.abs(gxs[i]) > Math.abs(gys[i]) ? 1 : w;  // across the edge
    if (m < mag[i - st] || m < mag[i + st]) continue;
    // a step (the sheet's edge: brighter on one side), not a printed stroke (paper on both sides)
    const ux = gxs[i] / m, uy = gys[i] / m;
    const xa = Math.round(x + ux * 3), ya = Math.round(y + uy * 3), xb = Math.round(x - ux * 3), yb = Math.round(y - uy * 3);
    if (xa < 0 || ya < 0 || xa >= w || ya >= h || xb < 0 || yb < 0 || xb >= w || yb >= h) continue;
    if (Math.abs(lum[ya * w + xa] - lum[yb * w + xb]) < 14) continue;
    pts.push(x, y);
  }
  return { pts, lum };
}

// is there a step at (x, y) across direction (nx, ny) pointing into the sheet: brighter inside?
function stepAt(lum, w, h, x, y, nx, ny, r = 3) {
  const xi = Math.round(x + nx * r), yi = Math.round(y + ny * r), xo = Math.round(x - nx * r), yo = Math.round(y - ny * r);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
  if (xo < 0 || yo < 0 || xo >= w || yo >= h) return 0.5;  // outside is off the view: not known
  return lum[yi * w + xi] - lum[yo * w + xo] > 8 ? 1 : 0;
}

// corners (tl, tr, br, bl) of 4 points in any order
function orderCorners(p) {
  const s = p.map(([x, y]) => x + y), d = p.map(([x, y]) => x - y);
  const at = (arr, f) => p[arr.indexOf(f(...arr))];
  return [at(s, Math.min), at(d, Math.max), at(s, Math.max), at(d, Math.min)];
}

// how well an outline fits: its sides lie on edges, and inside it is paper
function quadScore(edge, lab, id, w, h, q) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  let sup = 0;
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    if (nx * (cx - a[0]) + ny * (cy - a[1]) < 0) { nx = -nx; ny = -ny; }  // pointing into the sheet
    let hit = 0, cnt = 0;
    for (let t = 0.03; t < 0.97; t += 0.02) {
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      cnt++;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) { hit += 0.5; continue; }
      // the step within a pixel of the line
      hit += Math.max(stepAt(edge.lum, w, h, x, y, nx, ny), stepAt(edge.lum, w, h, x + nx, y + ny, nx, ny), stepAt(edge.lum, w, h, x - nx, y - ny, nx, ny));
    }
    sup += hit / cnt;
  }
  let inside = 0, cnt = 0;
  for (let u = 0.05; u < 1; u += 0.06) for (let v = 0.05; v < 1; v += 0.06) {
    const top = [q[0][0] + (q[1][0] - q[0][0]) * u, q[0][1] + (q[1][1] - q[0][1]) * u];
    const bot = [q[3][0] + (q[2][0] - q[3][0]) * u, q[3][1] + (q[2][1] - q[3][1]) * u];
    const x = Math.round(top[0] + (bot[0] - top[0]) * v), y = Math.round(top[1] + (bot[1] - top[1]) * v);
    cnt++;
    if (x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id) inside++;
  }
  const area = Math.abs(q.reduce((s, p, i) => { const r = q[(i + 1) % 4]; return s + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2 / (w * h);
  return (sup / 4) * Math.pow(inside / cnt, 3) * Math.sqrt(Math.min(1, area / 0.5));
}

// the straight edges in view (Hough: every edge point votes for the lines through it), and the 4 of
// them — two pairs, each pair roughly parallel, the pairs roughly square — that best make a sheet
function houghQuad(edge, lab, id, w, h) {
  const { pts } = edge, NT = 180, D = Math.ceil(Math.hypot(w, h)), NR = 2 * D + 1;
  const acc = new Uint16Array(NT * NR), cs = new Float32Array(NT), sn = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cs[t] = Math.cos(t * Math.PI / NT); sn[t] = Math.sin(t * Math.PI / NT); }
  for (let j = 0; j < pts.length; j += 2) {
    const x = pts[j], y = pts[j + 1];
    for (let t = 0; t < NT; t++) acc[t * NR + Math.round(x * cs[t] + y * sn[t]) + D]++;
  }
  const size = Math.min(w, h), minV = Math.max(12, size * 0.12);
  const cand = [];
  for (let t = 0; t < NT; t++) for (let r = 0; r < NR; r++) if (acc[t * NR + r] >= minV) cand.push([acc[t * NR + r], t, r - D]);
  cand.sort((a, b) => b[0] - a[0]);
  const lines = [];
  for (const [v, t, r] of cand) {
    // one line per edge: none already taken nearby (wrapping at 180°: the same line, rho flipped)
    if (lines.some((L) => { const dt = Math.abs(L.t - t); return (dt <= 5 && Math.abs(L.r - r) <= 8) || (dt >= NT - 5 && Math.abs(L.r + r) <= 8); })) continue;
    lines.push({ t, r, v });
    if (lines.length >= 14) break;
  }
  if (lines.length < 4) return null;
  const meet = (A, B) => {
    const a1 = cs[A.t], b1 = sn[A.t], a2 = cs[B.t], b2 = sn[B.t], det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 0.5) return null;
    return [(A.r * b2 - B.r * b1) / det, (a1 * B.r - a2 * A.r) / det];
  };
  const angle = (A, B) => { const d = Math.abs(A.t - B.t) % NT; return Math.min(d, NT - d); };
  const pairs = [];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    if (angle(A, B) > 15) continue;
    const ra = A.r, rb = Math.abs(A.t - B.t) > NT / 2 ? -B.r : B.r;
    if (Math.abs(ra - rb) < size * 0.25) continue;
    pairs.push([A, B]);
  }
  let best = null, bestS = 0;
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const [A, B] = pairs[i], [C, E] = pairs[j];
    if (Math.abs(angle(A, C) - 90) > 25) continue;
    const ps = [meet(A, C), meet(A, E), meet(B, C), meet(B, E)];
    if (ps.some((p) => !p || p[0] < -0.1 * w || p[0] > 1.1 * w || p[1] < -0.1 * h || p[1] > 1.1 * h)) continue;
    const q = orderCorners(ps);
    if (new Set(q).size < 4) continue;
    const s = quadScore(edge, lab, id, w, h, q);
    if (s > bestS) { bestS = s; best = q; }
  }
  return best;
}

// the 4 sides of the sheet as straight lines, met at the corners: [[x, y] ×4] (tl, tr, br, bl), or null
function sideLines(edge, w, h, c) {
  const pts = edge.pts, size = Math.min(w, h), lines = [];
  const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
  for (let k = 0; k < 4; k++) {
    const a = c[k], b = c[(k + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < size * 0.2) return null;
    const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
    let inx = -dy, iny = dx;
    if (inx * (cx - a[0]) + iny * (cy - a[1]) < 0) { inx = -inx; iny = -iny; }
    // the middle of the side (corners left out: that is where the damage is), near the rough side
    const side = [];
    for (let j = 0; j < pts.length; j += 2) {
      const px = pts[j] - a[0], py = pts[j + 1] - a[1];
      const t = (px * dx + py * dy) / L, d = Math.abs(px * dy - py * dx);
      if (t > 0.12 && t < 0.88 && d < size * 0.12 && stepAt(edge.lum, w, h, pts[j], pts[j + 1], inx, iny, 2)) side.push(pts[j], pts[j + 1]);
    }
    const n = side.length / 2;
    if (n < 12) return null;
    // two points make a line: try many pairs, keep the line most edge points lie on (within 1.2 px)
    let best = null, bestIn = 0, seed = 12345 + k;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let it = 0; it < 90; it++) {
      const i1 = Math.floor(rnd() * n) * 2, i2 = Math.floor(rnd() * n) * 2;
      const ux = side[i2] - side[i1], uy = side[i2 + 1] - side[i1 + 1], ul = Math.hypot(ux, uy);
      if (ul < L * 0.2) continue;
      const nx = -uy / ul, ny = ux / ul, off = nx * side[i1] + ny * side[i1 + 1];
      if (Math.abs(nx * dx + ny * dy) > 0.5) continue;  // not along this side (more than ~30° off)
      let inl = 0;
      for (let j = 0; j < side.length; j += 2) if (Math.abs(nx * side[j] + ny * side[j + 1] - off) < 1.2) inl++;
      if (inl > bestIn) { bestIn = inl; best = [nx, ny, off]; }
    }
    if (!best || bestIn < Math.max(10, n * 0.25)) return null;
    // the line through all its points (least squares on the inliers)
    let sx = 0, sy = 0, m = 0;
    const on = [];
    for (let j = 0; j < side.length; j += 2) if (Math.abs(best[0] * side[j] + best[1] * side[j + 1] - best[2]) < 1.5) { on.push(side[j], side[j + 1]); sx += side[j]; sy += side[j + 1]; m++; }
    const mx = sx / m, my = sy / m;
    let xx = 0, xy = 0, yy = 0;
    for (let j = 0; j < on.length; j += 2) { const u = on[j] - mx, v = on[j + 1] - my; xx += u * u; xy += u * v; yy += v * v; }
    const th = 0.5 * Math.atan2(2 * xy, xx - yy);  // the line's direction
    const nx = -Math.sin(th), ny = Math.cos(th);
    lines.push([nx, ny, nx * mx + ny * my]);
  }
  // neighbouring sides meet at the corners: corner k is where side k-1 and side k cross
  const out = [];
  for (let k = 0; k < 4; k++) {
    const [a1, b1, c1] = lines[(k + 3) % 4], [a2, b2, c2] = lines[k];
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 0.3) return null;  // nearly parallel: no corner
    const x = (c1 * b2 - c2 * b1) / det, y = (a1 * c2 - a2 * c1) / det;
    // a corner may lie just outside the view (cut off) but not far from where the sheet is
    if (x < -0.08 * w || x > 1.08 * w || y < -0.08 * h || y > 1.08 * h) return null;
    if (Math.hypot(x - c[k][0], y - c[k][1]) > size * 0.35) return null;
    out.push([x, y]);
  }
  return out;
}

// what is wrong with a view of the sheet (the first problem found), '' when it is fine
export function problemOf(res) {
  if (!res) return '找不到考卷：把考卷放在深色的桌面上，整張拍進來';
  if (!res.quad) return res.full ? '' : '找不到考卷的邊';
  const k = res.checks;
  return k.touch > 0.02 ? '有角跑出畫面：往後退一點，四個角都要看得到'
    : k.other > 0.1 ? '旁邊有其他紙：把下面、旁邊的紙移開，只留這一張'
    : k.contrast < 45 ? '考卷和桌面太像：放在深色的桌面或墊一張深色的紙'
    : k.area < 0.2 ? '再靠近一點，讓考卷差不多到白框'
    : k.angleDev > 18 ? '手機要和考卷平行（從正上方往下拍）'
    : k.fill < 0.9 ? '有一角被蓋住或摺到：把手、東西移開，壓平'
    : k.light < 0.45 ? '有陰影：換個方向或開燈，別讓手機擋到光' : '';
}

// the same checks on a photo already taken (the phone's own camera app): {quad, problem}
export async function checkImage(blob) {
  const bmp = await createImageBitmap(blob);
  const w = W0, h = Math.max(8, Math.round(W0 * bmp.height / bmp.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, w, h);
  const res = analyse(x.getImageData(0, 0, w, h).data, w, h);
  return { quad: res && res.quad, problem: problemOf(res), landscape: bmp.width > bmp.height };
}

// --- the camera screen ---------------------------------------------------------------------------
// onShot(file, {corners, verified, spread, orient}) → a handle for the page (whatever the caller
// keeps); onFix(handle, {corners?, manual?, spread?}) and onDrop(handle) come later, from the Pi's
// check of the photo (the camera does not wait for it)
export async function openCamera({ onShot, onFix = null, onDrop = null, count = 0, title = '拍考卷', checkUrl = '/api/scan/check' }) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
  } catch (e) {
    return { error: e.message || '無法開啟相機' };
  }
  // keep the lens focusing on its own (some phones open the camera with the focus where it was left)
  try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not every phone */ }
  const pref = (() => { try { return JSON.parse(localStorage.getItem('camMode') || '{}'); } catch { return {}; } })();
  const mode = { pages: pref.pages || 'auto', orient: pref.orient || 'auto', autoShot: pref.autoShot !== false };
  const el = document.createElement('div');
  el.className = 'cam';
  el.innerHTML = `<video class="cam-v" playsinline muted autoplay></video><canvas class="cam-o"></canvas>
    <div class="cam-top">
      <button class="cam-x" aria-label="關閉相機">✕</button>
      <div class="cam-seg" data-k="pages"><button data-v="auto">自動</button><button data-v="single">單頁</button><button data-v="double">雙頁</button></div>
      <div class="cam-seg" data-k="orient"><button data-v="auto">自動</button><button data-v="portrait">直拍</button><button data-v="landscape">橫拍</button></div>
    </div>
    <div class="cam-hint" aria-live="polite">把考卷放進框裡</div>
    <div class="cam-bot">
      <label class="cam-auto"><input type="checkbox" ${mode.autoShot ? 'checked' : ''}> 自動拍</label>
      <button class="cam-shot" aria-label="拍照"><span></span></button>
      <button class="cam-done">完成<b>${count ? `（${count} 頁）` : ''}</b></button>
    </div>
    <div class="cam-flash"></div>`;
  document.body.appendChild(el);
  const video = el.querySelector('video'), ov = el.querySelector('.cam-o'), ctx = ov.getContext('2d');
  video.srcObject = stream;
  const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
  const save = () => { try { localStorage.setItem('camMode', JSON.stringify(mode)); } catch { /* */ } };
  const drawSeg = () => el.querySelectorAll('.cam-seg').forEach((s) => s.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode[s.dataset.k])));
  el.querySelectorAll('.cam-seg button').forEach((b) => b.onclick = () => { mode[b.parentElement.dataset.k] = b.dataset.v; save(); drawSeg(); });
  el.querySelector('.cam-auto input').onchange = (e) => { mode.autoShot = e.target.checked; save(); };
  drawSeg();
  let last = null, stableSince = 0, running = true, shooting = false, frames = 0, t0 = performance.now(), fps = 0;
  let shotSig = null, shotPage = null, changed = true, curOk = false, unsettled = 0, lastGuide = null;  // after a shot: wait for the next page before 自動拍
  // focus: the first page used to come out blurred — 自動拍 fired a second after the camera opened,
  // before the lens had focused on the sheet (every page after it was at the same distance, so sharp).
  // The sheet's middle is measured (every other frame, at 240 px: cheap enough for an old tablet) the way
  // the Pi measures the photo (scanner.sharpness): the shot waits until the lens has stopped getting
  // sharper. FOCUS_MIN is asked only in the first 1.5 s the sheet is still — a page with little print
  // never reads 7, and the Pi takes a blurred photo back anyway (settle)
  const FOCUS_MIN = 7, FW = 240, camStart = performance.now();
  const fc = document.createElement('canvas'); fc.width = fc.height = FW;
  const fctx = fc.getContext('2d', { willReadFrequently: true });
  fctx.imageSmoothingQuality = 'high';  // shrunk with averaging, as the Pi does (plain sampling keeps sensor noise: reads sharper)
  let focusHist = [], focused = false, blurShots = 0, blurHold = false;  // blurHold: 3 blurred shots in a row — wait for her to re-aim
  let notice = '', noticeUntil = 0;  // a message kept on the hint for a moment (the loop rewrites it every frame)
  const say = (text, ms = 2500) => { notice = text; noticeUntil = performance.now() + ms; hint.textContent = text; };
  const focusOf = (q, src = video, vw = video.videoWidth, vh = video.videoHeight) => {
    // the middle of the sheet at the Pi's scale (the sheet 1000 px long): gradient energy over that
    // after a σ=2 blur — a sharp page keeps its fine detail (≈10–14), an unfocused one does not (≈5–6).
    // src: the live video, or the frame just taken (a canvas of vw × vh)
    const qw = Math.hypot((q[1][0] - q[0][0]) * vw, (q[1][1] - q[0][1]) * vh), qh = Math.hypot((q[3][0] - q[0][0]) * vw, (q[3][1] - q[0][1]) * vh);
    const k = 1000 / Math.max(qw, qh, 1), s = FW / k;
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4 * vw, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4 * vh;
    fctx.drawImage(src, Math.max(0, cx - s / 2), Math.max(0, cy - s / 2), s, s, 0, 0, FW, FW);
    const d = fctx.getImageData(0, 0, FW, FW).data, g = new Float32Array(FW * FW);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) / 256;
    const energy = (a) => {
      let e = 0;
      for (let y = 1; y < FW - 1; y++) for (let x = 1; x < FW - 1; x++) {
        const i = y * FW + x;
        const gx = a[i - FW + 1] + 2 * a[i + 1] + a[i + FW + 1] - a[i - FW - 1] - 2 * a[i - 1] - a[i + FW - 1];
        const gy = a[i + FW - 1] + 2 * a[i + FW] + a[i + FW + 1] - a[i - FW - 1] - 2 * a[i - FW] - a[i - FW + 1];
        e += gx * gx + gy * gy;
      }
      return e;
    };
    const K = [], R = 6;
    let ks = 0;
    for (let i = -R; i <= R; i++) { K.push(Math.exp(-i * i / 8)); ks += K[K.length - 1]; }
    const tmp = new Float32Array(FW * FW), b = new Float32Array(FW * FW);
    for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
      let v = 0;
      for (let i = -R; i <= R; i++) v += K[i + R] * g[y * FW + Math.min(FW - 1, Math.max(0, x + i))];
      tmp[y * FW + x] = v / ks;
    }
    for (let y = 0; y < FW; y++) for (let x = 0; x < FW; x++) {
      let v = 0;
      for (let i = -R; i <= R; i++) v += K[i + R] * tmp[Math.min(FW - 1, Math.max(0, y + i)) * FW + x];
      b[y * FW + x] = v / ks;
    }
    const e = energy(g);
    return e > 1 ? e / (energy(b) + 1e-6) : 0;
  };
  const sig = () => {  // a tiny picture of the frame, to tell a new page from the same one
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(video, 0, 0, 16, 16);
    const d = x.getImageData(0, 0, 16, 16).data, out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    return out;
  };
  const sigDiff = (a, b) => { let s0 = 0; for (let i = 0; i < a.length; i++) s0 += Math.abs(a[i] - b[i]); return s0 / a.length; };
  // what is printed on the sheet (inside its outline, 24×24): a stapled stack's next page lies exactly
  // where the last one did, so only its print tells it apart
  const pageSig = (px, w, h, q) => {
    const out = new Uint8Array(576);
    for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) {
      const u = (i + 0.5) / 24, v = (j + 0.5) / 24;
      const tx = q[0][0] + (q[1][0] - q[0][0]) * u, ty = q[0][1] + (q[1][1] - q[0][1]) * u;
      const bx = q[3][0] + (q[2][0] - q[3][0]) * u, by = q[3][1] + (q[2][1] - q[3][1]) * u;
      const x = Math.min(w - 1, Math.max(0, Math.round((tx + (bx - tx) * v) * (w - 1))));
      const y = Math.min(h - 1, Math.max(0, Math.round((ty + (by - ty) * v) * (h - 1))));
      let s0 = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = (Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
        s0 += px[k] + px[k + 1] + px[k + 2];
      }
      out[j * 24 + i] = s0 / 27;
    }
    // the same page a bit brighter or darker is still the same page: centred and evened out
    let m = 0, v = 0;
    for (let i = 0; i < 576; i++) m += out[i];
    m /= 576;
    for (let i = 0; i < 576; i++) v += (out[i] - m) ** 2;
    const k = 40 / (Math.sqrt(v / 576) + 1e-6), z = new Float32Array(576);
    for (let i = 0; i < 576; i++) z[i] = (out[i] - m) * k;
    return z;
  };
  const hint = el.querySelector('.cam-hint');
  // what is shown: the guide frame for the mode (auto: the mode seen), the paper found
  const loop = () => {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const r = el.getBoundingClientRect();
      if (ov.width !== r.width * devicePixelRatio) { ov.width = r.width * devicePixelRatio; ov.height = r.height * devicePixelRatio; }
      const sc = Math.min(r.width / vw, r.height / vh);  // the whole camera frame is shown (contain)
      const dw = vw * sc, dh = vh * sc, ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
      const sw = W0, sh = Math.round(W0 * vh / vw);
      small.width = sw; small.height = sh;
      sctx.drawImage(video, 0, 0, sw, sh);
      const fpx = sctx.getImageData(0, 0, sw, sh).data;
      let guide = null;
      if (mode.pages !== 'auto') {  // 單頁／雙頁 chosen: the sheet is lined up with the white frame
        const o = mode.orient !== 'auto' ? mode.orient : (el.dataset.orient || (mode.pages === 'double' ? 'landscape' : 'portrait'));
        const a = o === 'landscape' ? 1.414 : 1 / 1.414, fw = vw / vh;  // the frame's shape, in the camera picture
        let gw2 = GUIDE, gh2 = GUIDE * fw / a;
        if (gh2 > GUIDE) { gh2 = GUIDE; gw2 = GUIDE * a / fw; }
        const x0 = (1 - gw2) / 2, y0 = (1 - gh2) / 2;
        guide = [[x0, y0], [x0 + gw2, y0], [x0 + gw2, y0 + gh2], [x0, y0 + gh2]];
      }
      const res = analyse(fpx, sw, sh, guide);
      lastGuide = guide;
      frames++;
      const now = performance.now();
      if (now - t0 > 1000) { fps = frames * 1000 / (now - t0); frames = 0; t0 = now; el.dataset.fps = fps.toFixed(1); }
      const pages = mode.pages === 'auto' ? (res && res.spread ? 'double' : 'single') : mode.pages;
      const orient = mode.orient === 'auto' ? (res && res.landscape ? 'landscape' : (pages === 'double' ? 'landscape' : 'portrait')) : mode.orient;
      el.dataset.pages = pages; el.dataset.orient = orient;
      const dpr = devicePixelRatio;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      // guide frame inside the camera picture: A4 (1:1.414), two A4 side by side for 雙頁
      const ar = orient === 'landscape' ? 1.414 : 1 / 1.414;
      let gw = dw * GUIDE, gh = gw / ar;
      if (gh > dh * GUIDE) { gh = dh * GUIDE; gw = gh * ar; }
      const gx = ox + (dw - gw) / 2, gy = oy + (dh - gh) / 2;
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
      ctx.strokeRect(gx, gy, gw, gh);
      if (pages === 'double') { ctx.beginPath(); ctx.moveTo(gx + gw / 2, gy); ctx.lineTo(gx + gw / 2, gy + gh); ctx.stroke(); }
      ctx.setLineDash([]);
      // corner marks of the guide
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
      for (const [cx, cy, dx, dy] of [[gx, gy, 1, 1], [gx + gw, gy, -1, 1], [gx + gw, gy + gh, -1, -1], [gx, gy + gh, 1, -1]]) {
        ctx.beginPath(); ctx.moveTo(cx, cy + 24 * dy); ctx.lineTo(cx, cy); ctx.lineTo(cx + 24 * dx, cy); ctx.stroke();
      }
      let ok = false;
      if (res && res.quad) {
        const problem = problemOf(res);
        const pts = res.quad.map(([x, y]) => [ox + x * dw, oy + y * dh]);
        const moved = last ? Math.max(...res.quad.map((p, i) => Math.hypot(p[0] - last[i][0], p[1] - last[i][1]))) : 1;
        if (moved > 0.03) stableSince = now;  // a hand-held phone jitters: 3% of the frame still counts as still
        last = res.quad;
        const still = now - stableSince > 400;
        ok = !problem;
        // in focus: sharp, and as sharp as it has been for the last while (the lens is not still moving)
        let focus = focusHist.length ? focusHist[focusHist.length - 1][1] : 0;
        if (ok && !shooting) {
          if (frames % 2 === 0 || !focusHist.length) { focus = focusOf(res.quad); focusHist.push([now, focus]); }
          focusHist = focusHist.filter(([t]) => now - t < 2000);
          const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
          const recent = median(focusHist.filter(([t]) => now - t < 600).map(([, v]) => v));
          const before = median(focusHist.filter(([t]) => now - t >= 600 && now - t < 1500).map(([, v]) => v));
          // the lens settled: no sharper than it was a moment ago (within 10%); sharp enough: 7, or the sheet
          // has been still for 1.5 s already (little print on it reads lower, yet it is as sharp as it gets)
          const settled = before > 0 && recent <= 1.1 * before;
          const sharpEnough = recent >= FOCUS_MIN || now - stableSince > 1500;
          focused = recent > 0 && settled && sharpEnough && now - camStart > 1500;
          el.dataset.focus = focus.toFixed(1);
        } else if (!ok) { focusHist = []; focused = false; }
        const lensBusy = ok && still && !focused;
        ctx.fillStyle = ok ? (still ? 'rgba(34,197,94,.28)' : 'rgba(34,197,94,.14)') : 'rgba(229,40,26,.18)';
        ctx.strokeStyle = ok ? '#22C55E' : '#E5281A'; ctx.lineWidth = ok ? 3 : 5;
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
        hint.textContent = !ok ? `拍攝 NG：${problem}` : !still ? '拿穩…'
          : lensBusy ? '對焦中…'
          : `抓到了${pages === 'double' ? '（雙頁）' : ''}，${mode.autoShot ? '拍照中…' : '可以拍了'}`;
        // the next page is told by what is printed on it, never by the view moving: re-aiming over the
        // page just taken, or a hand passing, used to count as a new page (the same page photographed
        // twice). Only while the print cannot be compared (no outline, no shot yet) does motion count
        const samePrint = ok && shotPage ? sigDiff(pageSig(fpx, sw, sh, res.quad), shotPage) <= 12 : null;
        if (shotSig && !changed) {
          unsettled = (!ok || moved > 0.03) ? unsettled + 1 : Math.max(0, unsettled - 1);
          if (samePrint === false || (samePrint === null && (moved > 0.05 || unsettled >= 3 || sigDiff(sig(), shotSig) > 10))) changed = true;
        }
        if (blurHold && (moved > 0.05 || (shotSig && sigDiff(sig(), shotSig) > 10))) { blurHold = false; blurShots = 0; }  // re-aimed
        curOk = ok;
        el.dataset.pdiff = shotPage && res.quad ? sigDiff(pageSig(fpx, sw, sh, res.quad), shotPage).toFixed(1) : '';
        const steady = now - stableSince;
        const newPage = changed && samePrint !== true;  // changed by motion, yet the same print is back in view: not a new page
        if (ok && still && mode.autoShot && newPage && !shooting && !blurHold && ((focused && steady > 800) || steady > 2500)) shoot(false, steady > 2500);
        else if (ok && still && mode.autoShot && !newPage) hint.textContent = '這頁拍好了・換下一頁（或按快門再拍一次）';
        else if (ok && still && mode.autoShot && blurHold) hint.textContent = '拍了幾次都模糊：手機拿遠一點再靠近重新對焦（或按快門直接用這張）';
      } else {
        last = null; changed = true; curOk = false; unsettled = 0; focusHist = []; focused = false;
        hint.textContent = res && res.full ? '考卷已經佔滿畫面，可以拍了' : '把考卷放進框裡（放在深色的桌面上最準）';
      }
      if (now < noticeUntil) hint.textContent = notice;
      el.classList.toggle('ready', ok);
      el.classList.toggle('ng', !!(res && res.quad && !ok));
    }
    setTimeout(() => requestAnimationFrame(loop), 60);
  };
  requestAnimationFrame(loop);
  let n = count;
  // the shot is the frame on screen, taken from the live video at once — the frame judged sharp and
  // still, not a photo taken a moment later (ImageCapture.takePhoto: slow, and on this phone no
  // bigger than the video); a 3000 px copy goes up, a 1600 px copy to the Pi's check
  const shotC = document.createElement('canvas'), chkC = document.createElement('canvas');
  const grab = () => {
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(1, 3000 / Math.max(vw, vh));
    shotC.width = Math.round(vw * s); shotC.height = Math.round(vh * s);
    const x = shotC.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(video, 0, 0, shotC.width, shotC.height);
    const k = Math.min(1, 1600 / Math.max(shotC.width, shotC.height));
    chkC.width = Math.round(shotC.width * k); chkC.height = Math.round(shotC.height * k);
    const y = chkC.getContext('2d'); y.imageSmoothingQuality = 'high'; y.drawImage(shotC, 0, 0, chkC.width, chkC.height);
  };
  const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  const check = async (chkBlob, corners) => {
    // the Pi looks at the photo itself: corners (near the live outline: half the time of a blind
    // search), 單頁／雙頁, focus
    try {
      const fd = new FormData();
      fd.append('file', chkBlob, 'p.jpg');
      if (corners) fd.append('hint', JSON.stringify(corners));
      const r = await fetch(checkUrl, { method: 'POST', body: fd });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const countText = () => { el.querySelector('.cam-done b').textContent = n ? `（${n} 頁）` : ''; };
  let uploads = Promise.resolve(), gateMiss = 0;  // the shots go up one after another, in order, while the camera goes on
  const upload = (file, info) => (uploads = uploads.then(() => onShot(file, info)).catch(() => null));
  async function shoot(manual = false, force = false) {
    if (shooting || !video.videoWidth) return;
    shooting = true;
    const quad = last, pages = el.dataset.pages, orient = el.dataset.orient, okAtShot = curOk;
    grab();
    if (quad && okAtShot && !manual && !force) {
      // the frame taken is about as sharp as the sheet has looked (not one caught mid-move): else the
      // next one — but not for ever (the copy reads a little differently from the live video)
      const best = Math.max(0, ...focusHist.map(([, v]) => v));
      const f = focusOf(quad, shotC, shotC.width, shotC.height);
      if ((f < 0.8 * FOCUS_MIN || f < 0.7 * best) && ++gateMiss < 5) { shooting = false; return; }
      gateMiss = 0;
    }
    shotSig = sig(); changed = false; unsettled = 0;
    shotPage = quad ? pageSig(sctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height, quad) : null;
    el.querySelector('.cam-flash').classList.add('on');
    setTimeout(() => el.querySelector('.cam-flash').classList.remove('on'), 180);
    const [blob, chkBlob] = await Promise.all([toBlob(shotC, 0.9), toBlob(chkC, 0.85)]);
    const file = new File([blob], `cam_${Date.now()}.jpg`, { type: 'image/jpeg' });
    const spreadGuess = mode.pages === 'auto' ? pages === 'double' : mode.pages === 'double';
    if (okAtShot && quad) {
      // the camera is free for the next page at once: the photo goes up with the live outline, and
      // what the Pi makes of it is applied afterwards (settle) — its corners, 單頁／雙頁, or taken back
      n++;
      const page = n;
      blurShots = 0; blurHold = false;
      countText();
      toastShot(spreadGuess);
      stableSince = performance.now() + 600;
      shooting = false;
      settle(upload(file, { corners: quad, verified: true, spread: spreadGuess, orient }), chkBlob, quad, page, spreadGuess, manual);
      return;
    }
    // NG when the shutter was pressed (a torn corner, a hand in view…): the Pi looks first, then she
    // places the corners herself
    say('檢查照片中…', 8000);
    const chk = await check(chkBlob, quad);
    noticeUntil = 0;
    if (chk && chk.blurry) say('這張有點模糊，AI 可能看不清楚（可以按快門再拍一次）', 3500);
    const auto = chk && chk.corners && chk.corners.length === 4 ? chk.corners : null;
    running = false;
    const { editCorners } = await import('./corners.js');
    const c = await editCorners(URL.createObjectURL(chkBlob), auto || quad || [[0.03, 0.03], [0.97, 0.03], [0.97, 0.97], [0.03, 0.97]],
      { auto, title: auto ? '請確認四個角（拍攝時有 NG）' : '請拖好四個角（找不到考卷的邊，缺角的就拖到原本的位置）' });
    running = true; requestAnimationFrame(loop);
    if (!c) { shooting = false; stableSince = performance.now() + 1500; say('已取消這張，再拍一次'); return; }
    const spread = mode.pages === 'auto' ? (chk ? chk.spread : pages === 'double') : mode.pages === 'double';
    n++;
    countText();
    toastShot(spread);
    upload(file, { corners: c, verified: true, spread, orient });
    stableSince = performance.now() + 1500;
    shooting = false;
  }
  // the Pi's check of a photo already sent: a blurred one is taken back; corners that agree with the
  // live outline are taken as right (the Pi's, a touch more exact); ones that differ she confirms
  async function settle(handle, chkBlob, corners, page, spreadGuess, manual) {
    const [chk, h] = await Promise.all([check(chkBlob, corners), handle]);
    if (!chk || h == null) return;
    if (chk.blurry && !manual) {
      if (onDrop) await onDrop(h);
      n--;
      countText();
      blurShots++;
      if (blurShots >= 3) blurHold = true;
      focusHist = []; focused = false; changed = true;
      say(`第 ${page} 頁沒對到焦，已拿掉：請重拍這一頁`, 4000);
      return;
    }
    const patch = {};
    if (mode.pages === 'auto' && chk.spread !== spreadGuess) patch.spread = chk.spread;
    if (chk.corners && chk.corners.length === 4) {
      const dists = chk.corners.map((p, i) => Math.hypot(p[0] - corners[i][0], p[1] - corners[i][1]));
      const agree = Math.max(...dists) < 0.06 && dists.reduce((a, b) => a + b, 0) / dists.length < 0.035;
      if (agree) patch.corners = chk.corners;
      else if (running) {
        running = false;
        const { editCorners } = await import('./corners.js');
        const c = await editCorners(URL.createObjectURL(chkBlob), chk.corners, { auto: chk.corners, title: `第 ${page} 頁：請確認四個角（自動偵測不太確定）` });
        running = true; requestAnimationFrame(loop);
        if (c) { patch.corners = c; patch.manual = true; }
      }
    }
    if (Object.keys(patch).length && onFix) await onFix(h, patch);
  }
  const toastShot = (spread) => say(`第 ${n} 頁拍好了（${spread ? '雙頁' : '單頁'}）・換下一頁`, 1500);
  el.querySelector('.cam-shot').onclick = () => shoot(true);
  return new Promise((resolve) => {
    const close = () => { running = false; stream.getTracks().forEach((t) => t.stop()); el.remove(); resolve({ shots: n - count }); };
    el.querySelector('.cam-x').onclick = close;
    el.querySelector('.cam-done').onclick = close;
  });
}

export const cameraTitle = (t) => esc(t);
