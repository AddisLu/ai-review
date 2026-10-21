"""AI 總複習學習站 — FastAPI server for the Raspberry Pi."""
import base64
import asyncio
import hashlib
import hmac
import json
import logging
import os
import random
import re
import shutil
import time
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import accounts, ai, analysis, bankview, curriculum, db, exporters, gamify, imaging, jobs, nas, pads, pipeline, practice, printing, qstate, templates, vischeck
from .config import DATA_DIR, DEFAULT_SETTINGS, EXPORT_DIR, MEDIA_DIR, STATIC_DIR, UPLOAD_DIR

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("app")

VERSION = "1.0.0"


@asynccontextmanager
async def _lifespan(app):
    import asyncio
    db.mark_loop_thread()  # writes nobody waits for leave this thread (db.execute_later)
    db.mark_interrupted()  # the server is (re)starting: nothing of the old process is still running
    # an exam's diagrams cut off by a restart carry on where they stopped, once
    cut = db.q("SELECT id, ref_id FROM jobs WHERE kind='visuals' AND status='error' AND message LIKE '伺服器重新啟動%'")
    for eid in {j["ref_id"] for j in cut}:
        ids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=?", (eid,))]
        if ids:
            jobs.start("visuals", eid, pipeline.visuals_job, ids)
    for j in cut:
        db.update("jobs", j["id"], {"message": "伺服器重新啟動，已接續"})
    # 題目升級 cut off by a restart carries on (questions already done are skipped)
    up = db.q("SELECT id, kind, ref_id FROM jobs WHERE kind IN ('upgrade_all','upgrade') AND status='error' "
              "AND message LIKE '伺服器重新啟動，請重試'")
    if any(j["kind"] == "upgrade_all" for j in up):
        ahead(("upgrade_all",), "upgrade_all", 0, pipeline.upgrade_all_job, False)
    for eid in {j["ref_id"] for j in up if j["kind"] == "upgrade"}:
        ahead(("upgrade", eid), "upgrade", eid, pipeline.upgrade_exam_job, eid)
    for j in up:
        db.update("jobs", j["id"], {"message": "伺服器重新啟動，已接續"})
    # the 詳解 after a 批改, cut off by a restart: carry on (questions already solved are skipped)
    for j in db.q("SELECT id, ref_id FROM jobs WHERE kind='solve_bg' AND status='error' AND message LIKE '伺服器重新啟動，請重試'"):
        db.update("jobs", j["id"], {"message": "伺服器重新啟動，已接續"})
        qids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (j["ref_id"],))]
        ahead(("solve_bg", j["ref_id"]), "solve_bg", j["ref_id"], pipeline.solve_then_upgrade_job, j["ref_id"], qids)
    # 批改 cut off by a restart after its pages were read: grade now (the 詳解 come later)
    for e in db.q("SELECT id, options FROM exams WHERE status IN ('ready','solving')"):
        if isinstance(e["options"], dict) and e["options"].get("mode") == "grade" and not e["options"].get("grade") and \
                db.scalar("SELECT COUNT(*) FROM questions WHERE exam_id=?", (e["id"],)) and \
                not db.scalar("SELECT 1 FROM pages WHERE exam_id=? AND status IN ('queued','error')", (e["id"],)):
            jobs.start("exam", e["id"], pipeline.resume_grade_job, e["id"])
    cut_refresh = db.q("SELECT id FROM jobs WHERE kind='refresh_all' AND status='error' AND message LIKE '伺服器重新啟動，請重試'")
    if cut_refresh:  # 全部跑一遍 cut off by this restart: carry on (finished questions are not redone)
        for j in cut_refresh:
            db.update("jobs", j["id"], {"message": "伺服器重新啟動，已接續"})
        ahead(("refresh_all",), "refresh_all", 0, pipeline.refresh_all_job, True)
    if not db.get_setting("refresh_v2_started"):  # once: layouts read, everything proofread again, papers remade
        db.set_setting("refresh_v2_started", db.now())
        ahead(("refresh_all",), "refresh_all", 0, pipeline.refresh_all_job)
    if not db.get_setting("figures_svg_v1_started"):  # figures still kept as photos: drawn again, once
        db.set_setting("figures_svg_v1_started", db.now())
        ahead(("redraw_figures",), "redraw_figures", 0, pipeline.redraw_figures_job)
    if db.q("SELECT id FROM jobs WHERE kind='redraw_figures' AND status='error' AND message LIKE '伺服器重新啟動，請重試'"):
        db.execute("UPDATE jobs SET message='伺服器重新啟動，已接續' WHERE kind='redraw_figures' AND message LIKE '伺服器重新啟動，請重試'")
        ahead(("redraw_figures",), "redraw_figures", 0, pipeline.redraw_figures_job)
    if not db.get_setting("school_v1_started"):  # 學校考卷 for every exam photographed so far, once
        db.set_setting("school_v1_started", db.now())
        ahead(("school_all",), "school_all", 0, pipeline.school_all_job)
    if not db.get_setting("upgrade_v1_started"):  # 題目升級 for every exam photographed so far, once
        db.set_setting("upgrade_v1_started", db.now())
        ahead(("upgrade_all",), "upgrade_all", 0, pipeline.upgrade_all_job, False)
    if not db.get_setting("regrade_e25_v1_started") and db.one("SELECT id FROM exams WHERE id=25 AND title LIKE '三上 數學 CH4（中）%'"):
        # asked for on 2026-10-15: its misread pages read again (spread split) and graded again (new grader)
        db.set_setting("regrade_e25_v1_started", db.now())
        ahead(("rescan", 25), "rescan", 25, pipeline.reread_then_grade_job, 25, [233, 235, 240, 245])
    if not db.get_setting("resolve_e25_v1_started") and db.one("SELECT id FROM pages WHERE id=262 AND exam_id=25"):
        # the same exam: answers left from when its spread was misread — worked out again
        db.set_setting("resolve_e25_v1_started", db.now())
        jobs.start("page", 25, pipeline.resolve_pages_job, 25, [262, 233])
    if not db.get_setting("cont_e25_v1_started") and db.one("SELECT id FROM exams WHERE id=25"):
        # the same exam: a question whose options run on to the next page (第 19 題 ③④) put together
        db.set_setting("cont_e25_v1_started", db.now())
        jobs.start("page", 25, pipeline.continuations_job, 25)
    if not db.get_setting("split_e25_v3_started") and db.one("SELECT id FROM pages WHERE id=262 AND exam_id=25"):
        # the same spread: its two pages came out swapped (turned 90° the wrong way) — swapped back, read again upright
        db.set_setting("split_e25_v3_started", db.now())
        jobs.start("page", 25, pipeline.fix_spread_job, 25, [262, 233])
    if not db.get_setting("split_e25_v2_started") and db.one("SELECT id FROM pages WHERE id=233 AND exam_id=25"):
        # asked for on 2026-10-15: its upside-down two-page spread turned, cut into two pages, Q7 joined to its options
        db.set_setting("split_e25_v2_started", db.now())
        jobs.start("page", 25, pipeline.replace_page_job, 25, 233)
    task = asyncio.get_running_loop().create_task(nas.loop())  # background NAS sync
    asyncio.get_running_loop().create_task(_lag_watch())
    asyncio.get_running_loop().create_task(_clean_exports())
    asyncio.get_running_loop().create_task(_chapter_sweep())
    # 問 AI answers sooner: a Claude process for it is started now and kept ready
    for g in {int(r["grade"] or 6) for r in db.q("SELECT grade FROM students WHERE role!='parent'")}:
        ai.prewarm_chat(_chat_system(True), _setting("effort_chat"), g)
    ahead(("vischeck_all",), "vischeck_all", 0, pipeline.vischeck_all_job, False)  # any diagram not yet looked at by the AI
    yield
    task.cancel()


async def _chapter_sweep():
    """自然 questions not yet placed in the review book's 章節 (new scans too) get placed, a few minutes
    after things go quiet — never while an exam is being read."""
    while True:
        await asyncio.sleep(300)
        try:
            if db.scalar("SELECT 1 FROM questions WHERE subject IN ('自然') AND COALESCE(chapter,'')='' LIMIT 1") and \
                    not db.scalar("SELECT 1 FROM jobs WHERE kind IN ('exam','chapters') AND status IN ('queued','running') LIMIT 1"):
                ahead(("chapters",), "chapters", 0, pipeline.chapters_job)
        except Exception as e:  # noqa: BLE001 — never let the sweeper die
            log.warning("chapter sweep: %s", e)


async def _clean_exports():
    """Generated PDF / Word files older than 6 hours go (they are made again when asked for) — also
    the ones left in the old exports folder on the SD card."""
    from .config import OLD_EXPORT_DIR
    while True:
        cutoff = time.time() - 6 * 3600
        for d in {EXPORT_DIR, OLD_EXPORT_DIR}:
            for f in list(d.glob("*")) if d.exists() else []:
                try:
                    if f.is_file() and f.stat().st_mtime < cutoff:
                        f.unlink()
                except OSError:
                    pass
        await asyncio.sleep(3600)


async def _lag_watch():
    """Logs when something holds up the server (every page waits while it does) — with what
    the server was doing at that moment, seen from a watchdog thread."""
    import sys
    import threading
    import traceback
    loop_thread = threading.get_ident()
    beat = [time.monotonic()]

    def watchdog():
        told = told_all = 0.0
        while True:
            time.sleep(0.25)
            stuck = time.monotonic() - beat[0]
            if stuck > 1.0 and beat[0] != told:
                told = beat[0]
                frame = sys._current_frames().get(loop_thread)
                where = "".join(traceback.format_stack(frame)[-8:]) if frame else "?"
                log.warning("event loop stuck %.1fs in:\n%s", stuck, where)
            if stuck > 3.0 and beat[0] != told_all:  # long: what every other thread is doing (who holds the database?)
                told_all = beat[0]
                names = {t.ident: t.name for t in threading.enumerate()}
                for ident, frame in sys._current_frames().items():
                    if ident in (loop_thread, threading.get_ident()):
                        continue
                    st = traceback.format_stack(frame)
                    if any("ai-review/app" in x for x in st):
                        log.warning("  meanwhile %s:\n%s", names.get(ident, ident), "".join(st[-10:]))

    threading.Thread(target=watchdog, daemon=True, name="lag-watchdog").start()
    while True:
        t = time.monotonic()
        beat[0] = t
        await asyncio.sleep(0.5)
        lag = time.monotonic() - t - 0.5
        if lag > 0.3:
            log.warning("event loop blocked for %.2fs", lag)


app = FastAPI(title="AI 總複習學習站", version=VERSION, lifespan=_lifespan)


class _Gzip:
    """Compresses what is fetched (scripts, styles, JSON lists) — several times fewer bytes over
    the Pi's Wi-Fi. Uploads, the chat stream (a POST) and images/PDF/Word files are left alone."""
    def __init__(self, app):
        from starlette.middleware.gzip import GZipMiddleware
        self.app, self.gz = app, GZipMiddleware(app, minimum_size=1024, compresslevel=5)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "GET" and not scope["path"].startswith("/media/") \
                and not scope["path"].startswith(("/api/print/", "/api/backup", "/api/snap/", "/api/pad/")):
            return await self.gz(scope, receive, send)
        return await self.app(scope, receive, send)


class _ETag:
    """GET /api/… JSON gets an ETag (a hash of the body) and "no-cache": the browser keeps the last
    copy and asks "still this one?" — an unchanged exam (2 MB for a 59-page homework) comes back as an
    empty 304 instead of being downloaded again on every tap between its screens."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "GET" or not scope["path"].startswith("/api/") \
                or scope["path"].startswith(("/api/print/", "/api/backup", "/api/snap/", "/api/pad/", "/api/thumb/")):
            return await self.app(scope, receive, send)
        start, chunks = None, []

        async def wrapped(msg):
            nonlocal start
            if msg["type"] == "http.response.start":
                ct = dict(msg.get("headers") or []).get(b"content-type", b"")
                if msg["status"] != 200 or not ct.startswith(b"application/json"):
                    start = False
                    return await send(msg)
                start = msg
                return
            if start is False:
                return await send(msg)
            chunks.append(msg.get("body", b""))
            if msg.get("more_body"):
                return
            body = b"".join(chunks)
            tag = '"' + hashlib.blake2b(body, digest_size=12).hexdigest() + '"'
            hs = [(k, v) for k, v in start.get("headers", []) if k.lower() not in (b"content-length", b"etag", b"cache-control")]
            hs += [(b"etag", tag.encode()), (b"cache-control", b"private, no-cache")]
            inm = dict(scope.get("headers") or []).get(b"if-none-match", b"").decode()
            if tag in [t.strip() for t in inm.split(",")]:
                await send({"type": "http.response.start", "status": 304, "headers": hs})
                return await send({"type": "http.response.body", "body": b""})
            await send({**start, "headers": hs + [(b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, wrapped)


app.add_middleware(_ETag)
app.add_middleware(_Gzip)
db.init()


# --- auth ---------------------------------------------------------------------
# Optional family (site) password → then each person logs in to their own
# profile. Parents can look at any child's data; children only their own.

def _setting(k):
    return db.get_setting(k, DEFAULT_SETTINGS.get(k))


def _session_token(pw: str) -> str:
    secret = db.get_setting("secret") or ""
    if not secret:
        accounts.sign(0)  # creates the secret
        secret = db.get_setting("secret")
    return hmac.new(secret.encode(), pw.encode(), hashlib.sha256).hexdigest()


OPEN_PATHS = ("/api/login", "/api/status", "/api/print/spec/", "/api/auth/", "/api/setup",
              "/api/pad/", "/api/snap/")  # 用 iPad 寫 / 用手機拍: the QR code's session token is the phone's credential


def _site_ok(request: Request) -> bool:
    pw = _setting("site_password")
    return not pw or request.cookies.get("sess") == _session_token(pw)


@app.middleware("http")
async def auth(request: Request, call_next):
    path = request.url.path
    request.state.user = None
    if path.startswith("/api") or path.startswith("/media"):
        # Headless Chromium fetching media for a PDF comes from localhost.
        local = request.client and request.client.host == "127.0.0.1" and \
            request.headers.get("x-forwarded-for") is None and path.startswith(("/media", "/api/vrender/"))
        user = accounts.verify(request.cookies.get(accounts.COOKIE))
        request.state.user = user
        if user and not local and not path.startswith(("/api/jobs/", "/api/upgrade/status", "/api/pads/active", "/media")):
            ai.touch()  # someone is using the site: background AI work steps back
            db.touch()
        if not path.startswith(OPEN_PATHS) and not local:
            if not _site_ok(request) or not user:
                return JSONResponse({"detail": "請先登入"}, status_code=401)
        if user:
            accounts.current_grade.set(_viewed_grade(request, user))
    t0 = time.monotonic()
    response = await call_next(request)
    dt = time.monotonic() - t0
    if dt > 1.0 and not path.endswith(("/chat", "/stream")):
        log.info("slow request %.2fs %s %s", dt, request.method, path)
    if path.startswith("/static/") or (path.startswith("/v/") and not path.startswith(f"/v/{build()}/")):
        # an old page asking for scripts by an old address: always re-check (never a stale mix of
        # old and new scripts — that once stopped every login)
        response.headers["Cache-Control"] = "no-cache"
    # /v/<this build>/… keeps its "immutable": the address changes on every restart, so the
    # browser never needs to download the same script twice
    return response


def _viewed_grade(request: Request, user: dict) -> int:
    s = sid(request)
    return db.scalar("SELECT grade FROM students WHERE id=?", (s,)) or user["grade"] or 6


def is_parent(request: Request) -> bool:
    u = getattr(request.state, "user", None)
    return bool(u and u["role"] == "parent")


def parent_ok(request: Request) -> bool:
    if is_parent(request):
        return True
    pin = request.headers.get("x-parent-pin", "")
    return bool(pin and (accounts.check_parent_secret(pin) or
                         (accounts.setup_needed() and pin == str(_setting("parent_pin")))))


def need_parent(request: Request):
    if not parent_ok(request):
        raise HTTPException(403, "需要家長權限（請用家長帳號登入或輸入家長密碼）")


def sid(request: Request) -> int:
    """The student whose data this request reads/writes."""
    u = getattr(request.state, "user", None)
    if u and u["role"] == "parent":
        try:
            v = int(request.headers.get("x-student-id", "0"))
        except ValueError:
            v = 0
        if v and db.scalar("SELECT 1 FROM students WHERE id=?", (v,)):
            return v
        return u["id"]
    if u:
        return u["id"]
    return db.scalar("SELECT MIN(id) FROM students")


def own(request: Request, student_id) -> None:
    """Children may only touch their own records; parents may touch all."""
    if is_parent(request):
        return
    if student_id is not None and int(student_id or 0) != sid(request):
        raise HTTPException(403, "這不是你的資料")


def own_q(request: Request, qid: int) -> dict:
    """A question from the shared bank, overlaid with the viewer's own state."""
    q = qstate.get(sid(request), qid)
    if not q:
        raise HTTPException(404, "找不到題目")
    return q


def can_edit(request: Request, q: dict) -> bool:
    """Shared content (stem, answer, explanation) is edited by whoever added
    the question, or a parent."""
    return is_parent(request) or q["owner_id"] == sid(request)


def own_exam(request: Request, exam_id: int) -> dict:
    e = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    if not e:
        raise HTTPException(404, "找不到試卷")
    own(request, e["student_id"])
    return e


def own_page(request: Request, page_id: int) -> dict:
    p = db.one("SELECT * FROM pages WHERE id=?", (page_id,))
    if not p:
        raise HTTPException(404, "找不到頁面")
    own_exam(request, p["exam_id"])
    return p


def own_paper(request: Request, pid: int) -> dict:
    p = db.one("SELECT * FROM papers WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404, "找不到試卷")
    own(request, p["student_id"])
    return p


def need_ai():
    if not ai.configured():
        if ai.provider() == "subscription":
            raise HTTPException(400, "樹莓派上的 Claude 還沒登入：請在樹莓派終端機執行 claude，用你的 claude.ai 帳號登入。")
        raise HTTPException(400, "尚未設定 Claude API 金鑰，請到「家長 → 設定」填入。")


@app.post("/api/login")
async def login(body: dict):
    """Family (site) password, when one is set."""
    pw = _setting("site_password")
    if pw and body.get("password") != pw:
        raise HTTPException(403, "密碼錯誤")
    resp = JSONResponse({"ok": True})
    if pw:
        resp.set_cookie("sess", _session_token(pw), max_age=180 * 86400, httponly=True, samesite="lax")
    return resp


def _profiles():
    return db.q("SELECT id, name, grade, avatar, role, theme FROM students ORDER BY role DESC, id")


_SECURE_URL: list = []


def _secure_url() -> str:
    """The site's https address (tailscale serve on this Pi), for the live camera: browsers only open
    the camera on https. Found once from `tailscale status`; '' when there is none."""
    if not _SECURE_URL:
        url = db.get_setting("secure_url") or ""
        if not url:
            try:
                import subprocess
                st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=5).stdout or "{}")
                name = ((st.get("Self") or {}).get("DNSName") or "").rstrip(".")
                serve = subprocess.run(["tailscale", "serve", "status"], capture_output=True, text=True, timeout=5).stdout
                if name and name in serve:
                    url = f"https://{name}"
            except Exception:  # noqa: BLE001
                url = ""
        _SECURE_URL.append(url)
    return _SECURE_URL[0]


@app.get("/api/status")
async def status(request: Request):
    site_ok = _site_ok(request)
    user = request.state.user if site_ok else None
    out = {"version": VERSION, "build": build(), "needs_login": not site_ok, "ai_ready": ai.configured(), "secure_url": _secure_url(),
           "setup_needed": accounts.setup_needed() if site_ok else False,
           "user": user}
    if site_ok:
        out["profiles"] = _profiles()
    if user:
        out.update({
            "students": _profiles() if user["role"] == "parent" else [user],
            "subjects": curriculum.SUBJECTS, "qtypes": curriculum.QTYPES,
            "model": _setting("model"),
            "scan_defaults": {"remove_handwriting": bool(_setting("remove_handwriting")),
                              "remove_color": bool(_setting("remove_color_ink"))},
        })
    return out


def _login_response(user_id: int) -> JSONResponse:
    resp = JSONResponse({"ok": True, "user": accounts.verify(accounts.sign(user_id))})
    resp.set_cookie(accounts.COOKIE, accounts.sign(user_id), max_age=accounts.COOKIE_AGE,
                    httponly=True, samesite="lax")
    return resp


@app.post("/api/setup")
async def setup(body: dict, request: Request):
    """First run: create the parent account and turn the starter profile
    into the first child (keeping anything already recorded)."""
    if not _site_ok(request):
        raise HTTPException(401, "請先輸入家庭密碼")
    if not accounts.setup_needed():
        raise HTTPException(400, "已經設定過了")
    pname, ppw = (body.get("parent_name") or "家長").strip(), body.get("parent_password") or ""
    if len(ppw) < 4:
        raise HTTPException(400, "家長密碼至少 4 個字")
    child = body.get("child") or {}
    cpin = str(child.get("pin") or "")
    if not (cpin.isdigit() and 4 <= len(cpin) <= 6):
        raise HTTPException(400, "孩子的密碼請用 4~6 位數字")
    first = db.one("SELECT * FROM students WHERE role='student' ORDER BY id LIMIT 1")
    cdata = {"name": (child.get("name") or "小朋友").strip(), "grade": int(child.get("grade") or 6),
             "pin_hash": accounts.hash_secret(cpin), "role": "student"}
    if first:
        db.update("students", first["id"], cdata)
    else:
        db.insert("students", {**cdata, "created_at": db.now()})
    pid = db.insert("students", {"name": pname, "grade": 6, "avatar": "🦉", "role": "parent",
                                 "pin_hash": accounts.hash_secret(ppw), "created_at": db.now()})
    return _login_response(pid)


@app.post("/api/auth/login")
async def auth_login(body: dict, request: Request):
    if not _site_ok(request):
        raise HTTPException(401, "請先輸入家庭密碼")
    uid = int(body.get("id") or 0)
    row = db.one("SELECT * FROM students WHERE id=?", (uid,))
    if not row:
        raise HTTPException(404, "找不到這個帳號")
    if accounts.rate_limited(uid):
        raise HTTPException(429, "錯太多次了，請 5 分鐘後再試")
    if row["pin_hash"] and not accounts.check_secret(str(body.get("pin") or ""), row["pin_hash"]):
        accounts.note_failure(uid)
        raise HTTPException(403, "密碼不對喔")
    return _login_response(uid)


@app.post("/api/auth/logout")
async def auth_logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(accounts.COOKIE)
    return resp


# --- students & gamification --------------------------------------------------------

@app.get("/api/me")
async def me(request: Request):
    s = sid(request)
    new_badges = gamify.check_badges(s)
    return {**gamify.summary(s), "quests": gamify.quest_progress(s),
            "new_badges": [gamify.BADGES[b][1] for b in new_badges],
            "due_review": len(practice.due_review(s, 200)),
            "wrong_open": len(qstate.query(s, "is_wrong=1 AND mastered=0", [], "")),
            "minutes_today": analysis.minutes_today(s),
            "daily_limit": db.scalar("SELECT daily_limit FROM students WHERE id=?", (s,)) or 0,
            "goals": [_goal_today(g, s) for g in db.q("SELECT * FROM goals WHERE student_id=? AND exam_date>=? "
                                                     "ORDER BY exam_date LIMIT 1", (s, db.today()))],
            "help_open": db.scalar("SELECT COUNT(*) FROM help_requests WHERE status='open'") if is_parent(request) else 0,
            "rewards_pending": db.scalar("SELECT COUNT(*) FROM redemptions WHERE status='pending'") if is_parent(request) else 0,
            "homework": sorted([t for t in bankview.tasks(s, 20) if t["status"] != "done"],
                               key=lambda t: (t["due_date"] or "9999", t["id"]))}


def _secret_for(role: str, value) -> str:
    v = str(value or "")
    if role == "parent":
        if len(v) < 4:
            raise HTTPException(400, "家長密碼至少 4 個字")
    elif not (v.isdigit() and 4 <= len(v) <= 6):
        raise HTTPException(400, "孩子的密碼請用 4~6 位數字")
    return accounts.hash_secret(v)


@app.post("/api/students")
async def add_student(body: dict, request: Request):
    need_parent(request)
    role = "parent" if body.get("role") == "parent" else "student"
    sid_ = db.insert("students", {"name": body.get("name") or "新同學", "grade": int(body.get("grade") or 6),
                                  "avatar": body.get("avatar") or ("🦉" if role == "parent" else "🐱"),
                                  "role": role, "pin_hash": _secret_for(role, body.get("pin")),
                                  "created_at": db.now()})
    return {"id": sid_}


@app.put("/api/students/{student_id}")
async def edit_student(student_id: int, body: dict, request: Request):
    upd = {}
    if "daily_goal" in body:
        own(request, student_id)
        upd["daily_goal"] = int(body["daily_goal"])
    if "daily_limit" in body:
        need_parent(request)
        upd["daily_limit"] = max(0, int(body["daily_limit"]))
    if set(body) & {"name", "grade", "pin"}:
        need_parent(request)
        row = db.one("SELECT role FROM students WHERE id=?", (student_id,))
        for k in ("name", "grade"):
            if k in body:
                upd[k] = body[k]
        if body.get("pin"):
            upd["pin_hash"] = _secret_for(row["role"], body["pin"])
    db.update("students", student_id, upd)
    return {"ok": True}


@app.delete("/api/students/{student_id}")
async def del_student(student_id: int, request: Request):
    need_parent(request)
    row = db.one("SELECT role FROM students WHERE id=?", (student_id,))
    if row and row["role"] == "parent" and (db.scalar("SELECT COUNT(*) FROM students WHERE role='parent'") or 0) <= 1:
        raise HTTPException(400, "至少要保留一個家長帳號")
    if (db.scalar("SELECT COUNT(*) FROM students WHERE role='student'") or 0) <= 1 and row and row["role"] == "student":
        raise HTTPException(400, "至少要保留一位學生")
    db.execute("DELETE FROM students WHERE id=?", (student_id,))
    return {"ok": True}


@app.get("/api/me/badges")
async def my_badges(request: Request):
    return gamify.badge_list(sid(request))


@app.post("/api/me/quests/{quest}/claim")
async def claim(quest: str, request: Request):
    return gamify.claim_quest(sid(request), quest)


@app.get("/api/shop")
async def shop(request: Request):
    s = gamify.summary(sid(request))
    return {"items": gamify.SHOP, "owned": s["owned"], "coins": s["coins"]}


@app.post("/api/shop/buy")
async def shop_buy(body: dict, request: Request):
    r = gamify.buy(sid(request), body.get("item", ""))
    if r.get("error"):
        raise HTTPException(400, r["error"])
    return r


@app.post("/api/me/equip")
async def equip(body: dict, request: Request):
    s = sid(request)
    st = gamify.summary(s)
    upd = {}
    for kind in ("avatar", "theme", "title"):
        if kind in body:
            val = body[kind]
            free = {"avatar": {"🐱"}, "theme": {"sky"}, "title": {""}}[kind]
            owned_vals = {i["value"] for i in gamify.SHOP if i["kind"] == kind and i["id"] in st["owned"]}
            if val not in free | owned_vals:
                raise HTTPException(400, "還沒有擁有這個項目")
            upd[kind] = val
    db.update("students", s, upd)
    return {"ok": True}


@app.get("/api/league")
async def league(request: Request):
    return gamify.league(sid(request))


# --- exams ----------------------------------------------------------------------------

def scan_owner(request: Request, want: int = 0) -> int:
    """Whose exam this is. A child scans her own; a parent picks the child (a parent's own
    record never holds a scanned exam: that was how exams ended up under 媽媽)."""
    u = getattr(request.state, "user", None)
    s = sid(request)
    if not u or u["role"] != "parent":
        return s
    kids = [r["id"] for r in db.q("SELECT id FROM students WHERE role='student' ORDER BY id")]
    if want and want in kids:
        return want
    if s in kids:
        return s
    if len(kids) == 1:
        return kids[0]
    raise HTTPException(400, "請先選這是哪個孩子的考卷")


# --- 讀檔: PDF and image files read in on the scan page -------------------------------------------

MAX_PAGES = 100
PHOTO_EXT = (".jpg", ".jpeg", ".heic", ".heif")  # what a camera makes; other images may be computer-made


def _pdf_pages(pdf: Path, name: str) -> list[Path]:
    """Every page of a PDF as a JPEG (long side 2400 px: sharp enough to read small print)."""
    import subprocess
    prefix = pdf.with_name(pdf.stem + "_pg")
    try:
        subprocess.run(["pdftoppm", "-scale-to", "2400", "-jpeg", "-jpegopt", "quality=90", "-l", str(MAX_PAGES),
                        str(pdf), str(prefix)], check=True, timeout=900, capture_output=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise HTTPException(400, f"「{name}」這個 PDF 打不開（可能有密碼或檔案壞了）")
    pages = sorted(pdf.parent.glob(prefix.name + "-*.jpg"), key=lambda x: int(re.search(r"-(\d+)\.jpg$", x.name).group(1)))
    if not pages:
        raise HTTPException(400, f"「{name}」這個 PDF 裡沒有頁面")
    return pages


def _check_image(path: Path, name: str):
    from PIL import Image
    try:
        with Image.open(path) as im:
            im.verify()
    except Exception:
        raise HTTPException(400, f"「{name}」不是圖片或 PDF，讀不進來")


async def _take_uploads(files: list[UploadFile], corners: str = "", spreads: str = "",
                        sources: str = "") -> tuple[list[tuple[Path, dict]], Path]:
    """What the scan page sent, saved in a temporary folder: (file, page meta) per page — a photo as it
    is (with the corners / 單頁雙頁 chosen for it), a PDF as each of its pages (computer-made: kept
    flat, no outline / flat-field / dewarp). A file read in (讀檔) that turns out computer-made too."""
    import tempfile
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="in_", dir=UPLOAD_DIR))
    try:
        try:
            src = json.loads(sources) if sources else []
        except ValueError:
            src = []
        out = []
        for i, f in enumerate(files):
            name = Path(f.filename or "photo.jpg").name
            ext = Path(name).suffix.lower()
            safe = ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext or "") else ".jpg"
            dest = tmp / f"u{i}{safe}"
            with open(dest, "wb") as fo:
                shutil.copyfileobj(f.file, fo)
            with open(dest, "rb") as fi:
                pdf = fi.read(5) == b"%PDF-"
            if pdf:
                pages = await asyncio.to_thread(_pdf_pages, dest, name)
                out += [(pg, {"digital": True, "source": "pdf"}) for pg in pages]
            else:
                await asyncio.to_thread(_check_image, dest, name)
                meta = _corners_meta(corners, i, spreads).get("meta", {})
                if (i < len(src) and src[i] == "file") or ext not in PHOTO_EXT:
                    meta["digital"] = "auto"  # decided by looking at it (scanner.looks_digital)
                out.append((dest, meta))
            if len(out) > MAX_PAGES:
                raise HTTPException(400, f"一次最多 {MAX_PAGES} 頁，請分成幾份")
        return out, tmp
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def _add_pages(exam_id: int, items: list[tuple[Path, dict]], start: int = 0):
    folder = MEDIA_DIR / f"exam_{exam_id}"
    folder.mkdir(parents=True, exist_ok=True)
    for i, (path, meta) in enumerate(items):
        rel = f"exam_{exam_id}/p{start + i}_orig{path.suffix.lower() or '.jpg'}"
        shutil.move(str(path), MEDIA_DIR / rel)
        db.insert("pages", {"exam_id": exam_id, "idx": start + i, "orig_path": rel, "status": "queued",
                            **({"meta": meta} if meta else {})})


@app.post("/api/exams")
async def create_exam(request: Request, files: list[UploadFile] = File(...), title: str = Form(""),
                      subject: str = Form(""), remove_handwriting: bool = Form(True),
                      remove_color: bool = Form(True), exam_date: str = Form(""), student_id: int = Form(0),
                      mode: str = Form(""), in_bank: str = Form(""), school: str = Form(""),
                      corners: str = Form(""), spreads: str = Form(""), sources: str = Form("")):
    need_ai()
    s = scan_owner(request, student_id)
    if not files:
        raise HTTPException(400, "請選擇至少一張照片")
    items, tmp = await _take_uploads(files, corners, spreads, sources)
    grade = mode == "grade"  # 批改功課: her answers are checked (no teacher marks on homework)
    exam_id = db.insert("exams", {
        "student_id": s, "title": title or "未命名試卷", "subject": subject,
        "exam_date": exam_date or db.today(), "status": "processing",
        "options": {"subject": subject, "remove_handwriting": remove_handwriting,
                    "remove_color": remove_color, "template": db.get_setting("scan_template") or "auto",
                    **({"mode": "grade"} if grade else {}), **({"in_bank": False} if in_bank in ("0", "false") else {}),
                    **({"school": school == "1", "school_set": True} if school in ("0", "1") else {})},
        "created_at": db.now()})
    _add_pages(exam_id, items)
    shutil.rmtree(tmp, ignore_errors=True)
    job = jobs.start("exam", exam_id, pipeline.process_exam, exam_id)
    return {"exam_id": exam_id, "job_id": job, "pages": len(items)}


@app.put("/api/exams/{exam_id}/bank")
async def exam_bank(exam_id: int, body: dict, request: Request):
    """加入題庫 or not: homework photographed only to be graded and redone stays out of the 題庫,
    the analysis and the daily practice (its questions are still there for the exam itself)."""
    own_exam(request, exam_id)
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    opts = {k: v for k, v in opts.items() if k != "in_bank"}
    if body.get("in_bank") is False:
        opts["in_bank"] = False
    db.update("exams", exam_id, {"options": opts})
    return {"in_bank": opts.get("in_bank", True)}


@app.post("/api/exams/{exam_id}/pages/{page_id}/replace")
async def exam_page_replace(exam_id: int, page_id: int, request: Request, file: UploadFile = File(...)):
    """換這一頁: a better photo of one page (or the page after she wrote more on it). Only that page is
    read again; questions found again keep their history, and a graded exam gets that page graded again."""
    own_exam(request, exam_id)
    need_ai()
    page = db.one("SELECT * FROM pages WHERE id=? AND exam_id=?", (page_id, exam_id))
    if not page:
        raise HTTPException(404, "找不到這一頁")
    if db.scalar("SELECT 1 FROM jobs WHERE kind IN ('exam','page') AND ref_id=? AND status IN ('queued','running')", (exam_id,)):
        raise HTTPException(409, "這份還在整理中，整理完再換頁")
    items, tmp = await _take_uploads([file])
    path, pmeta = items[0]  # a PDF: its first page
    rel = f"exam_{exam_id}/p{page['idx']}_orig_{int(time.time())}{path.suffix.lower() or '.jpg'}"
    shutil.move(str(path), MEDIA_DIR / rel)
    shutil.rmtree(tmp, ignore_errors=True)
    meta = page["meta"] if isinstance(page["meta"], dict) else {}
    meta.pop("corners_set", None)  # a new photo: its own outline is found again
    meta.pop("digital", None)
    for k in ("half", "pair", "gutter", "turn", "prepared", "spread"):  # a new photo: one page, or a spread found again
        meta.pop(k, None)
    if pmeta.get("digital") is not None:
        meta["digital"] = pmeta["digital"]
    db.update("pages", page_id, {"orig_path": rel, "status": "queued", "error": "", "meta": meta})
    return {"job_id": jobs.start("page", exam_id, pipeline.replace_page_job, exam_id, page_id)}


@app.post("/api/exams/{exam_id}/grade")
async def exam_grade(exam_id: int, request: Request):
    """批改 an exam already in the bank, with the answers on its photos."""
    own_exam(request, exam_id)
    need_ai()
    return {"job_id": ahead(("grade", exam_id), "grade", exam_id, pipeline.grade_job, exam_id)}


@app.put("/api/exams/{exam_id}/grade/{qid}")
async def exam_grade_set(exam_id: int, qid: int, body: dict, request: Request):
    """請你確認: a parent decides a mark the AI could not (or changes one): correct / wrong / partial / blank."""
    own_exam(request, exam_id)
    need_parent(request)
    res = body.get("result")
    if res not in ("correct", "wrong", "partial", "blank"):
        raise HTTPException(400, "請選對、錯、部分對或沒寫")
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    g = dict(opts.get("grade") or {})
    if str(qid) not in g:
        raise HTTPException(404, "這題沒有批改")
    g[str(qid)] = {**g[str(qid)], "result": res, "by": "parent",
                   "comment": g[str(qid)].get("comment", "") if res in ("wrong", "partial") else ""}
    n = pipeline.grade_counts(g)
    db.update("exams", exam_id, {"options": {**opts, "grade": g, "grade_summary": n}})
    return {"ok": True, "summary": n}


@app.post("/api/exams/{exam_id}/grade/photos")
async def exam_grade_photos(exam_id: int, request: Request, files: list[UploadFile] = File(...)):
    """重寫後拍照批改: photos of the paper she did again, graded against this exam."""
    own_exam(request, exam_id)
    need_ai()
    if not files:
        raise HTTPException(400, "請選擇至少一張照片")
    stamp, rels = int(time.time()), []
    for i, f in enumerate(files[:12]):
        ext = Path(f.filename or "x.jpg").suffix.lower() or ".jpg"
        rel = f"exam_{exam_id}/redo_{stamp}_{i}{ext}"
        (MEDIA_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
        with open(MEDIA_DIR / rel, "wb") as out:
            shutil.copyfileobj(f.file, out)
        rels.append(rel)
    return {"job_id": jobs.start("grade", exam_id, pipeline.regrade_photos_job, exam_id, rels)}


@app.post("/api/exams/{exam_id}/pages")
async def add_pages(exam_id: int, request: Request, files: list[UploadFile] = File(...), corners: str = Form(""),
                    spreads: str = Form(""), sources: str = Form("")):
    """再拍一頁: add photos (or a PDF's pages) to an exam that was already sent off."""
    own_exam(request, exam_id)
    need_ai()
    items, tmp = await _take_uploads(files, corners, spreads, sources)
    start = (db.scalar("SELECT MAX(idx) FROM pages WHERE exam_id=?", (exam_id,)) or 0) + 1
    _add_pages(exam_id, items, start)
    shutil.rmtree(tmp, ignore_errors=True)
    db.update("exams", exam_id, {"status": "processing"})
    return {"job_id": jobs.start("exam", exam_id, pipeline.process_exam, exam_id), "pages": len(items)}


def _clean_corners(c) -> list | None:
    """4 corners [[x, y]…] in 0..1 (tl, tr, br, bl), [] for the whole photo, None when not given."""
    if c is None:
        return None
    if c == []:
        return []
    try:
        pts = [[min(1.0, max(0.0, float(x))), min(1.0, max(0.0, float(y)))] for x, y in c]
    except (TypeError, ValueError):
        return None
    return pts if len(pts) == 4 else None


def _corners_meta(raw: str, i: int, spreads: str = "") -> dict:
    """What came with photo i from the scan page: the corners a person placed and 單頁／雙頁 (JSON
    lists, one per photo; null = find it automatically)."""
    meta = {}
    try:
        c = _clean_corners(json.loads(raw)[i]) if raw else None
        if c is not None:
            meta["corners_set"] = c
    except (ValueError, IndexError, TypeError):
        pass
    try:
        sp = json.loads(spreads)[i] if spreads else None
        if isinstance(sp, bool):
            meta["spread"] = sp
    except (ValueError, IndexError, TypeError):
        pass
    return {"meta": meta} if meta else {}


@app.post("/api/scan/corners")
async def scan_corners(file: UploadFile = File(...)):
    """The page outline found in a photo (for the corner editor before sending): 0..1 corners."""
    import asyncio
    import cv2
    import numpy as np
    from . import scanner
    data = await file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "看不懂這張照片")
    q = await asyncio.to_thread(scanner.find_page, img)
    h, w = img.shape[:2]
    return {"corners": [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in q] if q is not None else []}


@app.post("/api/scan/check")
async def scan_check(file: UploadFile = File(...), hint: str = Form("")):
    """拍照指引, after each shot: corners, how sure, 單頁／雙頁 (the camera decides whether to ask)."""
    import asyncio
    import cv2
    import numpy as np
    from . import scanner
    img = cv2.imdecode(np.frombuffer(await file.read(), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "看不懂這張照片")
    # the outline and focus are judged at 1000 px anyway: a 3000 px photo only made the check 3× slower
    # (1.2 s between a shot and the next) — the corners come back as 0..1, so the size does not matter
    s = 1600 / max(img.shape[:2])
    if s < 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    h = None
    try:
        h = _clean_corners(json.loads(hint)) if hint else None
    except ValueError:
        h = None
    r = await asyncio.to_thread(scanner.check_photo, img, h or None)
    return {**r, "digital": bool(await asyncio.to_thread(scanner.looks_digital, img))}


@app.get("/api/pages/{page_id}/corners")
async def page_corners(page_id: int, request: Request):
    """The photo of a page and its corners: the ones used for the scan, and the automatic ones."""
    import asyncio
    from . import scanner
    p = own_page(request, page_id)
    meta = p["meta"] if isinstance(p["meta"], dict) else {}
    used = meta.get("corners")
    if used is None:
        img = await asyncio.to_thread(imaging.load, MEDIA_DIR / p["orig_path"])
        q = await asyncio.to_thread(scanner.find_page, img)
        h, w = img.shape[:2]
        used = [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in q] if q is not None else []
    return {"photo": p["orig_path"], "corners": used, "manual": meta.get("corners_set") is not None}


@app.get("/api/pages/{page_id}/photo")
async def page_photo(page_id: int, request: Request):
    """The page's photo as the scanner sees it (EXIF-rotated, any format → JPEG, ≤1600 px)."""
    import asyncio
    import cv2
    p = own_page(request, page_id)
    return await asyncio.to_thread(_jpeg_view, MEDIA_DIR / p["orig_path"])


@app.post("/api/exams/{exam_id}/pages/{page_id}/corners")
async def set_page_corners(exam_id: int, page_id: int, body: dict, request: Request):
    """調整四個角: the page scanned again from its photo with the corners a person placed, then read
    again (like 換這一頁, the same photo)."""
    own_exam(request, exam_id)
    need_ai()
    page = db.one("SELECT * FROM pages WHERE id=? AND exam_id=?", (page_id, exam_id))
    if not page:
        raise HTTPException(404, "找不到這一頁")
    auto = body.get("auto") is True  # 用新的前處理重做: the outline found automatically again
    c = None if auto else _clean_corners(body.get("corners"))
    if c is None and not auto:
        raise HTTPException(400, "四個角不正確")
    if db.scalar("SELECT 1 FROM jobs WHERE kind IN ('exam','page','rescan') AND ref_id=? AND status IN ('queued','running')", (exam_id,)):
        raise HTTPException(409, "這份還在整理中，整理完再調整")
    meta = page["meta"] if isinstance(page["meta"], dict) else {}
    meta = {k: v for k, v in meta.items() if k != "corners_set"}
    if not auto:
        meta["corners_set"] = c
    db.update("pages", page_id, {"meta": meta, "status": "queued", "error": ""})
    return {"job_id": jobs.start("page", exam_id, pipeline.replace_page_job, exam_id, page_id)}


@app.post("/api/exams/{exam_id}/rescan")
async def exam_rescan(exam_id: int, request: Request):
    """這份全部用新的前處理重做: every page scanned again from its photo and read again, one by one."""
    own_exam(request, exam_id)
    need_ai()
    if db.scalar("SELECT 1 FROM jobs WHERE kind IN ('exam','page','rescan') AND ref_id=? AND status IN ('queued','running')", (exam_id,)):
        raise HTTPException(409, "這份還在整理中")
    return {"job_id": jobs.start("rescan", exam_id, pipeline.rescan_exam_job, exam_id)}


THUMB_DIR = DATA_DIR / "thumbs"


def _thumb_file(rel: str, w: int) -> Path:
    """A small JPEG of a media image (lists show 40–240 px pictures: never the 1 MB scan)."""
    import cv2
    src = (MEDIA_DIR / rel).resolve()
    if MEDIA_DIR.resolve() not in src.parents or not src.exists():
        raise HTTPException(404)
    dest = THUMB_DIR / f"{rel.replace('/', '_')}.{w}.jpg"
    if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
        img = imaging.load(src)
        h, ww = img.shape[:2]
        s = min(1.0, w / ww)
        img = cv2.resize(img, (max(1, int(ww * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(dest), img, [cv2.IMWRITE_JPEG_QUALITY, 78])
    return dest


@app.get("/api/thumb/{rel:path}")
async def thumb(rel: str, w: int = 240):
    import asyncio
    w = 1200 if w > 480 else 480 if w > 240 else 240  # 1200: a page in the 原卷照片 view (~5× fewer bytes)
    f = await asyncio.to_thread(_thumb_file, rel, w)
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=604800"})


@app.get("/api/exams")
async def list_exams(request: Request):
    s = sid(request)
    rows = db.q(
        "SELECT e.*, (SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id) AS n_questions, "
        "(SELECT COUNT(*) FROM questions q JOIN student_q sq ON sq.question_id=q.id AND sq.student_id=e.student_id "
        "WHERE q.exam_id=e.id AND sq.is_wrong=1) AS n_wrong, "
        "(SELECT scan_path FROM pages p WHERE p.exam_id=e.id ORDER BY idx LIMIT 1) AS thumb, "
        "(SELECT COUNT(*) FROM pages p WHERE p.exam_id=e.id) AS n_pages, "
        "(SELECT COUNT(*) FROM questions q WHERE q.exam_id=e.id AND q.upgraded_at!='' AND q.upgraded_at IS NOT NULL) AS n_upgraded, "
        "(SELECT id FROM jobs j WHERE j.kind='exam' AND j.ref_id=e.id ORDER BY id DESC LIMIT 1) AS job_id, "
        "st.name AS owner_name, st.avatar AS owner_avatar "
        "FROM exams e LEFT JOIN students st ON st.id=e.student_id "
        # a parent looking at her own record sees the whole family's exams (whose is shown on each)
        f"WHERE {'1' if is_parent(request) and s == request.state.user['id'] else 'e.student_id=?'} ORDER BY e.id DESC",
        () if is_parent(request) and s == request.state.user["id"] else (s,))
    for r in rows:  # for the list's filters: what kind of paper, 批改 or not, in the 題庫 or not
        if r.get("thumb"):
            try:
                r["thumb_v"] = int((MEDIA_DIR / r["thumb"]).stat().st_mtime)
            except OSError:
                r["thumb_v"] = 0
        o = r["options"] if isinstance(r["options"], dict) else {}
        k = templates.exam_category(r)
        r["kind"], r["kind_name"] = k, templates.get(k)["name"]
        r["mode"] = o.get("mode", "")
        r["in_bank"] = o.get("in_bank", True) is not False
        r["school"] = bool(o.get("school"))
        g = o.get("grade_summary")
        if g:
            done = g.get("correct", 0) + g.get("wrong", 0) + g.get("partial", 0)  # 沒寫、看不清楚 not counted
            r["score"] = round(100 * (g.get("correct", 0) + 0.5 * g.get("partial", 0)) / done) if done else None
            r["to_fix"] = g.get("wrong", 0) + g.get("partial", 0)
    return rows


# the long parts of a question (詳解、圖、提示…): 3/4 of a big exam's bytes. ?lite=1 leaves them out —
# the exam page fetches them when a question is opened or practised
HEAVY_Q = ("visuals", "explanation", "steps", "figure_svg", "hints", "bar_model", "concept", "qtype_tip",
           "key_points", "mistakes", "figure_facts", "option_notes", "figure_unsure", "lead")


@app.get("/api/exams/{exam_id}")
async def get_exam(exam_id: int, request: Request, lite: int = 0, only: str = ""):
    e = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    if not e:
        raise HTTPException(404, "找不到試卷")
    if only:  # just these long parts of each question (全部顯示詳解 needs explanation, steps)
        keys = [k for k in only.split(",") if k in HEAVY_Q]
        qs = qstate.query(sid(request), "exam_id=?", [exam_id], "ORDER BY seq", everything=True)
        return JSONResponse({"questions": [{"id": q["id"], **{k: q.get(k) for k in keys}} for q in qs]})
    e["pages"] = db.q("SELECT * FROM pages WHERE exam_id=? ORDER BY idx", (exam_id,))
    for p in e["pages"]:  # the scan's version: a browser keeps the picture until the page is made again
        try:
            p["scan_v"] = int((MEDIA_DIR / p["scan_path"]).stat().st_mtime) if p.get("scan_path") else 0
        except OSError:
            p["scan_v"] = 0
    e["questions"] = _with_chapter(qstate.query(sid(request), "exam_id=?", [exam_id], "ORDER BY seq", everything=True))
    e["job"] = db.one("SELECT * FROM jobs WHERE kind='exam' AND ref_id=? ORDER BY id DESC LIMIT 1", (exam_id,))
    e["template"] = templates.for_exam(e)
    e["gaps"] = pipeline.find_gaps(exam_id) if e["status"] != "processing" else []  # 漏拍提醒
    if lite:
        for q in e["questions"]:
            for k in HEAVY_Q:
                q.pop(k, None)
        e["lite"] = list(HEAVY_Q)
    return JSONResponse(e)  # plain rows: skips FastAPI's encoder (0.08 s for a 375-question exam)


@app.delete("/api/exams/{exam_id}/pages/{page_id}")
async def delete_page(exam_id: int, page_id: int, request: Request):
    """刪除這一頁 (a page photographed twice, …): the page and its questions go, the pages after it move up."""
    own_exam(request, exam_id)
    need_parent(request)
    page = db.one("SELECT * FROM pages WHERE id=? AND exam_id=?", (page_id, exam_id))
    if not page:
        raise HTTPException(404, "找不到這一頁")
    if db.scalar("SELECT 1 FROM jobs WHERE kind IN ('exam','page','rescan') AND ref_id=? AND status IN ('queued','running')", (exam_id,)):
        raise HTTPException(409, "這份還在整理中，整理完再刪")
    if db.scalar("SELECT COUNT(*) FROM pages WHERE exam_id=?", (exam_id,)) <= 1:
        raise HTTPException(400, "只剩這一頁了：要刪掉整份考卷，請按「刪除這份考卷」")
    qids = [r["id"] for r in db.q("SELECT id FROM questions WHERE page_id=?", (page_id,))]
    for q in qids:
        db.execute("DELETE FROM student_q WHERE question_id=?", (q,))
        db.execute("DELETE FROM questions WHERE id=?", (q,))
    db.execute("DELETE FROM pages WHERE id=?", (page_id,))
    db.execute("UPDATE pages SET idx=idx-1 WHERE exam_id=? AND idx>?", (exam_id, page["idx"]))
    for p in db.q("SELECT id, meta FROM pages WHERE exam_id=?", (exam_id,)):  # its other half: a page on its own now
        m = p["meta"] if isinstance(p["meta"], dict) else {}
        if m.get("pair") == page_id:
            db.update("pages", p["id"], {"meta": {k: v for k, v in m.items() if k != "pair"}})
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    if opts.get("grade"):
        g = {k: v for k, v in opts["grade"].items() if int(k) not in qids}
        db.update("exams", exam_id, {"options": {**opts, "grade": g, "grade_summary": pipeline.grade_counts(g)}})
    nas.mark_dirty()
    return {"ok": True, "removed": len(qids)}


@app.get("/api/exams/{exam_id}/gaps")
async def exam_gaps(exam_id: int, request: Request):
    """漏拍提醒: question numbers missing between pages / on a page, or read twice."""
    own_exam(request, exam_id)
    return {"gaps": pipeline.find_gaps(exam_id)}


@app.put("/api/exams/{exam_id}/owner")
def exam_owner(exam_id: int, body: dict, request: Request):
    """這是誰的考卷: move an exam (its questions, wrong marks, practice) to another child."""
    need_parent(request)
    e = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    if not e:
        raise HTTPException(404, "找不到試卷")
    to = int(body.get("student_id") or 0)
    if not db.scalar("SELECT 1 FROM students WHERE id=? AND role='student'", (to,)):
        raise HTTPException(400, "請選一個孩子")
    if e["status"] == "processing":
        raise HTTPException(400, "AI 還在辨識這份考卷，整理好之後再改")
    pipeline.move_exam(exam_id, to)
    return {"ok": True, "student_id": to}


@app.post("/api/exams/regenerate")
async def exams_regenerate(body: dict, request: Request):
    """依範本重新產生: exams sorted again by the current template rules, their Word paper and
    answer key made again (and the NAS 考卷 folders rewritten)."""
    need_parent(request)
    ids = [int(i) for i in body.get("ids") or []] or [r["id"] for r in (
        db.q("SELECT id FROM exams WHERE status='ready' AND student_id=?", (int(body["student_id"]),)) if body.get("student_id")
        else db.q("SELECT id FROM exams WHERE status='ready'"))]
    plan = []
    for eid in ids:
        e = db.one("SELECT * FROM exams WHERE id=?", (eid,))
        if not e or e["status"] != "ready":
            continue
        if body.get("reset"):  # back to 「依類型自動」, so new types and keywords apply (only shown when dry)
            opts = {**(e["options"] if isinstance(e["options"], dict) else {}), "template": "auto"}
            if not body.get("dry"):
                db.update("exams", eid, {"options": opts})
            e = {**e, "options": opts}
        t = templates.for_exam(e)
        who = db.one("SELECT name FROM students WHERE id=?", (e["student_id"],))
        plan.append({"id": eid, "title": e["title"], "template": t["name"], "auto": t["auto"], "owner": who["name"] if who else ""})
    if body.get("dry"):
        return {"plan": plan}
    return {"plan": plan, "job_id": jobs.start("regenerate", 0, pipeline.regenerate_job, [p["id"] for p in plan])}


@app.post("/api/exams/upgrade")
async def exams_upgrade(body: dict, request: Request):
    """題目升級: proofread every question against its photo, rebuild figures (table / SVG) and
    rewrite the 詳解 — for one exam or all of them, in the background (new scans go first)."""
    need_parent(request)
    need_ai()
    if body.get("exam_id"):
        eid = int(body["exam_id"])
        if body.get("force"):
            db.execute("UPDATE questions SET upgraded_at='' WHERE exam_id=?", (eid,))
        return {"job_id": ahead(("upgrade", eid), "upgrade", eid, pipeline.upgrade_exam_job, eid)}
    return {"job_id": ahead(("upgrade_all",), "upgrade_all", 0, pipeline.upgrade_all_job, bool(body.get("force")))}


@app.post("/api/exams/fidelity")
async def exams_fidelity_all(request: Request):
    """與原卷一致: every exam's regenerated paper compared with its photos; what differs is made again."""
    need_parent(request)
    need_ai()
    return {"job_id": ahead(("fidelity_all",), "fidelity_all", 0, pipeline.fidelity_all_job)}


@app.post("/api/exams/{exam_id}/fidelity")
async def exam_fidelity(exam_id: int, request: Request):
    own_exam(request, exam_id)
    need_ai()
    return {"job_id": ahead(("fidelity", exam_id), "fidelity", exam_id, pipeline.fidelity_exam_job, exam_id)}


@app.post("/api/exams/{exam_id}/zhuyin")
async def exam_zhuyin(exam_id: int, request: Request):
    """補注音: a paper printed with 注音 on every character gets the marks on every question whose
    text still lacks them — from the text alone, in the background."""
    own_exam(request, exam_id)
    need_ai()
    return {"job_id": ahead(("zhuyin", exam_id), "zhuyin", exam_id, pipeline.zhuyin_job, exam_id)}


@app.post("/api/exams/{exam_id}/priority")
async def exam_priority(exam_id: int, request: Request):
    """優先升級: this exam's questions go first (the running sessions pick them up next)."""
    need_parent(request)
    pipeline.prioritize(exam_id)
    pipeline.ensure_pool()
    return {"ok": True, "left": pipeline._exam_left(exam_id)}


@app.get("/api/upgrade/status")
def upgrade_status():
    rows = db.q("SELECT e.id, e.title, COUNT(q.id) AS n, SUM(q.upgraded_at!='' AND q.upgraded_at IS NOT NULL) AS done "
                "FROM exams e JOIN questions q ON q.exam_id=e.id WHERE e.status='ready' GROUP BY e.id ORDER BY e.id DESC")
    job = db.one("SELECT progress, message, status FROM jobs WHERE kind='upgrade_all' ORDER BY id DESC LIMIT 1")
    return {"exams": [{**r, "done": int(r["done"] or 0)} for r in rows], "priority": pipeline._priority(),
            "parallel": pipeline.upgrade_parallel(), "job": job}


@app.put("/api/exams/{exam_id}/template")
def exam_template(exam_id: int, body: dict, request: Request):
    """換範本 for this exam ("auto" = by its kind again)."""
    own_exam(request, exam_id)
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    tid = str(body.get("id") or "auto")
    if tid != "auto" and not any(t["id"] == tid for t in templates.all_templates()):
        raise HTTPException(404, "找不到這個範本")
    db.update("exams", exam_id, {"options": {**opts, "template": tid}})
    return templates.for_exam(db.one("SELECT * FROM exams WHERE id=?", (exam_id,)))


@app.put("/api/exams/{exam_id}")
async def edit_exam(exam_id: int, body: dict, request: Request):
    own_exam(request, exam_id)
    db.update("exams", exam_id, {k: v for k, v in body.items() if k in {"title", "subject", "note", "exam_date"}})
    if "school" in body:  # 學校考卷, set by hand: the AI never changes it again
        e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
        opts = e["options"] if isinstance(e["options"], dict) else {}
        db.update("exams", exam_id, {"options": {**opts, "school": bool(body["school"]), "school_set": True}})
    if "subject" in body and body.get("apply_subject"):
        db.execute("UPDATE questions SET subject=? WHERE exam_id=?", (body["subject"], exam_id))
    return {"ok": True}


@app.delete("/api/exams/{exam_id}")
async def delete_exam(exam_id: int, request: Request, keep_questions: bool = False):
    own_exam(request, exam_id)
    need_parent(request)  # the photos and every question go with it: not something a child does alone
    if keep_questions:
        db.execute("UPDATE questions SET exam_id=0, page_id=0 WHERE exam_id=?", (exam_id,))
    else:
        db.execute("DELETE FROM questions WHERE exam_id=?", (exam_id,))
    db.execute("DELETE FROM pages WHERE exam_id=?", (exam_id,))
    db.execute("DELETE FROM exams WHERE id=?", (exam_id,))
    if not keep_questions:
        shutil.rmtree(MEDIA_DIR / f"exam_{exam_id}", ignore_errors=True)
    return {"ok": True}


def exam_busy(exam_id: int) -> bool:
    return bool(db.scalar("SELECT 1 FROM jobs WHERE kind='exam' AND ref_id=? AND status IN ('queued','running')", (exam_id,)))


@app.post("/api/exams/{exam_id}/retry")
async def retry_exam(exam_id: int, request: Request, body: dict | None = None):
    """重新處理: only the pages that failed (all of them with {"all": true}). Never while the
    exam is still being worked on — two runs at once made every question twice."""
    own_exam(request, exam_id)
    need_ai()
    if exam_busy(exam_id):
        raise HTTPException(409, "這份考卷還在整理其他頁，等整理完再按重試")
    whole = bool((body or {}).get("all"))
    pages = db.q("SELECT id FROM pages WHERE exam_id=?" + ("" if whole else " AND status='error'"), (exam_id,))
    if not pages:
        pages = db.q("SELECT id FROM pages WHERE exam_id=?", (exam_id,))
    ids = [p["id"] for p in pages]
    marks = ",".join("?" * len(ids))
    db.execute(f"DELETE FROM student_q WHERE question_id IN (SELECT id FROM questions WHERE page_id IN ({marks}))", ids)
    db.execute(f"DELETE FROM questions WHERE page_id IN ({marks})", ids)
    db.execute(f"UPDATE pages SET status='queued', error='' WHERE id IN ({marks})", ids)
    db.update("exams", exam_id, {"status": "processing"})
    return {"job_id": jobs.start("exam", exam_id, pipeline.process_exam, exam_id)}


@app.post("/api/exams/{exam_id}/solve")
async def solve_exam(exam_id: int, request: Request, body: dict | None = None):
    own_exam(request, exam_id)
    need_ai()
    body = body or {}
    if body.get("all"):
        ids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=?", (exam_id,))]
    else:
        ids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? AND solved=0", (exam_id,))]
    if not ids:
        return {"job_id": 0}
    return {"job_id": jobs.start("solve", exam_id, pipeline.solve_job, ids)}


@app.post("/api/pages/{page_id}/region")
async def page_region(page_id: int, body: dict, request: Request):
    own_page(request, page_id)
    need_ai()
    box = body.get("box")
    if not (isinstance(box, list) and len(box) == 4):
        raise HTTPException(400, "請框選範圍")
    return {"job_id": jobs.start("region", page_id, pipeline.region_job, page_id,
                                 [int(v) for v in box], sid(request))}


FLAG_SQL = {
    "wrong": "is_wrong=1", "highlighted": "is_highlighted=1", "marked": "is_marked=1",
    "favorite": "is_favorite=1", "mastered": "mastered=1", "unmastered": "is_wrong=1 AND mastered=0",
    "due": "is_wrong=1 AND mastered=0 AND (next_review='' OR next_review<=date('now','localtime'))",
    "any_mark": "(is_wrong=1 OR is_highlighted=1 OR is_marked=1 OR is_favorite=1)",
    "unsolved": "solved=0",
    # where a 錯題 came from: marked wrong on the exam by the teacher (found when scanning) / by us
    "teacher": "teacher_mark IN ('wrong','partial')",
    "self": "is_wrong=1 AND teacher_mark NOT IN ('wrong','partial')",
}


def _book_index(subject: str) -> list[tuple[str, str]]:
    """(key, searchable text) per 章節: a 主題 carries its unit's name too."""
    out, unit = [], ""
    for c in curriculum.chapters(subject):
        if not c["topic"]:
            unit = c["label"]
            out.append((c["key"], f"{c['area']} {unit} 第{c['unit']}單元"))
        else:
            out.append((c["key"], f"{unit} {c['label']}"))
    return out


def _chapter_sql(subject: str, key: str) -> tuple[str, list]:
    """WHERE for one 章節 of the review book: the AI's placement, or (not placed yet) the guess from
    the curriculum unit. "?" = 未分類."""
    guess = curriculum.UNIT_CHAPTER
    if key == "?":
        known = list(guess)
        return (f"(chapter='-' OR (COALESCE(chapter,'')='' AND COALESCE(unit,'') NOT IN ({','.join('?' * len(known))})))", known)
    units = [u for u, k in guess.items() if k == key or (("." not in key) and k.startswith(key + "."))]
    cond = "(chapter=? OR chapter LIKE ?" if "." not in key else "(chapter=?"
    a = [key, f"{key}.%"] if "." not in key else [key]
    if units:
        cond += f" OR (COALESCE(chapter,'')='' AND unit IN ({','.join('?' * len(units))}))"
        a += units
    return cond + ")", a


def _everything(p) -> bool:
    """One exam's own questions or questions picked by id: also those kept out of the 題庫."""
    return bool(p.get("exam_id") or p.get("ids"))


def _subject_chapter(subjects: str | None, chapters: str | None, args: list) -> str:
    """科目 and 章節 picked together: a subject with 章節 picked is only those 章節, one without is
    the whole subject ("數學, 自然:6" = all of 數學 + 自然 第6單元). 章節 keys: "自然:6" / "自然:6.1" /
    "自然:?" (the review book), "數學:<unit>" (the curriculum unit)."""
    subs = [s for s in (subjects or "").split(",") if s][:10]
    by = {}
    for key in (chapters or "").split(",")[:40]:
        s, _, ch = key.partition(":")
        if s and ch:
            by.setdefault(s, []).append(ch)
    ors = []
    for s in subs + [s for s in by if s not in subs]:
        if s not in by:
            ors.append("subject=?")
            args.append(s)
            continue
        for ch in by[s]:
            if s in curriculum.CHAPTER_SUBJECTS:
                cond, a = _chapter_sql(s, ch)
                ors.append(f"(subject=? AND {cond})")
                args += [s, *a]
            else:
                ors.append("(subject=? AND unit=?)")
                args += [s, ch]
    return "(" + " OR ".join(ors) + ")" if ors else ""


def _with_chapter(items: list[dict]) -> list[dict]:
    for q in items:
        q["chapter_label"] = curriculum.chapter_label(q.get("subject") or "", q.get("unit") or "", q.get("chapter") or "")
    return items


def _filters(request: Request, params: dict):
    """WHERE clause over qstate.view(); the view's single ? (viewer id) is
    prepended by the callers."""
    where, args = ["1"], []
    if params.get("scope") == "mine":
        where.append("owner_id=?")
        args.append(sid(request))
    subj_ch = _subject_chapter(params.get("subject"), params.get("chapter"), args)
    if subj_ch:
        where.append(subj_ch)
    for col in ("unit", "qtype", "source", "level"):
        if params.get(col):
            vals = params[col].split(",")
            where.append(f"{col} IN ({','.join('?' * len(vals))})")
            args += vals
    if params.get("exam_id"):
        ex = [int(x) for x in str(params["exam_id"]).split(",") if x.strip().isdigit()][:50]
        where.append(f"exam_id IN ({','.join('?' * len(ex)) or 'NULL'})")
        args += ex
    if params.get("ids"):
        ids = [int(x) for x in str(params["ids"]).split(",") if x.strip().isdigit()][:300]
        where.append(f"id IN ({','.join('?' * len(ids)) or 'NULL'})")
        args += ids
    if params.get("min_wrong"):
        where.append("wrong_count>=?")
        args.append(int(params["min_wrong"]))
    if params.get("grade"):
        where.append("grade=?")
        args.append(int(params["grade"]))
    for f in (params.get("flags") or "").split(","):
        if f in FLAG_SQL:
            where.append(FLAG_SQL[f])
    if params.get("flags_any"):
        ors = [FLAG_SQL[f] for f in params["flags_any"].split(",") if f in FLAG_SQL]
        if ors:
            where.append("(" + " OR ".join(ors) + ")")
    if params.get("min_grade"):
        where.append("grade>=?")
        args.append(int(params["min_grade"]))
    if params.get("max_grade"):
        where.append("grade<=?")
        args.append(int(params["max_grade"]))
    if params.get("q"):  # every word must match somewhere: the question, its concept, its exam's name
        for w in str(params["q"]).split()[:6]:
            ors = ["stem LIKE ?", "note LIKE ?", "unit LIKE ?", "answer LIKE ?", "exam_id IN (SELECT id FROM exams WHERE title LIKE ?)"]
            args += [f"%{w}%"] * 5
            for subj in curriculum.CHAPTER_SUBJECTS:  # a 章節 name in the book (水溶液, 第6單元…)
                hit = [c for c in _book_index(subj) if w in c[1]]
                for key, _ in hit:
                    cond, a = _chapter_sql(subj, key)
                    ors.append(f"(subject=? AND {cond})")
                    args += [subj, *a]
            where.append("(" + " OR ".join(ors) + ")")
    if params.get("school") in ("0", "1"):  # 學校考卷 or not
        where.append("school=?" if params["school"] == "1" else "school=0")
        if params["school"] == "1":
            args.append(1)
    if params.get("since"):  # added on or after (YYYY-MM-DD; the exam's own date when it has one)
        where.append("COALESCE((SELECT e.exam_date FROM exams e WHERE e.id = exam_id), substr(created_at, 1, 10)) >= ?")
        args.append(str(params["since"])[:10])
    if params.get("hide_generated") == "1":
        where.append("source IN ('scan','manual')")
    return " AND ".join(where), args


@app.get("/api/questions")
async def list_questions(request: Request):
    p = dict(request.query_params)
    where, args = _filters(request, p)
    order = {"new": "id DESC", "old": "id", "exam": "exam_id DESC, seq", "unit": "subject, unit, qtype, id",
             "wrong": "wrong_count DESC, id DESC"}.get(p.get("sort", "new"), "id DESC")
    limit = min(int(p.get("limit", 200)), 1000)
    offset = int(p.get("offset", 0))
    V, me = qstate.view(_everything(p)), [sid(request)]
    total = db.scalar(f"SELECT COUNT(*) FROM {V} WHERE {where}", me + args)
    rows = db.q(f"SELECT * FROM {V} WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
                me + args + [limit, offset])
    if p.get("lite"):  # a list: the long parts (詳解、圖、提示…) come when a card is opened
        for q in rows:
            for k in HEAVY_Q:
                q.pop(k, None)
            q["_lite"] = True
    return {"total": total, "items": _with_chapter(rows)}


@app.get("/api/bank/facets")
async def bank_facets(request: Request):
    """題庫 search: every filter's choices with counts. Each group is counted with all the OTHER
    groups' conditions applied (so a count is exactly what tapping it adds); `total` uses all of them."""
    V, me = qstate.view(), [sid(request)]
    p = {k: v for k, v in request.query_params.items()}
    groups = {"status": ("flags_any",), "subject": ("subject", "chapter"), "chapter": ("chapter",), "exam": ("exam_id",),
              "qtype": ("qtype",), "source": ("source",), "time": ("since",), "school": ("school",)}

    def scope(group: str | None):
        drop = groups.get(group, ())
        return _filters(request, {k: v for k, v in p.items() if k not in drop})

    def count(group: str, col: str) -> dict:
        w, a = scope(group)
        return {r["k"]: r["n"] for r in db.q(f"SELECT {col} AS k, COUNT(*) AS n FROM {V} WHERE {w} GROUP BY {col} ORDER BY n DESC", me + a) if r["k"]}

    w, a = scope(None)
    total = db.scalar(f"SELECT COUNT(*) FROM {V} WHERE {w}", me + a)
    w, a = scope("status")
    status = db.one(f"SELECT COUNT(*) AS total, SUM(is_wrong AND NOT mastered) AS unmastered, SUM(teacher_mark IN ('wrong','partial')) AS teacher, "
                    f"SUM(is_highlighted OR is_marked) AS marks, SUM(is_favorite) AS favorite, SUM(mastered) AS mastered FROM {V} WHERE {w}", me + a)
    w, a = scope("exam")
    exams = db.q(f"SELECT e.id, e.title, e.subject, e.exam_date, e.student_id, x.n, x.wrong FROM (SELECT exam_id, COUNT(*) AS n, "
                 f"SUM(is_wrong AND NOT mastered) AS wrong FROM {V} WHERE {w} GROUP BY exam_id) x JOIN exams e ON e.id = x.exam_id "
                 f"ORDER BY e.exam_date DESC, e.id DESC", me + a)
    w, a = scope("time")
    day = "COALESCE((SELECT e.exam_date FROM exams e WHERE e.id = exam_id), substr(created_at, 1, 10))"
    since = {d: str(p.get(f"since_{d}") or "") for d in ("0", "7", "30", "90", "term")}  # the browser's own dates
    times = {"": 0}
    sub_q = f"SELECT {day} AS d FROM {V} WHERE {w}"
    for r in db.q(f"SELECT d, COUNT(*) AS n FROM ({sub_q}) GROUP BY d", me + a):
        times[""] += r["n"]
        for k, v in since.items():
            if v and (r["d"] or "") >= v:
                times[k] = times.get(k, 0) + r["n"]
    # 章節: the review book for 自然 (unit → its 主題, with counts), the curriculum units for the rest
    w, a = scope("chapter")
    rows = db.q(f"SELECT subject, unit, COALESCE(chapter,'') AS chapter, COUNT(*) AS n FROM {V} WHERE {w} GROUP BY subject, unit, chapter", me + a)
    chapters = []
    for subj in sorted({r["subject"] for r in rows if r["subject"]}):
        mine = [r for r in rows if r["subject"] == subj]
        if subj in curriculum.CHAPTER_SUBJECTS:
            n = {}
            for r in mine:
                k = curriculum.chapter_of(subj, r["unit"], r["chapter"]) or "?"
                n[k] = n.get(k, 0) + r["n"]
                if "." in k:
                    n[k.split(".")[0]] = n.get(k.split(".")[0], 0) + r["n"]
            items = [{"key": f"{subj}:{c['key']}", "label": c["label"], "group": f"{subj}・{c['area']}", "topic": c["topic"], "n": n.get(c["key"], 0)}
                     for c in curriculum.chapters(subj) if n.get(c["key"])]
            if n.get("?"):
                items.append({"key": f"{subj}:?", "label": "未分類", "group": f"{subj}・其他", "topic": 0, "n": n["?"]})
        else:
            order = {u: i for i, u in enumerate(u for t in curriculum.CURRICULUM.get(subj, {}).values() for u in t)}
            units = {}
            for r in mine:
                if r["unit"]:
                    units[r["unit"]] = units.get(r["unit"], 0) + r["n"]
            items = [{"key": f"{subj}:{u}", "label": u, "group": subj, "topic": 0, "n": c}
                     for u, c in sorted(units.items(), key=lambda x: (order.get(x[0], 999), x[0]))]
        chapters += items
    w, a = scope("school")
    sc = db.one(f"SELECT COUNT(*) AS n, COALESCE(SUM(school = 1), 0) AS school FROM {V} WHERE {w}", me + a)
    return {"total": total, "flags": status, "school": {"1": sc["school"], "0": sc["n"] - sc["school"]}, "subjects": count("subject", "subject"), "qtypes": count("qtype", "qtype"),
            "sources": count("source", "source"), "exams": exams, "times": times, "chapters": chapters}


@app.get("/api/questions/ids")
async def question_ids(request: Request):
    """Just the ids a search finds (for 組合: several searches practised or printed together)."""
    where, args = _filters(request, dict(request.query_params))
    return {"ids": [r["id"] for r in db.q(f"SELECT id FROM {qstate.view(_everything(request.query_params))} WHERE {where} ORDER BY exam_id, seq, id LIMIT 1000",
                                          [sid(request)] + args)]}


@app.get("/api/questions/groups")
async def question_groups(request: Request):
    p = dict(request.query_params)
    where, args = _filters(request, p)
    rows = db.q(f"SELECT subject, unit, qtype, COUNT(*) AS n, SUM(is_wrong AND NOT mastered) AS wrong, "
                f"SUM(is_highlighted) AS highlighted, SUM(is_marked) AS marked, SUM(mastered) AS mastered, "
                f"SUM(wrong_count) AS wrong_times "
                f"FROM {qstate.view()} WHERE {where} GROUP BY subject, unit, qtype ORDER BY subject, unit, qtype",
                [sid(request)] + args)
    return rows


@app.get("/api/questions/{qid}")
async def get_question(qid: int, request: Request):
    q = own_q(request, qid)
    me = sid(request)
    q["history"] = db.q("SELECT id, mode, answer, correct, error_type, analysis, image_path, created_at "
                        "FROM attempts WHERE question_id=? AND student_id=? ORDER BY id DESC LIMIT 20", (qid, me))
    q["similar"] = qstate.query(me, "parent_id=?", [qid], "ORDER BY id", everything=True)
    q["similar"] = [{k: x[k] for k in ("id", "stem", "qtype", "solved", "attempts", "correct_count")} for x in q["similar"]]
    q["has_knowledge"] = bool(db.scalar("SELECT 1 FROM knowledge WHERE subject=? AND unit=?",
                                        (q["subject"], q["unit"])))
    q["exam_title"] = db.scalar("SELECT title FROM exams WHERE id=?", (q["exam_id"],)) if q["exam_id"] else ""
    q["can_edit"] = can_edit(request, q)
    q["reteach"] = [r["content"] | {"id": r["id"], "wrong_count": r["wrong_count"], "created_at": r["created_at"]}
                    for r in db.q("SELECT * FROM explanations WHERE question_id=? AND student_id=? AND kind='reteach' "
                                  "ORDER BY id DESC", (qid, me))]
    if is_parent(request):
        c = db.one("SELECT * FROM explanations WHERE question_id=? AND student_id=? AND kind='coach' ORDER BY id DESC",
                   (qid, me))
        q["coach"] = c["content"] if c else None
    # family view: how often each child has missed this one (parents only)
    if is_parent(request):
        q["family"] = db.q("SELECT st.name, sq.wrong_count, sq.mastered FROM student_q sq JOIN students st "
                           "ON st.id=sq.student_id WHERE sq.question_id=? AND (sq.wrong_count>0 OR sq.is_wrong=1)", (qid,))
    return q


QEDIT = {"level", "number", "section", "subject", "grade", "unit", "qtype", "stem", "options", "answer", "choice_index",
         "explanation", "steps", "hints", "key_points", "mistakes", "qtype_tip", "difficulty",
         "student_answer", "teacher_mark", "is_wrong", "is_highlighted", "is_marked", "is_favorite",
         "note", "tags", "mastered", "seq", "bar_model", "chapter"}


def _clean_q(body: dict) -> dict:
    d = {k: v for k, v in body.items() if k in QEDIT}
    if "bar_model" in d and not isinstance(d["bar_model"], str):
        d["bar_model"] = json.dumps(d["bar_model"], ensure_ascii=False) if d["bar_model"] else ""
    if d.get("is_wrong") == 1 or d.get("is_wrong") is True:
        d.setdefault("next_review", db.today())
    return d


@app.post("/api/questions")
async def create_question(body: dict, request: Request):
    content, personal = qstate.split(_clean_q(body))
    content.update({"student_id": sid(request), "source": body.get("source", "manual"),
                    "exam_id": int(body.get("exam_id") or 0), "created_at": db.now(), "updated_at": db.now(),
                    "solved": 1 if body.get("answer") else 0})
    if content["exam_id"] and "seq" not in content:
        content["seq"] = (db.scalar("SELECT MAX(seq) FROM questions WHERE exam_id=?", (content["exam_id"],)) or 0) + 1
    qid = db.insert("questions", content)
    if personal:
        if personal.get("is_wrong"):
            personal.setdefault("wrong_count", 1)
        qstate.set_state(sid(request), qid, personal)
    return {"id": qid}


@app.put("/api/questions/{qid}")
async def edit_question(qid: int, body: dict, request: Request):
    q = own_q(request, qid)
    content, personal = qstate.split(_clean_q(body))
    if content:
        if not can_edit(request, q):
            raise HTTPException(403, "這題是別人加入的，只有他本人或家長可以修改題目內容")
        content["updated_at"] = db.now()
        db.update("questions", qid, content)
    if personal:
        if personal.get("is_wrong") and not q["is_wrong"] and not q["wrong_count"]:
            personal["wrong_count"] = 1
        qstate.set_state(sid(request), qid, personal)
    return {"ok": True}


@app.delete("/api/questions/{qid}")
async def delete_question(qid: int, request: Request):
    own_q(request, qid)
    need_parent(request)  # 刪除題庫資料: parents only (a scanned question is the child's own)
    db.execute("DELETE FROM questions WHERE id=?", (qid,))
    db.execute("DELETE FROM student_q WHERE question_id=?", (qid,))
    return {"ok": True}


@app.post("/api/questions/bulk")
async def bulk(body: dict, request: Request):
    ids = [int(i) for i in body.get("ids", [])]
    me = sid(request)
    rows = [q for q in (qstate.get(me, i) for i in ids) if q]
    editable = [q["id"] for q in rows if can_edit(request, q)]
    if not rows:
        return {"ok": True}
    action = body.get("action")
    if action == "delete":
        need_parent(request)
        if editable:
            marks = ",".join("?" * len(editable))
            db.execute(f"DELETE FROM questions WHERE id IN ({marks})", editable)
            db.execute(f"DELETE FROM student_q WHERE question_id IN ({marks})", editable)
        return {"ok": True, "deleted": len(editable), "skipped": len(rows) - len(editable)}
    if action == "set":
        content, personal = qstate.split(_clean_q(body.get("data", {})))
        for q in rows:
            if personal:
                p = dict(personal)
                if p.get("is_wrong") and not q["wrong_count"]:
                    p["wrong_count"] = 1
                qstate.set_state(me, q["id"], p)
            if content and q["id"] in editable:
                db.update("questions", q["id"], content)
        return {"ok": True}
    if action == "add_to_wrong":
        # Parent puts shared questions into another child's 錯題本.
        need_parent(request)
        to = int(body.get("student_id") or 0)
        if not db.scalar("SELECT 1 FROM students WHERE id=? AND role='student'", (to,)):
            raise HTTPException(404, "找不到學生")
        for q in rows:
            qstate.set_state(to, q["id"], {"is_wrong": 1, "mastered": 0, "next_review": db.today()})
        return {"ok": True, "added": len(rows)}
    if action == "solve":
        need_ai()
        return {"job_id": jobs.start("solve", 0, pipeline.solve_job, [q["id"] for q in rows])}
    return {"ok": True}


@app.post("/api/questions/{qid}/solve")
async def solve_one(qid: int, request: Request, body: dict | None = None):
    """Re-solve; with a note (「11 是到最底下的整段」) the AI re-reads the figure with
    that correction, and the note stays with the question for every later AI task."""
    own_q(request, qid)
    need_ai()
    note = ((body or {}).get("note") or "").strip()[:300]
    if note:
        db.execute("UPDATE questions SET fix_note=? WHERE id=?", (note, qid))
    return {"job_id": jobs.start("solve", qid, pipeline.solve_job, [qid])}


@app.post("/api/questions/{qid}/fix")
async def fix_question(qid: int, body: dict, request: Request):
    """這題有問題？告訴 AI 怎麼改: the description is kept with the question (every later AI step
    follows it) and the question is redone from the photo right away (a person is waiting)."""
    own_q(request, qid)
    need_ai()
    note = (body.get("note") or "").strip()[:400]
    if not note:
        raise HTTPException(400, "請說明哪裡有問題")
    old = db.scalar("SELECT fix_note FROM questions WHERE id=?", (qid,)) or ""
    db.execute("UPDATE questions SET fix_note=?, upgraded_at='' WHERE id=?", ((old + "；" if old and note not in old else "") + note, qid))
    return {"job_id": jobs.start("fix", qid, pipeline.fix_question_job, qid)}


@app.post("/api/exams/{exam_id}/verify")
async def verify_exam(exam_id: int, request: Request):
    """答案複查: before the paper is printed, a second look at every answer and 詳解 from the photos
    (what it changes is listed on the exam for the parent)."""
    own_exam(request, exam_id)
    need_parent(request)
    need_ai()
    if db.scalar("SELECT 1 FROM questions WHERE exam_id=? AND (upgraded_at='' OR upgraded_at IS NULL)", (exam_id,)):
        raise HTTPException(409, "AI 還在對照原稿校對這份考卷，校對完再複查")
    if db.scalar("SELECT 1 FROM jobs WHERE kind='verify' AND ref_id=? AND status IN ('queued','running')", (exam_id,)):
        raise HTTPException(409, "這份正在複查中")
    return {"job_id": jobs.start("verify", exam_id, pipeline.verify_job, exam_id)}


@app.post("/api/questions/{qid}/visualize")
async def visualize(qid: int, request: Request):
    own_q(request, qid)
    need_ai()
    return {"job_id": ahead(("visualize", qid), "visualize", qid, pipeline.visualize_job, qid)}


@app.post("/api/questions/{qid}/steps")
async def steps(qid: int, body: dict, request: Request):
    """Typed working-out (no stylus) analysed like the handwriting pad."""
    need_ai()
    s = sid(request)
    q = own_q(request, qid)
    text = (body.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "請先打下你的計算步驟")
    try:
        res = await ai.steps_text(q, text)
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    correct = res.get("result") == "correct"
    if res.get("result") in ("correct", "wrong"):
        practice.srs_update(s, q, correct, res.get("final_answer", "") if not correct else "")
    res["attempt_id"] = practice.record(s, q, "steps", text, correct if res.get("result") in ("correct", "wrong") else None,
                                        analysis=res, error_type=res.get("error_type", ""))
    xp, coins = _reward("tutor", correct)
    res["reward"] = gamify.award(s, xp, coins, "步驟分析")
    if res.get("result") == "wrong":
        prepare_after_wrong(s, qid)
    return res


@app.post("/api/questions/{qid}/coach")
async def coach(qid: int, request: Request):
    need_parent(request)
    own_q(request, qid)
    need_ai()
    return {"job_id": ahead(("coach", qid, sid(request)), "coach", qid, pipeline.coach_job, qid, sid(request))}


@app.post("/api/questions/{qid}/chat/note")
async def chat_note(qid: int, request: Request):
    need_ai()
    s = sid(request)
    q = own_q(request, qid)
    c = db.one("SELECT * FROM chats WHERE question_id=? AND student_id=?", (qid, s))
    if not c or len(c["messages"]) < 2:
        raise HTTPException(400, "先和小老師聊一聊，再整理成筆記")
    try:
        note = await ai.chat_note(q, c["messages"])
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    nid = db.insert("notes", {"student_id": s, "question_id": qid, "subject": q["subject"], "unit": q["unit"],
                              "title": note.get("title") or "觀念筆記", "content": note, "source": "chat",
                              "created_at": db.now()})
    return {"id": nid, **note}


@app.post("/api/questions/{qid}/help")
async def ask_help(qid: int, body: dict, request: Request):
    q = own_q(request, qid)
    s = sid(request)
    msg = (body.get("message") or "").strip() or _help_summary(s, q)
    hid = db.insert("help_requests", {"student_id": s, "question_id": q["id"],
                                      "message": msg[:500], "created_at": db.now(), "updated_at": db.now()})
    if ai.configured() and not db.scalar("SELECT 1 FROM explanations WHERE question_id=? AND student_id=? AND kind='coach'",
                                         (q["id"], s)):
        ahead(("coach", q["id"], s), "coach", q["id"], pipeline.coach_job, q["id"], s)  # ready when the parent opens it
    return {"id": hid, "message": msg}


def _help_summary(s: int, q: dict) -> str:
    """One tap 請爸媽幫忙: tell the parent what she tried, so nobody has to type."""
    parts = []
    wrong = [a["answer"] for a in db.q("SELECT answer FROM attempts WHERE student_id=? AND question_id=? AND correct=0 "
                                       "AND answer!='' ORDER BY id DESC LIMIT 3", (s, q["id"]))]
    if wrong:
        parts.append("寫過的答案：" + "、".join(dict.fromkeys(wrong)))
    diag = next((r["content"] for r in db.q("SELECT content FROM explanations WHERE question_id=? AND kind='diag' "
                                             "ORDER BY id DESC", (q["id"],))
                 if wrong and (r["content"] or {}).get("answer") == practice._norm(wrong[0])), None)
    if diag and diag.get("likely_cause"):
        parts.append("AI 判斷：" + diag["likely_cause"])
    chat = db.one("SELECT messages FROM chats WHERE student_id=? AND question_id=?", (s, q["id"]))
    msgs = (chat or {}).get("messages") or []
    if isinstance(msgs, str):
        msgs = json.loads(msgs or "[]")
    asked = next((m.get("text", "") for m in reversed(msgs) if m.get("role") == "user" and m.get("text")), "")
    if asked:
        parts.append(f"問過小老師：「{asked[:60]}」")
    return "；".join(parts) or "這題不會，想請你陪我看一下"


@app.post("/api/questions/{qid}/reteach")
async def reteach(qid: int, request: Request):
    own_q(request, qid)
    need_ai()
    return {"job_id": ahead(("reteach", qid, sid(request)), "reteach", qid, pipeline.reteach_job, qid, sid(request))}


@app.post("/api/questions/{qid}/similar")
async def similar(qid: int, body: dict, request: Request):
    own_q(request, qid)
    need_ai()
    n = max(1, min(10, int(body.get("n", 3))))
    return {"job_id": jobs.start("similar", qid, pipeline.similar_job, qid, n,
                                 body.get("difficulty", "same"), sid(request))}


def _reward(mode: str, correct: bool) -> tuple[int, int]:
    if mode == "tutor":
        return (15, 3) if correct else (8, 1)
    if mode == "review":
        return (15, 3) if correct else (3, 0)
    if mode in ("challenge", "unit", "duel"):
        return (12, 2) if correct else (2, 0)
    return (10, 2) if correct else (2, 0)


@app.post("/api/questions/{qid}/answer")
async def answer(qid: int, body: dict, request: Request):
    s = sid(request)
    q = own_q(request, qid)
    mode = body.get("mode", "practice")
    if "self_correct" in body:  # child marks a written answer after checking the solution
        res = {"correct": bool(body["self_correct"]), "feedback": ""}
    else:
        res = await practice.check(q, body.get("answer", ""))
    if is_parent(request) and s != request.state.user["id"] and not body.get("as_child"):
        # a parent trying her child's exam: checked, but never written into the child's record
        # (as_child: the child is answering on the parent's device — it counts)
        return {**res, "answer": q["answer"], "choice_index": q["choice_index"], "preview": True}
    upd = practice.srs_update(s, q, res["correct"], "" if "self_correct" in body else body.get("answer", ""))
    res["attempt_id"] = practice.record(s, q, mode, body.get("answer", ""), res["correct"], int(body.get("seconds", 0)))
    xp, coins = _reward(mode, res["correct"])
    reward = gamify.award(s, xp, coins, f"{mode}答題")
    res.update({"reward": reward, "answer": q["answer"], "choice_index": q["choice_index"],
                "wrong_count": upd.get("wrong_count", q["wrong_count"]),
                "new_badges": [gamify.BADGES[b][1] for b in gamify.check_badges(s)]})
    wrong = str(body.get("answer", "")).strip()
    if not res["correct"] and wrong and "self_correct" not in body and ai.configured():
        if q.get("choice_index") and q.get("options"):  # say which option they picked, not just its number
            try:
                wrong = f"選了第 {int(wrong)} 個選項：{q['options'][int(wrong) - 1]}"
            except (ValueError, IndexError):
                pass
        res["diagnose_job"] = jobs.start("diagnose", qid, pipeline.diagnose_job, qid, s, res["attempt_id"], wrong)
    if not res["correct"]:
        prepare_after_wrong(s, qid)
    return res


# --- 練習任務: every practice round is a task with its own score; what was done right is not repeated ---

def _session_row(r: dict) -> dict:
    res = r["results"] or {}
    ids = r["question_ids"] or []
    done = len(res)
    ok = sum(1 for v in res.values() if v)
    return {"id": r["id"], "title": r["title"], "source": r["source"], "n": len(ids), "done": done, "correct": ok,
            "pct": round(100 * ok / done) if done else None, "finished": bool(r["finished_at"]),
            "created_at": r["created_at"], "finished_at": r["finished_at"]}


@app.post("/api/practice/sessions")
def session_start(body: dict, request: Request):
    s = sid(request)
    ids = [int(i) for i in body.get("ids", [])][:300]
    sid_ = db.insert("practice_sessions", {"student_id": s, "title": str(body.get("title") or "練習")[:60],
                                           "source": str(body.get("source") or "")[:40], "question_ids": ids,
                                           "results": {}, "created_at": db.now(), "updated_at": db.now()})
    return {"id": sid_}


def _own_session(request: Request, ps: int) -> dict:
    r = db.one("SELECT * FROM practice_sessions WHERE id=?", (ps,))
    if not r or r["student_id"] != sid(request):
        raise HTTPException(404, "找不到這次練習")
    return r


@app.post("/api/practice/sessions/{ps}/result")
def session_result(ps: int, body: dict, request: Request):
    r = _own_session(request, ps)
    res = r["results"] or {}
    qid = str(int(body.get("qid") or 0))
    if qid not in res:  # the first try counts
        res[qid] = bool(body.get("correct"))
        ids = r["question_ids"] or []
        if int(qid) not in ids:
            ids.append(int(qid))
        db.update("practice_sessions", ps, {"results": res, "question_ids": ids, "updated_at": db.now()})
    return _session_row(db.one("SELECT * FROM practice_sessions WHERE id=?", (ps,)))


@app.post("/api/practice/sessions/{ps}/finish")
def session_finish(ps: int, request: Request):
    _own_session(request, ps)
    db.update("practice_sessions", ps, {"finished_at": db.now(), "updated_at": db.now()})
    return _session_row(db.one("SELECT * FROM practice_sessions WHERE id=?", (ps,)))


@app.get("/api/practice/sessions")
def session_list(request: Request, source: str = "", limit: int = 30):
    s = sid(request)
    rows = db.q("SELECT * FROM practice_sessions WHERE student_id=? AND (?='' OR source=?) AND results!='{}' "
                "ORDER BY id DESC LIMIT ?", (s, source, source, max(1, min(200, limit))))
    return [_session_row(r) for r in rows]


@app.get("/api/practice/progress")
def session_progress(request: Request, source: str):
    """For one exam / task: which questions she already got right last time (not asked again), which
    she got wrong last time, how often each one was ever wrong (錯題紀錄), and the earlier rounds'
    scores. Answers given outside a round (the question page, 手寫批改) count too."""
    s = sid(request)
    rows = db.q("SELECT * FROM practice_sessions WHERE student_id=? AND source=? ORDER BY id", (s, source))
    events = []  # (time, qid, correct)
    for r in rows:
        for k, v in (r["results"] or {}).items():
            events.append((r["updated_at"] or r["created_at"] or "", int(k), bool(v)))
    wrong_n: dict = {}
    m = re.fullmatch(r"exam:(\d+)", source or "")
    if m:
        # every answer of this exam's questions is an attempt (rounds included); a round's result
        # without one (answered before this was kept) still counts
        rounds_only = events
        events = []
        for a in db.q("SELECT a.question_id, a.correct, a.created_at FROM attempts a JOIN questions q ON q.id=a.question_id "
                      "WHERE a.student_id=? AND q.exam_id=? AND a.correct IS NOT NULL ORDER BY a.id", (s, int(m.group(1)))):
            events.append((a["created_at"] or "", a["question_id"], bool(a["correct"])))
            if not a["correct"]:
                wrong_n[a["question_id"]] = wrong_n.get(a["question_id"], 0) + 1
        seen = {e[1] for e in events}
        for e in rounds_only:
            if e[1] not in seen:
                events.append(e)
                if not e[2]:
                    wrong_n[e[1]] = wrong_n.get(e[1], 0) + 1
    else:
        for e in events:
            if not e[2]:
                wrong_n[e[1]] = wrong_n.get(e[1], 0) + 1
    last: dict = {}
    for _, qid, ok in sorted(events, key=lambda e: e[0]):
        last[qid] = ok
    return {"right": [k for k, v in last.items() if v], "wrong": [k for k, v in last.items() if not v],
            "wrong_counts": {str(k): n for k, n in wrong_n.items()},
            "rounds": [_session_row(r) for r in rows if r["results"]][-10:]}


@app.post("/api/questions/{qid}/tutor")
async def tutor(qid: int, request: Request, image: UploadFile = File(...), attempt: int = Form(0)):
    """逐行批改. With `attempt` (the quick check already recorded this try): that attempt gets the
    line-by-line analysis instead of a second one being counted."""
    need_ai()
    s = sid(request)
    q = own_q(request, qid)
    data = await image.read()
    prev = db.one("SELECT * FROM attempts WHERE id=? AND student_id=? AND question_id=?", (attempt, s, qid)) if attempt else None
    rel = prev["image_path"] if prev and prev["image_path"] else f"work/{s}/{qid}_{int(time.time())}.png"
    (MEDIA_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
    (MEDIA_DIR / rel).write_bytes(data)
    try:
        res = await ai.tutor(q, data, pipeline.figure_bytes(q))
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    correct = res.get("result") == "correct"
    decided = res.get("result") in ("correct", "wrong")
    if prev:
        db.execute("UPDATE attempts SET analysis=?, error_type=?, answer=?, correct=? WHERE id=?",
                   (json.dumps(res, ensure_ascii=False), res.get("error_type", ""), str(res.get("final_answer", ""))[:2000],
                    int(correct) if decided else prev["correct"], prev["id"]))
        if decided and prev["correct"] is None:
            practice.srs_update(s, q, correct, res.get("final_answer", "") if not correct else "")
        res["reward"] = {"xp": 0, "coins": 0}
        res["new_badges"] = []
    else:
        if decided:
            practice.srs_update(s, q, correct, res.get("final_answer", "") if not correct else "")
        practice.record(s, q, "tutor", res.get("final_answer", ""), correct if decided else None,
                        analysis=res, error_type=res.get("error_type", ""), image_path=rel)
        xp, coins = _reward("tutor", correct)
        res["reward"] = gamify.award(s, xp, coins, "手寫解題")
        res["new_badges"] = [gamify.BADGES[b][1] for b in gamify.check_badges(s)]
    res["image"] = rel
    if res.get("result") == "wrong":
        prepare_after_wrong(s, qid)
    return res


@app.post("/api/questions/{qid}/tutor/quick")
async def tutor_quick(qid: int, request: Request, image: UploadFile = File(...), record: int = Form(0)):
    """先對答案: the AI only reads what she wrote and whether it is right (no 詳解); her final answer is
    compared with the key here first. With `record` this is the graded try (counted, rewarded):
    a right answer needs nothing more, the line-by-line grading runs only when she asks."""
    need_ai()
    s = sid(request)
    q = own_q(request, qid)
    data = await image.read()
    # the figure only when there is no key to compare with (a smaller, faster request)
    try:
        res = await ai.tutor_quick(q, data, None if q.get("answer") else pipeline.figure_bytes(q))
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    said = str(res.get("final_answer") or "").strip()
    if said and q.get("answer") and res.get("result") in ("correct", "wrong"):
        lc = practice.local_check(q, said)
        if lc is not None:
            res["result"] = "correct" if lc else "wrong"
            res["checked"] = "local"
    if not record:
        return res
    rel = f"work/{s}/{qid}_{int(time.time())}.png"
    (MEDIA_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
    (MEDIA_DIR / rel).write_bytes(data)
    correct = res.get("result") == "correct"
    decided = res.get("result") in ("correct", "wrong")
    if decided:
        upd = practice.srs_update(s, q, correct, said if not correct else "")
        res["wrong_count"] = upd.get("wrong_count", q["wrong_count"])
    res["attempt_id"] = practice.record(s, q, "tutor", said, correct if decided else None,
                                        analysis={"quick": True, "headline": res.get("headline", "")}, image_path=rel)
    if decided:
        xp, coins = _reward("tutor", correct)
        res["reward"] = gamify.award(s, xp, coins, "手寫解題")
        res["new_badges"] = [gamify.BADGES[b][1] for b in gamify.check_badges(s)]
    res["image"] = rel
    if res.get("result") == "wrong":
        prepare_after_wrong(s, qid)
    return res


def _data_url_bytes(u: str | None) -> bytes | None:
    if not u or "," not in u:
        return None
    return base64.b64decode(u.split(",", 1)[1])


# --- 先準備好: AI work started before the child asks for it -----------------------------------

_ahead: dict[tuple, int] = {}


def ahead(key: tuple, kind: str, ref: int, fn, *args) -> int:
    """Start a background job once per key; while it runs, every request for the
    same thing gets that job instead of starting another."""
    jid = _ahead.get(key)
    if jid:
        j = db.one("SELECT status FROM jobs WHERE id=?", (jid,))
        if j and j["status"] in ("queued", "running"):
            return jid
    jid = jobs.start(kind, ref, fn, *args)
    _ahead[key] = jid
    return jid


def prepare_after_wrong(s: int, qid: int):
    """Answered wrong: draw the concept diagram now, and once it is the second
    mistake, write 「換個方法解說」 — both ready by the time she taps."""
    if not ai.configured():
        return
    q = qstate.get(s, qid)
    if not q or not q.get("solved"):
        return
    if not q.get("visuals"):
        ahead(("visualize", qid), "visualize", qid, pipeline.visualize_job, qid)
    if (q.get("wrong_count") or 0) >= 2:
        last = db.scalar("SELECT MAX(wrong_count) FROM explanations WHERE question_id=? AND student_id=? AND kind='reteach'",
                         (qid, s)) or 0
        if last < q["wrong_count"]:
            ahead(("reteach", qid, s), "reteach", qid, pipeline.reteach_job, qid, s)


def _cached(qid: int, kind: str, level: int | None = None):
    rows = db.q("SELECT content, wrong_count FROM explanations WHERE question_id=? AND student_id=0 AND kind=? "
                "ORDER BY id DESC", (qid, kind))
    return next((r["content"] for r in rows if level is None or r["wrong_count"] == level), None)


async def _job_result(jid: int, timeout: float = 90):
    t = time.time()
    while time.time() - t < timeout:
        j = db.one("SELECT status, result, message FROM jobs WHERE id=?", (jid,))
        if j and j["status"] == "done":
            return j["result"]
        if j and j["status"] == "error":
            raise HTTPException(502, j["message"])
        await asyncio.sleep(0.3)
    raise HTTPException(504, "AI 太久沒有回應，請再試一次")


@app.post("/api/questions/{qid}/hint")
async def hint(qid: int, body: dict, request: Request):
    q = own_q(request, qid)
    need_ai()
    s = sid(request)
    if body.get("example"):
        hit = _cached(qid, "example")
        if hit:
            return {**hit, "cached": True}
        return await _job_result(ahead(("example", qid), "example", qid, pipeline.example_job, qid, s))
    level = max(1, min(5, int(body.get("level", 1))))
    stored = {1: 0, 3: 1, 5: 2}  # the three stored hints are levels 1, 3 and 5
    image = _data_url_bytes(body.get("image"))

    def prefetch_next():
        # she is stuck: get the next AI-written level and the worked example ready now
        nxt = level + 1
        if nxt in (2, 4) and not _cached(qid, "hint", nxt):
            ahead(("hint", qid, nxt), "hint", qid, pipeline.hint_job, qid, s, nxt)
        if level >= 1 and not _cached(qid, "example"):
            ahead(("example", qid), "example", qid, pipeline.example_job, qid, s)

    if not image and q["hints"] and level in stored and len(q["hints"]) > stored[level]:
        prefetch_next()
        return {"hint": q["hints"][stored[level]], "guiding_question": "", "look_at": "", "cached": True}
    if not image:
        hit = _cached(qid, "hint", level)
        res = {**hit, "cached": True} if hit else await _job_result(ahead(("hint", qid, level), "hint", qid, pipeline.hint_job, qid, s, level))
        prefetch_next()
        return res
    try:
        return await ai.hint(q, level, image, pipeline.figure_bytes(q))
    except ai.AIError as e:
        raise HTTPException(502, str(e))


@app.get("/api/debug/ai")
async def debug_ai(request: Request):
    """What the AI is doing right now: calls holding a slot (front = someone waiting, back =
    background work), the warm Claude processes, and the Claude processes on the Pi."""
    need_parent(request)
    from . import claude_sub
    now = time.monotonic()
    procs = 0
    for p in Path("/proc").iterdir():
        try:
            if p.name.isdigit() and b"--output-format" in (p / "cmdline").read_bytes():
                procs += 1
        except OSError:
            pass
    return {"front": ai._lanes.front, "back": ai._lanes.back, "back_slots": ai._lanes._back_slots(),
            "active": sorted(([t, "back" if bg else "front", round(now - s)] for t, bg, s in ai._lanes.active.values()), key=lambda x: -x[2]),
            "warm": len(claude_sub._pool), "cli_processes": procs}


@app.post("/api/debug/pen")
async def debug_pen(request: Request):
    """What a tablet's stylus reports (canvas.js penReport): read with journalctl when a pen
    button does nothing on some device."""
    try:
        body = await request.json()
    except ValueError:
        body = {}
    log.info("pen %s %s", request.client.host if request.client else "?",
             json.dumps(body, ensure_ascii=False)[:6000])
    return {"ok": True}


@app.get("/api/questions/{qid}/chat")
async def get_chat(qid: int, request: Request):
    own_q(request, qid)
    c = db.one("SELECT * FROM chats WHERE question_id=? AND student_id=?", (qid, sid(request)))
    return c["messages"] if c else []


@app.delete("/api/questions/{qid}/chat")
async def clear_chat(qid: int, request: Request):
    own_q(request, qid)
    db.execute("DELETE FROM chats WHERE question_id=? AND student_id=?", (qid, sid(request)))
    return {"ok": True}


@app.post("/api/questions/{qid}/sketch")
async def question_sketch(qid: int, request: Request, body: dict | None = None):
    """AI 幫我畫圖: a picture of the question for the 計算紙 (made once and kept; again: a new one)."""
    q = own_q(request, qid)
    done = db.get_setting(f"sketch_{qid}")
    if done and done.get("svg") and not (body or {}).get("again"):
        return done
    need_ai()
    try:
        res = await ai.sketch(q)
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    if "<svg" not in (res.get("svg") or ""):
        raise HTTPException(502, "AI 這次沒有畫好，再按一次試試看")
    out = {"svg": res["svg"], "caption": res.get("caption", "")}
    db.set_setting(f"sketch_{qid}", out)
    return out


def _chat_system(ask: bool) -> str:
    """The same system prompt for every chat (a warm Claude process is ready for it); the question
    itself travels in the message. ask: 我不懂，問 AI — teach it with diagrams, animation, a check."""
    return ai.prompts.CHAT_SYSTEM_EXTRA + ai.prompts.CHAT_VISUAL.format() + ai.prompts.VISUAL_GUIDE + \
        (ai.prompts.CHAT_ASK if ask else "")


@app.post("/api/questions/{qid}/chat")
async def chat(qid: int, body: dict, request: Request):
    need_ai()
    s = sid(request)
    q = own_q(request, qid)
    c = db.one("SELECT * FROM chats WHERE question_id=? AND student_id=?", (qid, s))
    history = c["messages"] if c else []
    text = (body.get("message") or "").strip()[:2000]
    img = _data_url_bytes(body.get("image"))
    img_rel = ""
    if img:
        img_rel = f"work/{s}/chat_{qid}_{int(time.time())}.png"
        (MEDIA_DIR / img_rel).parent.mkdir(parents=True, exist_ok=True)
        (MEDIA_DIR / img_rel).write_bytes(img)
    history.append({"role": "user", "text": text, "image": img_rel})
    msgs = []
    for m in history[-16:]:
        content = []
        if m.get("image") and (MEDIA_DIR / m["image"]).exists():
            content.append(ai.img_block((MEDIA_DIR / m["image"]).read_bytes(), "image/png"))
        content.append({"type": "text", "text": m.get("text") or "（請看圖）"})
        msgs.append({"role": m["role"], "content": content})
    fig = pipeline.figure_bytes(q)
    if fig:
        msgs[0]["content"].insert(0, ai.img_block(fig))
    ctx = ai.question_text(q, with_answer=True)
    if q["student_answer"]:
        ctx += f"\n學生原本的作答：{q['student_answer']}"
    if q["explanation"]:
        ctx += f"\n參考詳解（給你參考，不要整段貼給學生）：{q['explanation']}"
    system_extra = _chat_system(body.get("mode") == "ask")

    async def gen():
        out = []
        async for chunk in ai.stream_chat(system_extra, msgs, _setting("effort_chat"), context=ctx):
            out.append(chunk)
            yield chunk
        ai.prewarm_chat(_chat_system(True), _setting("effort_chat"), accounts.current_grade.get())  # she will likely ask again
        history.append({"role": "assistant", "text": "".join(out)})
        if c:
            db.update("chats", c["id"], {"messages": history, "updated_at": db.now()})
        else:
            db.insert("chats", {"student_id": s, "question_id": qid, "messages": history,
                                "updated_at": db.now()})

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


# --- analysis, plans, notes, goals, rewards, help ---------------------------------------------

@app.get("/api/analysis")
async def get_analysis(request: Request):
    return analysis.full(sid(request))


@app.get("/api/bank/matrix")
async def bank_matrix(request: Request, subject: str = "", min_grade: int = 0, max_grade: int = 0):
    """題庫 as a unit × level grid: counts plus this child's own progress."""
    where, args = ["unit!=''"], []
    if subject:
        where.append("subject=?"); args.append(subject)
    if min_grade:
        where.append("grade>=?"); args.append(min_grade)
    if max_grade:
        where.append("grade<=?"); args.append(max_grade)
    rows = db.q(f"SELECT subject, unit, level, COUNT(*) AS n, SUM(mastered) AS mastered, "
                f"SUM(is_wrong AND NOT mastered) AS wrong, SUM(attempts>0) AS tried, MIN(grade) AS grade "
                f"FROM {qstate.view()} WHERE {' AND '.join(where)} GROUP BY subject, unit, level",
                [sid(request)] + args)
    units = {}
    for r in rows:
        u = units.setdefault((r["subject"], r["unit"]), {"subject": r["subject"], "unit": r["unit"], "grade": r["grade"],
                                                          "levels": {}})
        u["levels"][r["level"]] = {k: r[k] or 0 for k in ("n", "mastered", "wrong", "tried")}
    score = {(u["subject"], u["unit"]): u for u in analysis.units(sid(request))}
    out = []
    for key, u in units.items():
        a = score.get(key)
        u.update({"status": a["status"] if a else "尚未練習", "status_key": a["status_key"] if a else "none",
                  "score": a["score"] if a else None})
        out.append(u)
    out.sort(key=lambda u: (u["subject"], u["grade"] or 0, u["unit"]))
    return out


@app.post("/api/plan")
async def make_plan(body: dict, request: Request):
    need_parent(request)  # 依分析出題 is on the parent's analysis page
    need_ai()
    s = sid(request)
    n = max(3, min(30, int(body.get("n", 10))))
    return {"job_id": jobs.start("plan", s, pipeline.plan_job, s, n, body.get("units"), body.get("mix"),
                                 body.get("title", ""), (request.state.user or {}).get("id", s))}


@app.get("/api/notes")
async def list_notes(request: Request):
    return db.q("SELECT * FROM notes WHERE student_id=? ORDER BY subject, unit, id DESC", (sid(request),))


@app.post("/api/notes")
async def add_note(body: dict, request: Request):
    nid = db.insert("notes", {"student_id": sid(request), "question_id": int(body.get("question_id") or 0),
                              "subject": body.get("subject", ""), "unit": body.get("unit", ""),
                              "title": (body.get("title") or "觀念筆記")[:60], "content": body.get("content") or {},
                              "source": body.get("source", "manual"), "created_at": db.now()})
    return {"id": nid}


@app.delete("/api/notes/{nid}")
async def del_note(nid: int, request: Request):
    db.execute("DELETE FROM notes WHERE id=? AND student_id=?", (nid, sid(request)))
    return {"ok": True}


@app.post("/api/attempts/{aid}/reason")
async def attempt_reason(aid: int, body: dict, request: Request):
    reason = body.get("reason", "")
    if reason not in analysis.SELF_REASONS:
        raise HTTPException(400, "未知的原因")
    db.execute("UPDATE attempts SET self_reason=? WHERE id=? AND student_id=?", (reason, aid, sid(request)))
    return {"ok": True}


def _goal_today(g: dict, s: int) -> dict:
    days = (date.fromisoformat(g["exam_date"]) - date.today()).days
    units = g["units"] or []
    weak = {(u["subject"], u["unit"]): u for u in analysis.units(s)}
    ranked = sorted(units, key=lambda u: (weak.get((u[0], u[1])) or {}).get("score") or 0)
    focus = ranked[date.today().toordinal() % len(ranked)] if ranked else None
    due = 0
    if units:
        marks = " OR ".join("(subject=? AND unit=?)" for _ in units)
        due = len(qstate.query(s, f"is_wrong=1 AND mastered=0 AND ({marks})", [x for u in units for x in u], ""))
    return {**g, "days_left": days, "focus": focus, "due_wrong": due}


@app.get("/api/goals")
async def goals(request: Request, student_id: int = 0):
    s = student_id if student_id and is_parent(request) else sid(request)
    return [_goal_today(g, s) for g in db.q("SELECT * FROM goals WHERE student_id=? AND exam_date>=? ORDER BY exam_date",
                                            (s, db.today()))]


@app.get("/api/goals/suggest")
async def suggest_goal(request: Request, student_id: int = 0):
    need_parent(request)
    s = student_id or sid(request)
    today = date.today()
    title = "期中考" if today.month in (3, 4, 9, 10) else "期末考"
    since = (today - timedelta(days=45)).isoformat()
    rows = db.q(f"SELECT subject, unit, SUM(CASE WHEN exam_id IN (SELECT id FROM exams WHERE created_at>=?) THEN 1 ELSE 0 END) AS recent, "
                f"SUM(is_wrong AND NOT mastered) AS open FROM {qstate.view()} WHERE unit!='' GROUP BY subject, unit", (since, s))
    units = [[r["subject"], r["unit"]] for r in rows if r["recent"] or r["open"]]
    return {"title": title, "exam_date": (today + timedelta(days=14)).isoformat(), "units": units,
            "reason": "依最近 45 天掃描的考卷和還沒精熟的錯題自動帶入" if units else ""}


@app.post("/api/goals")
async def add_goal(body: dict, request: Request):
    need_parent(request)
    s = int(body.get("student_id") or 0) or sid(request)
    gid = db.insert("goals", {"student_id": s, "title": body.get("title") or "段考", "exam_date": body["exam_date"],
                              "units": body.get("units") or [], "created_at": db.now()})
    return {"id": gid}


@app.delete("/api/goals/{gid}")
async def del_goal(gid: int, request: Request):
    need_parent(request)
    db.execute("DELETE FROM goals WHERE id=?", (gid,))
    return {"ok": True}


@app.get("/api/rewards")
async def rewards(request: Request):
    return {"rewards": db.q("SELECT * FROM rewards WHERE active=1 ORDER BY cost"),
            "mine": db.q("SELECT * FROM redemptions WHERE student_id=? ORDER BY id DESC LIMIT 20", (sid(request),)),
            "pending": db.q("SELECT r.*, s.name FROM redemptions r JOIN students s ON s.id=r.student_id "
                            "WHERE r.status='pending' ORDER BY r.id") if is_parent(request) else []}


@app.post("/api/rewards")
async def add_reward(body: dict, request: Request):
    need_parent(request)
    return {"id": db.insert("rewards", {"title": body["title"][:40], "cost": max(1, int(body.get("cost", 100))),
                                        "created_at": db.now()})}


@app.delete("/api/rewards/{rid}")
async def del_reward(rid: int, request: Request):
    need_parent(request)
    db.execute("UPDATE rewards SET active=0 WHERE id=?", (rid,))
    return {"ok": True}


@app.post("/api/rewards/{rid}/redeem")
async def redeem(rid: int, request: Request):
    s = sid(request)
    r = db.one("SELECT * FROM rewards WHERE id=? AND active=1", (rid,))
    if not r:
        raise HTTPException(404, "找不到這個獎勵")
    coins = db.scalar("SELECT coins FROM students WHERE id=?", (s,)) or 0
    if coins < r["cost"]:
        raise HTTPException(400, "金幣不夠喔，再多練習幾題吧！")
    db.execute("UPDATE students SET coins=coins-? WHERE id=?", (r["cost"], s))
    rid2 = db.insert("redemptions", {"student_id": s, "reward_id": rid, "title": r["title"], "cost": r["cost"],
                                     "created_at": db.now(), "updated_at": db.now()})
    return {"id": rid2}


@app.post("/api/redemptions/{xid}")
async def decide_redemption(xid: int, body: dict, request: Request):
    need_parent(request)
    x = db.one("SELECT * FROM redemptions WHERE id=?", (xid,))
    status = body.get("status")
    if not x or x["status"] != "pending" or status not in ("approved", "rejected"):
        raise HTTPException(400, "無法處理")
    if status == "rejected":
        db.execute("UPDATE students SET coins=coins+? WHERE id=?", (x["cost"], x["student_id"]))
    db.update("redemptions", xid, {"status": status, "updated_at": db.now()})
    return {"ok": True}


@app.get("/api/help")
async def help_list(request: Request):
    base = ("SELECT h.*, s.name, s.avatar, q.stem, q.unit, q.subject FROM help_requests h JOIN students s ON s.id=h.student_id "
            "LEFT JOIN questions q ON q.id=h.question_id ")
    if is_parent(request):
        return db.q(base + "WHERE h.status='open' ORDER BY h.id DESC")
    return db.q(base + "WHERE h.student_id=? ORDER BY h.id DESC LIMIT 20", (sid(request),))


@app.post("/api/help/{hid}")
async def help_update(hid: int, body: dict, request: Request):
    need_parent(request)
    db.update("help_requests", hid, {"status": body.get("status", "done"), "reply": (body.get("reply") or "")[:500],
                                     "updated_at": db.now()})
    return {"ok": True}


# --- curriculum, knowledge, units ------------------------------------------------------------

@app.get("/api/chapters")
async def get_chapters(subject: str):
    """The review book's 章節 for a subject ([] when it has none: its 單元 are the chapters)."""
    return curriculum.chapters(subject)


@app.get("/api/curriculum")
async def get_curriculum(request: Request, subject: str, grade: int = 0):
    s = sid(request)
    units = curriculum.units_for(subject, grade or None)
    prog = {(r["grade"], r["unit"]): r for r in db.q(
        "SELECT * FROM unit_progress WHERE student_id=? AND subject=?", (s, subject))}
    know = {(r["grade"], r["unit"]) for r in db.q("SELECT grade, unit FROM knowledge WHERE subject=?", (subject,))}
    counts = {r["unit"]: r for r in db.q(
        f"SELECT unit, COUNT(*) AS n, SUM(is_wrong AND NOT mastered) AS wrong FROM {qstate.view()} "
        "WHERE subject=? GROUP BY unit", (s, subject))}
    acc = {r["unit"]: r["pct"] for r in practice.unit_accuracy(s, 365) if r["subject"] == subject}
    known = {u["unit"] for u in units}
    # Units the AI invented while filing scanned questions.
    for unit, r in counts.items():
        if unit and unit not in known:
            units.append({"subject": subject, "grade": grade or 6, "term": "其他", "unit": unit})
    for u in units:
        p = prog.get((u["grade"], u["unit"]))
        u.update({"stars": p["stars"] if p else 0, "plays": p["plays"] if p else 0,
                  "has_knowledge": (u["grade"], u["unit"]) in know,
                  "questions": counts.get(u["unit"], {}).get("n", 0) or 0,
                  "wrong": counts.get(u["unit"], {}).get("wrong", 0) or 0,
                  "accuracy": acc.get(u["unit"])})
    return units


@app.post("/api/units")
async def add_unit(body: dict):
    db.execute("INSERT OR IGNORE INTO custom_units(subject,grade,unit) VALUES(?,?,?)",
               (body["subject"], int(body.get("grade", 6)), body["unit"].strip()))
    return {"ok": True}


@app.get("/api/knowledge")
async def get_knowledge(subject: str, unit: str, grade: int = 0):
    if grade:
        r = db.one("SELECT * FROM knowledge WHERE subject=? AND unit=? AND grade=?", (subject, unit, grade))
    else:
        r = db.one("SELECT * FROM knowledge WHERE subject=? AND unit=? ORDER BY grade DESC", (subject, unit))
    return r


@app.post("/api/knowledge/generate")
async def gen_knowledge(body: dict):
    need_ai()
    return {"job_id": jobs.start("knowledge", 0, pipeline.knowledge_job, body["subject"],
                                 int(body.get("grade", 6)), body["unit"])}


@app.post("/api/generate")
async def gen_questions(body: dict, request: Request):
    need_ai()
    n = max(1, min(15, int(body.get("n", 5))))
    return {"job_id": jobs.start("generate", 0, pipeline.generate_job, sid(request), body["subject"],
                                 int(body.get("grade", 6)), body["unit"], n,
                                 body.get("difficulty", "mix"), body.get("source", "ai"), body.get("level", ""))}


_preparing: dict[tuple, int] = {}


@app.post("/api/units/prepare")
async def unit_prepare(body: dict, request: Request):
    """Get a level's questions ready before she taps 闖關: started when the unit
    page opens, shared by every tap (and every child) while it runs."""
    s = sid(request)
    subject, unit, level, grade = body["subject"], body["unit"], body.get("level", "basic"), int(body.get("grade", 6))
    have = db.scalar(f"SELECT COUNT(*) FROM {qstate.view()} WHERE subject=? AND unit=? AND level=? AND solved=1",
                     (s, subject, unit, level)) or 0
    key = (subject, grade, unit, level)
    jid = _preparing.get(key)
    if jid:
        j = db.one("SELECT status FROM jobs WHERE id=?", (jid,))
        if j and j["status"] in ("queued", "running"):
            return {"job_id": jid, "have": have}
        _preparing.pop(key, None)
    if have >= 5 or not ai.configured():
        return {"job_id": None, "have": have}
    jid = jobs.start("generate", 0, pipeline.generate_job, s, subject, grade, unit, 6 - have if have < 5 else 0,
                     "mix", "ai", level)
    _preparing[key] = jid
    return {"job_id": jid, "have": have}


@app.get("/api/units/practice")
async def unit_practice(request: Request, subject: str, unit: str, grade: int = 6, n: int = 5, level: str = ""):
    if level:
        return qstate.query(sid(request), "subject=? AND unit=? AND level=? AND solved=1", [subject, unit, level, n],
                            "ORDER BY mastered, attempts, RANDOM() LIMIT ?")
    return practice.unit_set(sid(request), subject, grade, unit, n)


@app.get("/api/units/levels")
async def unit_levels(request: Request, subject: str, unit: str):
    rows = {r["level"]: r for r in db.q("SELECT * FROM unit_levels WHERE student_id=? AND subject=? AND unit=?",
                                        (sid(request), subject, unit))}
    counts = {r["level"]: r["n"] for r in db.q(f"SELECT level, COUNT(*) AS n FROM {qstate.view()} WHERE subject=? AND unit=? "
                                               "AND solved=1 GROUP BY level", (sid(request), subject, unit))}
    return [{"level": lv, "name": nm, "stars": (rows.get(lv) or {}).get("stars", 0), "questions": counts.get(lv, 0)}
            for lv, nm in qstate.LEVELS.items()]


@app.post("/api/units/finish")
async def unit_finish(body: dict, request: Request):
    s = sid(request)
    correct, total = int(body.get("correct", 0)), max(1, int(body.get("total", 1)))
    ratio = correct / total
    stars = 3 if ratio >= 1 else 2 if ratio >= 0.8 else 1 if ratio >= 0.6 else 0
    key = (s, body["subject"], int(body.get("grade", 6)), body["unit"])
    old = db.one("SELECT * FROM unit_progress WHERE student_id=? AND subject=? AND grade=? AND unit=?", key)
    if old:
        db.execute("UPDATE unit_progress SET stars=?, best=?, plays=plays+1, updated_at=? "
                   "WHERE student_id=? AND subject=? AND grade=? AND unit=?",
                   (max(old["stars"], stars), max(old["best"], correct), db.now(), *key))
    else:
        db.execute("INSERT INTO unit_progress(student_id,subject,grade,unit,stars,best,plays,updated_at) "
                   "VALUES(?,?,?,?,?,?,1,?)", (*key, stars, correct, db.now()))
    practice.record(s, None, "unit", str(correct), stars > 0)
    if body.get("level") in qstate.LEVELS:
        db.execute("INSERT INTO unit_levels(student_id,subject,unit,level,stars,plays,updated_at) VALUES(?,?,?,?,?,1,?) "
                   "ON CONFLICT(student_id,subject,unit,level) DO UPDATE SET stars=MAX(stars,excluded.stars), plays=plays+1, "
                   "updated_at=excluded.updated_at", (s, body["subject"], body["unit"], body["level"], stars, db.now()))
    reward = gamify.award(s, 20 + stars * 10, 5 + stars * 3, "單元闖關")
    return {"stars": stars, "reward": reward,
            "new_badges": [gamify.BADGES[b][1] for b in gamify.check_badges(s)]}


# --- practice modes ----------------------------------------------------------------------------

@app.get("/api/practice/review")
async def review(request: Request, subject: str = "", limit: int = 20):
    return practice.due_review(sid(request), limit, subject)


@app.get("/api/practice/challenge")
async def challenge(request: Request, subject: str = ""):
    return practice.daily_challenge(sid(request), subject)


@app.post("/api/practice/challenge/finish")
async def challenge_finish(body: dict, request: Request):
    s = sid(request)
    correct, total = int(body.get("correct", 0)), int(body.get("total", 10))
    already = db.scalar("SELECT COUNT(*) FROM attempts WHERE student_id=? AND mode='challenge_done' "
                        "AND created_at>=?", (s, db.today()))
    practice.record(s, None, "challenge_done", f"{correct}/{total}", correct == total and total >= 10)
    reward = gamify.award(s, 30 if not already else 10, (15 + correct) if not already else 3, "每日挑戰")
    return {"reward": reward, "new_badges": [gamify.BADGES[b][1] for b in gamify.check_badges(s)]}


@app.get("/api/practice/duel")
async def duel(request: Request, subject: str = ""):
    s = sid(request)
    gw, ga = practice.grade_sql(s)
    where = f"solved=1 AND {gw} AND (choice_index>0 OR qtype IN ('是非題','填充題','計算題'))"
    args = list(ga)
    if subject:
        where += " AND subject=?"
        args.append(subject)
    pool = qstate.query(s, where, args, "ORDER BY RANDOM() LIMIT 5")
    td = practice.target_difficulty(s)
    rnd = random.Random()
    name = rnd.choice(gamify.BOT_NAMES)
    return {"questions": pool, "bot": {"name": name, "avatar": rnd.choice(gamify.BOT_AVATARS),
                                       "accuracy": 0.45 + 0.1 * td, "speed": rnd.uniform(8, 20)}}


@app.post("/api/practice/duel/finish")
async def duel_finish(body: dict, request: Request):
    s = sid(request)
    win = bool(body.get("win"))
    practice.record(s, None, "duel", f"{body.get('score', 0)}:{body.get('bot_score', 0)}", win)
    reward = gamify.award(s, 25 if win else 10, 10 if win else 3, "PK 對戰")
    return {"reward": reward, "new_badges": [gamify.BADGES[b][1] for b in gamify.check_badges(s)]}


@app.post("/api/practice/drill/finish")
async def drill_finish(body: dict, request: Request):
    s = sid(request)
    correct = int(body.get("correct", 0))
    practice.record(s, None, "drill", str(correct), None, int(body.get("seconds", 60)),
                    analysis={"kind": body.get("kind"), "total": body.get("total"),
                              "wrong": body.get("wrong", [])[:20]})
    best = db.scalar("SELECT MAX(CAST(answer AS INTEGER)) FROM attempts WHERE student_id=? AND mode='drill' "
                     "AND json_extract(analysis,'$.kind')=?", (s, body.get("kind"))) or 0
    reward = gamify.award(s, min(30, correct), min(10, correct // 3), "心算快打")
    return {"reward": reward, "best": best,
            "new_badges": [gamify.BADGES[b][1] for b in gamify.check_badges(s)]}


# --- stats & reports ---------------------------------------------------------------------------

@app.get("/api/stats")
async def stats(request: Request):
    s = sid(request)
    subj = db.q("SELECT subject, COUNT(*) AS n, SUM(is_wrong) AS wrong, SUM(is_wrong AND mastered) AS fixed, "
                f"SUM(is_highlighted) AS highlighted, SUM(is_marked) AS marked, SUM(wrong_count) AS wrong_times FROM {qstate.view()} "
                "WHERE source IN ('scan','manual') OR is_wrong=1 GROUP BY subject", (s,))
    top_wrong = qstate.query(s, "wrong_count>0", [], "ORDER BY wrong_count DESC, last_wrong_at DESC LIMIT 8")
    top_wrong = [{k: q[k] for k in ("id", "subject", "unit", "qtype", "stem", "wrong_count", "mastered")} for q in top_wrong]
    since30 = (date.today() - timedelta(days=30)).isoformat()
    acc = db.q("SELECT subject, COUNT(*) AS n, SUM(correct) AS ok FROM attempts WHERE student_id=? "
               "AND correct IS NOT NULL AND question_id>0 AND created_at>=? GROUP BY subject", (s, since30))
    errors = db.q("SELECT error_type, COUNT(*) AS n FROM attempts WHERE student_id=? AND error_type NOT IN ('','無') "
                  "GROUP BY error_type ORDER BY n DESC", (s,))
    daily = db.q("SELECT substr(created_at,1,10) AS day, COUNT(*) AS n, SUM(correct) AS ok FROM attempts "
                 "WHERE student_id=? AND question_id>0 AND created_at>=? GROUP BY day ORDER BY day",
                 (s, (date.today() - timedelta(days=13)).isoformat()))
    minutes = db.scalar("SELECT COUNT(*) FROM attempts WHERE student_id=? AND created_at>=?", (s, since30))
    usage = db.one("SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS outp, "
                   "COALESCE(SUM(cache_read),0) AS cache FROM ai_usage WHERE created_at>=?", (since30,))
    usage["usd"] = round(usage["inp"] * 4e-6 + usage["outp"] * 20e-6 + usage["cache"] * 0.2e-6, 2)
    return {"subjects": subj, "accuracy": acc, "top_wrong": top_wrong, "units": practice.unit_accuracy(s, 90), "errors": errors,
            "daily": daily, "calendar": gamify.activity_calendar(s), "attempts_30d": minutes,
            "exams": db.scalar("SELECT COUNT(*) FROM exams WHERE student_id=?", (s,)),
            "usage": usage, "me": gamify.summary(s),
            "report": db.get_setting(f"report_{s}")}


@app.post("/api/report")
async def make_report(request: Request):
    need_ai()
    s = sid(request)
    st = await stats(request)
    data = {k: st[k] for k in ("subjects", "accuracy", "units", "errors", "daily", "attempts_30d")}
    data["streak"] = st["me"]["streak"]
    data["recent_wrong"] = [{"subject": q["subject"], "unit": q["unit"], "qtype": q["qtype"], "stem": q["stem"][:80],
                             "wrong_times": q["wrong_count"], "wrong_answers": q["wrong_answers"]}
                            for q in qstate.query(s, "is_wrong=1 AND mastered=0", [], "ORDER BY wrong_count DESC, id DESC LIMIT 25")]
    return {"job_id": jobs.start("report", s, pipeline.report_job, s, data)}


# --- papers (組卷 / 作業) & printing --------------------------------------------------------------------

@app.get("/api/papers")
async def papers(request: Request):
    return db.q("SELECT * FROM papers WHERE student_id=? ORDER BY id DESC", (sid(request),))


@app.get("/api/papers/{pid}")
async def paper(pid: int, request: Request):
    own_paper(request, pid)
    p = db.one("SELECT * FROM papers WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404, "找不到試卷")
    p["questions"] = [q for q in (qstate.get(p["student_id"], i) for i in p["question_ids"]) if q]
    return p


@app.post("/api/papers")
async def new_paper(body: dict, request: Request):
    if body.get("kind") == "homework":
        need_parent(request)
    pid = db.insert("papers", {
        "student_id": sid(request), "title": body.get("title") or "複習卷", "kind": body.get("kind", "custom"),
        "config": body.get("config") or {}, "question_ids": [int(i) for i in body.get("question_ids", [])],
        "due_date": body.get("due_date", ""), "status": "assigned" if body.get("kind") == "homework" else "",
        "created_at": db.now()})
    if (body.get("config") or {}).get("lesson") and body.get("question_ids") and ai.configured():
        ahead(("lesson", pid), "lesson", pid, pipeline.lesson_job, pid)  # written while the paper page opens
    return {"id": pid}


@app.put("/api/papers/{pid}")
async def edit_paper(pid: int, body: dict, request: Request):
    p = own_paper(request, pid)
    if parent_ok(request):
        keep = {"title", "config", "question_ids", "due_date", "status", "kind"}
    else:  # a child edits her own papers only: assigning, due dates and rewards stay with the parent
        if p["kind"] == "homework" or body.get("kind") == "homework" or "status" in body:
            raise HTTPException(403, "作業由家長指派，需要家長權限")
        keep = {"title", "config", "question_ids"}
        if isinstance(body.get("config"), dict):
            body["config"] = {k: v for k, v in body["config"].items() if k != "task"}
    db.update("papers", pid, {k: v for k, v in body.items() if k in keep})
    return {"ok": True}


@app.delete("/api/papers/{pid}")
async def del_paper(pid: int, request: Request):
    if own_paper(request, pid)["kind"] == "homework":
        need_parent(request)  # homework is the parent's to take back
    db.execute("DELETE FROM papers WHERE id=?", (pid,))
    return {"ok": True}


@app.post("/api/papers/{pid}/lesson")
async def paper_lesson(pid: int, request: Request):
    own_paper(request, pid)
    need_ai()
    if not db.one("SELECT id FROM papers WHERE id=?", (pid,)):
        raise HTTPException(404, "找不到試卷")
    return {"job_id": ahead(("lesson", pid), "lesson", pid, pipeline.lesson_job, pid)}


# --- 錯題頁: concepts to work on, weaknesses, tasks --------------------------------------------------

@app.get("/api/bank/overview")
def bank_overview(request: Request):
    try:
        need_parent(request)  # a parent account, or the parent PIN on a child's device
        parent = True
    except HTTPException:
        parent = False
    return bankview.overview(sid(request), parent)


@app.post("/api/bank/similar")
async def bank_similar(body: dict, request: Request):
    """錯題＋AI 類似題: one new question per wrong question, made while she does the wrong ones."""
    need_ai()
    s = sid(request)
    ids = [int(i) for i in body.get("ids", [])][:8]
    return {"job_id": jobs.start("similar_many", 0, pipeline.similar_many_job, ids, s)}


@app.post("/api/tasks")
async def task_create(body: dict, request: Request):
    """指派任務: a parent gives the child concepts to work on (shows on her 今天)."""
    need_parent(request)
    s = sid(request)
    units = [(str(u[0]), str(u[1])) for u in body.get("units", []) if len(u) == 2]
    kind = body.get("kind") if body.get("kind") in bankview.TASK_KINDS else "lesson"
    n = max(1, min(30, int(body.get("n") or 10)))
    ids = [int(i) for i in body.get("ids", [])] or bankview.pick_questions(s, units, n)
    ids = ids[:n]
    if not ids:
        raise HTTPException(400, "這些觀念還沒有可以練的題目（請先掃描考卷或在單元裡讓 AI 出題）")
    names = "、".join(dict.fromkeys(u for _, u in units)) or "錯題"
    title = str(body.get("title") or "")[:40] or f"{names[:24]}：{bankview.TASK_KINDS[kind]}"
    if not body.get("force"):
        same = db.one("SELECT due_date FROM papers WHERE student_id=? AND kind='homework' AND title=? AND status!='done'", (s, title))
        if same:
            raise HTTPException(409, f"「{title}」已經指派過了（{same['due_date']} 到期，還沒完成）")
    task = {"kind": kind, "message": str(body.get("message", ""))[:80], "reward": max(0, min(100, int(body.get("reward") or 20))),
            "units": units, "generating": kind == "similar"}
    cfg = {"group_by_type": True, "numbering": "section", "answers": "end", "explanations": True,
           "lesson": kind in ("lesson", "paper"), "visuals": True, "template": "wrong", "task": task}
    pid = db.insert("papers", {"student_id": s, "title": title, "kind": "homework",
                               "config": cfg, "question_ids": ids, "due_date": body.get("due_date") or db.today(),
                               "status": "assigned", "created_at": db.now()})
    if kind in ("lesson", "paper"):
        jobs.start("lesson", pid, pipeline.lesson_job, pid)
    if kind == "similar":
        jobs.start("task_similar", pid, pipeline.task_similar_job, pid, s)
    return {"id": pid}


@app.delete("/api/tasks/{pid}")
def task_delete(pid: int, request: Request):
    need_parent(request)
    p = own_paper(request, pid)
    if p["kind"] == "homework":
        db.execute("DELETE FROM papers WHERE id=?", (pid,))
    return {"ok": True}


@app.post("/api/papers/{pid}/complete")
async def paper_done(pid: int, request: Request):
    own_paper(request, pid)
    p = db.one("SELECT * FROM papers WHERE id=?", (pid,))
    if p and p["status"] == "assigned" and p["kind"] == "homework":
        db.update("papers", pid, {"status": "done"})
        coins = max(0, min(100, int(((p["config"] or {}).get("task") or {}).get("reward") or 15)))
        return {"reward": gamify.award(sid(request), 30, coins, "完成作業")}
    return {"ok": True}


# --- 試卷範本 -----------------------------------------------------------------------------------

@app.get("/api/templates")
def templates_list(request: Request):
    s = sid(request)
    ex = templates.examples(s)
    wrong = db.scalar(f"SELECT COUNT(*) FROM {qstate.view()} WHERE is_wrong=1 AND NOT mastered AND solved=1", (s,)) or 0
    if wrong:
        ex["wrong"] = [{"id": 0, "title": f"待加強的錯題 {wrong} 題・卷子最多取 30", "n": min(30, wrong), "wrong": True}]
    return {"templates": templates.all_templates(), "default": db.get_setting("scan_template") or "auto",
            "examples": ex, "mapping": templates.mapping(),
            "fields": templates.FIELDS, "blocks": templates.BLOCK,
            "answer_styles": [{"id": a, "name": n, "desc": d} for a, n, d in templates.ANSWER_STYLES]}


@app.put("/api/templates/default")
def templates_default(body: dict, request: Request):
    need_parent(request)
    tid = str(body.get("id") or "auto")
    if tid != "auto" and not any(t["id"] == tid for t in templates.all_templates()):
        raise HTTPException(404, "找不到這個範本")
    db.set_setting("scan_template", tid)
    return {"ok": True}


@app.put("/api/templates/for")
def templates_for(body: dict, request: Request):
    """這類考卷都用這個範本 (e.g. my own Word template for every 期中考)."""
    need_parent(request)
    kind, tid = str(body.get("kind") or ""), str(body.get("id") or "")
    if not any(t["id"] == kind and t["kind"] != "custom" for t in templates.all_templates()):
        raise HTTPException(400, "沒有這種考卷類型")
    m = db.get_setting("template_for") or {}
    if tid and tid != kind:
        if not any(t["id"] == tid for t in templates.all_templates()):
            raise HTTPException(404, "找不到這個範本")
        m[kind] = tid
    else:
        m.pop(kind, None)
    db.set_setting("template_for", m)
    return {"mapping": templates.mapping()}


@app.post("/api/templates/types")
def templates_type_save(body: dict, request: Request):
    """整理清單: add or change one of her own exam types."""
    need_parent(request)
    try:
        return templates.save_type(body)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/templates/types/{tid}")
def templates_type_delete(tid: str, request: Request):
    need_parent(request)
    templates.delete_type(tid)
    return {"ok": True}


@app.put("/api/templates/{tid}/hidden")
def templates_hide(tid: str, body: dict, request: Request):
    """Show or hide a type in the 掃描後排成 menus."""
    need_parent(request)
    if not any(t["id"] == tid for t in templates.all_templates()):
        raise HTTPException(404, "找不到這個範本")
    templates.set_hidden(tid, bool(body.get("hidden")))
    return {"ok": True}


@app.post("/api/templates/{tid}/sample")
def templates_sample(tid: str, request: Request, body: dict | None = None):
    """預覽: this template with a real scanned exam (or sample questions)."""
    t = templates.get(tid)
    exam_id = int((body or {}).get("exam_id") or 0)
    ids, title = [], "範例試卷・六年級數學"
    if (body or {}).get("wrong"):  # 錯題複習卷: her own open wrong questions
        ids = [r["id"] for r in db.q(f"SELECT id FROM {qstate.view()} WHERE is_wrong=1 AND NOT mastered AND solved=1 "
                                     "ORDER BY wrong_count DESC, id DESC LIMIT 30", (sid(request),))]
        title = "錯題複習卷"
    if exam_id:
        e = db.one("SELECT title FROM exams WHERE id=?", (exam_id,))
        ids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (exam_id,))]
        title = e["title"] if e else title
    cfg = {**t["config"], "template": t["id"]}
    if (body or {}).get("answer_style") in ("brief", "steps", "visual"):
        cfg["answer_style"] = body["answer_style"]
    if (body or {}).get("key_only"):
        cfg["key_only"] = True  # 解答卷 by itself
    tok = exporters.make_spec(title, ids, cfg, exam_id, "", 0, sample=not ids)
    return {"token": tok}


@app.get("/api/templates/{tid}/docx")
def templates_docx(tid: str):
    t = templates.get(tid)
    out = EXPORT_DIR / f"template_{t['id']}.docx"
    templates.template_docx(t["id"], out)
    return FileResponse(out, filename=f"{t['name'].replace('／', '-')}範本.docx",
                        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


@app.post("/api/templates")
async def templates_upload(request: Request, file: UploadFile = File(...), name: str = Form(""), base: str = Form("")):
    need_parent(request)
    data = await file.read()
    if len(data) > 15e6:
        raise HTTPException(400, "檔案太大（請小於 15 MB）")
    try:
        meta = templates.save_custom(data, name or Path(file.filename or "").stem, base)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return meta


@app.delete("/api/templates/{tid}")
def templates_delete(tid: str, request: Request):
    need_parent(request)
    templates.delete_custom(tid)
    if db.get_setting("scan_template") == tid:
        db.set_setting("scan_template", "auto")
    return {"ok": True}


@app.get("/api/print/pages/{tok}")
async def print_pages(tok: str, dpi: int = 110):
    """An uploaded Word template's pages as pictures (converted from the filled-in Word file)."""
    if not exporters.resolve(tok):
        raise HTTPException(404, "列印設定已過期")
    dpi = max(60, min(220, dpi))
    try:
        pdf = await exporters.pdf(tok)
        pages = await templates.pdf_pages(pdf, dpi)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"pages": [f"/api/print/page/{tok}/{dpi}/{i}" for i in range(len(pages))]}


@app.get("/api/print/page/{tok}/{dpi}/{i}")
async def print_page(tok: str, dpi: int, i: int):
    files = sorted(EXPORT_DIR.glob(f"{tok}_p{dpi}-*.png"), key=lambda p: int(re.search(r"-(\d+)\.png$", p.name).group(1)))
    if i >= len(files) or i < 0:
        raise HTTPException(404)
    return FileResponse(files[i], media_type="image/png")


@app.post("/api/print/spec")
async def print_spec(body: dict):
    tok = exporters.make_spec(body.get("title", "複習卷"), [int(i) for i in body.get("question_ids", [])],
                              body.get("config", {}), int(body.get("exam_id") or 0), body.get("subtitle", ""),
                              int(body.get("paper_id") or 0))
    return {"token": tok}


@app.get("/api/print/spec/{tok}")
async def print_spec_get(tok: str):
    r = exporters.resolve(tok)
    if not r:
        raise HTTPException(404, "列印設定已過期，請重新產生")
    return r


@app.get("/api/print/pdf/{tok}")
async def print_pdf(tok: str):
    if not exporters.resolve(tok):
        raise HTTPException(404, "列印設定已過期")
    try:
        path = await exporters.pdf(tok)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    title = exporters.resolve(tok)["title"]
    return FileResponse(path, media_type="application/pdf", filename=f"{title}.pdf")


@app.get("/api/print/docx/{tok}")
async def print_docx(tok: str):
    import asyncio
    try:
        await exporters.prepare_visuals(tok)
        path = await asyncio.to_thread(exporters.docx, tok)
    except RuntimeError as e:
        raise HTTPException(404, str(e))
    title = exporters.resolve(tok)["title"]
    return FileResponse(path, filename=f"{title}.docx",
                        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")


# --- printers (CUPS / AirPrint) --------------------------------------------------------------------

def _print_error(e: Exception) -> HTTPException:
    return HTTPException(400, str(e))


@app.get("/api/printers")
async def list_printers():
    return await printing.printers()


@app.get("/api/printers/discover")
async def discover_printers(request: Request):
    need_parent(request)
    try:
        return await printing.discover()
    except printing.PrintError as e:
        raise _print_error(e)


@app.post("/api/printers")
async def add_printer(body: dict, request: Request):
    need_parent(request)
    try:
        name = await printing.add(body.get("name") or "Printer", body.get("uri", ""),
                                  bool(body.get("default")), bool(body.get("share", True)))
    except printing.PrintError as e:
        raise _print_error(e)
    return {"name": name}


@app.post("/api/printers/{name}/{action}")
async def printer_action(name: str, action: str, request: Request, body: dict | None = None):
    try:
        if action == "enable":
            await printing.enable(name)
        elif action == "test":
            return {"job": await printing.test_page(name)}
        else:
            need_parent(request)
            if action == "default":
                await printing.set_default(name)
            elif action == "share":
                await printing.share(name, bool((body or {}).get("on", True)))
            else:
                raise HTTPException(404)
    except printing.PrintError as e:
        raise _print_error(e)
    return {"ok": True}


@app.delete("/api/printers/{name}")
async def delete_printer(name: str, request: Request):
    need_parent(request)
    try:
        await printing.remove(name)
    except printing.PrintError as e:
        raise _print_error(e)
    return {"ok": True}


@app.post("/api/print/send")
async def print_send(body: dict):
    tok = body.get("token", "")
    spec = exporters.resolve(tok)
    if not spec:
        raise HTTPException(404, "列印設定已過期，請重新產生")
    try:
        pdf = await exporters.pdf(tok)
        job = await printing.send(body.get("printer", ""), pdf, int(body.get("copies", 1)),
                                  body.get("duplex", "one"), bool(body.get("color", False)),
                                  spec["config"].get("orientation") == "landscape", spec["title"])
    except (printing.PrintError, RuntimeError) as e:
        raise _print_error(e)
    return {"job": job}


@app.get("/api/print/jobs")
async def print_jobs():
    return await printing.jobs()


@app.delete("/api/print/jobs/{job_id}")
async def print_cancel(job_id: str):
    try:
        await printing.cancel(job_id)
    except printing.PrintError as e:
        raise _print_error(e)
    return {"ok": True}


# --- NAS sync ------------------------------------------------------------------------------------

@app.get("/api/nas")
async def nas_status(request: Request):
    need_parent(request)
    return nas.status()


@app.put("/api/nas")
async def nas_save(body: dict, request: Request):
    need_parent(request)
    for k in ("path", "user", "port"):
        if k in body:
            db.set_setting(f"nas_{k}", body[k])
    if body.get("password"):
        db.set_setting("nas_password", body["password"])
    if "enabled" in body:
        db.set_setting("nas_enabled", bool(body["enabled"]))
    if body.get("enabled"):
        nas.mark_dirty()
    return nas.status()


@app.post("/api/nas/test")
async def nas_test(request: Request):
    import asyncio
    need_parent(request)
    try:
        root = await asyncio.to_thread(nas.test)
    except Exception as e:
        raise HTTPException(400, nas._friendly(e))
    return {"ok": True, "root": root}


@app.post("/api/nas/sync")
async def nas_sync_now(request: Request):
    need_parent(request)
    try:
        return await nas.sync(force=True)
    except RuntimeError as e:
        raise HTTPException(400, str(e))


# --- jobs ----------------------------------------------------------------------------------------

@app.get("/api/jobs/{job_id}")
async def job(job_id: int):
    j = jobs.get(job_id)
    if not j:
        raise HTTPException(404, "找不到工作")
    return j


# --- settings (parent) -----------------------------------------------------------------------------

@app.post("/api/parent/verify")
async def parent_verify(body: dict, request: Request):
    if is_parent(request):
        return {"ok": True, "default_pin": False}
    pin = str(body.get("pin", ""))
    if accounts.check_parent_secret(pin) or (accounts.setup_needed() and pin == str(_setting("parent_pin"))):
        return {"ok": True, "default_pin": False}
    raise HTTPException(403, "家長密碼錯誤")


@app.get("/api/settings")
async def get_settings(request: Request):
    need_parent(request)
    out = {k: _setting(k) for k in DEFAULT_SETTINGS}
    key = out.get("api_key") or ""
    out["api_key"] = (key[:10] + "…" + key[-4:]) if key else ""
    out["api_key_set"] = bool(key)
    out["base_url"] = _setting("base_url") or ""
    from . import claude_sub
    out["provider_effective"] = ai.provider()
    out["subscription_ready"] = claude_sub.logged_in()
    out["claude_cli"] = bool(claude_sub.cli_path())
    out["urls"] = _lan_urls()
    return out


def _lan_urls() -> list[str]:
    import socket
    import subprocess
    from .config import PORT
    urls = [f"http://{socket.gethostname()}.local:{PORT}"]
    try:
        ips = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout.split()
    except Exception:
        ips = []
    for ip in ips:
        if ":" in ip or ip.startswith("172.17."):  # skip IPv6 and docker bridge
            continue
        label = "（Tailscale 外出用）" if ip.startswith("100.") else ""
        urls.append(f"http://{ip}:{PORT} {label}".strip())
    return urls


@app.put("/api/settings")
async def put_settings(body: dict, request: Request):
    need_parent(request)
    for k, v in body.items():
        if k == "api_key" and (not v or "…" in v):
            continue
        if k in DEFAULT_SETTINGS or k == "base_url":
            db.set_setting(k, v)
    resp = JSONResponse({"ok": True})
    if body.get("site_password"):
        resp.set_cookie("sess", _session_token(body["site_password"]), max_age=180 * 86400,
                        httponly=True, samesite="lax")
    return resp


@app.post("/api/settings/test")
async def test_ai(request: Request):
    need_parent(request)
    need_ai()
    try:
        return {"ok": True, "reply": await ai.ping()}
    except Exception as e:
        raise HTTPException(502, str(ai._friendly(e)))


@app.get("/api/backup")
async def backup(request: Request):
    need_parent(request)
    import asyncio
    import sqlite3
    tmp = EXPORT_DIR / "backup"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    src = sqlite3.connect(db.DB_PATH)
    dst = sqlite3.connect(tmp / "app.db")
    src.backup(dst)
    src.close()
    dst.close()
    shutil.copytree(MEDIA_DIR, tmp / "media")
    name = f"ai-review-backup-{date.today().isoformat()}"
    path = await asyncio.to_thread(shutil.make_archive, str(EXPORT_DIR / name), "zip", tmp)
    shutil.rmtree(tmp, ignore_errors=True)
    return FileResponse(path, filename=f"{name}.zip")


# --- static ----------------------------------------------------------------------------------------

class _CachedMedia(StaticFiles):
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        if r.status_code in (200, 304):
            r.headers["Cache-Control"] = "private, max-age=3600"
        return r


app.mount("/media", _CachedMedia(directory=MEDIA_DIR), name="media")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# The scripts and styles get a new address (/v/<build>/…) whenever one of them changes, so no
# browser keeps running old code from its cache; pages are rewritten to it. It used to change only
# on a restart: a script edited without one was cached next to the old ones under the same address
# (a new view importing from an old scan.js → 題庫 would not open on a tablet, only 「再試一次」).
_build = [0.0, ""]


def build() -> str:
    """The newest file under static/ (vendor aside), in seconds; looked at again every few seconds."""
    now = time.monotonic()
    if now - _build[0] > 5 or not _build[1]:
        newest = 0.0
        for root, dirs, files in os.walk(STATIC_DIR):
            dirs[:] = [d for d in dirs if d != "vendor"]
            for f in files:
                try:
                    newest = max(newest, os.stat(os.path.join(root, f)).st_mtime)
                except OSError:
                    pass
        _build[:] = [now, str(int(newest))]
    return _build[1]


@app.get("/v/{ver}/{path:path}")
async def versioned(ver: str, path: str):
    f = (STATIC_DIR / path).resolve()
    if STATIC_DIR.resolve() not in f.parents or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})


def _page(name: str) -> HTMLResponse:
    html = (STATIC_DIR / name).read_text(encoding="utf-8").replace('"/static/', f'"/v/{build()}/')
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


# --- 用 iPad 寫: handwriting on a tablet, mirrored to the computer -------------------------------

@app.post("/api/pads")
async def pad_create(body: dict, request: Request):
    q = own_q(request, int(body["question_id"]))
    origin = str(body.get("origin") or "")
    if not re.fullmatch(r"https?://[A-Za-z0-9.\-\[\]:]+", origin):
        raise HTTPException(400, "網址不正確")
    p = pads.create(sid(request), q["id"])
    url = f"{origin}/pad.html?t={p['token']}"
    return {"token": p["token"], "url": url, "qr": pads.qr_svg(url)}


@app.get("/api/pads/active")
async def pad_active(request: Request):
    """A tablet logged in as the same child: the computer is waiting for her to write."""
    p = pads.active_for(sid(request))
    if not p:
        return {}
    q = db.one("SELECT stem FROM questions WHERE id=?", (p["question_id"],)) or {}
    return {"token": p["token"], "question_id": p["question_id"], "stem": q.get("stem", "")}


@app.delete("/api/pads/{token}")
async def pad_close(token: str, request: Request):
    p = pads.get(token)
    if p and p["student_id"] == sid(request):
        pads.close(token)
    return {"ok": True}


def _pad(token: str) -> dict:
    p = pads.get(token)
    if not p or p.get("kind", "write") != "write":
        raise HTTPException(404, "這個手寫連線已經結束，請在電腦上重新開啟「用 iPad 寫」")
    return p


@app.get("/api/pad/{token}")
async def pad_state(token: str, v: int = -1, side: str = ""):
    p = _pad(token)
    if side == "tablet":
        p["tablet_seen"] = time.time()
    out = {"v": p["v"], "status": p["status"], "submit_v": p["submit_v"], "result": p["result"], "result_v": p.get("result_v", 0),
           "tablet_online": time.time() - p["tablet_seen"] < 6}
    if v != p["v"]:
        out.update({"strokes": p["strokes"], "w": p["w"], "h": p["h"]})
    if v < 0:  # first load on the tablet: what to solve
        q = db.one("SELECT stem, options, figure_path, unit FROM questions WHERE id=?", (p["question_id"],)) or {}
        out["question"] = {"stem": q.get("stem", ""), "options": q.get("options") or [], "unit": q.get("unit", ""),
                           "figure": bool(q.get("figure_path"))}
    return out


@app.put("/api/pad/{token}")
async def pad_write(token: str, request: Request):
    p = _pad(token)
    raw = await request.body()
    if len(raw) > pads.MAX_BYTES:
        raise HTTPException(413, "筆跡太多了，請按「清除」或在電腦上批改")
    body = json.loads(raw or b"{}")
    p["strokes"] = body.get("strokes") or []
    p["w"], p["h"] = float(body.get("w") or 0), float(body.get("h") or 0)
    p["v"] += 1
    p["tablet_seen"] = time.time()
    if p["status"] == "graded":
        p["status"] = "writing"  # she is correcting after a grade
    return {"v": p["v"]}


@app.post("/api/pad/{token}/submit")
async def pad_submit(token: str):
    p = _pad(token)
    p["status"], p["submit_v"] = "submit", p["v"]
    return {"ok": True}


@app.post("/api/pad/{token}/result")
async def pad_result(token: str, body: dict, request: Request):
    p = _pad(token)
    # only the logged-in computer that owns the session grades; the tablet's token is not enough
    if not request.state.user or p["student_id"] != sid(request):
        raise HTTPException(403, "不是你的手寫連線")
    keep = ("result", "error_type", "diagnosis", "next_hint", "encouragement", "recognized_steps", "partial")
    p["result"] = {k: body.get(k) for k in keep}
    p["result_v"] = p.get("result_v", 0) + 1  # the quick look first, then the full grading
    p["status"] = "graded"
    return {"ok": True}


@app.get("/api/pad/{token}/figure")
async def pad_figure(token: str):
    p = _pad(token)
    fp = db.scalar("SELECT figure_path FROM questions WHERE id=?", (p["question_id"],))
    if not fp or not (MEDIA_DIR / fp).exists():
        raise HTTPException(404)
    return FileResponse(MEDIA_DIR / fp)


# --- 用手機拍: a desktop's scan page receives photos from a phone ---------------------------------

def _exam_from_files(s: int, paths: list[Path], mode: str = "", in_bank: bool = True, corners: list | None = None,
                     spreads: list | None = None) -> int:
    opts = {"subject": "", "remove_handwriting": bool(db.get_setting("remove_handwriting", True)),
            "remove_color": bool(db.get_setting("remove_color_ink", True)),
            "template": db.get_setting("scan_template") or "auto",
            **({"mode": "grade"} if mode == "grade" else {}), **({} if in_bank else {"in_bank": False})}
    exam_id = db.insert("exams", {"student_id": s, "title": "未命名試卷", "subject": "", "exam_date": db.today(),
                                  "status": "processing", "options": opts, "created_at": db.now()})
    (MEDIA_DIR / f"exam_{exam_id}").mkdir(parents=True, exist_ok=True)
    for i, src in enumerate(paths):
        rel = f"exam_{exam_id}/p{i}_orig{src.suffix.lower() or '.jpg'}"
        shutil.move(str(src), MEDIA_DIR / rel)
        c = (corners or [None] * len(paths))[i]
        sp = (spreads or [None] * len(paths))[i]
        meta = {**({"corners_set": c} if c is not None else {}), **({"spread": sp} if isinstance(sp, bool) else {})}
        db.insert("pages", {"exam_id": exam_id, "idx": i, "orig_path": rel, "status": "queued", **({"meta": meta} if meta else {})})
    jobs.start("exam", exam_id, pipeline.process_exam, exam_id)
    return exam_id


@app.post("/api/photo-sessions")
async def snap_create(body: dict, request: Request):
    need_ai()
    origin = str(body.get("origin") or "")
    if not re.fullmatch(r"https?://[A-Za-z0-9.\-\[\]:]+", origin):
        raise HTTPException(400, "網址不正確")
    p = pads.create(scan_owner(request, int(body.get("student_id") or 0)), 0, kind="photos")
    p["mode"] = "grade" if body.get("mode") == "grade" else ""
    p["in_bank"] = body.get("in_bank") is not False
    url = f"{origin}/snap.html?t={p['token']}"
    return {"token": p["token"], "url": url, "qr": pads.qr_svg(url)}


@app.put("/api/photo-sessions/{token}")
async def snap_mode(token: str, body: dict, request: Request):
    """拍考卷整理 ⇄ 拍功課批改 switched on the computer: the phone's next 完成 follows it."""
    p = pads.get(token)
    if not p or p.get("kind") != "photos":
        raise HTTPException(404, "連線已結束")
    p["mode"] = "grade" if body.get("mode") == "grade" else ""
    if "in_bank" in body:
        p["in_bank"] = body.get("in_bank") is not False
    return {"ok": True}


def _snap(token: str) -> dict:
    p = pads.get(token)
    if not p or p.get("kind") != "photos":
        raise HTTPException(404, "這個拍照連線已經結束，請在電腦上重新按「用手機拍」")
    return p


@app.get("/api/snap/{token}")
async def snap_state(token: str, side: str = ""):
    p = _snap(token)
    if side == "phone":
        p["tablet_seen"] = time.time()
    return {"count": len(p["photos"]), "sent": p.get("sent", []), "phone_online": time.time() - p["tablet_seen"] < 6,
            "v": p["v"], "owner": db.scalar("SELECT name FROM students WHERE id=?", (p["student_id"],)) or ""}


@app.post("/api/snap/{token}/photo")
async def snap_photo(token: str, file: UploadFile = File(...), spread: str = Form(""), corners: str = Form("")):
    p = _snap(token)
    if len(p["photos"]) >= 30:
        raise HTTPException(400, "一次最多 30 頁")
    folder = DATA_DIR / "uploads" / f"phone_{token}"
    folder.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "x.jpg").suffix.lower()
    ext = ext if ext in (".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif") else ".jpg"
    dest = folder / f"{int(time.time() * 1000)}{ext}"
    with open(dest, "wb") as out:
        shutil.copyfileobj(file.file, out)
    p["photos"].append(str(dest))
    if spread in ("0", "1"):
        p.setdefault("spreads", {})[str(dest)] = spread == "1"
    if corners:
        try:
            c = _clean_corners(json.loads(corners))
            if c is not None:
                p.setdefault("corners", {})[str(dest)] = c
        except ValueError:
            pass
    p["v"] += 1
    p["tablet_seen"] = time.time()
    return {"count": len(p["photos"]), "id": dest.stem}


def _snap_photo_by_id(p: dict, pid: str) -> str:
    """The photo of a snap session by the id its upload returned (its position moves when one is deleted)."""
    for x in p["photos"]:
        if Path(x).stem == pid:
            return x
    raise HTTPException(404, "沒有這張照片")


@app.put("/api/snap/{token}/p/{pid}")
async def snap_fix(token: str, pid: str, body: dict):
    """After the camera's own check of a photo it sent at once: the Pi's corners / 單頁雙頁 for it."""
    p = _snap(token)
    x = _snap_photo_by_id(p, pid)
    if "corners" in body:
        c = _clean_corners(body.get("corners"))
        if c is None:
            raise HTTPException(400, "四個角不正確")
        p.setdefault("corners", {})[x] = c
    if isinstance(body.get("spread"), bool):
        p.setdefault("spreads", {})[x] = body["spread"]
    p["v"] += 1
    return {"ok": True}


@app.delete("/api/snap/{token}/p/{pid}")
async def snap_drop(token: str, pid: str):
    """A photo taken back (the Pi found it out of focus)."""
    p = _snap(token)
    x = _snap_photo_by_id(p, pid)
    p["photos"].remove(x)
    Path(x).unlink(missing_ok=True)
    p["v"] += 1
    return {"count": len(p["photos"])}


@app.delete("/api/snap/{token}/photo/{i}")
async def snap_delete(token: str, i: int):
    p = _snap(token)
    if 0 <= i < len(p["photos"]):
        Path(p["photos"].pop(i)).unlink(missing_ok=True)
        p["v"] += 1
    return {"count": len(p["photos"])}


@app.get("/api/snap/{token}/thumb/{i}")
async def snap_thumb(token: str, i: int):
    p = _snap(token)
    if not 0 <= i < len(p["photos"]):
        raise HTTPException(404)
    return FileResponse(p["photos"][i])


def _jpeg_view(path) -> Response:
    """A photo as the scanner sees it (EXIF-rotated, any format → JPEG, ≤1600 px)."""
    import cv2
    img = imaging.load(path)
    h, w = img.shape[:2]
    s = min(1.0, 1600 / max(h, w))
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return Response(buf.tobytes(), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/snap/{token}/check")
async def snap_check(token: str, file: UploadFile = File(...)):
    _snap(token)
    return await scan_check(file)


@app.get("/api/snap/{token}/view/{i}")
async def snap_view(token: str, i: int):
    import asyncio
    p = _snap(token)
    if not 0 <= i < len(p["photos"]):
        raise HTTPException(404)
    return await asyncio.to_thread(_jpeg_view, p["photos"][i])


@app.get("/api/snap/{token}/corners/{i}")
async def snap_corners(token: str, i: int):
    """The page outline found in photo i (and the corners placed by hand, if any)."""
    import asyncio
    from . import scanner
    p = _snap(token)
    if not 0 <= i < len(p["photos"]):
        raise HTTPException(404)
    path = p["photos"][i]
    img = await asyncio.to_thread(imaging.load, path)
    q = await asyncio.to_thread(scanner.find_page, img)
    h, w = img.shape[:2]
    auto = [[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in q] if q is not None else []
    return {"auto": auto, "set": p.setdefault("corners", {}).get(path)}


@app.put("/api/snap/{token}/corners/{i}")
async def snap_set_corners(token: str, i: int, body: dict):
    p = _snap(token)
    if not 0 <= i < len(p["photos"]):
        raise HTTPException(404)
    c = _clean_corners(body.get("corners"))
    if c is None:
        raise HTTPException(400, "四個角不正確")
    p.setdefault("corners", {})[p["photos"][i]] = c
    p["v"] += 1
    return {"ok": True}


@app.post("/api/snap/{token}/done")
async def snap_done(token: str):
    """Either side may finish one exam: the phone (完成) or the computer (開始整理). The AI
    works on it in the background and the same connection is ready for the next exam at once."""
    p = _snap(token)
    if not p["photos"]:
        raise HTTPException(400, "還沒有照片")
    need_ai()
    pages = len(p["photos"])
    cs = p.get("corners", {})
    sp = p.get("spreads", {})
    exam_id = _exam_from_files(p["student_id"], [Path(x) for x in p["photos"]], p.get("mode", ""), p.get("in_bank", True),
                               [cs.get(x) for x in p["photos"]], [sp.get(x) for x in p["photos"]])
    p["photos"] = []
    for prev in p.get("sent", [])[-1:]:  # the part before was only a cover page: join it to this one
        st = db.scalar("SELECT status FROM exams WHERE id=?", (prev["exam_id"],))
        if st == "ready":
            pipeline.merge_empty(prev["exam_id"])
    p.setdefault("sent", []).append({"exam_id": exam_id, "pages": pages})
    p["v"] += 1
    return {"exam_id": exam_id, "n": len(p["sent"])}


@app.get("/snap.html")
async def snap_page():
    return _page("snap.html")


@app.get("/pad.html")
async def pad_page():
    return _page("pad.html")


@app.get("/vrender.html")
def vrender_page():
    return _page("vrender.html")


@app.get("/vpng.html")
def vpng_page():
    return _page("vpng.html")


@app.get("/api/vrender/{token}")
def vrender_data(token: str, request: Request):
    """The diagram being checked, for the Pi's own headless Chromium only (one-time token)."""
    v = vischeck.take(token) if request.client and request.client.host == "127.0.0.1" else None
    if v is None:
        raise HTTPException(404)
    return v


@app.post("/api/vrender/{token}/done")
def vrender_done(token: str, body: dict):
    vischeck.report(token, bool(body.get("drawn")))
    return {"ok": True}


@app.post("/api/visuals/recheck")
async def visuals_recheck(request: Request, body: dict | None = None):
    """家長: have the AI look at every diagram again (all=true also re-checks ones that passed)."""
    need_parent(request)
    return {"job_id": ahead(("vischeck_all",), "vischeck_all", 0, pipeline.vischeck_all_job, bool((body or {}).get("all")))}


@app.get("/print.html")
async def print_page():
    return _page("print.html")


@app.get("/sw.js")
async def sw():
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404)
    return _page("index.html")
