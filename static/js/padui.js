// The writing screen's toolbar, shared by the computer's 電子計算紙 and the
// tablet page — laid out like GoodNotes: pen, highlighter, eraser and lasso;
// tapping the tool that is already selected opens its options (pen type,
// sizes, colours / eraser size and mode); undo/redo, zoom, pages, paper.
// A big round button on the side flips pen ⇄ eraser in one tap (web pages
// cannot see Apple Pencil's double-tap; the S Pen side button works directly).
import { PENS } from './canvas.js';
import { $, confirmBox, esc, icon, toast } from './ui.js';

const PEN_SIZES = [[2, '細'], [3, '中'], [5, '粗']];
const COLORS = ['#1C1E21', '#2F5BEA', '#C92A2A', '#2B8A3E', '#E8590C', '#7048E8', '#8B5A2B', '#868E96', '#D6336C'];
const HL_COLORS = ['rgba(255, 196, 0, 0.38)', 'rgba(64, 192, 87, 0.35)', 'rgba(240, 101, 149, 0.33)', 'rgba(77, 171, 247, 0.35)'];
const HL_SIZES = [[10, '細'], [16, '中'], [26, '粗']];
const ERASER_SIZES = [[8, '小'], [16, '中'], [32, '大']];
const PAPERS = [['grid', '方格'], ['lines', '橫線'], ['dots', '點格'], ['blank', '空白']];

export function toolbarHtml({ extraMenu = '' } = {}) {
  const seg = (attr, list, cur) => `<div class="seg mini">${list.map(([v, l]) => `<button data-${attr}="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="wpad-tools" role="toolbar" aria-label="計算紙工具">
    <button class="tool on" data-tool="pen" aria-label="筆（再點一次：顏色和粗細）" title="筆（再點一次：顏色和粗細）"><span class="pendot"><i style="background:${PENS.black.color}"></i></span></button>
    <button class="tool" data-tool="marker" aria-label="螢光筆（再點一次：顏色和粗細）" title="螢光筆"><span class="hl">${icon('marker', 20)}</span></button>
    <button class="tool" data-tool="eraser" aria-label="橡皮擦（再點一次：大小和模式）" title="橡皮擦（再點一次：大小和模式）">${icon('eraser')}</button>
    <button class="tool" data-tool="lasso" aria-label="套索：圈起來可以移動、刪除" title="套索：圈起來可以移動、刪除、複製">${icon('lasso')}</button>
    <button class="tool" data-tool="hand" aria-label="移動紙張：一指拖動、兩指縮放" title="移動紙張（一指拖動、兩指縮放；再點一次回到筆）">${icon('hand')}</button>
    <span class="sep"></span>
    <button class="tool" data-tool="undo" aria-label="上一步（兩指點一下也可以）" title="上一步（兩指點一下也可以）">${icon('undo')}</button>
    <button class="tool wide-only" data-tool="redo" aria-label="下一步" title="下一步">${icon('undo', 20, 'style="transform:scaleX(-1)"')}</button>
    <span class="sep wide-only"></span>
    <button class="tool wide-only" data-tool="zout" aria-label="縮小" title="縮小（兩指捏合也可以）">${icon('minus')}</button>
    <button class="tool zoomv wide-only" data-tool="fit" aria-label="回到整頁寬" title="回到整頁寬">100%</button>
    <button class="tool wide-only" data-tool="zin" aria-label="放大" title="放大（兩指撐開也可以）">${icon('plus')}</button>
    <span class="sep"></span>
    <button class="tool wide-only" data-tool="prev" aria-label="上一頁" title="上一頁">${icon('left', 18)}</button>
    <button class="tool pageno" data-tool="pageno" aria-live="polite" title="換頁">1/1</button>
    <button class="tool wide-only" data-tool="next" aria-label="下一頁" title="下一頁">${icon('left', 18, 'style="transform:scaleX(-1)"')}</button>
    <button class="tool wide" data-tool="newpage" aria-label="新的一頁" title="新的一頁（訂正用）">${icon('newpage', 18)}<span class="wide-only">新頁</span></button>
    <span class="sep"></span>
    <button class="tool" data-tool="menu" aria-label="更多" aria-haspopup="true">${icon('more')}</button>
  </div>
  <button class="btn sm dark resetview hidden" data-tool="reset" aria-label="回到原位">${icon('fit', 16)} 回到原位</button>
  <button class="erasing-note hidden" data-tool="backtopen">${icon('eraser', 14)} 橡皮擦中・點我回到筆</button>
  <button class="qtoggle" data-tool="flip" aria-label="筆和橡皮擦切換" title="筆 ⇄ 橡皮擦">${icon('eraser', 26)}</button>
  <div class="selbar hidden" role="toolbar" aria-label="選取的筆跡">
    <button class="btn sm ghost" data-sel="delete">${icon('trash', 16)} 刪除</button>
    <button class="btn sm ghost" data-sel="copy">複製</button>
    ${COLORS.slice(0, 3).map((c) => `<button class="tool" data-sel="color" data-c="${c}" aria-label="換顏色"><span class="sw" style="background:${c}"></span></button>`).join('')}
  </div>
  <div class="tmenu-pop hidden" data-pop="pen" role="menu" aria-label="筆的設定">
    <div class="label">筆</div>${seg('ptype', [['fountain', '鋼筆（跟著力道變粗細）'], ['ball', '原子筆（粗細一樣）']], 'fountain')}
    <div class="label">粗細</div>
    <div class="row nowrap" style="gap:6px">${PEN_SIZES.map(([w, l]) => `<button class="tool sizebtn ${w === 3 ? 'on' : ''}" data-size="${w}" aria-label="${l}"><i style="width:${w * 2 + 2}px;height:${w * 2 + 2}px"></i></button>`).join('')}
      <input type="range" min="1" max="10" step="0.5" value="3" data-sizer aria-label="自訂粗細" style="flex:1"></div>
    <div class="label">顏色</div>
    <div class="swatches">${COLORS.map((c, i) => `<button class="tool ${i === 0 ? 'on' : ''}" data-color="${c}" aria-label="顏色"><span class="sw" style="background:${c}"></span></button>`).join('')}</div>
  </div>
  <div class="tmenu-pop hidden" data-pop="marker" role="menu" aria-label="螢光筆的設定">
    <div class="label">粗細</div>${seg('hsize', HL_SIZES, 16)}
    <div class="label">顏色</div>
    <div class="swatches">${HL_COLORS.map((c, i) => `<button class="tool ${i === 0 ? 'on' : ''}" data-hcolor="${c}" aria-label="螢光筆顏色"><span class="sw" style="background:${c.replace(/0\.3\d\)/, '0.9)')}"></span></button>`).join('')}</div>
    <div class="small muted">畫到最後停住半秒，就會變成直線。</div>
  </div>
  <div class="tmenu-pop hidden" data-pop="eraser" role="menu" aria-label="橡皮擦的設定">
    <div class="label">大小</div>${seg('esize', ERASER_SIZES, 16)}
    <div class="label">擦法</div>${seg('emode', [['stroke', '整筆擦掉'], ['partial', '只擦碰到的部分']], 'stroke')}
    <button class="btn sm ghost block" data-tool="clear">清除這一頁</button>
  </div>
  <div class="tmenu-pop hidden" data-pop="lasso" role="menu">
    <div class="small">用套索把字圈起來，就可以拖動位置、刪除、複製或換顏色。</div>
  </div>
  <div class="tmenu-pop hidden" data-pop="menu" role="menu" aria-label="更多">
    <div class="label">紙張</div>${seg('paper', PAPERS, 'grid')}
    <label class="check"><input type="checkbox" data-tool="penonly"> 只用觸控筆（手指用來移動紙張）</label>
    <label class="check"><input type="checkbox" data-tool="tapundo"> 兩指點一下＝上一步</label>
    <button class="btn sm ghost block" data-tool="fitall">看全部筆跡</button>
    <button class="btn sm ghost block narrow-only" data-tool="fit2">回到原位</button>
    <button class="btn sm ghost block narrow-only" data-tool="redo2">下一步（取消上一步）</button>
    ${extraMenu}
    <div class="small muted" style="line-height:1.6">紙張沒有邊界：兩指拖動到任何地方、捏合放大縮小<br>筆畫停住半秒：變直線<br>S Pen 按住側鍵寫：橡皮擦　側邊圓鈕：筆⇄橡皮擦</div>
  </div>`;
}

export function bindToolbar(root, pad) {
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => root.querySelectorAll(s);
  const pops = $$('.tmenu-pop');
  const closePops = () => pops.forEach((p) => p.classList.add('hidden'));
  const openPop = (name) => { const p = $(`[data-pop=${name}]`); const was = !p.classList.contains('hidden'); closePops(); if (!was) p.classList.remove('hidden'); };
  const flip = $('[data-tool=flip]');
  let lastInk = 'pen';
  const show = () => {
    for (const t of ['pen', 'marker', 'eraser', 'lasso', 'hand']) $(`[data-tool=${t}]`).classList.toggle('on', pad.tool === t);
    $('.pendot i').style.background = pad.color;
    const d = Math.max(4, Math.min(16, pad.size * 2 + 2));
    $('.pendot i').style.width = $('.pendot i').style.height = `${d}px`;
    $('.hl').style.color = pad.hlColor.replace(/0\.3\d\)/, '1)');
    flip.innerHTML = pad.tool === 'eraser' ? icon('pen', 26) : icon('eraser', 26);
    flip.classList.toggle('on', pad.tool === 'eraser');
    flip.classList.toggle('hidden', !pad.penOnly); // only for a stylus (finger writing needs the room)
    const note = $('[data-tool=backtopen]'); // never erase (or fail to write) without knowing why
    note.classList.toggle('hidden', pad.tool !== 'eraser' && pad.tool !== 'hand');
    note.innerHTML = pad.tool === 'hand' ? `${icon('hand', 14)} 移動中：一指拖動紙張・點我回到筆` : `${icon('eraser', 14)} 橡皮擦中・點我回到筆`;
  };
  for (const t of ['pen', 'marker', 'eraser', 'lasso', 'hand']) {
    $(`[data-tool=${t}]`).onclick = (e) => {
      e.stopPropagation();
      if (pad.tool === t && t === 'hand') { pad.setTool(lastInk); closePops(); show(); return; } // 移動 again: back to writing
      if (pad.tool === t) { openPop(t); return; } // second tap on the selected tool: its options
      closePops();
      pad.setTool(t);
      if (t === 'pen' || t === 'marker') lastInk = t;
      show();
    };
  }
  flip.onclick = () => { pad.setTool(pad.tool === 'eraser' ? lastInk : 'eraser'); closePops(); show(); };
  $('[data-tool=backtopen]').onclick = () => { pad.setTool(lastInk); closePops(); show(); };
  const tu = $('[data-tool=tapundo]');
  tu.checked = pad.tapUndo;
  tu.onchange = () => { pad.tapUndo = tu.checked; try { localStorage.setItem('tapUndo', tu.checked ? '1' : '0'); } catch { /* private mode */ } };
  pad.onundo = async () => {
    // show what happened, with a way back
    const { toast } = await import('./ui.js');
    toast('已復原上一步（兩指點一下）。不小心的話按「下一步」就能回來', 'ok');
  };
  // pen options
  $$('[data-ptype]').forEach((b) => b.onclick = () => { pad.penType = b.dataset.ptype; $$('[data-ptype]').forEach((x) => x.classList.toggle('on', x === b)); });
  const setSize = (w) => {
    pad.size = w;
    $('[data-sizer]').value = w;
    $$('[data-size]').forEach((x) => x.classList.toggle('on', Number(x.dataset.size) === w));
    show();
  };
  $$('[data-size]').forEach((b) => b.onclick = () => setSize(Number(b.dataset.size)));
  $('[data-sizer]').oninput = (e) => setSize(Number(e.target.value));
  $$('[data-color]').forEach((b) => b.onclick = () => {
    pad.color = b.dataset.color; pad.setTool('pen'); lastInk = 'pen';
    $$('[data-color]').forEach((x) => x.classList.toggle('on', x === b));
    show();
  });
  // highlighter options
  $$('[data-hsize]').forEach((b) => b.onclick = () => { pad.hlSize = Number(b.dataset.hsize); $$('[data-hsize]').forEach((x) => x.classList.toggle('on', x === b)); });
  $$('[data-hcolor]').forEach((b) => b.onclick = () => { pad.hlColor = b.dataset.hcolor; $$('[data-hcolor]').forEach((x) => x.classList.toggle('on', x === b)); show(); });
  // eraser options
  $$('[data-esize]').forEach((b) => b.onclick = () => { pad.eraserSize = Number(b.dataset.esize); $$('[data-esize]').forEach((x) => x.classList.toggle('on', x === b)); });
  $$('[data-emode]').forEach((b) => b.onclick = () => { pad.eraserMode = b.dataset.emode; $$('[data-emode]').forEach((x) => x.classList.toggle('on', x === b)); });
  // paper
  $$('[data-paper]').forEach((b) => b.onclick = () => { pad.paper = b.dataset.paper; $$('[data-paper]').forEach((x) => x.classList.toggle('on', x === b)); pad.render(); });
  // lasso selection actions
  const selbar = $('.selbar');
  pad.onselect = (sel) => selbar.classList.toggle('hidden', !sel);
  $('[data-sel=delete]').onclick = () => pad.deleteSelection();
  $('[data-sel=copy]').onclick = () => pad.duplicateSelection();
  $$('[data-sel=color]').forEach((b) => b.onclick = () => pad.recolorSelection(b.dataset.c));
  // history, zoom, pages
  $('[data-tool=undo]').onclick = () => pad.undo();
  $('[data-tool=redo]').onclick = () => pad.redo();
  $('[data-tool=fit2]').onclick = () => { pad.resetView(); closePops(); };
  $('[data-tool=fitall]').onclick = () => { pad.fitAll(); closePops(); };
  $('[data-tool=redo2]').onclick = () => { pad.redo(); closePops(); };
  $('[data-tool=pageno]').onclick = () => { if (pad.pages.length > 1) pad.gotoPage((pad.page + 1) % pad.pages.length); };
  $('[data-tool=zin]').onclick = () => pad.zoomStep(1.25);
  $('[data-tool=zout]').onclick = () => pad.zoomStep(0.8);
  $('[data-tool=fit]').onclick = () => pad.resetView();
  $('[data-tool=reset]').onclick = () => pad.resetView();
  $('[data-tool=prev]').onclick = () => pad.gotoPage(pad.page - 1);
  $('[data-tool=next]').onclick = () => pad.gotoPage(pad.page + 1);
  $('[data-tool=newpage]').onclick = () => pad.newPage();
  $('[data-tool=menu]').onclick = (e) => { e.stopPropagation(); openPop('menu'); };
  root.addEventListener('pointerdown', (e) => { if (!e.target.closest('.wpad-tools, .tmenu-pop')) closePops(); });
  const po = $('[data-tool=penonly]');
  po.checked = pad.penOnly;
  po.onchange = () => pad.setFingerWrite(!po.checked);
  // a finger tried to write while only the pen writes: say why nothing appears, offer to change it
  let toldAt = 0;
  pad.onfingertry = () => {
    if (Date.now() - toldAt < 30000 || root.querySelector('.fingertip')) return;
    toldAt = Date.now();
    const tip = document.createElement('div');
    tip.className = 'fingertip';
    tip.innerHTML = '<span>現在只有觸控筆能寫字，手指用來移動、縮放紙張</span><button class="btn sm">讓手指也能寫</button><button class="btn sm ghost">好</button>';
    const [yes, ok] = tip.querySelectorAll('button');
    yes.onclick = () => { pad.setFingerWrite(true); po.checked = false; show(); tip.remove(); toast('手指也可以寫字了（兩指還是可以縮放）', 'ok'); };
    ok.onclick = () => tip.remove();
    (root.querySelector('.wpad-paper') || root).appendChild(tip);
    setTimeout(() => tip.remove(), 9000);
  };
  $('[data-tool=clear]').onclick = async () => { closePops(); if (await confirmBox('清除這一頁的所有筆跡？（可以按上一步復原）', '清除', true)) pad.clear(); };
  const prevView = pad.onview;
  pad.onview = () => {
    prevView && prevView();
    $('.zoomv').textContent = `${Math.round(pad.zoom * 100)}%`;
    $('[data-tool=reset]').classList.toggle('hidden', !pad.moved);
    $('.pageno').textContent = `${pad.page + 1}/${pad.pages.length}`;
    $('.pageno').disabled = pad.pages.length < 2;
    $('[data-tool=prev]').disabled = pad.page === 0;
    $('[data-tool=next]').disabled = pad.page >= pad.pages.length - 1;
    po.checked = pad.penOnly;
  };
  pad.onview();
  show();
  po.addEventListener('change', show);
  return { syncPenOnly: () => { po.checked = pad.penOnly; show(); }, show };
}

// The paper takes the whole screen (like GoodNotes / Samsung Notes): the
// question folds into one line at the top, tools float at the bottom, and
// hints / grading open in a sheet that can be put away.
export function writingShell({ title, question, actions, extraMenu = '' }) {
  return `<div class="wpad">
    <div class="wpad-top pad-q">
      <button class="icon-btn" data-close aria-label="關閉">${icon('close', 22)}</button>
      <button class="qchip" id="qchip" aria-expanded="true"><b>${esc(title)}</b><span class="qline">${question.line}</span>${icon('chev', 16, 'class="qarrow"')}</button>
      <div class="wpad-actions">${actions}</div>
    </div>
    <div class="wpad-body">
    <div class="wpad-q" id="qbody">${question.html}<div class="small muted wpad-qtip">點圖可以放大</div></div>
    <div class="wpad-paper">
      <div class="pad-area" id="padarea"></div>
      ${toolbarHtml({ extraMenu })}
      <button class="btn sm dark wpad-peek hidden" id="peek">看批改結果</button>
      <div class="wpad-sheet hidden" id="sheet" role="region" aria-label="提示與批改">
        <div class="row nowrap wpad-sheet-head"><b style="flex:1" id="sheettitle">小老師</b><button class="btn sm ghost" id="sheetclose">收起，繼續寫</button></div>
        <div id="out"></div>
      </div>
    </div>
    </div>
  </div>`;
}

export function bindShell(m, pad) {
  const qb = $('#qbody', m), chip = $('#qchip', m);
  const setQ = (open) => { qb.classList.toggle('hidden', !open); chip.setAttribute('aria-expanded', String(open)); chip.classList.toggle('open', open); };
  // the question stays in view while she writes (she has to read it); folding is her choice
  chip.onclick = () => setQ(qb.classList.contains('hidden'));
  // the pen must never select the question's text or start dragging its picture
  qb.addEventListener('pointerdown', (e) => { if (e.pointerType === 'pen') e.preventDefault(); }); // fingers may still scroll it
  qb.addEventListener('selectstart', (e) => e.preventDefault());
  setQ(true);
  qb.querySelectorAll('img').forEach((img) => {
    img.draggable = false;
    img.onclick = () => {
      const v = document.createElement('div');
      v.className = 'figview';
      v.innerHTML = `<img src="${img.src}" alt="題目附圖"><button class="btn dark">關閉</button>`;
      v.onclick = () => v.remove();
      m.appendChild(v);
    };
  });
  const sheet = $('#sheet', m), peek = $('#peek', m);
  const paper = m.querySelector('.wpad-paper');
  const show = (title) => { if (title) $('#sheettitle', m).textContent = title; sheet.classList.remove('hidden'); peek.classList.add('hidden'); paper.classList.add('sheet-open'); };
  const hide = () => { sheet.classList.add('hidden'); paper.classList.remove('sheet-open'); if ($('#out', m).children.length) peek.classList.remove('hidden'); };
  $('#sheetclose', m).onclick = hide;
  peek.onclick = () => show();
  return { show, hide, setQ };
}

