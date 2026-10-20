"""用 iPad 寫: a handwriting canvas on another device, mirrored live.

The computer (e.g. a MacBook with no pen) opens a session for one question
and shows a QR code. The tablet scans it, writes on a full-screen canvas,
and every finished stroke is sent here; the computer polls and redraws the
same strokes, then grades them with the normal handwriting tutor. The
session token in the QR code is the tablet's only credential: random,
single-question, and gone after 30 minutes. Sessions live in memory — a
restart just means scanning again."""
import io
import secrets
import shutil
import time
from pathlib import Path

import segno

TTL = 30 * 60
PHOTO_TTL = 6 * 3600  # a photo session lives through a whole afternoon of photographing exams
MAX_BYTES = 2_000_000  # strokes JSON per session
_pads: dict[str, dict] = {}


def _sweep():
    now = time.time()
    for t in [t for t, p in _pads.items() if now - p["touched"] > (PHOTO_TTL if p.get("kind") == "photos" else TTL)]:
        close(t)


def create(student_id: int, question_id: int, kind: str = "write") -> dict:
    _sweep()
    if kind == "photos":
        # the same phone connection is reused: leaving the scan page (to check an exam) and coming
        # back must not end it — the phone keeps shooting and pages not sent yet stay
        live = [p for p in _pads.values() if p["student_id"] == student_id and p.get("kind") == "photos"]
        if live:
            p = max(live, key=lambda x: x["created"])
            p["touched"] = time.time()
            return p
    # one live session of each kind per child: a new one replaces the old
    for t in [t for t, p in _pads.items() if p["student_id"] == student_id and p.get("kind", "write") == kind]:
        close(t)
    token = secrets.token_urlsafe(12)
    _pads[token] = {"token": token, "student_id": student_id, "question_id": question_id, "strokes": [],
                    "w": 0, "h": 0, "v": 0, "status": "writing", "result": None, "submit_v": 0,
                    "created": time.time(), "touched": time.time(), "tablet_seen": 0.0,
                    "kind": kind, "photos": [], "exam_id": None}
    return _pads[token]


def get(token: str) -> dict | None:
    _sweep()
    p = _pads.get(token)
    if p:
        p["touched"] = time.time()
    return p


def active_for(student_id: int) -> dict | None:
    _sweep()
    mine = [p for p in _pads.values() if p["student_id"] == student_id and p["status"] != "closed"
            and p.get("kind", "write") == "write"]
    return max(mine, key=lambda p: p["created"]) if mine else None


def close(token: str):
    _pads.pop(token, None)  # photos not sent yet are kept on disk (never thrown away silently)


def qr_svg(url: str) -> str:
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="svg", scale=5, border=2, dark="#1C1E21", light="#FFFFFF")
    return buf.getvalue().decode()
