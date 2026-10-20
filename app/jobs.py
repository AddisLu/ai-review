"""Background jobs (scanning, AI generation). State lives in the jobs table so
any device can poll progress."""
import asyncio
import json
import logging
import traceback

from . import db
from .ai import AIError

log = logging.getLogger("jobs")
_tasks: set[asyncio.Task] = set()


def create(kind: str, ref_id: int = 0) -> int:
    return db.insert("jobs", {"kind": kind, "ref_id": ref_id, "status": "queued",
                              "created_at": db.now(), "updated_at": db.now()})


_last_progress: dict = {}


def progress(job_id: int, pct: int, message: str = ""):
    import time as _t
    now = _t.monotonic()
    last = _last_progress.get(job_id)
    if last and now - last[0] < 1.0 and last[1] == message:  # the same step again within a second: skip
        return
    _last_progress[job_id] = (now, message)
    db.update("jobs", job_id, {"status": "running", "progress": pct, "message": message,
                               "updated_at": db.now()})


# got ready before she taps (換個方法解說, an example, why it went wrong, 觀念圖解…): in the front lane
# but at most two at once, and never the last free slot — a question asked right now always gets one
SOON_KINDS = {"example", "reteach", "diagnose", "visualize", "coach", "lesson"}
BACKGROUND_KINDS = {"upgrade_all", "upgrade", "visuals", "vischeck_all", "vischeck", "regenerate", "task_similar", "refresh_all", "layout_all", "solve_bg", "chapters", "school_all", "redraw_figures", "verify"}


def start(kind: str, ref_id: int, fn, *args) -> int:
    """Run `await fn(job_id, *args)` in the background; its return value is
    stored as the job result."""
    job_id = create(kind, ref_id)

    async def runner():
        from . import ai
        if kind in BACKGROUND_KINDS:  # nobody is waiting for these: they never slow down what a person is doing
            ai.background.set(True)
        elif kind in SOON_KINDS:  # made ahead of a tap that may come: never in the way of a question asked now
            ai.soon.set(True)
        try:
            progress(job_id, 1, "開始處理…")
            result = await fn(job_id, *args)
            db.update("jobs", job_id, {"status": "done", "progress": 100, "message": "完成",
                                       "result": json.dumps(result or {}, ensure_ascii=False),
                                       "updated_at": db.now()})
        except AIError as e:
            db.update("jobs", job_id, {"status": "error", "message": str(e), "updated_at": db.now()})
        except Exception as e:  # keep the server alive, surface the error
            log.error("job %s failed: %s", job_id, traceback.format_exc())
            db.update("jobs", job_id, {"status": "error", "message": f"處理失敗：{e}",
                                       "updated_at": db.now()})

    t = asyncio.get_running_loop().create_task(runner())
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return job_id


def get(job_id: int) -> dict | None:
    return db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
