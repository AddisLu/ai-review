"""Photo -> clean scan pipeline (runs on the Pi with OpenCV).

1. load: HEIC/JPEG/PNG, honour EXIF rotation
2. find the paper outline and flatten it (perspective warp)
3. normalise lighting so the paper becomes white (shadows removed)
4. detect highlighter regions (fluorescent colours, large soft areas)
5. erase coloured ink (blue/red pens, highlighter) and AI-located pencil handwriting
6. crop question / figure regions for the editable exam
Boxes are always [x0, y0, x1, y1] in 0..1000 coordinates of the scan image.
"""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:  # pragma: no cover - optional dependency
    pass

MAX_SIDE = 3000


def load(path: str | Path) -> np.ndarray:
    im = ImageOps.exif_transpose(Image.open(path))
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        # a transparent PNG (screenshot, exported page): on white paper, not black
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    im = im.convert("RGB")
    arr = cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    h, w = arr.shape[:2]
    s = MAX_SIDE / max(h, w)
    if s < 1:
        arr = cv2.resize(arr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return arr


def save(img: np.ndarray, path: str | Path, quality: int = 90):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".png":
        cv2.imwrite(str(path), img)
    else:
        cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, quality])


def _order(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(4, 2).astype("float32")
    s = pts.sum(1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]],
                    dtype="float32")


def find_page(img: np.ndarray) -> np.ndarray | None:
    """Return the 4 paper corners (tl, tr, br, bl) or None if the photo is
    already a flat scan / no clear outline exists."""
    h, w = img.shape[:2]
    scale = 1000 / max(h, w)
    small = cv2.resize(img, (int(w * scale), int(h * scale)))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    area_total = small.shape[0] * small.shape[1]
    candidates = []
    # Paper is usually the brightest large region; try edges and a brightness mask.
    edges = cv2.Canny(gray, 40, 120)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
    _, bright = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    for mask in (edges, bright):
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:5]:
            a = cv2.contourArea(c)
            if a < 0.25 * area_total:
                continue
            peri = cv2.arcLength(c, True)
            for eps in (0.02, 0.03, 0.05):
                approx = cv2.approxPolyDP(c, eps * peri, True)
                if len(approx) == 4 and cv2.isContourConvex(approx):
                    candidates.append((a, approx))
                    break
    if not candidates:
        return None
    a, quad = max(candidates, key=lambda t: t[0])
    if a > 0.97 * area_total:  # outline is the photo border itself
        return None
    return _order(quad) / scale


def warp(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = quad
    wa = np.linalg.norm(br - bl)
    wb = np.linalg.norm(tr - tl)
    ha = np.linalg.norm(tr - br)
    hb = np.linalg.norm(tl - bl)
    W, H = int(max(wa, wb)), int(max(ha, hb))
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], dtype="float32")
    M = cv2.getPerspectiveTransform(quad.astype("float32"), dst)
    out = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC,
                              borderMode=cv2.BORDER_REPLICATE)
    # Trim a thin margin so the table/paper edge doesn't show as a dark frame.
    m = max(2, int(min(W, H) * 0.006))
    return out[m:H - m, m:W - m]


def normalize_light(img: np.ndarray) -> np.ndarray:
    """Divide by an estimate of the paper colour so shadows and yellowed paper
    turn white while ink keeps its colour."""
    h, w = img.shape[:2]
    k = max(15, (min(h, w) // 40) | 1)
    # Estimate paper brightness from the brightest channel, so a yellow
    # highlighter (bright in R and G) counts as paper and keeps its colour.
    v = img.max(axis=2)
    bg = cv2.dilate(v, np.ones((7, 7), np.uint8))
    bg = cv2.medianBlur(bg, min(k, 255))
    bg = cv2.GaussianBlur(bg, (0, 0), k / 4).astype(np.float32)
    out = img.astype(np.float32) * (255.0 / np.maximum(bg, 1))[..., None]
    out = np.clip(out, 0, 255).astype(np.uint8)
    # Gentle contrast stretch: push near-white to white, keep dark ink dark.
    lut = np.clip((np.arange(256) - 25) * 255.0 / 205.0, 0, 255).astype(np.uint8)
    return cv2.LUT(out, lut)


def scan(path: str | Path, corners: list | None = None, spread: bool | None = None,
         digital: bool | str | None = None) -> tuple[np.ndarray, dict]:
    """Full photo -> flat, evenly lit colour scan (app/scanner.py: outline, warp, flat-field,
    curved-page correction, staples). Returns (image, what was done). A PDF page / file read in
    that is computer-made (`digital`) is kept as it is."""
    from . import scanner
    return scanner.scan(load(path), corners, spread, digital)


def rotate(img: np.ndarray, deg: int) -> np.ndarray:
    deg %= 360
    if deg == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if deg == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if deg == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def rotate_box(box, deg: int):
    """Rotate a 0..1000 box the same way rotate() turns the image clockwise."""
    if not box:
        return box
    x0, y0, x1, y1 = box
    deg %= 360
    if deg == 90:
        return [1000 - y1, x0, 1000 - y0, x1]
    if deg == 180:
        return [1000 - x1, 1000 - y1, 1000 - x0, 1000 - y0]
    if deg == 270:
        return [y0, 1000 - x1, y1, 1000 - x0]
    return box


def to_px(box, shape, pad: float = 0) -> tuple[int, int, int, int]:
    h, w = shape[:2]
    x0, y0, x1, y1 = box
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    px, py = pad * w / 1000, pad * h / 1000
    return (max(0, int(x0 * w / 1000 - px)), max(0, int(y0 * h / 1000 - py)),
            min(w, int(x1 * w / 1000 + px)), min(h, int(y1 * h / 1000 + py)))


def ink_masks(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(highlighter_mask, coloured_pen_mask) on a normalised scan."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    coloured = (s > 60) & (v > 60)
    # Highlighters are bright and moderately saturated; pens are darker or thin.
    hl = coloured & (v > 170)
    hl = hl.astype(np.uint8) * 255
    k = max(3, min(img.shape[:2]) // 300)
    hl = cv2.morphologyEx(hl, cv2.MORPH_OPEN, np.ones((k * 2 + 1, k * 2 + 1), np.uint8))
    pen = (coloured.astype(np.uint8) * 255)
    return hl, pen


HL_NAMES = [((15, 40), "黃"), ((40, 90), "綠"), ((90, 130), "藍"), ((130, 175), "粉紅"),
            ((0, 15), "橘"), ((175, 181), "橘")]


def find_highlights(img: np.ndarray) -> list[dict]:
    """Highlighter strokes as 0..1000 boxes with a colour name."""
    hl, _ = ink_masks(img)
    hh, ww = img.shape[:2]
    # Join a highlighter stroke broken by printed text into one region.
    hl = cv2.morphologyEx(hl, cv2.MORPH_CLOSE, np.ones((9, 25), np.uint8))
    n, labels, stats, cents = cv2.connectedComponentsWithStats(hl)
    hue = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 0]
    out = []
    min_area = 0.0006 * hh * ww
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a < min_area or min(w, h) < 0.006 * min(hh, ww):
            continue
        fill = a / float(w * h)
        if fill < 0.25:  # sparse loops are pen circles, not highlighter
            continue
        med = float(np.median(hue[labels == i]))
        name = next((nm for (lo, hi), nm in HL_NAMES if lo <= med < hi), "螢光")
        out.append({"box": [int(x * 1000 / ww), int(y * 1000 / hh),
                            int((x + w) * 1000 / ww), int((y + h) * 1000 / hh)],
                    "color": name})
    return out


def overlap(a, b) -> float:
    """Fraction of box a covered by box b."""
    if not a or not b:
        return 0.0
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = max(1, (a[2] - a[0]) * (a[3] - a[1]))
    return ix * iy / area


def crop(img: np.ndarray, box, pad: float = 6, trim: bool = True) -> np.ndarray | None:
    x0, y0, x1, y1 = to_px(box, img.shape, pad=pad)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    c = img[y0:y1, x0:x1]
    if trim:
        c = trim_white(c)
    return c


def trim_white(img: np.ndarray, margin: int = 8) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ys, xs = np.where(gray < 200)
    if len(xs) == 0:
        return img
    h, w = gray.shape
    x0, x1 = max(0, xs.min() - margin), min(w, xs.max() + margin)
    y0, y1 = max(0, ys.min() - margin), min(h, ys.max() + margin)
    return img[y0:y1, x0:x1]


def for_ai(img: np.ndarray, max_side: int = 2000, quality: int = 85) -> bytes:
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    elif max(h, w) < 800:
        # a small figure crop (labels ~10 px tall): enlarge smoothly and sharpen a little,
        # so the model reads "11" and "3" and where their brackets point
        k = min(4.0, 1000 / max(h, w))
        img = cv2.resize(img, (int(w * k), int(h * k)), interpolation=cv2.INTER_CUBIC)
        img = cv2.addWeighted(img, 1.5, cv2.GaussianBlur(img, (0, 0), 2.0), -0.5, 0)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()


def file_for_ai(path: str | Path, max_side: int = 1600) -> bytes:
    return for_ai(load(path), max_side=max_side)


def upscale_crop(img: np.ndarray, box, pad: float = 10, scale: float = 2.0) -> np.ndarray | None:
    """A question's region, enlarged (the AI reads small print and thin lines better)."""
    c = crop(img, box, pad=pad, trim=False)
    if c is None:
        return None
    s = min(scale, 2400 / max(c.shape[:2]))
    return cv2.resize(c, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC) if s > 1 else c


def enhance_figure(img: np.ndarray, target: int = 1400) -> np.ndarray:
    """A figure kept as a picture, made print-ready: the faint gray watermark and paper tone
    go to white, lines and text get darker, and it is enlarged smoothly and sharpened."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    s = max(1.0, min(4.0, target / max(gray.shape[:2])))
    big = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    blur = cv2.GaussianBlur(big, (0, 0), 1.2)
    sharp = cv2.addWeighted(big, 1.6, blur, -0.6, 0)
    # levels: paper and light watermark (≥ 185) → white; ink (≤ 90) → black; in between stretched
    lut = np.clip((np.arange(256) - 90) * 255.0 / (185 - 90), 0, 255).astype(np.uint8)
    out = cv2.LUT(sharp, lut)
    return cv2.cvtColor(out, cv2.COLOR_GRAY2BGR)



def blank_answer_boxes(img: np.ndarray) -> tuple[np.ndarray, int]:
    """A figure kept as a picture (插圖、情境圖): the small answer boxes (□ to tick or mark △) are
    emptied, so what was written in them on the photographed paper is not shown as if it were part
    of the question. A box is a small square closed by four straight lines (it may share them with
    the panel's frame); circled numbers and characters are not. Returns the picture and how many
    boxes were emptied."""
    out = img.copy()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = gray.shape[:2]
    big = max(h, w)
    lo, hi = max(16, int(0.045 * big)), int(0.2 * big)
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 12)
    k = max(10, int(lo * 0.8))
    hor = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    ver = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k)))
    lines = cv2.dilate(cv2.bitwise_or(hor, ver), np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(cv2.bitwise_not(lines), connectivity=4)
    found = 0
    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        if not (lo <= cw <= hi and lo <= ch <= hi and 0.72 <= cw / ch <= 1.38) or area < 0.8 * cw * ch:
            continue
        if x <= 1 or y <= 1 or x + cw >= w - 1 or y + ch >= h - 1:
            continue  # open to the picture's edge: not closed on four sides
        # each side is a straight line along (most of) the region's edge
        def cover(mask, ys, xs):
            return mask[max(0, ys.start):ys.stop, max(0, xs.start):xs.stop].any(axis=0 if ys.stop - ys.start < xs.stop - xs.start else 1).mean()
        top = cover(hor, slice(y - 5, y + 1), slice(x, x + cw))
        bot = cover(hor, slice(y + ch - 1, y + ch + 5), slice(x, x + cw))
        left = cover(ver, slice(y, y + ch), slice(x - 5, x + 1))
        right = cover(ver, slice(y, y + ch), slice(x + cw - 1, x + cw + 5))
        if min(top, bot, left, right) < 0.8:
            continue
        # an answer box is (mostly) empty paper: a mark covers little of it; a picture does not
        inner = gray[y:y + ch, x:x + cw]
        if (inner < 150).mean() > 0.3:
            continue
        cv2.rectangle(out, (int(x), int(y)), (int(x + cw - 1), int(y + ch - 1)), (255, 255, 255), -1)
        found += 1
    return out, found
