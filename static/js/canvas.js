// Handwriting pad, built to feel like GoodNotes / Samsung Notes:
// - ink: every stroke is a filled outline whose width follows pen pressure
//   (tapered ends, light anti-jitter smoothing). The stroke being written is
//   drawn on its own low-latency "wet" layer, with the browser's predicted
//   points when available, so the line keeps up with the pen tip; finished
//   strokes are cached as Path2D shapes so zooming and panning stay smooth.
// - the paper is endless like 無邊記 (Freeform): it goes on in every direction;
//   W is only the "starting width" that fits the screen at 100%. It is seen through a viewport:
//   pinch / two fingers zoom and move it (GPU transform while moving, one
//   sharp repaint when the fingers lift, then momentum); ctrl / trackpad
//   wheel zooms, the mouse wheel scrolls.
// - palm rejection: once a stylus is seen, a single finger or a resting hand
//   does nothing; touches are ignored while the pen writes; it takes two
//   fingers to move the paper.
// - pens, highlighter, stroke eraser (S Pen side button / pen eraser end too),
//   pages for corrections, undo/redo per page, two-finger tap = undo.
// The browser never scrolls, selects or zooms on the paper itself (Chrome on
// Android applies "pan" to the S Pen and iPad Safari selects text otherwise).
// Strokes are vectors in page coordinates: rotation and zoom never lose or blur
// writing, and the image sent to the AI is redrawn crisp.

const ERASER_R = 16; // screen px
export const PENS = {
  black: { color: '#1C1E21' }, blue: { color: '#2F5BEA' }, red: { color: '#C92A2A' },
  marker: { color: 'rgba(255, 196, 0, 0.38)', marker: true },
};

export class Pad {
  constructor(host, { grid = true } = {}) {
    this.host = host;
    host._pad = this; // lets tests and devtools inspect the strokes
    this.grid = grid;
    this.tool = 'pen';          // pen | marker | eraser | lasso | hand (移動: one finger or the pen drags the paper)
    this.pen = 'black';
    this.color = PENS.black.color;
    this.penType = 'fountain';  // fountain: width follows pressure / ball: even width
    this.size = 3;              // pen width on screen (px)
    this.hlColor = PENS.marker.color;
    this.hlSize = 16;
    this.eraserSize = 16;       // eraser radius on screen (px)
    this.eraserMode = 'stroke'; // stroke: whole strokes / partial: only what it touches
    this.paper = 'grid';        // grid | lines | dots | blank
    this.selection = null;      // lasso: {items, bb}
    this.onselect = null;
    this.penOnly = (() => { try { return localStorage.getItem('penOnly') === '1'; } catch { return false; } })();
    this.fingerWrite = (() => { try { return localStorage.getItem('fingerWrite') === '1'; } catch { return false; } })();
    this.onfingertry = null; // one finger tried to write while only the pen writes (the page can offer to change that)
    this.readOnly = false; // mirroring another device's writing
    this.onchange = null; // strokes changed (finished stroke, erase, undo, page)
    this.onpen = null;    // first stylus contact
    this.onview = null;   // zoom / page changed (for the toolbar)
    this.onundo = null;   // a two-finger tap undid something (so the page can offer 取消)
    this.onlasso = null;  // (poly) => true when the page used the circled area itself (圈起來問 AI)
    // two-finger tap = undo is opt-in: a resting hand or iPadOS cancelling touches when the
    // Pencil lands must never erase writing
    this.tapUndo = (() => { try { return localStorage.getItem('tapUndo') === '1'; } catch { return false; } })();
    host.classList.add('pad-viewport');
    this.bg = document.createElement('canvas');
    this.ink = document.createElement('canvas');
    this.wet = document.createElement('canvas'); // the stroke being written
    // the paper (grid / lines / dots) is a CSS background the browser draws, not a canvas
    // repainted every frame: on a 3× phone screen that alone was half the cost of a pinch
    this.paperEl = document.createElement('div');
    this.paperEl.className = 'pad-paper';
    host.appendChild(this.paperEl);
    this.bg.style.display = 'none';
    for (const c of [this.bg, this.ink, this.wet]) { c.className = 'pad-layer'; host.appendChild(c); }
    this.wet.style.pointerEvents = 'none';
    // a plain context: "desynchronized" (low-latency) canvases lose their transparency on some
    // Android GPUs (Galaxy Tab S7 FE) and the whole paper turns black
    this.wetCtx = this.wet.getContext('2d');
    this.vw = Math.max(200, host.clientWidth);
    this.vh = Math.max(200, host.clientHeight);
    this.W = Math.max(320, this.vw);
    this.pages = [{ strokes: [], hist: [], redo: [], H: Math.max(900, Math.round(this.vh * 1.6)) }];
    this.page = 0;
    this.zoom = 1;          // 1 = page width fills the viewport
    this.ox = 0; this.oy = 0; // page coordinates at the viewport's top-left
    this.sizeCanvas();
    this.bind();
    this._ro = new ResizeObserver(() => {
      const w = Math.max(200, host.clientWidth), h = Math.max(200, host.clientHeight);
      if (w !== this.vw || h !== this.vh) { this.vw = w; this.vh = h; this.sizeCanvas(); }
    });
    this._ro.observe(host);
  }

  destroy() {
    this._ro.disconnect();
    for (const [t, ev, fn, opt] of this._globals || []) t.removeEventListener(ev, fn, opt);
    this._globals = [];
    clearTimeout(this._snapT);
    for (const c of [this.bg, this.ink, this.wet, ...(this._snapLv || []).map((l) => l.c)]) { c.width = 0; c.height = 0; } // let the GPU memory go now
  }

  // --- page state ---------------------------------------------------------
  get cur() { return this.pages[this.page]; }
  get strokes() { return this.cur.strokes; }
  set strokes(v) { this.cur.strokes = v; }
  get H() { return this.cur.H; }
  set H(v) { this.cur.H = v; }
  get z() { return (this.vw / this.W) * this.zoom; }

  setPenOnly(v) {
    this.penOnly = v;
    try { localStorage.setItem('penOnly', v ? '1' : '0'); } catch { /* private mode */ }
  }

  // she chose to write with fingers too: the pen no longer switches fingers to "move only"
  setFingerWrite(v) {
    this.fingerWrite = v;
    try { localStorage.setItem('fingerWrite', v ? '1' : '0'); } catch { /* private mode */ }
    this.setPenOnly(!v);
  }

  get eraser() { return this.tool === 'eraser'; }
  set eraser(v) { if (v) this.setTool('eraser'); else if (this.tool === 'eraser') this.setTool('pen'); }

  setTool(t) {
    if (t !== 'lasso') this.clearSelection();
    this.tool = t;
    this.host.classList.toggle('hand', t === 'hand');
  }

  setPen(name) {
    const p = PENS[name];
    if (p.marker) { this.setTool('marker'); return; }
    this.pen = name;
    this.color = p.color;
    this.setTool('pen');
  }

  // --- viewport -----------------------------------------------------------
  sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.ink, this.wet]) {
      c.width = Math.round(this.vw * dpr);
      c.height = Math.round(this.vh * dpr);
      c.style.width = this.vw + 'px';
      c.style.height = this.vh + 'px';
    }
    this.dpr = dpr;
    this.clamp();
    this.render();
  }

  // the paper is endless in every direction: nothing to clamp, only keep it finite
  clamp() {
    const lim = 50000;
    this.ox = Math.min(lim, Math.max(-lim, this.ox || 0));
    this.oy = Math.min(lim, Math.max(-lim, this.oy || 0));
    const bottom = this.oy + this.vh / this.z;
    if (bottom > this.H) this.H = Math.min(lim, bottom + 600); // H: how far down there is paper (for older code paths)
  }

  // during a gesture: use the overview when it is sharp enough here, or when drawing the
  // strokes themselves would miss frames
  _snapUse() {
    const s = this._snapOk() && this._snap;
    if (!s) return false;
    return s.empty || s.k >= this.z * this.dpr * 0.8 || this.costHere() > 10;
  }

  onScreen(s) {
    if (s._live) return true;
    const b = strokeBox(s);
    return !(b[2] < this.ox || b[0] > this.ox + this.vw / this.z || b[3] < this.oy || b[1] > this.oy + this.vh / this.z);
  }

  // about how many ms drawing the strokes on screen right now takes (from earlier paints)
  costHere() {
    let n = 0;
    for (const s of this.strokes) if (this.onScreen(s)) n++;
    return n * (this._msPer || 0.01);
  }

  view(c) { const k = this.dpr * this.z; c.setTransform(k, 0, 0, k, -this.ox * k, -this.oy * k); }
  _painted() { this._lz = this.z; this._lox = this.ox; this._loy = this.oy; }

  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.paint(); });
  }

  // something on the page changed: the overview picture is rebuilt when the hand rests
  _changed() {
    this._ver = (this._ver || 0) + 1;
    clearTimeout(this._snapT);
    this._snapT = setTimeout(() => this._idleSnap(), 700);
    this.onchange && this.onchange();
  }

  _idleSnap() {
    if (this.strokes.some((x) => x._live) && (this._snapWait = (this._snapWait || 0) + 1) < 8) { this._snapT = setTimeout(() => this._idleSnap(), 700); return; } // still writing
    this._snapWait = 0;
    if (!this._snapOk()) this.buildSnap();
  }

  _snapKey() { return `${this.page}|${this.strokes.length}|${this._ver || 0}|${this.W}`; }
  _snapOk() { return this._snap && this._snap.key === this._snapKey(); }

  // The overview: all the ink of this page in one picture (up to ~8M pixels). While the
  // fingers move a full page around, one drawImage per frame replaces repainting
  // thousands of strokes — zooming out over a page full of writing stays smooth.
  buildSnap() {
    const key = this._snapKey();
    const st = this.strokes.filter((x) => !x._live);
    if (!st.length) { this._snap = { key, empty: true }; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of st) { const b = strokeBox(x); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const k = Math.min(this.dpr * 2, Math.sqrt(8e6 / (w * h)), 4096 / Math.max(w, h));
    // levels at full, ½, ¼… resolution: each frame copies the one closest to the screen's
    // scale (a near 1:1 copy is cheap and stays crisp; shrinking a huge picture is not)
    const old = this._snapLv || [];
    const levels = [];
    for (let i = 0, lk = k; i < 6; i++, lk /= 2) {
      const c = old[i]?.c || document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w * lk)); c.height = Math.max(1, Math.ceil(h * lk));
      const g = c.getContext('2d');
      if (!i) { g.setTransform(lk, 0, 0, lk, -x0 * lk, -y0 * lk); for (const x of st) this.drawStroke(x, g); }
      else { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(levels[i - 1].c, 0, 0, c.width, c.height); }
      levels.push({ c, k: lk });
      if (c.width < 256 && c.height < 256) break;
    }
    for (const l of old.slice(levels.length)) { l.c.width = 0; l.c.height = 0; }
    this._snapLv = levels;
    this._snap = { key, x0, y0, k, levels };
  }

  // fast: draw the ink from the overview picture (while a gesture moves the paper)
  // the paper pattern at the current view (squares every 32 page px; fewer when zoomed far out)
  paperCss() {
    const st = this.paperEl.style;
    const kind = this.grid ? this.paper : 'blank';
    if (kind === 'blank') { if (st.backgroundImage !== 'none') st.backgroundImage = 'none'; return; }
    const z = this.z, step = (z < 0.3 ? 128 : z < 0.5 ? 64 : 32) * z;
    const ox = -((this.ox * z) % step), oy = -((this.oy * z) % step);
    const L = '#E3EAF6';
    const img = kind === 'dots' ? 'radial-gradient(circle, #B9C4D6 1.6px, transparent 2px)'
      : kind === 'lines' ? `linear-gradient(to bottom, ${L} 1px, transparent 1px)`
      : `linear-gradient(to right, ${L} 1px, transparent 1px), linear-gradient(to bottom, ${L} 1px, transparent 1px)`;
    if (this._paperImg !== img) { st.backgroundImage = img; this._paperImg = img; }
    st.backgroundSize = `${step}px ${step}px`;
    const half = kind === 'dots' ? step / 2 : 0;
    st.backgroundPosition = `${ox - half}px ${oy - half}px`;
  }

  paint(quiet = false, fast = false) {
    const t0 = performance.now();
    this.paperCss();
    if (this.ink.style.transform) this.ink.style.transform = '';
    const c = this.ink.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.ink.width, this.ink.height);
    this.view(c);
    const snap = fast && this._snap;
    if (snap && !snap.empty) {
      const want = this.z * this.dpr;
      let lv = snap.levels[0];
      for (const l of snap.levels) if (l.k >= want * 0.9) lv = l;
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'low';
      c.drawImage(lv.c, snap.x0, snap.y0, lv.c.width / lv.k, lv.c.height / lv.k);
    } else if (!snap) {
      // only what is on screen (a zoomed-in view of a full page draws a few strokes, not all)
      let n = 0;
      for (const s of this.strokes) if (this.onScreen(s)) { this.drawStroke(s, c); n++; }
      this._drawn = n;
    }
    this.drawSelection();
    this._painted();
    // how long a full repaint takes here (smoothed): gestures repaint live when it is cheap
    const ms = performance.now() - t0;
    if (!fast) {
      this._paintMs = this._paintMs == null ? ms : this._paintMs * 0.7 + ms * 0.3;
      if (this._drawn > 30) { const per = ms / this._drawn; this._msPer = this._msPer ? this._msPer * 0.6 + per * 0.4 : per; }
    }
    if (!quiet) this.onview && this.onview();
  }

  // zoom to `zoom` keeping the page point under screen (sx, sy) in place
  setZoom(zoom, sx = this.vw / 2, sy = this.vh / 2) {
    const z0 = this.z;
    const px = this.ox + sx / z0, py = this.oy + sy / z0;
    this.zoom = Math.min(5, Math.max(0.25, zoom));
    const z = this.z;
    this.ox = px - sx / z;
    this.oy = py - sy / z;
    this.clamp();
    this.render();
  }

  zoomBy(k, sx, sy) { this.setZoom(this.zoom * k, sx, sy); }
  zoomStep(k) { this._settle && this._settle(); this.zoomBy(k); } // toolbar ＋／－
  // 回到原位: full page width, back at the top
  resetView() { this._settle && this._settle(); this.zoom = 1; this.ox = 0; this.oy = 0; this.clamp(); this.render(); }
  get moved() { return Math.abs(this.zoom - 1) > 0.01 || Math.abs(this.ox) > 1 || Math.abs(this.oy) > 1; }

  // 看全部筆跡: zoom out/in so everything written on this page fits the screen
  fitAll() {
    this._settle && this._settle();
    const st = this.strokes.filter((x) => !x.eraser);
    if (!st.length) { this.resetView(); return; }
    const [x0, y0, x1, y1] = bbox(st), m = 40;
    const z = Math.min(this.vw / (x1 - x0 + 2 * m), this.vh / (y1 - y0 + 2 * m));
    this.zoom = Math.min(5, Math.max(0.25, z / (this.vw / this.W)));
    const zz = this.z;
    this.ox = (x0 + x1) / 2 - this.vw / zz / 2;
    this.oy = (y0 + y1) / 2 - this.vh / zz / 2;
    this.clamp();
    this.render();
  }
  fitWidth() { this.zoom = 1; this.ox = 0; this.clamp(); this.render(); }
  panBy(dx, dy) { this.ox += dx / this.z; this.oy += dy / this.z; this.clamp(); this.render(); }
  extend() { this.H += 600; return true; } // the paper is endless; kept for older callers

  // --- pages --------------------------------------------------------------
  newPage() {
    if (this.readOnly) return;
    this.pages.push({ strokes: [], hist: [], redo: [], H: Math.max(900, Math.round(this.vh / this.z * 1.6)) });
    this.gotoPage(this.pages.length - 1);
  }

  gotoPage(i) {
    if (i < 0 || i >= this.pages.length || this.readOnly) return;
    this._settle && this._settle();
    this.clearSelection();
    this.page = i;
    this.ox = 0; this.oy = 0;
    this.clamp();
    this.render();
    this._changed();
  }

  // --- input ----------------------------------------------------------------
  bind() {
    const el = this.ink;
    el.style.touchAction = 'none';
    let cur = null, curId = null, curType = '', erasing = null, penUpAt = 0, predicted = [];
    let startPage = null;          // the page a stroke / erase / lasso began on
    let strokeAt = 0;              // when the current stroke started
    let lasso = null;              // {pts} while circling, {moving, from, total} while dragging a selection
    let hold = null;               // draw-and-hold: {x, y, t} of the last real movement
    const touches = new Map(); // finger gestures: id -> {x, y, px, py, sx, sy, t}
    let gesture = null;        // previous pinch distance / midpoint
    let tapCandidate = false, tapStart = 0, gestureEndAt = 0, penSeenAt = 0, pendingTap = false;
    let rect = this.host.getBoundingClientRect();
    const fresh = () => { rect = this.host.getBoundingClientRect(); }; // the frame, not a canvas that may be mid-transform

    const local = (e) => [e.clientX - rect.left, e.clientY - rect.top];
    const toPage = (e) => {
      const [sx, sy] = local(e);
      // only a stylus has real pressure (fingers report 0 or 1 on many devices)
      const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [this.ox + sx / this.z, this.oy + sy / this.z, p];
    };
    // a palm, not a fingertip: iPad Safari reports fingertips in coarse steps of 52 / 77 / 103 /
    // 129 / 155 px, so only a contact bigger than that is a hand resting on the glass
    // a palm: bigger than any fingertip (iPad Safari reports fingertips as 52…155 px), so two
    // fingers can always move and zoom
    const palm = (e) => Math.max(e.width || 0, e.height || 0) > 180 || (e.width || 0) * (e.height || 0) > 165 * 165;
    // a finger that would write: stricter — while the pen is in use (last 20 s) a contact wider
    // than a fingertip is the side of the hand, not a finger writing
    const palmWrite = (e) => palm(e) || (Date.now() - penSeenAt < 20000 && Math.max(e.width || 0, e.height || 0) > 110);
    // the pen is on or just above the glass (hover, writing, or lifted a moment ago): every touch
    // then is the hand holding it
    let penNearAt = 0;
    const penNear = () => Date.now() - penNearAt < 900;
    const track = (e) => ({ x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, sx: e.clientX, sy: e.clientY, t: Date.now(),
      w: Math.max(e.width || 0, e.height || 0) });

    // --- the wet layer: the current stroke, redrawn each frame (with prediction) ---
    let wetRaf = 0;
    const drawWet = () => {
      wetRaf = 0;
      const c = this.wetCtx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.wet.width, this.wet.height);
      if (!cur) return;
      this.view(c);
      this.drawStroke(predicted.length ? { ...cur, pts: cur.pts.concat(predicted), _path: null } : cur, c, true);
    };
    const wetFrame = () => { if (!wetRaf) wetRaf = requestAnimationFrame(drawWet); };
    const clearWet = () => {
      if (wetRaf) { cancelAnimationFrame(wetRaf); wetRaf = 0; }
      const c = this.wetCtx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.wet.width, this.wet.height);
    };

    // --- gestures: once per display frame the paper is redrawn at its new place. Zoomed in,
    // only the strokes on screen are drawn (cheap); zoomed out over a full page, the ink
    // comes from the overview picture (one image), so there are never blank edges or
    // a frozen picture. Sharp ink is repainted when the fingers lift. Then momentum.
    let live = null; // a gesture is moving the paper
    let vel = null, lastMove = 0, glide = 0, zoomed = false;
    // Every frame the paper (CSS) and the last ink picture (a GPU transform) follow the fingers
    // at once; the ink itself is repainted every frame while the device keeps up, else every
    // 2nd or 3rd frame (a slower phone keeps a smooth motion, the newly shown edge fills in a
    // moment later).
    const moveView = (fn) => {
      const now = performance.now();
      if (!live) {
        live = { at: now, slow: 0, n: 0 };
        if (this.strokes.length > 40 && !this._snapOk()) this.buildSnap(); // usually already built while resting
      }
      const keep = this.render;
      this.render = () => {}; // no extra repaint requests while moving
      try { fn(); } finally { this.render = keep; }
      const dt = now - live.at;
      live.at = now;
      if (live.n && dt > 24) live.slow = Math.min(6, live.slow + 1);
      else if (dt < 19) live.slow = Math.max(0, live.slow - 1);
      live.n++;
      const every = live.slow >= 4 ? 3 : live.slow >= 2 ? 2 : 1;
      if (live.n % every === 0 || this._lz == null) { this.paint(true, this._snapUse()); return; }
      this.paperCss();
      const k = this.z / this._lz, tx = (this._lox - this.ox) * this.z, ty = (this._loy - this.oy) * this.z;
      this.ink.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    };
    const settle = () => {
      if (!live) return;
      live = null;
      cancelAnimationFrame(this._raf); this._raf = 0;
      // sharp ink at the final place; a very full page zoomed far out keeps the overview
      // (it already has at least screen resolution there)
      const s = this._snapOk() && this._snap;
      this.paint(false, !!s && !s.empty && s.k >= this.z * this.dpr && this.costHere() > 12);
      fresh();
    };
    const stopGlide = () => { if (glide) { cancelAnimationFrame(glide); glide = 0; settle(); } };
    const startGlide = () => {
      if (zoomed || !vel || Date.now() - lastMove > 80 || Math.hypot(vel.x, vel.y) < 0.25) { zoomed = false; settle(); return; }
      let v = { ...vel }, t0 = performance.now();
      const step = (t) => {
        const dt = Math.min(32, t - t0); t0 = t;
        moveView(() => this.panBy(-v.x * dt, -v.y * dt));
        const f = Math.pow(0.94, dt / 16);
        v = { x: v.x * f, y: v.y * f };
        if (Math.hypot(v.x, v.y) < 0.03) { glide = 0; settle(); return; }
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    // Finger gestures, anchored: when the set of fingers changes we remember the page
    // point under them (and their distance); every move then puts that same point back
    // under the fingers at zoom × (distance ÷ start distance). Nothing accumulates, so
    // the paper stays glued to the fingers.
    const fingers = () => {
      const pts = [...touches.values()];
      if (!pts.length) return null;
      const two = pts.length >= 2;
      const [a, b] = two ? pts : [pts[0], pts[0]];
      return { two, d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2 - rect.left, my: (a.y + b.y) / 2 - rect.top };
    };
    const anchor = () => {
      if (gRaf) { cancelAnimationFrame(gRaf); gRaf = 0; }
      const f = fingers();
      gesture = f && { ...f, zoom: this.zoom, px: this.ox + f.mx / this.z, py: this.oy + f.my / this.z };
    };
    let gRaf = 0;
    const gestureStep = () => { if (!gRaf) gRaf = requestAnimationFrame(() => { gRaf = 0; gestureFrame(); }); };
    const gestureFrame = () => {
      const f = fingers();
      if (!f) return;
      if (!gesture || gesture.two !== f.two) { anchor(); return; }
      // fingers jitter a pixel or two: smooth the pinch distance a little
      // (only tiny wobbles are smoothed; real movement is followed exactly, so the paper
      // never lags behind the fingers)
      gesture.ds = gesture.ds == null || Math.abs(f.d - gesture.ds) > 3 ? f.d : gesture.ds * 0.5 + f.d * 0.5;
      f.d = gesture.ds;
      const now = Date.now();
      // glide speed from the last 80 ms of the midpoint (single events jitter: the two
      // fingers report one after the other); a pinch that zoomed never glides
      const hist = (gesture.hist ||= []);
      hist.push([now, f.mx, f.my]);
      while (hist.length > 2 && now - hist[0][0] > 80) hist.shift();
      const [t0, x0, y0] = hist[0], span = Math.max(16, now - t0);
      vel = { x: (f.mx - x0) / span, y: (f.my - y0) / span };
      lastMove = now;
      moveView(() => {
        if (f.two && gesture.d > 10) {
          this.zoom = Math.min(5, Math.max(0.25, gesture.zoom * f.d / gesture.d));
          if (Math.abs(this.zoom - gesture.zoom) > 0.02) zoomed = true;
        }
        const z = this.z;
        this.ox = gesture.px - f.mx / z;
        this.oy = gesture.py - f.my / z;
        this.clamp();
      });
    };

    const startTouchGesture = (e) => {
      stopGlide();
      fresh();
      touches.set(e.pointerId, track(e));
      vel = null;
      if (touches.size === 1) zoomed = false;
      anchor();
      // a real two-finger tap: two fingertip-sized touches landing together (≤150 ms apart),
      // not right after a zoom/pan and not while the pen is being used
      const ts = [...touches.values()];
      tapCandidate = this.tapUndo && touches.size === 2 && Math.abs(ts[0].t - ts[1].t) < 150
        && Date.now() - gestureEndAt > 600 && Date.now() - penSeenAt > 1000 && ts.every((t) => t.w < 60);
      pendingTap = false;
      tapStart = Date.now();
      try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
    };

    const startStroke = (e) => {
      stopGlide();
      fresh();
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      curId = e.pointerId;
      curType = e.pointerType;
      strokeAt = Date.now();
      startPage = this.cur;
      // S Pen side button / Surface eraser end = erase while held (a right-button mouse too)
      const side = sideButton(e);
      const p0 = toPage(e);
      if (this.tool === 'lasso' && !side) {
        const sel = this.selection;
        if (sel && p0[0] >= sel.bb[0] && p0[0] <= sel.bb[2] && p0[1] >= sel.bb[1] && p0[1] <= sel.bb[3]) lasso = { moving: true, from: p0, total: [0, 0], items: sel.items };
        else { this.clearSelection(); lasso = { pts: [p0] }; }
        return;
      }
      if (this.tool === 'eraser' || side) {
        if (this.eraserMode === 'partial') {
          // rubs out only what it touches: an "erase" stroke painted over the ink
          cur = { color: '#000', size: (this.eraserSize * 2) / this.z, eraser: 2, pts: [p0], _live: true };
          this.strokes.push(cur);
          const c = this.ink.getContext('2d'); this.view(c); this.drawLine(cur, c);
          return;
        }
        erasing = []; this.eraseAt(p0, erasing); return;
      }
      const marker = this.tool === 'marker';
      const size = (marker ? this.hlSize : this.size) / this.z; // what she sees on screen, at any zoom
      cur = { color: marker ? this.hlColor : this.color, size, marker, type: this.penType, pts: [p0], _live: true };
      if (e.pointerType === 'touch') cur._touchAt = Date.now();  // a finger line (taken back if the pen lands right after)
      this.strokes.push(cur);
      predicted = [];
      hold = { x: p0[0], y: p0[1], t: Date.now() };
      wetFrame();
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.pointerType === 'touch') {
        // the first finger of a new touch: any finger still remembered lost its pointerup
        // somewhere (Safari sometimes drops it) — a stale one would freeze the next pinch
        if (e.isPrimary && touches.size) { touches.clear(); gesture = null; }
        // the hand holding the pen: never a line, never a move
        if ((cur && curType === 'pen') || penNear() || palm(e)) return;
        if (this.penOnly || this.readOnly) {
          // writing with a pen: the hand on the screen must never move the paper. It takes two
          // fingers to move or zoom (one finger alone does nothing), and they must land together:
          // a finger added to a hand already resting on the glass moves nothing
          if (touches.size === 1 && Date.now() - [...touches.values()][0].t > 400) return;
          startTouchGesture(e);
          return;
        }
        if (this.tool === 'hand' && !cur) { startTouchGesture(e); return; } // 移動: one finger drags, two zoom
        // finger writing: a second finger turns a just-started stroke into pinch / pan
        if (cur && curType === 'touch') {
          // the second finger of a pinch lands up to a few tenths of a second after the first,
          // which has already started a line: if it is that soon (or the line is still short),
          // the line is taken back and both fingers zoom
          const p0 = cur.pts[0], pl = cur.pts[cur.pts.length - 1];
          const len = p0 && pl ? Math.hypot(pl[0] - p0[0], pl[1] - p0[1]) * this.z : 0;
          if (Date.now() - strokeAt < 350 || len < 40) {
            const first = cur.pts[0];
            this.strokes.pop();
            clearWet();
            const t0 = { ...track(e), x: rect.left + (first[0] - this.ox) * this.z, y: rect.top + (first[1] - this.oy) * this.z };
            t0.px = t0.sx = t0.x; t0.py = t0.sy = t0.y;
            touches.set(curId, t0);
            cur = null; curId = null;
            startTouchGesture(e); // anchors on both fingers
          }
          return;
        }
        if (touches.size) { startTouchGesture(e); return; }
        if (palmWrite(e)) return;  // the side of the hand: no line
      }
      if (this.readOnly) return;
      if (e.pointerType === 'pen') {
        penSeenAt = penNearAt = Date.now(); tapCandidate = false;
        if (touches.size) { touches.clear(); gesture = null; settle(); }  // a hand moving the paper as the pen lands: stop
        // marks the hand made just before the pen came down are the palm, not writing: take them back
        const now = Date.now(), palmy = this.strokes.filter((s) => s._touchAt && now - s._touchAt < 1500 && s !== cur);
        if (palmy.length) {
          this.strokes = this.strokes.filter((s) => !palmy.includes(s));
          this.cur.hist = this.cur.hist.filter((op) => !(op.t === 'add' && palmy.includes(op.s)));
          this.render(); this._changed();
        }
      }
      if (e.pointerType === 'pen' && !this.penOnly && !this.fingerWrite) {
        // first stylus touch: from now on fingers and palms only move the paper (two fingers)
        this.setPenOnly(true);
        if (cur && curType === 'touch') { this.strokes.pop(); cur = null; curId = null; clearWet(); }
        this.onpen && this.onpen();
      }
      if ((cur || erasing || lasso) && e.pointerId !== curId && !el.hasPointerCapture(curId)) {
        end({ pointerId: curId, type: 'pointerup' }); // the last stroke never got its pointerup: finish it
      }
      if (cur || erasing || lasso) return; // one stroke at a time
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      if (this.tool === 'hand') { startTouchGesture(e); return; } // the pen / mouse drags the paper too
      if (touches.size) { touches.clear(); gesture = null; settle(); } // the pen wins over fingers
      startStroke(e);
    });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen') penNearAt = Date.now();  // hovering counts (Apple Pencil hover, S Pen)
      const t = touches.get(e.pointerId);
      if (t && penNear()) { gesture = null; return; }  // the pen came near: the hand stops moving the paper
      if (t) {
        t.x = e.clientX; t.y = e.clientY;
        if (Math.hypot(t.x - t.sx, t.y - t.sy) > 6) tapCandidate = false;
        if ((this.penOnly || this.readOnly) && touches.size < 2 && this.tool !== 'hand') { // one finger alone: nothing
          gesture = null;
          if (!this.readOnly && !t.told && Math.hypot(t.x - t.sx, t.y - t.sy) > 30) { t.told = true; this.onfingertry && this.onfingertry(); }
          return;
        }
        gestureStep();
        return;
      }
      // Galaxy Tab (S Pen) side button: Chrome reports it as the pen moving with a button held and
      // no pressure, without any pointerdown — erase under the pen tip while it is held
      if (e.pointerType === 'pen' && !cur && !erasing && !lasso && !this.readOnly) {
        if ((e.buttons & 1) && !e.pressure) {
          const evs0 = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
          if (!this._sideErase) this._sideErase = [];
          for (const ev of (evs0.length ? evs0 : [e])) this.eraseAt(toPage(ev), this._sideErase);
          this._eraserRing(e);
          return;
        }
        if (this._sideErase) this._endSideErase();
      }
      if (e.pointerId !== curId) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const list = evs.length ? evs : [e];
      if (erasing) { for (const ev of list) this.eraseAt(toPage(ev), erasing); return; }
      if (lasso) {
        const p = toPage(e);
        if (lasso.moving) {
          const dx = p[0] - lasso.from[0], dy = p[1] - lasso.from[1];
          lasso.from = p; lasso.total[0] += dx; lasso.total[1] += dy;
          this.moveItems(lasso.items, dx, dy);
          if (this.selection) this.selection.bb = bbox(lasso.items);
          this.render();
        } else {
          lasso.pts.push(p);
          const c = this.wetCtx;
          c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.wet.width, this.wet.height);
          this.view(c);
          c.setLineDash([6 / this.z, 5 / this.z]); c.lineWidth = 1.5 / this.z; c.strokeStyle = '#2F5BEA';
          c.beginPath(); lasso.pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.stroke();
          c.setLineDash([]);
        }
        return;
      }
      if (!cur) return;
      // the side button pressed in the middle of a line: the line so far stays, the rest erases
      if (!cur.eraser && sideButton(e)) {
        end({ pointerId: e.pointerId, type: 'pointerup' });
        startStroke(e);
        return;
      }
      if (cur.eraser === 2) {
        const c = this.ink.getContext('2d'); this.view(c);
        for (const ev of list) cur.pts.push(toPage(ev));
        this.drawLine({ ...cur, pts: cur.pts.slice(-3) }, c);
        return;
      }
      if (cur.straight) { // draw-and-hold made it a straight line: the end follows the pen
        const p = toPage(list[list.length - 1]);
        cur.pts = straight(cur.pts[0], p, cur.pts[1][2]);
        cur._path = null;
        wetFrame();
        return;
      }
      const minD = 0.4 / this.z;
      for (const ev of list) {
        const p = toPage(ev);
        const last = cur.pts[cur.pts.length - 1];
        if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < minD) { last[2] = Math.max(last[2], p[2]); continue; }
        cur.pts.push(p);
      }
      // where the pen is about to be (Chrome / Android): drawn now, replaced next frame
      predicted = e.getPredictedEvents ? e.getPredictedEvents().slice(0, 2).map(toPage) : [];
      wetFrame();
      // draw and hold: keep the pen still for half a second at the end → a straight line
      const lp = cur.pts[cur.pts.length - 1];
      if (Math.hypot(lp[0] - hold.x, lp[1] - hold.y) > 4 / this.z) {
        hold = { x: lp[0], y: lp[1], t: Date.now() };
        clearTimeout(this._holdT);
        const mine = cur;
        this._holdT = setTimeout(() => {
          if (cur !== mine || mine.pts.length < 6) return;
          const a = mine.pts[0], b = mine.pts[mine.pts.length - 1];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 24 / this.z) return;
          // only a nearly straight stroke (not a "2" or an "S" paused half-way)
          const off = Math.max(...mine.pts.map((q) => Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) / len));
          if (off > len * 0.15) return;
          mine.straight = true;
          mine._path = null;
          mine.pts = straight(a, b, mine.pts.reduce((x, q) => x + q[2], 0) / mine.pts.length);
          predicted = [];
          wetFrame();
        }, 500);
      }
      if (cur.pts[cur.pts.length - 1][1] > this.H - 80) this.extend();
    });

    const end = (e) => {
      if (touches.has(e.pointerId)) {
        // only fingers actually lifted (pointerup) can make a tap: iPadOS *cancels* resting-hand
        // touches when the Pencil lands, and that must never undo anything
        const lifted = e.type === 'pointerup';
        if (!lifted) { tapCandidate = false; pendingTap = false; }
        if (lifted && tapCandidate && touches.size === 2 && Date.now() - tapStart < 300) pendingTap = true; // first finger up
        const quick = lifted && pendingTap && touches.size === 1 && Date.now() - tapStart < 300; // …and the second
        touches.delete(e.pointerId);
        anchor(); // the remaining finger(s) carry on from here
        if (!touches.size) {
          gestureEndAt = Date.now();
          if (quick) settle(); else startGlide();
        }
        if (quick) {
          pendingTap = false;
          tapCandidate = false;
          const op = this.cur.hist[this.cur.hist.length - 1];
          this.undo(); // two-finger tap = undo
          if (op) this.onundo && this.onundo();
        }
        return;
      }
      if (e.pointerId !== curId) return;
      if (curType === 'pen') penUpAt = penNearAt = Date.now();
      clearTimeout(this._holdT);
      if (lasso) {
        const l = lasso;
        lasso = null; curId = null;
        if (l.moving) {
          if (l.total[0] || l.total[1]) { startPage.hist.push({ t: 'move', items: l.items, dx: l.total[0], dy: l.total[1] }); startPage.redo = []; this._changed(); }
          return;
        }
        const poly = l.pts;
        if (this.onlasso && poly.length > 2 && this.onlasso(poly) === true) { this.drawSelection(); return; } // 圈起來問 AI took it
        const items = poly.length > 2 ? this.strokes.filter((st) => !st.eraser && (st.pic
          ? inside([(st.pts[0][0] + st.pts[1][0]) / 2, (st.pts[0][1] + st.pts[1][1]) / 2], poly)  // a picture: circle its middle
          : st.pts.filter((q) => inside(q, poly)).length >= st.pts.length * 0.6)) : [];
        this.selection = items.length ? { items, bb: bbox(items) } : null;
        this.drawSelection();
        this.onselect && this.onselect(this.selection);
        return;
      }
      if (erasing) {
        if (erasing.length) { startPage.hist.push({ t: 'erase', items: erasing }); startPage.redo = []; this._changed(); }
        erasing = null; curId = null;
        return;
      }
      if (cur && cur.eraser === 2) {
        delete cur._live; cur._bb = null;
        startPage.hist.push({ t: 'add', s: cur });
        startPage.redo = [];
        cur = null; curId = null;
        this._changed();
        return;
      }
      if (cur) {
        const s = cur;
        cur = null; curId = null; predicted = [];
        delete s._live;
        s._path = null; s._bb = null; // built from all the points, now that it is finished
        clearWet();
        if (startPage === this.cur) {
          // the finished stroke goes onto the ink layer as one clean shape
          const c = this.ink.getContext('2d');
          this.view(c);
          this.drawStroke(s, c);
          c.globalCompositeOperation = 'source-over';
        }
        startPage.hist.push({ t: 'add', s });
        startPage.redo = [];
        this._changed();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); penReport(e, 'contextmenu'); }); // S Pen button / long press
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen' && this._sideErase) this._endSideErase(); });
    // diagnostics only (see penReport): what every pointer and key does on the paper
    for (const ev of ['pointerdown', 'pointerup', 'pointercancel', 'auxclick']) el.addEventListener(ev, (e) => penReport(e, ev.replace('pointer', '')), { capture: true });
    el.addEventListener('pointermove', (e) => penReport(e, 'move'), { capture: true });
    if (!window.__penKeys) { window.__penKeys = true; window.addEventListener('keydown', (e) => penReport(e, 'key'), { capture: true }); }
    // iPad Safari still scrolls, selects text and shows the magnifier for Apple Pencil
    // unless the touch events themselves are cancelled (touch-action alone is not enough)
    for (const t of ['touchstart', 'touchmove', 'touchend']) el.addEventListener(t, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    for (const g of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(g, (e) => e.preventDefault(), { passive: false });
    const noPageZoom = (e) => e.preventDefault();
    this._globals = [[window, 'scroll', fresh, { passive: true }],
      ...['gesturestart', 'gesturechange'].map((g) => [document, g, noPageZoom, { passive: false }])];
    for (const [t, ev, fn, opt] of this._globals) t.addEventListener(ev, fn, opt);
    // toolbar zoom / reset / page change while a glide or wheel is still moving the picture
    this._settle = () => { stopGlide(); clearTimeout(this._wheelT); settle(); };

    // mouse wheel scrolls; ctrl+wheel (and trackpad pinch on a Mac) zooms
    // trackpads send many wheel events per frame: add them up, apply once per frame
    let wheel = null, wRaf = 0;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!wheel) { fresh(); wheel = { zoom: 1, dx: 0, dy: 0 }; }
      [wheel.sx, wheel.sy] = local(e);
      if (e.ctrlKey || e.metaKey) wheel.zoom *= Math.exp(-e.deltaY / 300);
      else { wheel.dx += e.deltaX; wheel.dy += e.deltaY; }
      if (!wRaf) wRaf = requestAnimationFrame(() => {
        wRaf = 0;
        const w = wheel; wheel = null;
        if (!w) return;
        moveView(() => { if (w.zoom !== 1) this.zoomBy(w.zoom, w.sx, w.sy); if (w.dx || w.dy) this.panBy(w.dx, w.dy); });
      });
      clearTimeout(this._wheelT);
      this._wheelT = setTimeout(settle, 140);
    }, { passive: false });
  }

  // stroke eraser: anything the eraser touches → that whole stroke is removed
  eraseAt(p, removed) {
    const r = (this.eraserSize || ERASER_R) / this.z;
    let hit = false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      const pad = r + s.size / 2;
      if (!s._bb) {
        const xs = s.pts.map((q) => q[0]), ys = s.pts.map((q) => q[1]);
        s._bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
      const [a, b, c2, d] = s._bb;
      if (p[0] < a - pad || p[0] > c2 + pad || p[1] < b - pad || p[1] > d + pad) continue;
      if (s.eraser || s.pic) continue; // a rubbed-out patch / the copied figure is not a stroke to pick up
      if (s.pts.some((q, j) => segDist(p, j ? s.pts[j - 1] : q, q) <= pad)) {
        removed.push([i, s]);
        this.strokes.splice(i, 1);
        hit = true;
      }
    }
    if (hit) { this.clearSelection(); this.render(); }
  }

  // the side-button eraser let go: one undo step for everything it rubbed out
  _endSideErase() {
    const items = this._sideErase;
    this._sideErase = null;
    this.drawSelection();  // clears the ring (and redraws a selection, if any)
    if (items && items.length) { this.cur.hist.push({ t: 'erase', items }); this.cur.redo = []; this._changed(); }
  }

  // where the side-button eraser is (it works without touching, so she needs to see it)
  _eraserRing(e) {
    const c = this.wetCtx, r = this.host.getBoundingClientRect();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.wet.width, this.wet.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.beginPath();
    c.arc(e.clientX - r.left, e.clientY - r.top, this.eraserSize || ERASER_R, 0, Math.PI * 2);
    c.fillStyle = 'rgba(229,72,77,.12)'; c.fill();
    c.lineWidth = 1.5; c.strokeStyle = '#E5484D'; c.stroke();
  }

  // --- ink ---------------------------------------------------------------------
  // Pressure-shaped ink: the stroke's outline (left and right edges offset by a
  // width that follows pressure, tapering at both ends), filled as one shape.
  drawStroke(s, c, wet = false) {
    const p = s.pts;
    if (!p.length) return;
    if (s.pic) { this.drawPic(s, c); return; }
    if (s.marker || s.eraser) { this.drawLine(s, c); return; }
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = s.color;
    if (!s._path || wet || s._live) { // a stroke still being written is never cached
      const shape = inkPath(p, s.size, s.type === 'ball' ? 0.25 : 1);
      if (wet || s._live) { c.fill(shape[0]); c.fill(shape[1]); return; }
      s._path = shape;
    }
    c.fill(s._path[0]); // outline and round ends filled separately (no holes where they overlap)
    c.fill(s._path[1]);
  }

  // a picture on the paper (the question's figure copied over): pts are its two corners
  drawPic(s, c) {
    if (!s._img) {
      s._img = new Image();
      s._img.onload = () => { this._ver = (this._ver || 0) + 1; this.render(); this._snapT = setTimeout(() => this._idleSnap(), 50); };
      s._img.src = s.pic;
    }
    if (!s._img.complete || !s._img.naturalWidth) return;
    const [[x0, y0], [x1, y1]] = s.pts;
    c.globalCompositeOperation = 'source-over';
    c.drawImage(s._img, x0, y0, x1 - x0, y1 - y0);
  }

  // put a picture on the paper, under the writing, near the top-left of what is on screen;
  // w×h is its size in screen px (it keeps that size on screen at the current zoom)
  addPicture(src, w, h) {
    if (this.readOnly) return null;
    const maxW = Math.min(this.vw * 0.8, 560) / this.z;
    let pw = w / this.z, ph = h / this.z;
    if (pw > maxW) { ph *= maxW / pw; pw = maxW; }
    const x0 = this.ox + 24 / this.z, y0 = this.oy + 24 / this.z;
    const s = { pic: src, color: '', size: 0, pts: [[x0, y0, 0.5], [x0 + pw, y0 + ph, 0.5]] };
    this.strokes.unshift(s);  // under everything she writes
    this.cur.hist.push({ t: 'add', s });
    this.cur.redo = [];
    this.H = Math.max(this.H, y0 + ph + 300);
    this.clearSelection();
    this.render();
    this._changed();
    return s;
  }

  // highlighter (and old pixel-eraser strokes): an even-width line
  drawLine(s, c) {
    const p = s.pts, n = p.length;
    c.globalCompositeOperation = s.eraser ? 'destination-out' : s.marker ? 'multiply' : 'source-over';
    c.strokeStyle = c.fillStyle = s.color;
    c.lineCap = c.lineJoin = 'round';
    c.lineWidth = s.eraser === 2 ? s.size : s.eraser ? s.size * 6 : s.size;
    c.beginPath();
    c.moveTo(p[0][0], p[0][1]);
    if (n === 1) c.lineTo(p[0][0] + 0.01, p[0][1]);
    for (let i = 1; i < n - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    if (n > 1) c.lineTo(p[n - 1][0], p[n - 1][1]);
    c.stroke();
    c.globalCompositeOperation = 'source-over';
  }

  redraw() { this.render(); }

  // --- history ------------------------------------------------------------------
  undo() {
    const op = this.cur.hist.pop();
    if (!op) return;
    if (this.readOnly) { this.cur.hist.push(op); return; }
    if (op.t === 'add') { const i = this.strokes.lastIndexOf(op.s); if (i >= 0) this.strokes.splice(i, 1); }
    else if (op.t === 'erase') for (const [i, s] of [...op.items].reverse()) this.strokes.splice(i, 0, s);
    else if (op.t === 'clear') this.strokes = op.items.slice();
    else if (op.t === 'move') this.moveItems(op.items, -op.dx, -op.dy);
    else if (op.t === 'addmany') this.strokes = this.strokes.filter((x) => !op.items.includes(x));
    else if (op.t === 'recolor') op.items.forEach((x, i) => { x.color = op.from[i]; x._path = null; });
    this.clearSelection();
    this.cur.redo.push(op);
    this.render();
    this._changed();
  }

  redo() {
    if (this.readOnly) return;
    const op = this.cur.redo.pop();
    if (!op) return;
    if (op.t === 'add') { if (op.s.pic) this.strokes.unshift(op.s); else this.strokes.push(op.s); }
    else if (op.t === 'erase') for (const [, s] of op.items) { const i = this.strokes.indexOf(s); if (i >= 0) this.strokes.splice(i, 1); }
    else if (op.t === 'clear') this.strokes = [];
    else if (op.t === 'move') this.moveItems(op.items, op.dx, op.dy);
    else if (op.t === 'addmany') this.strokes.push(...op.items);
    else if (op.t === 'recolor') op.items.forEach((x) => { x.color = op.to; x._path = null; });
    this.clearSelection();
    this.cur.hist.push(op);
    this.render();
    this._changed();
  }

  clear() {
    if (!this.strokes.length || this.readOnly) return;
    this.cur.hist.push({ t: 'clear', items: this.strokes.slice() });
    this.cur.redo = [];
    this.strokes = [];
    this.render();
    this._changed();
  }

  // --- lasso selection ------------------------------------------------------------
  moveItems(items, dx, dy) {
    for (const st of items) { for (const q of st.pts) { q[0] += dx; q[1] += dy; } st._path = null; st._bb = null; }
    this._ver = (this._ver || 0) + 1;
  }

  drawSelection() {
    const c = this.wetCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.wet.width, this.wet.height);
    if (!this.selection) return;
    this.view(c);
    const [x0, y0, x1, y1] = this.selection.bb, m = 8 / this.z;
    c.setLineDash([6 / this.z, 5 / this.z]); c.lineWidth = 1.5 / this.z; c.strokeStyle = '#2F5BEA';
    c.strokeRect(x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m);
    c.setLineDash([]);
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.drawSelection();
    this.onselect && this.onselect(null);
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    const items = sel.items.map((st) => [this.strokes.indexOf(st), st]).filter(([i]) => i >= 0).sort((a, b) => b[0] - a[0]);
    for (const [i] of items) this.strokes.splice(i, 1);
    this.cur.hist.push({ t: 'erase', items }); // removal order (high → low), like the eraser
    this.cur.redo = [];
    this.clearSelection();
    this.render();
    this._changed();
  }

  duplicateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const d = 24 / this.z;
    const copies = sel.items.map((st) => ({ ...st, _path: null, _bb: null, pts: st.pts.map(([x, y, p]) => [x + d, y + d, p]) }));
    this.strokes.push(...copies);
    this.cur.hist.push({ t: 'addmany', items: copies });
    this.cur.redo = [];
    this.selection = { items: copies, bb: bbox(copies) };
    this.render();
    this._changed();
  }

  recolorSelection(color) {
    const sel = this.selection;
    if (!sel) return;
    const items = sel.items.filter((st) => !st.marker);
    this.cur.hist.push({ t: 'recolor', items, from: items.map((st) => st.color), to: color });
    this.cur.redo = [];
    items.forEach((st) => { st.color = color; st._path = null; });
    this.render();
    this._changed();
  }

  isEmpty() { return !this.strokes.some((s) => !s.eraser && !s.marker && !s.pic); }

  // --- sync with another device --------------------------------------------------
  exportStrokes() {
    const r = (n, d) => Math.round(n * d) / d;
    return this.strokes.map((s) => ({ color: s.color, size: r(s.size, 100), eraser: s.eraser || 0, marker: !!s.marker, type: s.type || '',
      ...(s.pic ? { pic: s.pic } : {}),
      pts: s.pts.map(([x, y, p]) => [r(x, 10), r(y, 10), r(p, 100)]) }));
  }

  // the other device's page drawn at this page's width
  setStrokes(strokes, srcW, page = this.page) {
    this.clearSelection();
    const k = srcW ? this.W / srcW : 1;
    const pg = this.pages[page] || this.cur;
    pg.strokes = (strokes || []).map((s) => ({ ...s, size: s.size * k, pts: s.pts.map(([x, y, p]) => [x * k, y * k, p]) }));
    pg.hist = []; pg.redo = [];
    const maxY = Math.max(0, ...this.strokes.flatMap((s) => s.pts.map((q) => q[1])));
    this.H = Math.max(this.H, maxY + 300);
    this._ver = (this._ver || 0) + 1;
    this.render();
  }

  // --- export ------------------------------------------------------------------------
  // PNG of just the written area on white, redrawn from the strokes so it is
  // sharp at any zoom: long side between 900 and maxW pixels.
  async toBlob(maxW = 1600) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.strokes) {
      if (s.eraser) continue;
      for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    if (!isFinite(x0)) return null;
    const m = 24;
    x0 -= m; y0 -= m; x1 += m; y1 += m; // the paper is endless: export exactly what is written
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const long = Math.max(w, h);
    const scale = Math.min(maxW / long, Math.max(900 / long, 2), 4);
    const out = document.createElement('canvas');
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const ink = document.createElement('canvas');
    ink.width = out.width; ink.height = out.height;
    const ic = ink.getContext('2d');
    ic.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    for (const s of this.strokes) this.drawStroke(s, ic); // erasers punch through the ink only
    const c = out.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(ink, 0, 0);
    return new Promise((r) => out.toBlob(r, 'image/png'));
  }

  // what is on the paper inside a box (her writing and the copied figure), as a PNG data URL;
  // `poly` (the line she circled with) is drawn on it in red so the AI sees what she means
  async regionToDataURL(bb, poly = null, maxW = 1200) {
    const m = 16 / this.z;
    const x0 = bb[0] - m, y0 = bb[1] - m, w = Math.max(1, bb[2] - bb[0] + 2 * m), h = Math.max(1, bb[3] - bb[1] + 2 * m);
    const scale = Math.min(maxW / Math.max(w, h), 4, Math.max(2, 600 / Math.max(w, h)));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale)); out.height = Math.max(1, Math.round(h * scale));
    const ink = document.createElement('canvas');
    ink.width = out.width; ink.height = out.height;
    const ic = ink.getContext('2d');
    ic.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    for (const s of this.strokes) {
      const b = strokeBox(s);
      if (b[2] < x0 || b[0] > x0 + w || b[3] < y0 || b[1] > y0 + h) continue;
      this.drawStroke(s, ic);
    }
    if (poly && poly.length > 2) {
      ic.strokeStyle = '#E5484D'; ic.lineWidth = 2.5 / this.z; ic.setLineDash([8 / this.z, 6 / this.z]);
      ic.beginPath(); poly.forEach((q, i) => (i ? ic.lineTo(q[0], q[1]) : ic.moveTo(q[0], q[1]))); ic.closePath(); ic.stroke();
    }
    const c = out.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height);
    c.drawImage(ink, 0, 0);
    try { return out.toDataURL('image/png'); } catch { return null; }
  }

  async toDataURL(maxW = 1200) {
    const b = await this.toBlob(maxW);
    if (!b) return null;
    return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  }
}

// The outline of a pressure-sensitive stroke as Path2D shapes [outline, round ends] (page coordinates).
// Points are lightly smoothed (anti-jitter), widths follow pressure smoothly and
// taper over the first and last few samples, and the ends are rounded.
function inkPath(raw, size, sens = 1) {
  const n = raw.length;
  const path = new Path2D(), caps = new Path2D();
  const wOf = (p) => size * (1 + sens * 1.1 * (p - 0.5)); // pressure 0.5 → 1× size; sens 0 = even width
  if (n === 1) {
    caps.arc(raw[0][0], raw[0][1], wOf(raw[0][2]) / 2, 0, Math.PI * 2);
    return [path, caps];
  }
  // smoothing: a gentle low-pass on position, the last point kept exact
  const pts = [raw[0]];
  for (let i = 1; i < n; i++) {
    const q = pts[i - 1], p = raw[i];
    const k = i === n - 1 ? 1 : 0.62;
    pts.push([q[0] + (p[0] - q[0]) * k, q[1] + (p[1] - q[1]) * k, p[2]]);
  }
  // widths: smoothed pressure, tapered ends
  const ws = [];
  let w = wOf(pts[0][2]);
  const taper = Math.min(4, Math.floor(n / 3));
  for (let i = 0; i < n; i++) {
    w = w * 0.6 + wOf(pts[i][2]) * 0.4;
    let t = 1;
    if (taper) t = Math.min(1, 0.55 + 0.45 * Math.min(i, n - 1 - i) / taper);
    ws.push((w * t) / 2);
  }
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    left.push([pts[i][0] - dy * ws[i], pts[i][1] + dx * ws[i]]);
    right.push([pts[i][0] + dy * ws[i], pts[i][1] - dx * ws[i]]);
  }
  const ring = left.concat(right.reverse());
  path.moveTo((ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2);
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    path.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  path.closePath();
  caps.moveTo(pts[0][0] + ws[0], pts[0][1]);
  caps.arc(pts[0][0], pts[0][1], ws[0], 0, Math.PI * 2);
  caps.moveTo(pts[n - 1][0] + ws[n - 1], pts[n - 1][1]);
  caps.arc(pts[n - 1][0], pts[n - 1][1], ws[n - 1], 0, Math.PI * 2);
  return [path, caps];
}

// a straight line from a to b as stroke points (draw-and-hold)
// S Pen side button (barrel, buttons bit 2), an eraser end (bit 32), or a right mouse button
function sideButton(e) {
  return (e.pointerType === 'pen' && !!(e.buttons & 34)) || (e.pointerType === 'mouse' && !!(e.buttons & 2)) || e.button === 5;
}

// What the stylus reports goes to the server log (journalctl: "pen …"), so a tablet whose side
// button does nothing can be looked into: every press/release, every change of the buttons held
// (also while the pen hovers), context menus and keys — up to 120 events per page, sent in batches.
let penLog = [], penSent = 0, penT = 0, penLast = {};
function penReport(e, at) {
  if (penSent + penLog.length >= 120) return;
  const pt = e.pointerType || '';
  if (at === 'move') {  // only when what is held changes
    const k = `${pt}${e.pointerId}`, now = `${e.buttons}|${pt}`;
    if (penLast[k] === now) return;
    penLast[k] = now;
  }
  penLog.push({ at, pt, b: e.button, bs: e.buttons, p: Math.round((e.pressure || 0) * 100) / 100,
    w: Math.round(e.width || 0), tx: e.tiltX || 0, key: e.key || undefined, t: Math.round(performance.now()) });
  clearTimeout(penT);
  penT = setTimeout(() => {
    const batch = penLog; penLog = []; penSent += batch.length;
    try { navigator.sendBeacon('/api/debug/pen', new Blob([JSON.stringify({ ua: navigator.userAgent.slice(0, 90), ev: batch })], { type: 'application/json' })); } catch { /* best effort */ }
  }, 1500);
}

function straight(a, b, p) {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, p]);
}

// a stroke's box on the page including its width (cached; a stroke being written is not)
function strokeBox(s) {
  const b = s._bb || bbox([s]);
  if (!s._live) s._bb = b;
  const m = (s.eraser === 2 ? s.size : s.eraser ? s.size * 6 : s.size) / 2 + 2;
  return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
}

function bbox(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of items) for (const [x, y] of st.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}

function inside(p, poly) { // ray casting
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
