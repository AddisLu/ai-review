"""Phone photo → flat, evenly lit scan, like a document-scanner app (all OpenCV, on the Pi, no AI).

1. page outline: candidate quadrilaterals from straight edges (LSD line segments, two roughly
   horizontal + two roughly vertical) and from the paper's colour (bright, colourless area), each
   refined by fitting lines to the outline; the best one is chosen by how much of its border is a
   real edge, how much of the page's text it holds, its size and its shape (sheets in a pile: the top
   sheet's border is an edge all round, the sheets under it are partly covered).
2. perspective warp of those 4 corners to a flat rectangle.
3. flat-field correction (FFC): the paper's own brightness (shadows, a hand, the gutter of a book, a
   lamp) estimated with the ink taken out, and divided away — then a fine row/column pass that takes
   out thin shading lines (fold lines, the page-turn line, a crease) — paper white, ink keeps its colour.
4. curved pages and thick books: text lines (or columns, for 直書) are found and fitted with curves;
   a smooth 2-D displacement makes them straight (and level).
5. staples: small, isolated, metallic blobs near the corners are painted over with paper.
"""
import cv2
import numpy as np

WORK = 1000  # analysis size (longest side)


# --- 1. the page outline -----------------------------------------------------------------------

def _order(pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, np.float32).reshape(4, 2)
    c = pts.mean(0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]                    # clockwise from the top-left-ish one
    i = int(np.argmin(pts.sum(1)))
    return np.roll(pts, -i, axis=0)               # tl, tr, br, bl


def _intersect(l1, l2):
    (x1, y1), (x2, y2) = l1
    (x3, y3), (x4, y4) = l2
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(d) < 1e-6:
        return None
    a, b = x1 * y2 - y1 * x2, x3 * y4 - y3 * x4
    return ((a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d)


def _paper_mask(small: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    white = hsv[:, :, 2].astype(np.int16) - hsv[:, :, 1].astype(np.int16)
    white = cv2.GaussianBlur(np.clip(white, 0, 255).astype(np.uint8), (5, 5), 0)
    t, _ = cv2.threshold(white, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = (white > max(t, 110)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    return m


def _quad_from_contour(cnt) -> np.ndarray | None:
    hull = cv2.convexHull(cnt)
    peri = cv2.arcLength(hull, True)
    for eps in (0.01, 0.02, 0.03, 0.045, 0.06, 0.08):
        ap = cv2.approxPolyDP(hull, eps * peri, True)
        if len(ap) == 4:
            return _order(ap.reshape(4, 2))
    return _order(cv2.boxPoints(cv2.minAreaRect(hull)))


def _refine(quad: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Fit a straight line to the outline points along each side, the corners where they meet."""
    if pts is None or len(pts) < 20:
        return quad
    lines = []
    for k in range(4):
        a, b = quad[k], quad[(k + 1) % 4]
        ab = b - a
        L = float(np.hypot(*ab))
        if L < 10:
            return quad
        n = np.array([-ab[1], ab[0]]) / L
        rel = pts - a
        along = rel @ (ab / L)
        dist = np.abs(rel @ n)
        sel = pts[(dist < max(6, 0.02 * L)) & (along > 0.1 * L) & (along < 0.9 * L)]
        if len(sel) < 8:
            lines.append((tuple(a), tuple(b)))
            continue
        vx, vy, x0, y0 = cv2.fitLine(sel.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append(((x0, y0), (x0 + vx * 100, y0 + vy * 100)))
    out = []
    for k in range(4):
        p = _intersect(lines[k - 1], lines[k])
        if p is None:
            return quad
        out.append(p)
    q = _order(np.array(out))
    return q if cv2.contourArea(q) > 0.6 * cv2.contourArea(quad) else quad


def _line_quads(gray: np.ndarray) -> list[np.ndarray]:
    """Quadrilaterals made of 2 near-horizontal and 2 near-vertical long straight edges."""
    h, w = gray.shape
    lsd = cv2.createLineSegmentDetector()
    segs = lsd.detect(cv2.GaussianBlur(gray, (3, 3), 0))[0]
    if segs is None:
        return []
    segs = segs.reshape(-1, 4)
    ln = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    segs, ln = segs[ln > 0.08 * min(h, w)], ln[ln > 0.08 * min(h, w)]
    if len(segs) < 4:
        return []
    ang = np.degrees(np.arctan2(segs[:, 3] - segs[:, 1], segs[:, 2] - segs[:, 0])) % 180
    horiz = (ang < 35) | (ang > 145)
    vert = (ang > 55) & (ang < 125)

    def merge(group):
        """collinear pieces joined into long lines: (p1, p2, length)."""
        out = []
        for s, L in sorted(zip(segs[group], ln[group]), key=lambda t: -t[1]):
            p1, p2 = np.array(s[:2]), np.array(s[2:])
            d = p2 - p1
            n = np.array([-d[1], d[0]]) / (np.hypot(*d) + 1e-9)
            for o in out:
                q1, q2 = o[0], o[1]
                if abs((p1 - q1) @ o[3]) < 8 and abs((p2 - q1) @ o[3]) < 8:
                    o[2] += L
                    break
            else:
                out.append([p1, p2, L, n])
        return sorted(out, key=lambda o: -o[2])[:7]

    H, V = merge(horiz), merge(vert)
    quads = []
    for i in range(len(H)):
        for j in range(i + 1, len(H)):
            for k in range(len(V)):
                for m in range(k + 1, len(V)):
                    top, bot = sorted((H[i], H[j]), key=lambda o: (o[0][1] + o[1][1]))
                    lef, rig = sorted((V[k], V[m]), key=lambda o: (o[0][0] + o[1][0]))
                    pts = [_intersect((top[0], top[1]), (lef[0], lef[1])), _intersect((top[0], top[1]), (rig[0], rig[1])),
                           _intersect((bot[0], bot[1]), (rig[0], rig[1])), _intersect((bot[0], bot[1]), (lef[0], lef[1]))]
                    if any(p is None for p in pts):
                        continue
                    q = np.array(pts, np.float32)
                    if (q[:, 0] < -0.05 * w).any() or (q[:, 0] > 1.05 * w).any() or (q[:, 1] < -0.05 * h).any() or (q[:, 1] > 1.05 * h).any():
                        continue
                    quads.append(_order(q))
    return quads


def _score(q: np.ndarray, grad: np.ndarray, ink: np.ndarray, area: float, parts: list | None = None, raw=None, tb=None) -> float:
    """tb: the page's main text block (the biggest cluster of text lines) — the sheet holds all of it;
    an outline cutting through it (another sheet's edge in a stack, a fold) is not the sheet."""
    h, w = grad.shape
    a = cv2.contourArea(q)
    frac = a / area
    if frac < 0.2 or not cv2.isContourConvex(q.astype(np.float32).reshape(-1, 1, 2)):
        if parts is not None:
            parts.append("reject:shape")
        return -1
    # every corner roughly a right angle seen in perspective, sides not wildly different
    for k in range(4):
        u, v = q[k - 1] - q[k], q[(k + 1) % 4] - q[k]
        c = abs(u @ v) / (np.hypot(*u) * np.hypot(*v) + 1e-9)
        if c > 0.5:
            if parts is not None:
                parts.append("reject:angle")
            return -1
    sides = [np.hypot(*(q[(k + 1) % 4] - q[k])) for k in range(4)]
    if min(sides[0], sides[2]) / max(sides[0], sides[2]) < 0.55 or min(sides[1], sides[3]) / max(sides[1], sides[3]) < 0.55:
        if parts is not None:
            parts.append("reject:sides")
        return -1
    # border support: the part of the outline that is a real edge (or the photo's own edge)
    pts = []
    for k in range(4):
        a_, b_ = q[k], q[(k + 1) % 4]
        n = int(max(20, np.hypot(*(b_ - a_)) / 4))
        t = np.linspace(0.05, 0.95, n)[:, None]
        pts.append(a_ + (b_ - a_) * t)
    pts = np.concatenate(pts)
    xi, yi = np.round(pts[:, 0]).astype(int), np.round(pts[:, 1]).astype(int)
    border = (xi <= 2) | (yi <= 2) | (xi >= w - 3) | (yi >= h - 3)
    xi, yi = np.clip(xi, 0, w - 1), np.clip(yi, 0, h - 1)
    edge = grad[yi, xi] > 40   # grad is already the max over a 5×5 neighbourhood
    support = float(np.where(border, 0.6, edge).mean())
    mask = np.zeros_like(ink)
    cv2.fillConvexPoly(mask, q.astype(np.int32), 1)
    inside = (ink & mask).sum() / max(1, ink.sum())
    if inside < 0.5:
        if parts is not None:
            parts.append(f"reject:inside {inside:.2f}")
        return -1  # a box or table inside the page (most of the page's text left outside), not the sheet
    blk = 1.0
    if tb is not None and tb.any():
        blk = float((tb & (mask > 0)).sum() / tb.sum())
        if blk < 0.6:
            if parts is not None:
                parts.append(f"reject:block {blk:.2f}")
            return -1
    # a sheet's edge has its blank margin just inside it; a printed line inside the page (an underline,
    # a table, a box) has text on both sides — the band just inside each side must be nearly empty
    c = q.mean(0)
    band = np.zeros_like(ink)
    inner = (c + (q - c) * 0.94).astype(np.int32)
    cv2.fillConvexPoly(band, q.astype(np.int32), 1)
    cv2.fillConvexPoly(band, inner, 0)
    dens = (raw & band).sum() / max(1, band.sum())
    margin = max(0.0, 1 - dens / 0.12)
    if parts is not None:
        parts += [round(support, 2), round(float(inside), 2), round(frac, 2), round(float(dens), 3), round(blk, 2)]
    score = support * 2.0 + inside * 1.5 + min(frac, 0.95) * 1.0 + margin * 1.5
    # a sheet holds (nearly) all of its text: the main text block cut (another sheet's edge in a stack,
    # a fold) costs a lot — but a second sheet's text joined to the block (sticking out beneath) a little
    return score * min(1.0, inside / 0.75) * min(1.0, blk / 0.93) ** 4


def debug_candidates(img):
    global _DBG
    _DBG = []
    find_page(img)
    return sorted(_DBG, key=lambda t: -t[0])


_DBG = None

# focus: a page in focus keeps most of its edge energy when blurred a little (ratio ≈ 10–14 on the
# phone's photos, ≈ 8.3 at the worst in focus); one the camera had not focused on yet loses it (≈ 5–6)
SHARP_MIN = 7.5


def sharpness(page: np.ndarray) -> float:
    """How much in focus a flat page is: the gradient energy of the page (long side 1000 px) over that of
    the same page blurred by σ=2 — independent of how much is printed on it, since both sides scale
    with the ink; motion blur in one direction is not caught (it is the camera's stillness check)."""
    g = page if page.ndim == 2 else cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    s = 1000 / max(g.shape[:2])  # always at the one scale: the ratio depends on it
    g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA).astype(np.float32)

    def energy(a):
        gx, gy = cv2.Sobel(a, cv2.CV_32F, 1, 0), cv2.Sobel(a, cv2.CV_32F, 0, 1)
        return float(np.mean(gx * gx + gy * gy))
    e = energy(g)
    return round(e / (energy(cv2.GaussianBlur(g, (0, 0), 2.0)) + 1e-6), 2) if e > 1 else 0.0


def check_photo(img: np.ndarray, hint=None) -> dict:
    """After a shot (拍照指引): the outline found on the full photo, how sure it is, and 單頁／雙頁 —
    the camera compares it with what it saw live and asks for the corners when the two disagree.
    hint: the corners she lined the sheet up with (單頁／雙頁 chosen) — the sheet looked for near them."""
    global _DBG
    _DBG = []
    q = None
    h, w = img.shape[:2]
    if hint is not None:
        e = find_sheet_lines(img, hint)
        if e is not None and e[1] >= 0.5:
            qe = refine_sides(img, e[0])
            if np.abs(qe / [w, h] - np.asarray(hint)).max() < 0.12:
                q = qe.astype(np.float32)
    if q is None:
        q = find_page(img)
    else:
        _DBG.append((5.0, q * (WORK / max(h, w)), "hint", [], 5.0))
    cands, _DBG = sorted(_DBG, key=lambda t: -t[0]), None
    out = {"corners": [], "score": 0.0, "margin": 0.0, "spread": False, "landscape": w > h, "sharp": 0.0, "blurry": False}
    if q is None:
        return out  # focus is judged on the page itself (the desk around it would not do)
    out["corners"] = [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in q]
    out["score"] = round(float(cands[0][-1]), 2) if cands else 0.0  # the text/margins judge's score
    # how clearly the best outline beats a different one (two sheets → two good outlines)
    for s, q2, *_ in cands[1:]:
        sc = WORK / max(h, w)
        if np.abs(q2 / sc - q).max() > 0.06 * max(h, w):
            out["margin"] = round(float(cands[0][0] - s), 2)
            break
    else:
        out["margin"] = 9.0
    flat = warp(img, q)
    fh, fw = flat.shape[:2]
    small = cv2.resize(flat, (600, max(8, int(fh * 600 / fw))), interpolation=cv2.INTER_AREA)  # find_gutter works at 600
    out["landscape"] = fw > 1.12 * fh
    out["spread"] = find_gutter(ffc(small)) is not None
    out["sharp"] = sharpness(flat)  # the phone had not focused yet (自動拍 right as the camera opened)
    out["blurry"] = 0 < out["sharp"] < SHARP_MIN
    return out


# --- the sheet from its 4 straight edges (the same way as the live camera's green frame) ------------
# Paper area → brightness edges on and around it → the straight lines in view (Hough) → the 4 that best
# make a sheet (sides on brightness steps, paper inside), each side then fitted to the edge points along
# its middle (RANSAC: a line through the most of them) and neighbouring sides met at the corners. A cut,
# folded or stapled corner, or the pages of a stapled stack turned over behind it, does not move them.

LW = 200  # working width (px): as the camera's live copy — larger, printed text rows look like edges


def _sheet_mask(small: np.ndarray):
    lo = small.min(axis=2)  # bright and colourless: paper
    t, _ = cv2.threshold(lo, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = (lo > max(t, 100)).astype(np.uint8)
    # exactly as the camera does it (3×3 grown twice then shrunk twice, the outermost pixels left out):
    # the Pi then finds the same sheet as the green frame
    m = cv2.erode(cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=2), np.ones((3, 3), np.uint8), iterations=2,
                  borderType=cv2.BORDER_CONSTANT, borderValue=0)
    m[0], m[-1], m[:, 0], m[:, -1] = 0, 0, 0, 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 4)
    if n < 2:
        return None
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    if st[i, cv2.CC_STAT_AREA] < 0.15 * m.size:
        return None
    return (lab == i).astype(np.uint8)


def _step(lum, x, y, nx, ny, r):
    """1 where the brightness steps up into the sheet across (x, y) (inside = +normal), 0.5 off-view."""
    h, w = lum.shape
    xi, yi = np.rint(x + nx * r).astype(int), np.rint(y + ny * r).astype(int)
    xo, yo = np.rint(x - nx * r).astype(int), np.rint(y - ny * r).astype(int)
    ok_i = (xi >= 0) & (yi >= 0) & (xi < w) & (yi < h)
    ok_o = (xo >= 0) & (yo >= 0) & (xo < w) & (yo < h)
    li = lum[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)]
    lo = lum[np.clip(yo, 0, h - 1), np.clip(xo, 0, w - 1)]
    return np.where(~ok_i, 0.0, np.where(~ok_o, 0.5, (li - lo > 8).astype(float)))


def _inward(q, k):
    a, b = q[k], q[(k + 1) % 4]
    c = q.mean(0)
    d = (b - a) / (np.linalg.norm(b - a) + 1e-9)
    nrm = np.array([-d[1], d[0]])
    return (nrm if nrm @ (c - a) >= 0 else -nrm), d


def _sheet_score(lum, mask, q, r):
    h, w = lum.shape
    t = np.arange(0.03, 0.97, 0.02)
    sup = 0.0
    for k in range(4):
        a, b = q[k], q[(k + 1) % 4]
        nrm, _ = _inward(q, k)
        x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        off = (x < 1) | (y < 1) | (x >= w - 1) | (y >= h - 1)
        hit = np.maximum.reduce([_step(lum, x + nrm[0] * s, y + nrm[1] * s, nrm[0], nrm[1], r) for s in (-1, 0, 1)])
        sup += np.where(off, 0.5, hit).mean()
    u, v = np.meshgrid(np.arange(0.05, 1, 0.06), np.arange(0.05, 1, 0.06))
    top = q[0] + (q[1] - q[0]) * u[..., None]
    bot = q[3] + (q[2] - q[3]) * u[..., None]
    p = top + (bot - top) * v[..., None]
    xs, ys = np.rint(p[..., 0]).astype(int), np.rint(p[..., 1]).astype(int)
    ok = (xs >= 0) & (ys >= 0) & (xs < w) & (ys < h)
    inside = (ok & (mask[np.clip(ys, 0, h - 1), np.clip(xs, 0, w - 1)] > 0)).mean()
    area = abs(cv2.contourArea(q.astype(np.float32))) / (w * h)
    return (sup / 4) * inside ** 3 * np.sqrt(min(1.0, area / 0.5))


def _order4(p):
    p = np.asarray(p, np.float64)
    s, d = p.sum(1), p[:, 0] - p[:, 1]
    return np.array([p[np.argmin(s)], p[np.argmax(d)], p[np.argmax(s)], p[np.argmin(d)]])


def _hough_quad(pts, lum, mask, r):
    h, w = lum.shape
    NT, D = 180, int(np.ceil(np.hypot(w, h)))
    th = np.arange(NT) * np.pi / NT
    cs, sn = np.cos(th), np.sin(th)
    rho = np.rint(pts[:, :1] * cs + pts[:, 1:] * sn).astype(int) + D
    acc = np.zeros((NT, 2 * D + 1), np.int32)
    np.add.at(acc, (np.broadcast_to(np.arange(NT), rho.shape), rho), 1)
    size = min(w, h)
    minv = max(12 * r / 3, size * 0.12)
    ti, ri = np.nonzero(acc >= minv)
    order = np.argsort(-acc[ti, ri])
    lines = []
    for j in order:
        t, rr = int(ti[j]), int(ri[j]) - D
        if any((abs(L[0] - t) <= 5 and abs(L[1] - rr) <= 8 * r / 3) or (abs(L[0] - t) >= NT - 5 and abs(L[1] + rr) <= 8 * r / 3) for L in lines):
            continue
        lines.append((t, rr))
        if len(lines) >= 14:
            break
    if len(lines) < 4:
        return None

    def ang(A, B):
        d = abs(A[0] - B[0]) % NT
        return min(d, NT - d)

    def meet(A, B):
        a1, b1, a2, b2 = cs[A[0]], sn[A[0]], cs[B[0]], sn[B[0]]
        det = a1 * b2 - a2 * b1
        if abs(det) < 0.5:
            return None
        return ((A[1] * b2 - B[1] * b1) / det, (a1 * B[1] - a2 * A[1]) / det)

    pairs = []
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            A, B = lines[i], lines[j]
            if ang(A, B) > 15:
                continue
            rb = -B[1] if abs(A[0] - B[0]) > NT / 2 else B[1]
            if abs(A[1] - rb) < size * 0.25:
                continue
            pairs.append((A, B))
    best, bs = None, 0.0
    for i in range(len(pairs)):
        for j in range(i + 1, len(pairs)):
            (A, B), (C, E) = pairs[i], pairs[j]
            if abs(ang(A, C) - 90) > 25:
                continue
            ps = [meet(A, C), meet(A, E), meet(B, C), meet(B, E)]
            if any(p is None or p[0] < -0.1 * w or p[0] > 1.1 * w or p[1] < -0.1 * h or p[1] > 1.1 * h for p in ps):
                continue
            q = _order4(ps)
            if len({tuple(np.round(x, 3)) for x in q}) < 4:
                continue
            s = _sheet_score(lum, mask, q, r)
            if s > bs:
                bs, best = s, q
    return best


def _side_lines(pts, lum, q, r, rng):
    h, w = lum.shape
    size = min(w, h)
    lines = []
    for k in range(4):
        a, b = q[k], q[(k + 1) % 4]
        L = np.linalg.norm(b - a)
        if L < size * 0.2:
            return None
        nrm, d = _inward(q, k)
        rel = pts - a
        t = rel @ d / L
        dist = np.abs(rel @ nrm)
        sel = (t > 0.12) & (t < 0.88) & (dist < size * 0.12)
        cand = pts[sel]
        if len(cand):
            cand = cand[_step(lum, cand[:, 0], cand[:, 1], nrm[0], nrm[1], r * 2 / 3) > 0.5]
        if len(cand) < 12:
            return None
        tol = 1.2 * r / 3
        i1, i2 = rng.integers(0, len(cand), 120), rng.integers(0, len(cand), 120)
        u = cand[i2] - cand[i1]
        ul = np.linalg.norm(u, axis=1)
        good = (ul > L * 0.2)
        n_ = np.stack([-u[:, 1], u[:, 0]], 1) / (ul[:, None] + 1e-9)
        good &= np.abs(n_ @ d) < 0.5  # along this side
        if not good.any():
            return None
        n_, base = n_[good], cand[i1[good]]
        off = (n_ * base).sum(1)
        cnt = (np.abs(cand @ n_.T - off) < tol).sum(0)
        bi = int(np.argmax(cnt))
        if cnt[bi] < max(10, 0.25 * len(cand)):
            return None
        on = cand[np.abs(cand @ n_[bi] - off[bi]) < tol * 1.25]
        vx, vy, x0, y0 = cv2.fitLine(on.astype(np.float32), cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        nx, ny = -vy, vx
        lines.append((nx, ny, nx * x0 + ny * y0))
    out = []
    for k in range(4):
        a1, b1, c1 = lines[(k + 3) % 4]
        a2, b2, c2 = lines[k]
        det = a1 * b2 - a2 * b1
        if abs(det) < 0.3:
            return None
        x, y = (c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det
        if x < -0.08 * w or x > 1.08 * w or y < -0.08 * h or y > 1.08 * h or np.hypot(x - q[k][0], y - q[k][1]) > size * 0.35:
            return None
        out.append((x, y))
    return np.array(out)


def find_sheet_lines(img: np.ndarray, hint=None):
    """(corners tl, tr, br, bl in full-size pixels, how well they fit 0..1) or None. hint: corners (0..1)
    the sheet was lined up with (the camera's 單頁／雙頁 frame, the green outline) — edges looked for there."""
    h, w = img.shape[:2]
    sc = LW / w
    small = cv2.resize(img, (LW, max(8, round(h * sc))), interpolation=cv2.INTER_AREA)
    mask = _sheet_mask(small)
    if mask is None:
        return None
    sh, sw = mask.shape
    b, g, rr = small[..., 0].astype(np.int32), small[..., 1].astype(np.int32), small[..., 2].astype(np.int32)
    lum = ((rr * 77 + g * 150 + b * 29) >> 8).astype(np.float32)
    r = 3 * LW / 200  # the camera's 3 px step, at this size
    near = cv2.dilate(mask, np.ones((2 * int(r) + 1, 2 * int(r) + 1), np.uint8))
    gx = cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy) * (near > 0)
    horiz = np.abs(gx) > np.abs(gy)
    mx = np.maximum(np.roll(mag, 1, 1), np.roll(mag, -1, 1))
    my = np.maximum(np.roll(mag, 1, 0), np.roll(mag, -1, 0))
    edge = (mag >= 24) & np.where(horiz, mag >= mx, mag >= my)
    edge[:2], edge[-2:], edge[:, :2], edge[:, -2:] = False, False, False, False
    ys, xs = np.nonzero(edge)
    # steps only (the sheet's edge: brighter on one side) — a printed stroke has paper on both sides,
    # and rows of text otherwise outvote the sheet's top and bottom edges when the desk is light
    m_ = mag[ys, xs] + 1e-6
    ux, uy = gx[ys, xs] / m_, gy[ys, xs] / m_
    sh_, sw_ = lum.shape
    xa, ya = np.clip(np.rint(xs + ux * 3), 0, sw_ - 1).astype(int), np.clip(np.rint(ys + uy * 3), 0, sh_ - 1).astype(int)
    xb, yb = np.clip(np.rint(xs - ux * 3), 0, sw_ - 1).astype(int), np.clip(np.rint(ys - uy * 3), 0, sh_ - 1).astype(int)
    step = np.abs(lum[ya, xa] - lum[yb, xb]) >= 14
    xs, ys = xs[step], ys[step]
    pts = np.stack([xs, ys], 1).astype(np.float64)
    if len(pts) < 40:
        return None
    yy, xx = np.nonzero(mask)
    rough = np.array([[xx[np.argmax(v)], yy[np.argmax(v)]] for v in (-xx - yy, xx - yy, xx + yy, -xx + yy)], np.float64)
    starts = [rough]
    if hint is not None:
        starts = [np.array([[x * sw, y * sh] for x, y in hint], np.float64)]
    else:
        hq = _hough_quad(pts, lum, mask, r)
        if hq is not None:
            starts.append(hq)
    rng = np.random.default_rng(1)
    best, bs = None, -1.0
    for q in starts:
        for _ in range(2):
            f = _side_lines(pts, lum, q, r, rng)
            if f is None:
                break
            q = f
        s = _sheet_score(lum, mask, q, r)
        if s > bs:
            bs, best = s, q
    return best / sc, float(bs), (lambda qf: float(_sheet_score(lum, mask, np.asarray(qf, np.float64) * sc, r)))


def refine_sides(img: np.ndarray, q: np.ndarray) -> np.ndarray:
    """The 4 sides found at 200 px, made exact on a 1200 px copy: each side fitted again to the
    brightness step within a narrow band around it (its middle part), then the corners met again."""
    h, w = img.shape[:2]
    sc = min(1.0, 1200 / max(h, w))
    small = cv2.resize(img, (round(w * sc), round(h * sc)), interpolation=cv2.INTER_AREA) if sc < 1 else img
    lum = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    lum = cv2.GaussianBlur(lum, (3, 3), 0)
    gx = cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3)
    sh, sw = lum.shape
    qs = q * sc
    band = max(4.0, 0.012 * max(sh, sw))
    lines = []
    for k in range(4):
        a, b = qs[k], qs[(k + 1) % 4]
        nrm, _ = _inward(qs, k)
        t = np.linspace(0.12, 0.88, 160)
        pts = []
        offs = np.arange(-band, band + 0.5, 0.5)
        for tt in t:
            c = a + (b - a) * tt
            xs, ys = c[0] + nrm[0] * offs, c[1] + nrm[1] * offs
            xi, yi = np.rint(xs).astype(int), np.rint(ys).astype(int)
            ok = (xi >= 1) & (yi >= 1) & (xi < sw - 1) & (yi < sh - 1)
            if ok.sum() < len(offs) * 0.6:
                continue
            g = np.where(ok, gx[np.clip(yi, 0, sh - 1), np.clip(xi, 0, sw - 1)] * nrm[0]
                         + gy[np.clip(yi, 0, sh - 1), np.clip(xi, 0, sw - 1)] * nrm[1], -1e9)
            j = int(np.argmax(g))  # brightest step into the sheet across the side
            if g[j] > 40:
                pts.append((xs[j], ys[j]))
        if len(pts) < 40:
            lines.append(None)
            continue
        pts = np.array(pts, np.float32)
        vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        lines.append((-vy, vx, -vy * x0 + vx * y0))
    out = qs.copy()
    for k in range(4):
        A, B = lines[(k + 3) % 4], lines[k]
        if A is None or B is None:
            continue
        det = A[0] * B[1] - B[0] * A[1]
        if abs(det) < 0.3:
            continue
        x, y = (A[2] * B[1] - B[2] * A[1]) / det, (A[0] * B[2] - B[0] * A[2]) / det
        if np.hypot(x - qs[k][0], y - qs[k][1]) < 0.02 * max(sh, sw):  # a correction, not a new answer
            out[k] = (x, y)
    return out / sc


def find_page(img: np.ndarray) -> np.ndarray | None:
    """The 4 corners (tl, tr, br, bl, full-size pixels) of the sheet, or None (flat scan / unclear)."""
    h, w = img.shape[:2]
    sc = WORK / max(h, w)
    small = cv2.resize(img, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    sh, sw = gray.shape
    area = float(sh * sw)
    gx = cv2.Sobel(cv2.GaussianBlur(gray, (5, 5), 0), cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(cv2.GaussianBlur(gray, (5, 5), 0), cv2.CV_32F, 0, 1)
    grad = cv2.dilate(cv2.magnitude(gx, gy), np.ones((5, 5), np.uint8))
    # the page's text: dark, small, in the middle part of the paper-ish area
    raw = cv2.adaptiveThreshold(gray, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15)
    ink = raw > 0
    # text blocks (lines of characters), not photo noise: ink smeared into blocks, small specks dropped
    tb = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    tb = cv2.morphologyEx(tb, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n_, l_, st_, _ = cv2.connectedComponentsWithStats(tb, 8)
    keep_ = np.zeros(n_, np.uint8)
    keep_[1:] = (st_[1:, cv2.CC_STAT_AREA] > 60) & (st_[1:, cv2.CC_STAT_AREA] < 0.05 * gray.size)
    raw = keep_[l_]
    # text: only well inside paper (the sheet's own edge against the desk is "ink" to the threshold)
    ink &= cv2.erode(_paper_mask(small), np.ones((7, 7), np.uint8)) > 0
    ink = ink.astype(np.uint8)
    # the page's main text block: its lines joined (gaps up to ~2 lines), the biggest cluster
    cs_ = _char_size(gray)
    kk = int(max(7, cs_ * 1.8)) | 1
    tb = cv2.morphologyEx((raw & ink).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((kk, kk), np.uint8))
    nt, lt, stt, _ = cv2.connectedComponentsWithStats(tb, 8)
    tb = (lt == (1 + int(np.argmax(stt[1:, cv2.CC_STAT_AREA])))) if nt > 1 else np.zeros_like(tb, bool)
    cands = []
    pm = _paper_mask(small)
    n, lab, st, _ = cv2.connectedComponentsWithStats(pm, 8)
    for i in sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])[:3]:
        if st[i, cv2.CC_STAT_AREA] < 0.15 * area:
            continue
        cnts, _ = cv2.findContours((lab == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        c = max(cnts, key=cv2.contourArea)
        q = _quad_from_contour(c)
        cands.append(("mask", _refine(q, c.reshape(-1, 2).astype(np.float32))))
    cands += [("lines", q) for q in _line_quads(gray)]
    # the 4 straight edges, as the camera's green frame finds them (and made exact at 1200 px)
    edges = find_sheet_lines(img)
    if edges is not None:
        cands.append(("edges", (refine_sides(img, edges[0]) * sc).astype(np.float32)))
    best, bs, braw = None, 0.0, 0.0
    ebest = None
    for src, q in cands:
        parts = []
        s0 = s = _score(q, grad, ink, area, parts, raw, tb)
        if edges is not None and s > 0:
            # both judges: the text/margins one above, and the edges one (sides on brightness steps,
            # paper inside) — a fold line across the page or the sheets around it fail one of them
            es = edges[2](q / sc)
            s *= 0.4 + es
            # text left outside (parts[1] = the share inside) is only right when the outline sits on
            # clear edges all round (the pages of a stack turned behind); otherwise it cuts the page
            if parts and parts[1] < 0.9 and es < 0.5:
                s = s0 = -1
        if _DBG is not None:
            _DBG.append((s, q, src, parts, s0))
        if src == "edges":
            ebest = (q, s, s0)
        if s > bs:
            best, bs, braw = q, s, s0
    # the edge-line outline fitting cleanly and nearly as good on both judges: it is the one the green
    # frame showed (at 200 px the judges cannot tell a few pixels apart; the edges were fitted exactly)
    if ebest is not None and edges[1] >= 0.9 and ebest[1] >= 0.9 * bs and ebest[2] >= 3.0:
        best, bs, braw = ebest
    if best is None or braw < 3.0:
        return None
    if cv2.contourArea(best) > 0.97 * area:
        return None  # the sheet fills the photo already
    return best / sc


def warp(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = quad
    W = int(max(np.hypot(*(tr - tl)), np.hypot(*(br - bl))))
    H = int(max(np.hypot(*(bl - tl)), np.hypot(*(br - tr))))
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    M = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    out = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    m = max(2, int(min(W, H) * 0.004))
    return out[m:H - m, m:W - m]


# --- 3. flat-field correction ------------------------------------------------------------------

def _char_size(gray: np.ndarray) -> float:
    bw = cv2.adaptiveThreshold(gray, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    n, _, st, _ = cv2.connectedComponentsWithStats(bw, 8)
    hs = st[1:, cv2.CC_STAT_HEIGHT]
    hs = hs[(hs > 4) & (hs < gray.shape[0] / 15)]
    return float(np.median(hs)) if len(hs) > 20 else gray.shape[0] / 80


def ffc(img: np.ndarray) -> np.ndarray:
    """Flat-field correction: divide by the paper's brightness field (ink taken out), then even out
    thin shading lines along rows and columns (fold, page-turn line, crease), white paper, black ink."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    f = 4
    small = cv2.resize(img, (max(8, w // f), max(8, h // f)), interpolation=cv2.INTER_AREA)
    ch = max(2.0, _char_size(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)))
    k = int(ch * 2.5) | 1
    # each colour channel has its own paper level: a shadow lit by a blue sky or a warm lamp comes out
    # neutral white, not tinted (closing takes text and highlighter strokes, narrower than k, out)
    se = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    bgs = []
    for c in range(3):
        bg = cv2.morphologyEx(small[:, :, c], cv2.MORPH_CLOSE, se)
        bg = cv2.medianBlur(bg, min(255, (k * 2) | 1))
        bg = cv2.GaussianBlur(bg.astype(np.float32), (0, 0), k / 2)
        bgs.append(cv2.resize(bg, (w, h), interpolation=cv2.INTER_CUBIC))
    bg = np.stack(bgs, axis=-1)
    out = img.astype(np.float32) * (255.0 / np.maximum(bg, 24))
    # fine pass: rows and columns of paper still darker than the paper around them (thin shading)
    g = np.clip(out.max(axis=2), 0, 255)
    paper = g > 200
    for axis in (1, 0):
        num = np.where(paper, g, 0).sum(axis=axis)
        cnt = paper.sum(axis=axis)
        prof = num / np.maximum(cnt, 1)
        ok = cnt > (0.25 * (w if axis == 1 else h))
        if ok.sum() < 10:
            continue
        prof = np.where(ok, prof, np.median(prof[ok]))
        wide = cv2.blur(prof.reshape(-1, 1).astype(np.float32), (1, max(31, int(ch * 12)) | 1)).ravel()
        gain = np.clip(wide / np.maximum(prof, 1), 1.0, 1.25)  # only lift darker lines, never darken
        out *= gain[:, None, None] if axis == 1 else gain[None, :, None]
    # white balance (paper → white), black point, a gentle contrast curve
    g = out.max(axis=2)
    paper_rgb = np.array([np.percentile(out[..., c][g > np.percentile(g, 60)], 50) for c in range(3)])
    out = out * (250.0 / np.maximum(paper_rgb, 1))
    lo = np.percentile(out.min(axis=2), 0.5)
    out = (out - lo) * (255.0 / max(1.0, 250 - lo))
    out = np.clip(out, 0, 255)
    lut = (255 * (np.arange(256) / 255.0) ** 1.15).astype(np.uint8)  # ink a little darker
    return cv2.LUT(out.astype(np.uint8), lut)


# --- 4. curved pages / books -------------------------------------------------------------------

def _lines(ink: np.ndarray, ch: float):
    """Text lines as curves, like Leptonica's dewarp: the page cut into vertical strips, the line
    centres found in each strip's row profile, then linked strip to strip. Returns [(xs, ys)]."""
    h, w = ink.shape
    n = max(8, min(24, int(w / (ch * 4))))
    sw = w / n
    peaks = []
    sig = max(1.0, ch / 3)
    for k in range(n):
        x0, x1 = int(k * sw), int((k + 1) * sw)
        prof = cv2.GaussianBlur(ink[:, x0:x1].sum(1).astype(np.float32).reshape(-1, 1), (1, 0), sig).ravel()
        if prof.max() <= 0:
            peaks.append(np.array([]))
            continue
        thr = 0.25 * np.percentile(prof[prof > 0], 90) if (prof > 0).any() else 1
        d = int(max(2, ch * 0.6))
        loc = [y for y in range(d, h - d) if prof[y] > thr and prof[y] == prof[y - d:y + d + 1].max()]
        peaks.append(np.array(loc, np.float32))
    xc = (np.arange(n) + 0.5) * sw
    used = [np.zeros(len(p), bool) for p in peaks]
    lines = []
    for k0 in range(n):
        for a in range(len(peaks[k0])):
            if used[k0][a]:
                continue
            xs, ys, k, y = [xc[k0]], [peaks[k0][a]], k0, peaks[k0][a]
            used[k0][a] = True
            slope = 0.0
            while k + 1 < n and len(peaks[k + 1]):
                pred = y + slope
                j = int(np.argmin(np.abs(peaks[k + 1] - pred)))
                if abs(peaks[k + 1][j] - pred) > 0.45 * ch or used[k + 1][j]:
                    break
                used[k + 1][j] = True
                slope = 0.7 * slope + 0.3 * (peaks[k + 1][j] - y)
                y = peaks[k + 1][j]
                k += 1
                xs.append(xc[k])
                ys.append(y)
            if len(xs) >= max(5, n // 3):
                lines.append((np.array(xs, np.float32), np.array(ys, np.float32)))
    return lines


def _poly_terms(x, y, w, h):
    u, v = x / w * 2 - 1, y / h * 2 - 1
    return np.stack([u ** i * v ** j for i in range(4) for j in range(3)], axis=-1)


def dewarp(img: np.ndarray) -> tuple[np.ndarray, dict]:
    """Make the text lines straight and level (curled sheets, thick books): a smooth displacement
    fitted to all the page's text lines. 直書 pages use their columns instead (done transposed)."""
    h, w = img.shape[:2]
    f = max(1, int(round(max(h, w) / 1600)))
    small = cv2.resize(img, (w // f, h // f), interpolation=cv2.INTER_AREA) if f > 1 else img
    g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    bw = cv2.adaptiveThreshold(g, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 18)
    ch = _char_size(g)
    bw = (bw & (g < 120)).astype(np.uint8)  # dark print only: a grey watermark is not a text line
    lh, lv = _lines(bw, ch), _lines(bw.T.copy(), ch)
    vertical = sum(len(x) for x, _ in lv) > 1.3 * sum(len(x) for x, _ in lh)
    lines = lv if vertical else lh
    sh, sw = (bw.T.shape if vertical else bw.shape)
    info = {"lines": len(lines), "vertical": bool(vertical), "applied": False}
    if len(lines) < 5:
        return img, info
    X, Y, D = [], [], []
    for xs, ys in lines:
        c = np.polyfit(xs, ys, 3 if len(xs) > 10 else 2)
        fy = np.polyval(c, xs)
        if np.abs(fy - ys).mean() > ch * 0.4:
            continue  # not a clean line (a table, a picture)
        target = np.median(fy)
        X.append(xs), Y.append(fy), D.append(fy - target)
    if len(X) < 5:
        return img, info
    X, Y, D = np.concatenate(X), np.concatenate(Y), np.concatenate(D)
    A = _poly_terms(X, Y, sw, sh)
    lam = 1e-2 * len(D)  # a little ridge: a smooth surface, no wild terms
    coef = np.linalg.solve(A.T @ A + lam * np.eye(A.shape[1]), A.T @ D)
    resid_before = np.abs(D).mean()
    resid_after = np.abs(D - A @ coef).mean()
    info.update(bend=float(resid_before / ch), left=float(resid_after / ch))
    # nothing to straighten, or the fit does not explain the bending: leave the page as it is
    if resid_before < 0.12 * ch or resid_after > 0.7 * resid_before:
        return img, info
    # displacement map at full size (transposed for 直書)
    H, W = (w, h) if vertical else (h, w)
    gy, gx = np.mgrid[0:H:8, 0:W:8].astype(np.float32)
    # no extrapolation beyond the text: outside the lines' extent the nearest fitted value is used
    cx = np.clip(gx / f, X.min(), X.max())
    cy = np.clip(gy / f, Y.min(), Y.max())
    disp = (_poly_terms(cx.ravel(), cy.ravel(), sw, sh) @ coef).reshape(gx.shape) * f
    lim = 0.05 * H
    if np.abs(disp).max() > lim:
        info["too_big"] = float(np.abs(disp).max() / H)
        return img, info
    disp = cv2.GaussianBlur(disp.astype(np.float32), (0, 0), 3)
    disp = cv2.resize(disp.astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC)
    mx, my = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    my = my + disp
    if vertical:
        mx, my = my.T.copy(), mx.T.copy()
    out = cv2.remap(img, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    info["applied"] = True
    return out, info


# --- 5. staples ------------------------------------------------------------------------------

def remove_staples(img: np.ndarray) -> tuple[np.ndarray, int]:
    """Staples: small dark or shiny metal pieces, alone, near a corner — painted over with paper."""
    h, w = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    zone = np.zeros((h, w), np.uint8)
    cw, chh = int(w * 0.09), int(h * 0.07)  # staples sit right at a corner
    for x0, y0 in ((0, 0), (w - cw, 0), (0, h - chh), (w - cw, h - chh)):
        zone[y0:y0 + chh, x0:x0 + cw] = 1
    metal = ((g < 90) & (hsv[:, :, 1] < 60)).astype(np.uint8) & zone
    n, lab, st, _ = cv2.connectedComponentsWithStats(metal, 8)
    mask = np.zeros((h, w), np.uint8)
    found = 0
    near = cv2.dilate((g < 150).astype(np.uint8), np.ones((1, 1), np.uint8))
    for i in range(1, n):
        x, y, ww, hh, a = st[i]
        L, S = max(ww, hh), min(ww, hh)
        if not (0.02 * w < L < 0.07 * w and S < 0.25 * L and a > 0.25 * L * S * 0.5):
            continue  # a staple is a short, thin bar (a pencil "1" is shorter and not this dark)
        blob = g[y:y + hh, x:x + ww][lab[y:y + hh, x:x + ww] == i]
        if np.percentile(blob, 20) > 45:
            continue  # metal is near black (pencil is grey)
        pad = int(L * 0.8)
        y0, y1, x0, x1 = max(0, y - pad), min(h, y + hh + pad), max(0, x - pad), min(w, x + ww + pad)
        around = near[y0:y1, x0:x1].sum() - (lab[y0:y1, x0:x1] == i).sum()
        if around > 0.6 * a:
            continue  # other ink close by: text, not a staple
        mask[lab == i] = 255
        found += 1
    if found:
        mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
        img = cv2.inpaint(img, mask, 5, cv2.INPAINT_TELEA)
    return img, found


def clear_border(img: np.ndarray) -> np.ndarray:
    """Table, cloth or a book's page edges left along the border after the warp: dark areas that
    touch the image edge and are big are painted paper-white (text never touches the edge)."""
    h, w = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    dark = (g < 110).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark, 8)
    out = img
    for i in range(1, n):
        x, y, ww, hh, a = st[i]
        touches = x == 0 or y == 0 or x + ww >= w or y + hh >= h
        if touches and a > 0.0015 * h * w and (min(ww, hh) < 0.12 * min(h, w)):
            out = out.copy() if out is img else out
            m = cv2.dilate((lab == i).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
            out[m] = 255
    return out


def find_gutter(img: np.ndarray) -> int | None:
    """A two-page spread (an A3 sheet folded, an open book): the x of the fold between the pages —
    a column band in the middle with no text and/or a darker shading line. None when it is one page."""
    h, w = img.shape[:2]
    if w < 1.15 * h:
        return None  # a spread is wider than tall
    sc = 600 / w
    g = cv2.cvtColor(cv2.resize(img, (600, max(8, int(h * sc))), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    ink = (g < 150).astype(np.float32)
    col = cv2.blur(ink.mean(0).reshape(1, -1), (9, 1)).ravel()
    side = np.median(col[60:540])
    if side < 0.01:
        return None
    thr = 0.25 * side
    x = 210 + int(np.argmin(col[210:390]))
    if col[x] >= thr:
        return None
    a, b = x, x
    while a > 0 and col[a] < thr:
        a -= 1
    while b < 599 and col[b] < thr:
        b += 1
    bands = int(np.sum(np.diff((col < thr).astype(int)) == 1))
    # a fold between two pages: a wide blank band (3–35 % of the width), few others — the gaps between
    # 直書 columns are narrow and many
    if 18 <= b - a <= 210 and bands <= 8:
        return int((a + b) / 2 / sc)
    # a booklet opened flat: the pages meet closely — a narrower blank band, but right in the middle
    if 8 <= b - a < 18 and 0.42 * 600 <= (a + b) / 2 <= 0.58 * 600 and bands <= 8 and col[a:b + 1].min() < 0.12 * side:
        return int((a + b) / 2 / sc)
    return None


# --- all together -------------------------------------------------------------------------------

def looks_digital(img: np.ndarray) -> bool:
    """A file made on a computer (PDF page, screenshot, scanner output) rather than a photo: much of
    it pure white and its border white too (a photo of paper has sensor noise, shading and usually the
    desk around it). Such a page is already flat — outline, flat-field and dewarp would only harm it."""
    s = 600 / max(img.shape[:2])
    small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img
    lo = small.min(axis=2)
    if (lo >= 250).mean() < 0.35:
        return False
    b = max(2, int(min(lo.shape) * 0.02))
    edge = np.concatenate([lo[:b].ravel(), lo[-b:].ravel(), lo[:, :b].ravel(), lo[:, -b:].ravel()])
    return (edge >= 235).mean() > 0.9


def scan(img: np.ndarray, corners: list | None = None, spread: bool | None = None,
         digital: bool | str | None = None) -> tuple[np.ndarray, dict]:
    """A photo (already loaded, EXIF-rotated) → (flat scan, what was done). `corners`: the 4 corners
    a person placed (tl, tr, br, bl as 0..1 of the photo) — used instead of the automatic outline;
    [] = use the whole photo. `digital`: True for a PDF page, "auto" for a file read in (讀檔) —
    a computer-made page is kept as it is."""
    h, w = img.shape[:2]
    if corners is None and (digital is True or (digital == "auto" and looks_digital(img))):
        return img, {"digital": True, "warped": False, "manual": False, "corners": [], "spread": False,
                     "dewarp": {"applied": False}, "staples": 0}
    if corners is not None and len(corners) == 4:
        quad = np.array([[x * w, y * h] for x, y in corners], np.float32)
        manual = True
    elif corners == []:
        quad, manual = None, True
    else:
        quad, manual = find_page(img), False
    info = {"warped": quad is not None, "manual": manual,
            "corners": [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in quad] if quad is not None else []}
    if quad is not None:
        img = warp(img, quad)
    info["sharp"] = sharpness(img)  # kept with the page: a blurry one can be told from a bad read
    img = ffc(img)
    # two pages side by side (雙頁): each page curls on its own — straightened half by half
    gx = find_gutter(img) if spread is not False else None
    if spread and gx is None:
        gx = img.shape[1] // 2
    info["spread"] = gx is not None
    info["gutter"] = round(gx / img.shape[1], 4) if gx is not None else None
    if gx is not None:
        (left, dl), (right, dr) = dewarp(img[:, :gx]), dewarp(img[:, gx:])
        img = np.hstack([left, right])
        d = {"applied": dl.get("applied") or dr.get("applied"), "halves": [dl, dr]}
    else:
        img, d = dewarp(img)
    info["dewarp"] = d
    if d.get("applied"):
        img = ffc(img)  # the stretched parts evened out again
    img, info["staples"] = remove_staples(img)
    img = clear_border(img)
    return img, info
