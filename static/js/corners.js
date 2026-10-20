// 調整四個角 (like a scanner app): the photo with the page's 4 corners; drag them onto the paper's
// corners — a magnifier shows the spot under the finger. Corners are 0..1 of the photo (tl, tr, br, bl).
import { esc, modal } from './ui.js';

const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];

// a photo file → a small JPEG (orientation applied) to send for the automatic outline, and its URL
export async function photoForCorners(file, side = 1200) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);  // a transparent PNG: on white, not black
  x.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}

// the outline drawn over a thumbnail
export function cornersSvg(corners) {
  const q = corners && corners.length === 4 ? corners : FULL;
  return `<svg class="cn-thumb" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="${q.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}"/></svg>`;
}

// returns the corners chosen, or null when cancelled
export function editCorners(src, corners, { auto = null, title = '調整四個角' } = {}) {
  let q = (corners && corners.length === 4 ? corners : FULL).map((p) => [...p]);
  return modal({
    title: esc(title), wide: true,
    body: `<p class="small muted" style="margin:0 0 8px">把四個圓點拖到考卷的四個角（被壓住、摺到的角拖到它原本的位置）。框外的東西會被裁掉，框內會拉正、去陰影。</p>
      <div class="cn-wrap"><div class="cn-stage"><img class="cn-img" src="${src}" alt="原卷照片" draggable="false">
        <svg class="cn-svg" preserveAspectRatio="none"><polygon class="cn-poly"/></svg>
        ${[0, 1, 2, 3].map((i) => `<button class="cn-h" data-i="${i}" aria-label="第 ${i + 1} 個角"></button>`).join('')}
        <canvas class="cn-loupe" width="140" height="140"></canvas></div></div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        ${auto ? '<button class="btn soft" id="cnauto">自動偵測</button>' : ''}
        <button class="btn soft" id="cnfull">整張照片</button><span class="spacer"></span>
        <button class="btn ghost" data-close>取消</button><button class="btn ok" id="cnok">確定</button></div>`,
    onOpen: (m, close) => {
      const stage = m.querySelector('.cn-stage'), img = m.querySelector('.cn-img');
      const poly = m.querySelector('.cn-poly'), hs = [...m.querySelectorAll('.cn-h')];
      const loupe = m.querySelector('.cn-loupe'), lx = loupe.getContext('2d');
      const draw = () => {
        const W = img.clientWidth, H = img.clientHeight;
        m.querySelector('.cn-svg').setAttribute('viewBox', `0 0 ${W} ${H}`);
        poly.setAttribute('points', q.map(([x, y]) => `${x * W},${y * H}`).join(' '));
        hs.forEach((h, i) => { h.style.left = `${q[i][0] * W}px`; h.style.top = `${q[i][1] * H}px`; });
      };
      img.complete ? draw() : (img.onload = draw);
      const ro = new ResizeObserver(draw);
      ro.observe(img);
      let drag = -1;
      const at = (e) => {
        const r = img.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
      };
      const showLoupe = (p) => {
        const W = img.clientWidth, H = img.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
        const z = 3, s = 140 / z;  // a 3× view of the spot
        lx.fillStyle = '#fff'; lx.fillRect(0, 0, 140, 140);
        lx.drawImage(img, p[0] * nw - (s / 2) * nw / W, p[1] * nh - (s / 2) * nh / H, s * nw / W, s * nh / H, 0, 0, 140, 140);
        lx.strokeStyle = '#E5281A'; lx.lineWidth = 1.5;
        lx.beginPath(); lx.moveTo(70, 52); lx.lineTo(70, 88); lx.moveTo(52, 70); lx.lineTo(88, 70); lx.stroke();
        loupe.style.display = 'block';
        // keep the magnifier away from the finger: the opposite top corner
        loupe.style.left = p[0] > 0.5 ? '8px' : '';
        loupe.style.right = p[0] > 0.5 ? '' : '8px';
      };
      hs.forEach((h, i) => {
        h.addEventListener('pointerdown', (e) => { e.preventDefault(); drag = i; h.setPointerCapture(e.pointerId); showLoupe(q[i]); });
        h.addEventListener('pointermove', (e) => { if (drag !== i) return; q[i] = at(e); draw(); showLoupe(q[i]); });
        const up = () => { drag = -1; loupe.style.display = 'none'; };
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      const a = m.querySelector('#cnauto');
      if (a) a.onclick = () => { q = auto.map((p) => [...p]); draw(); };
      m.querySelector('#cnfull').onclick = () => { q = FULL.map((p) => [...p]); draw(); };
      m.querySelector('#cnok').onclick = () => {
        ro.disconnect();
        const full = q.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 0.005 && Math.abs(p[1] - FULL[i][1]) < 0.005);
        close(full ? [] : q.map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000]));
      };
    },
  });
}
