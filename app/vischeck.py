"""Every diagram is looked at before a child sees it.

A diagram (visual) is drawn by the same front-end code the child uses, in the
Pi's headless Chromium, and the picture is shown to the AI with the question:
are the numbers right, the labels readable and not overlapping, the answer not
given away, and would a child of that grade see how to solve it? If not, the AI
redraws it from that feedback and it is checked again; a diagram that still
fails is dropped (no picture is better than a confusing one)."""
import asyncio
import json
import logging
import secrets
import tempfile
from pathlib import Path

import cv2
import numpy as np

from . import ai
from .config import MEDIA_DIR, PORT
from .exporters import _chromium, chrome_cmd

log = logging.getLogger("vischeck")
_pending: dict[str, dict] = {}   # token -> visual, read by /api/vrender
_drawn: dict[str, bool] = {}     # token -> did the page draw anything (reported back by the page)
_lock = asyncio.Lock()           # one Chromium at a time on the Pi


def take(token: str) -> dict | None:
    return _pending.get(token)


def report(token: str, drawn: bool):
    if token in _pending:
        _drawn[token] = drawn


async def render(visual: dict) -> bytes | None:
    """PNG of the diagram as drawn for the child (trimmed to its content); b"" when
    the diagram itself draws nothing; None when the renderer could not run (then
    nothing is judged — a Chromium hiccup must never throw away a good diagram)."""
    exe = _chromium()
    if not exe:
        return None
    token = secrets.token_urlsafe(10)
    _pending[token] = visual
    out = Path(tempfile.mkdtemp()) / "v.png"
    url = f"http://127.0.0.1:{PORT}/vrender.html?k={token}"
    async with _lock:
        proc = await asyncio.create_subprocess_exec(
            *chrome_cmd(exe, "vis"), "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
            "--force-device-scale-factor=2", "--window-size=672,900", "--virtual-time-budget=5000",
            f"--screenshot={out}", url, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(proc.wait(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
    _pending.pop(token, None)
    drawn = _drawn.pop(token, None)
    if drawn is False:
        out.unlink(missing_ok=True)
        return b""
    if drawn is None or not out.exists():
        return None
    img = cv2.imread(str(out))
    out.unlink(missing_ok=True)
    if img is None:
        return None
    mask = (img.min(axis=2) < 245).astype(np.uint8)
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return b""
    y1 = min(img.shape[0], ys.max() + 24)
    ok, buf = cv2.imencode(".png", img[: y1, :])
    return buf.tobytes() if ok else None


CACHE = MEDIA_DIR / "vis"


def _key(v: dict) -> str:
    import hashlib
    raw = json.dumps({k: v.get(k) for k in ("type", "params_json", "params", "caption", "title")}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


async def pngs(visuals: list[dict]) -> list[Path | None]:
    """PNG files of many diagrams (for Word), drawn in one Chromium run and cached."""
    import base64
    CACHE.mkdir(parents=True, exist_ok=True)
    paths = [CACHE / f"{_key(v)}.png" for v in visuals]
    todo = [i for i, p in enumerate(paths) if not p.exists()]
    exe = _chromium()
    if todo and exe:
        token = secrets.token_urlsafe(10)
        _pending[token] = [visuals[i] for i in todo]
        url = f"http://127.0.0.1:{PORT}/vpng.html?k={token}"
        async with _lock:
            proc = await asyncio.create_subprocess_exec(
                *chrome_cmd(exe, "vis"), "--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=30000", "--dump-dom", url,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
            except asyncio.TimeoutError:
                proc.kill()
                out = b""
        _pending.pop(token, None)
        txt = out.decode("utf-8", "replace")
        if "@@PNGS@@" in txt and "@@END@@" in txt:
            import html as _html
            try:
                res = json.loads(_html.unescape(txt.split("@@PNGS@@", 1)[1].split("@@END@@", 1)[0]))
            except ValueError:
                res = []
            for i, r in zip(todo, res):
                if r and r.get("png"):
                    paths[i].write_bytes(base64.b64decode(r["png"]))
    return [p if p.exists() else None for p in paths]


async def refine(context: str, visual: dict, grade: int = 6, tries: int = 2) -> tuple[dict | None, dict]:
    """(visual that passed or None, last verdict)."""
    verdict = {"ok": False, "problems": ["沒有畫出來"]}
    for attempt in range(tries + 1):
        png = await render(visual)
        if png is None:
            return visual, {"ok": True, "problems": [], "unchecked": True}  # renderer down: check later
        if not png:
            verdict = {"ok": False, "problems": ["圖畫不出來（資料格式錯誤或缺少內容），請用正確的格式重畫"]}
        else:
            try:
                verdict = await ai.check_visual(context, visual, png, grade)
            except ai.AIError as e:
                log.warning("visual check failed: %s", e)
                return visual, {"ok": True, "problems": [], "unchecked": True}  # AI down: keep it, check later
            if verdict.get("ok"):
                return visual, verdict
        if attempt == tries:
            break
        try:
            visual = await ai.fix_visual(context, visual, verdict.get("problems") or [], grade)
        except ai.AIError as e:
            log.warning("visual fix failed: %s", e)
            break
    return None, verdict


async def refine_all(context: str, visuals: list, grade: int = 6) -> list:
    kept = []
    for v in visuals or []:
        if not isinstance(v, dict) or not v.get("type"):
            continue
        good, _ = await refine(context, v, grade)
        if good:
            kept.append(good)
    return kept
