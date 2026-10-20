"""Keep a complete, up-to-date copy of the family's data on the NAS.

The live SQLite database stays on the Pi's own disk (SQLite must not run
over a network share), and this module mirrors everything to the NAS
folder over SMB:

  資料庫/app.db                 latest consistent snapshot
  資料庫/每日/app-YYYY-MM-DD.db  one per day, last 30 kept
  照片與圖片/…                  every photo, scan, crop and handwriting image
  學生資料/<名字>/錯題本.csv      readable per-child wrong-question list
  學生資料/<名字>/練習紀錄.csv    readable practice history
  說明.txt                      what is where and how to restore

Only new or changed files are uploaded. Sync runs every 10 minutes when
something changed, after each scan, and on demand from the settings page.
"""
import asyncio
import csv
import io
import json
import logging
import sqlite3
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from . import db
from .config import DATA_DIR, DB_PATH, MEDIA_DIR

log = logging.getLogger("nas")
MANIFEST = DATA_DIR / "nas_manifest.json"
_lock = asyncio.Lock()
_dirty = asyncio.Event()

README = """AI 總複習學習站 — 家庭資料備份
====================================
這個資料夾由樹莓派上的「AI 總複習學習站」自動同步（每 10 分鐘檢查一次，掃描考卷後也會同步）。

考卷/<日期> <考卷名稱>/         每份考卷一個資料夾：電子試卷.docx（照範本排版、可編輯）、解答.docx、原卷照片
資料庫/app.db                 全部資料（帳號、題庫、錯題、練習紀錄、設定）的最新備份
資料庫/每日/                  每天一份，保留 30 天
照片與圖片/                    系統用的原始檔（考卷照片、題目圖、手寫計算紙；還原時用）
學生資料/<名字>/錯題本.csv       每位孩子的錯題（可用 Excel 開啟）
學生資料/<名字>/練習紀錄.csv     每位孩子的作答紀錄

還原方式（換一台樹莓派或 SD 卡壞掉時）：
1. 安裝 AI 總複習學習站（deploy/install.sh）
2. 把「資料庫/app.db」複製到 ai-review/data/app.db
3. 把「照片與圖片」資料夾內容複製到 ai-review/data/media/
4. sudo systemctl restart ai-review
"""


def _cfg() -> dict:
    return {
        "enabled": bool(db.get_setting("nas_enabled", False)),
        "path": db.get_setting("nas_path", r"\\192.168.1.10\Public\AI智能複習系統"),
        "user": db.get_setting("nas_user", ""),
        "password": db.get_setting("nas_password", ""),
    }


def _norm(path: str) -> str:
    p = path.strip().replace("/", "\\")
    if not p.startswith("\\\\"):
        p = "\\\\" + p.lstrip("\\")
    return p.rstrip("\\")


def _server(path: str) -> str:
    return _norm(path)[2:].split("\\")[0]


class _SMB:
    """smbclient calls with this NAS's port/credentials on every call."""

    def __init__(self, cfg: dict):
        import smbclient
        self._c = smbclient
        self._kw = {"port": int(db.get_setting("nas_port", 445) or 445),
                    "username": cfg["user"], "password": cfg["password"], "connection_timeout": 10}
        smbclient.register_session(_server(cfg["path"]), **self._kw)

    def makedirs(self, path, exist_ok=True):
        return self._c.makedirs(path, exist_ok=exist_ok, **self._kw)

    def open_file(self, path, **kw):
        return self._c.open_file(path, **kw, **self._kw)

    def remove(self, path):
        return self._c.remove(path, **self._kw)

    def listdir(self, path):
        return self._c.listdir(path, **self._kw)


def _session(cfg: dict) -> _SMB:
    return _SMB(cfg)


def status() -> dict:
    c = _cfg()
    return {"enabled": c["enabled"], "path": c["path"], "user": c["user"], "password_set": bool(c["password"]),
            "last_sync": db.get_setting("nas_last_sync", ""), "last_error": db.get_setting("nas_last_error", ""),
            "last_stats": db.get_setting("nas_last_stats", {})}


def _friendly(e: Exception) -> str:
    s = str(e)
    low = s.lower()
    if "logon_failure" in low or "logon failure" in low or "access_denied" in low or "0xc000006d" in low:
        return "NAS 帳號或密碼不對，或這個帳號沒有這個資料夾的寫入權限"
    if "bad_network_name" in low or "0xc00000cc" in low:
        return "找不到這個共用資料夾（請確認路徑，例如 \\\\192.168.1.10\\Public\\AI智能複習系統）"
    if "timed out" in low or "timeout" in low or "unreachable" in low or "refused" in low:
        return "連不到 NAS，請確認 NAS 已開機且在同一個網路"
    return f"NAS 同步失敗：{s[:200]}"


def test(cfg: dict | None = None) -> str:
    """Connect, create the folder, write and delete a small file."""
    cfg = cfg or _cfg()
    smb = _session(cfg)
    root = _norm(cfg["path"])
    smb.makedirs(root, exist_ok=True)
    probe = root + "\\.連線測試.txt"
    with smb.open_file(probe, mode="w", encoding="utf-8") as f:
        f.write(datetime.now().isoformat())
    smb.remove(probe)
    return root


def _db_snapshot() -> Path:
    tmp = Path(tempfile.mkdtemp()) / "app.db"
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(tmp)
    src.backup(dst)
    # a self-contained file (no -wal/-shm needed) that opens anywhere, even read-only
    dst.execute("PRAGMA journal_mode=DELETE")
    src.close()
    dst.close()
    return tmp


def _csvs() -> dict[str, bytes]:
    """Readable per-child exports (UTF-8 with BOM so Excel shows Chinese)."""
    from . import qstate
    out = {}
    for st in db.q("SELECT id, name, grade FROM students WHERE role='student'"):
        rows = qstate.query(st["id"], "is_wrong=1 OR wrong_count>0", [], "ORDER BY subject, unit, wrong_count DESC")
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["科目", "單元", "題型", "題目", "正確答案", "錯的次數", "寫錯的答案", "已精熟", "下次複習", "備註"])
        for q in rows:
            w.writerow([q["subject"], q["unit"], q["qtype"], q["stem"], q["answer"], q["wrong_count"],
                        "、".join(q["wrong_answers"] or []), "是" if q["mastered"] else "", q["next_review"], q["note"]])
        out[f"學生資料\\{st['name']}\\錯題本.csv"] = ("\ufeff" + buf.getvalue()).encode("utf-8")
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["時間", "模式", "科目", "單元", "題目", "作答", "對錯", "錯誤類型"])
        for a in db.q("SELECT a.*, q.stem FROM attempts a LEFT JOIN questions q ON q.id=a.question_id "
                      "WHERE a.student_id=? ORDER BY a.id DESC LIMIT 5000", (st["id"],)):
            w.writerow([a["created_at"].replace("T", " "), a["mode"], a["subject"], a["unit"], (a["stem"] or "")[:80],
                        a["answer"], {1: "對", 0: "錯"}.get(a["correct"], ""), a["error_type"]])
        out[f"學生資料\\{st['name']}\\練習紀錄.csv"] = ("\ufeff" + buf.getvalue()).encode("utf-8")
    return out


def _safe(name: str) -> str:
    import re
    return re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name or "未命名").strip(" .")[:60] or "未命名"


def _exam_sig(e: dict, qids: list[int], tid: str) -> list:
    return [len(qids), db.scalar("SELECT MAX(updated_at) FROM questions WHERE exam_id=?", (e["id"],)) or "",
            e["title"], e.get("exam_date") or "", tid, db.scalar("SELECT COUNT(*) FROM pages WHERE exam_id=?", (e["id"],))]


async def _exam_docs(manifest: dict) -> list[dict]:
    """考卷/<date> <title>/: the readable copy of each exam — its Word paper in its template,
    the answer key, the original photos and the cleaned pages. Only changed exams are rebuilt."""
    from . import exporters, templates
    out = []
    for e in db.q("SELECT * FROM exams WHERE status='ready' ORDER BY id"):
        qids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (e["id"],))]
        if not qids:
            continue
        t = templates.for_exam(e)
        sig = _exam_sig(e, qids, t["id"])
        folder = f"考卷\\{(e.get('exam_date') or '')[:10]} {_safe(e['title'])}".replace("\\\\", "\\")
        item = {"key": f"exam:{e['id']}", "sig": sig, "folder": folder, "files": [], "changed": manifest.get(f"exam:{e['id']}") != sig}
        if item["changed"]:
            try:
                for name, extra in (("電子試卷", {}), ("解答", {"key_only": True})):
                    tok = exporters.make_spec(e["title"], qids, {**t["config"], "template": t["id"], **extra}, e["id"])
                    await exporters.prepare_visuals(tok)
                    item["files"].append((f"{name}.docx", await asyncio.to_thread(exporters.docx, tok)))
            except Exception:
                log.exception("exam %s documents failed", e["id"])
            for pg in db.q("SELECT idx, orig_path FROM pages WHERE exam_id=? ORDER BY idx", (e["id"],)):
                for sub, rel in (("原卷照片", pg["orig_path"]),):
                    if rel and (MEDIA_DIR / rel).exists():
                        item["files"].append((f"{sub}\\第{pg['idx'] + 1}頁{Path(rel).suffix}", MEDIA_DIR / rel))
        out.append(item)
    return out


def _sync_blocking(exam_docs: list | None = None) -> dict:
    cfg = _cfg()
    smb = _session(cfg)
    root = _norm(cfg["path"])
    made: set[str] = set()

    def ensure_dir(d: str):
        if d not in made:
            smb.makedirs(d, exist_ok=True)
            made.add(d)

    def put_bytes(rel: str, data: bytes):
        target = root + "\\" + rel
        ensure_dir(target.rsplit("\\", 1)[0])
        with smb.open_file(target, mode="wb") as f:
            f.write(data)

    def put_file(rel: str, local: Path):
        target = root + "\\" + rel
        ensure_dir(target.rsplit("\\", 1)[0])
        with open(local, "rb") as src, smb.open_file(target, mode="wb") as dst:
            while chunk := src.read(1 << 20):
                dst.write(chunk)

    stats = {"files": 0, "bytes": 0}
    ensure_dir(root)
    put_bytes("說明.txt", README.encode("utf-8"))
    # database: latest + one per day
    snap = _db_snapshot()
    try:
        put_file("資料庫\\app.db", snap)
        day = date.today().isoformat()
        put_file(f"資料庫\\每日\\app-{day}.db", snap)
        stats["bytes"] += snap.stat().st_size
    finally:
        snap.unlink(missing_ok=True)
    try:
        cutoff = (date.today() - timedelta(days=30)).isoformat()
        for name in smb.listdir(root + "\\資料庫\\每日"):
            if name.startswith("app-") and name[4:14] < cutoff:
                smb.remove(root + "\\資料庫\\每日\\" + name)
    except Exception:
        log.exception("pruning daily copies failed")
    # media: only new or changed files
    try:
        manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    except ValueError:
        manifest = {}
    for f in MEDIA_DIR.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(MEDIA_DIR).as_posix()
        st = f.stat()
        sig = [st.st_size, int(st.st_mtime)]
        if manifest.get(rel) == sig:
            continue
        put_file("照片與圖片\\" + rel.replace("/", "\\"), f)
        manifest[rel] = sig
        stats["files"] += 1
        stats["bytes"] += st.st_size
        if stats["files"] % 50 == 0:
            MANIFEST.write_text(json.dumps(manifest))
    # 考卷/: one readable folder per exam
    stats["exams"] = len(exam_docs or [])
    for item in exam_docs or []:
        if not item["changed"]:
            continue
        for name, local in item["files"]:
            put_file(item["folder"] + "\\" + name, Path(local))
        manifest[item["key"]] = item["sig"]
    stats["photos"] = sum(1 for k in manifest if not k.startswith("exam:"))
    MANIFEST.write_text(json.dumps(manifest))
    for rel, data in _csvs().items():
        put_bytes(rel, data)
    return stats


async def sync(force: bool = False) -> dict:
    cfg = _cfg()
    if not cfg["enabled"] and not force:
        return {"skipped": True}
    if not cfg["user"]:
        raise RuntimeError("還沒有設定 NAS 帳號")
    async with _lock:
        t = time.time()
        try:
            try:
                manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
            except ValueError:
                manifest = {}
            docs = await _exam_docs(manifest)
            stats = await asyncio.to_thread(_sync_blocking, docs)
        except Exception as e:
            msg = _friendly(e)
            db.set_setting("nas_last_error", msg)
            log.warning("nas sync failed: %s", e)
            raise RuntimeError(msg) from e
        stats["seconds"] = round(time.time() - t, 1)
        db.set_setting("nas_last_sync", db.now())
        db.set_setting("nas_last_error", "")
        db.set_setting("nas_last_stats", stats)
        _dirty.clear()
        return stats


def forget_exam(exam_id: int):
    """Rewrite this exam's 考卷 folder on the next sync."""
    try:
        m = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
        if m.pop(f"exam:{exam_id}", None) is not None:
            MANIFEST.write_text(json.dumps(m))
    except ValueError:
        pass


def mark_dirty():
    """Called after something worth backing up happened (e.g. a scan)."""
    _dirty.set()


async def loop():
    """Background sync: right after changes, otherwise every 10 minutes if
    the database changed since the last sync."""
    last_mtime = 0.0
    try:  # the 考卷 folders have never been made (new in this version): build them soon after start
        if not any(k.startswith("exam:") for k in json.loads(MANIFEST.read_text() if MANIFEST.exists() else "{}")):
            _dirty.set()
    except ValueError:
        pass
    while True:
        try:
            await asyncio.wait_for(_dirty.wait(), timeout=600)
            await asyncio.sleep(20)  # let a burst of writes settle
        except asyncio.TimeoutError:
            pass
        try:
            if not _cfg()["enabled"]:
                _dirty.clear()
                continue
            mtime = max(DB_PATH.stat().st_mtime, (DB_PATH.with_suffix(".db-wal")).stat().st_mtime
                        if DB_PATH.with_suffix(".db-wal").exists() else 0)
            if _dirty.is_set() or mtime > last_mtime:
                await sync()
                last_mtime = mtime
        except Exception:
            log.exception("background nas sync failed")
            _dirty.clear()
