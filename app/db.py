"""SQLite storage. One connection per call; WAL mode lets the web server and
background jobs read and write at the same time."""
import concurrent.futures
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime

from .config import DB_PATH


SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade INTEGER DEFAULT 6,
  avatar TEXT DEFAULT '🐱',
  theme TEXT DEFAULT 'sky',
  title TEXT DEFAULT '',
  xp INTEGER DEFAULT 0,
  coins INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  best_streak INTEGER DEFAULT 0,
  last_active TEXT DEFAULT '',
  daily_goal INTEGER DEFAULT 50,
  owned TEXT DEFAULT '[]',
  freeze INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  title TEXT,
  subject TEXT DEFAULT '',
  exam_date TEXT DEFAULT '',
  source TEXT DEFAULT 'scan',
  status TEXT DEFAULT 'processing',
  options TEXT DEFAULT '{}',
  note TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER,
  idx INTEGER,
  orig_path TEXT,
  scan_path TEXT,
  clean_path TEXT,
  width INTEGER,
  height INTEGER,
  status TEXT DEFAULT 'queued',
  error TEXT DEFAULT '',
  meta TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  exam_id INTEGER,
  page_id INTEGER,
  seq INTEGER DEFAULT 0,
  number TEXT DEFAULT '',
  section TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  grade INTEGER DEFAULT 6,
  unit TEXT DEFAULT '',
  qtype TEXT DEFAULT '',
  stem TEXT DEFAULT '',
  options TEXT DEFAULT '[]',
  answer TEXT DEFAULT '',
  choice_index INTEGER DEFAULT 0,
  explanation TEXT DEFAULT '',
  steps TEXT DEFAULT '[]',
  hints TEXT DEFAULT '[]',
  key_points TEXT DEFAULT '[]',
  mistakes TEXT DEFAULT '',
  qtype_tip TEXT DEFAULT '',
  bar_model TEXT DEFAULT '',
  difficulty INTEGER DEFAULT 2,
  bbox TEXT DEFAULT '',
  figure_path TEXT DEFAULT '',
  crop_path TEXT DEFAULT '',
  student_answer TEXT DEFAULT '',
  teacher_mark TEXT DEFAULT 'none',
  is_wrong INTEGER DEFAULT 0,
  is_highlighted INTEGER DEFAULT 0,
  is_marked INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'scan',
  parent_id INTEGER DEFAULT 0,
  solved INTEGER DEFAULT 0,
  srs_box INTEGER DEFAULT 0,
  next_review TEXT DEFAULT '',
  attempts INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0,
  mastered INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_q_student ON questions(student_id, subject, unit);
CREATE INDEX IF NOT EXISTS ix_q_exam ON questions(exam_id, seq);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  question_id INTEGER DEFAULT 0,
  mode TEXT,
  subject TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  answer TEXT DEFAULT '',
  image_path TEXT DEFAULT '',
  correct INTEGER,
  error_type TEXT DEFAULT '',
  analysis TEXT DEFAULT '{}',
  seconds INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_att_student ON attempts(student_id, created_at);
CREATE TABLE IF NOT EXISTS papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  title TEXT,
  kind TEXT DEFAULT 'custom',
  config TEXT DEFAULT '{}',
  question_ids TEXT DEFAULT '[]',
  due_date TEXT DEFAULT '',
  status TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT,
  grade INTEGER,
  unit TEXT,
  content TEXT,
  created_at TEXT,
  UNIQUE(subject, grade, unit)
);
CREATE TABLE IF NOT EXISTS unit_progress (
  student_id INTEGER,
  subject TEXT,
  grade INTEGER,
  unit TEXT,
  stars INTEGER DEFAULT 0,
  best INTEGER DEFAULT 0,
  plays INTEGER DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY(student_id, subject, grade, unit)
);
CREATE TABLE IF NOT EXISTS custom_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT,
  grade INTEGER,
  unit TEXT,
  UNIQUE(subject, grade, unit)
);
CREATE TABLE IF NOT EXISTS xp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  day TEXT,
  xp INTEGER DEFAULT 0,
  coins INTEGER DEFAULT 0,
  reason TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_xp_day ON xp_log(student_id, day);
CREATE TABLE IF NOT EXISTS badges (
  student_id INTEGER,
  badge TEXT,
  earned_at TEXT,
  PRIMARY KEY(student_id, badge)
);
CREATE TABLE IF NOT EXISTS quests_done (
  student_id INTEGER,
  day TEXT,
  quest TEXT,
  PRIMARY KEY(student_id, day, quest)
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  question_id INTEGER,
  messages TEXT DEFAULT '[]',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,
  ref_id INTEGER,
  status TEXT DEFAULT 'queued',
  progress INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  result TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS student_q (
  student_id INTEGER,
  question_id INTEGER,
  is_wrong INTEGER DEFAULT 0,
  is_highlighted INTEGER DEFAULT 0,
  is_marked INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  student_answer TEXT DEFAULT '',
  teacher_mark TEXT DEFAULT 'none',
  srs_box INTEGER DEFAULT 0,
  next_review TEXT DEFAULT '',
  attempts INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0,
  mastered INTEGER DEFAULT 0,
  last_wrong_at TEXT DEFAULT '',
  wrong_answers TEXT DEFAULT '[]',
  updated_at TEXT,
  PRIMARY KEY(student_id, question_id)
);
CREATE INDEX IF NOT EXISTS ix_sq_q ON student_q(question_id);
CREATE TABLE IF NOT EXISTS explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER,
  student_id INTEGER,
  wrong_count INTEGER DEFAULT 0,
  content TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_expl_q ON explanations(question_id, student_id);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  title TEXT,
  exam_date TEXT,
  units TEXT DEFAULT '[]',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  cost INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  reward_id INTEGER,
  title TEXT,
  cost INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS help_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  question_id INTEGER,
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  reply TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  question_id INTEGER DEFAULT 0,
  subject TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  title TEXT,
  content TEXT DEFAULT '{}',
  source TEXT DEFAULT '',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS unit_levels (
  student_id INTEGER,
  subject TEXT,
  unit TEXT,
  level TEXT,
  stars INTEGER DEFAULT 0,
  plays INTEGER DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY(student_id, subject, unit, level)
);
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS practice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER,
  title TEXT DEFAULT '',
  source TEXT DEFAULT '',
  question_ids TEXT DEFAULT '[]',
  results TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT,
  finished_at TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_ps_student ON practice_sessions(student_id, source);
"""

JSON_FIELDS = {
    "options", "steps", "hints", "key_points", "tags", "question_ids", "config",
    "meta", "analysis", "messages", "result", "content", "owned", "visuals", "lesson", "wrong_answers", "units", "figure_table", "option_notes", "results", "lead",
}

# Columns added after the first release: (table, column, ddl)
MIGRATIONS = [
    ("questions", "visuals", "TEXT DEFAULT ''"),
    ("questions", "concept", "TEXT DEFAULT ''"),
    ("papers", "lesson", "TEXT DEFAULT ''"),
    ("students", "role", "TEXT DEFAULT 'student'"),
    ("students", "pin_hash", "TEXT DEFAULT ''"),
    ("students", "daily_limit", "INTEGER DEFAULT 0"),
    ("questions", "level", "TEXT DEFAULT ''"),
    ("attempts", "self_reason", "TEXT DEFAULT ''"),
    ("explanations", "kind", "TEXT DEFAULT 'reteach'"),
    ("questions", "figure_facts", "TEXT DEFAULT ''"),
    ("questions", "fix_note", "TEXT DEFAULT ''"),
    ("questions", "figure_unsure", "TEXT DEFAULT ''"),
    ("questions", "figure_kind", "TEXT DEFAULT ''"),      # none / table / svg / image (題目升級)
    ("questions", "figure_svg", "TEXT DEFAULT ''"),       # the figure redrawn as SVG
    ("questions", "figure_table", "TEXT DEFAULT ''"),     # the figure as a real table {header, rows}
    ("questions", "figure_pos", "TEXT DEFAULT ''"),       # right / below
    ("questions", "option_notes", "TEXT DEFAULT ''"),     # why each option is right or wrong
    ("questions", "upgraded_at", "TEXT DEFAULT ''"),
    ("questions", "chapter", "TEXT DEFAULT ''"),          # 自然: place in the review book ("6.1"; "-" none)
    ("questions", "lead", "TEXT DEFAULT ''"),             # 題組: the shared part a 承上題 needs {stem, figure…}
]


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    # WAL + NORMAL: a commit no longer waits for the SD card to flush (the database can't be
    # corrupted by this; a power cut may lose only the last moment of work)
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("PRAGMA cache_size=-16000")
    # no checkpoint inside a commit (on a busy SD card that write-back took 5–9 s while every page
    # waited); a background thread does it instead (_checkpointer)
    con.execute("PRAGMA wal_autocheckpoint=0")
    _start_checkpointer()
    return con


_ckpt_started = False
_last_write = [0.0]  # when something was last committed (the checkpointer waits for a quiet moment)


# The server's main thread (the event loop) must never wait on the SD card: while it does, every
# page of every person waits with it. A write nobody waits for (a job's progress, a usage row) is
# handed to one writer thread, in order; the thread may stall on the card, the pages do not.
_bg = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="db-writer")
_loop_thread = [0]
activity = [0.0]  # when a person last used the site (main.py's middleware): the checkpoint waits for a quiet moment


def mark_loop_thread():
    _loop_thread[0] = threading.get_ident()


def on_loop_thread() -> bool:
    return threading.get_ident() == _loop_thread[0]


def touch():
    activity[0] = time.monotonic()


def _bg_execute(sql, args):
    try:
        execute(sql, args)
    except Exception:
        import logging
        logging.getLogger("db").exception("background write failed: %s", sql[:80])


def execute_later(sql: str, args=()):
    """A write nobody waits for: done on the writer thread when called from the server's main thread
    (in order with the others), at once anywhere else."""
    if on_loop_thread():
        _bg.submit(_bg_execute, sql, list(args))
    else:
        execute(sql, args)


def update_later(table: str, row_id: int, data: dict):
    if not data:
        return
    keys = list(data.keys())
    execute_later(f"UPDATE {table} SET {','.join(k + '=?' for k in keys)} WHERE id=?", [_enc(data[k]) for k in keys] + [row_id])


def insert_later(table: str, data: dict):
    keys = list(data.keys())
    execute_later(f"INSERT INTO {table}({','.join(keys)}) VALUES({','.join('?' * len(keys))})", [_enc(data[k]) for k in keys])


def flush_later(timeout: float = 10.0):
    """Wait for the writer thread's queue (tests, a shutdown)."""
    _bg.submit(lambda: None).result(timeout=timeout)


def _start_checkpointer():
    global _ckpt_started
    if _ckpt_started:
        return
    _ckpt_started = True

    def run():
        # in a quiet moment (nothing written for 2.5 s, checked often) so a page saving something is
        # not waiting behind it; at the latest every 2 minutes so the WAL stays small
        import time as _t
        last = _t.monotonic()
        while True:
            _t.sleep(1)
            now = _t.monotonic()
            quiet = now - _last_write[0] > 2.5
            # and nobody tapping for a while: a checkpoint's write-back to the SD card slows every
            # page while it runs — unless the WAL has grown large, then at the latest every 2 minutes
            nobody = now - activity[0] > 20
            try:
                big = (DB_PATH.parent / (DB_PATH.name + "-wal")).stat().st_size > 64 * 1024 * 1024
            except OSError:
                big = False
            if not ((quiet and nobody and now - last > 5) or (big and quiet and now - last > 5) or now - last > 120):
                continue
            last = now
            try:
                c = sqlite3.connect(DB_PATH, timeout=30)
                c.execute("PRAGMA wal_checkpoint(PASSIVE)")
                c.close()
            except Exception:
                pass

    threading.Thread(target=run, daemon=True, name="db-checkpoint").start()


# One connection per thread, kept open. Opening and closing one for every query made each
# close checkpoint the WAL onto the SD card (a write could hold up the whole server for over a
# second), and a global lock made every page wait for background work's queries.
_local = threading.local()


@contextmanager
def conn():
    con = getattr(_local, "con", None)
    if con is None or getattr(_local, "path", None) != DB_PATH:
        if con is not None:
            con.close()
        con = _local.con = _connect()
        _local.path, _local.depth = DB_PATH, 0
    outer = _local.depth == 0
    if outer and con.in_transaction:  # should never happen: someone wrote outside conn() and never committed
        import logging, traceback
        logging.getLogger("db").warning("transaction left open on %s; committing now:\n%s",
                                        threading.current_thread().name, "".join(traceback.format_stack(limit=8)))
        con.commit()
    _local.depth += 1
    t0 = time.monotonic() if outer else 0
    try:
        yield con
        if outer:
            if con.in_transaction:
                _last_write[0] = time.monotonic()
            con.commit()
    except BaseException:
        if outer:
            con.rollback()
        raise
    finally:
        _local.depth -= 1
        if outer and time.monotonic() - t0 > 1.0:
            import logging, traceback
            logging.getLogger("db").warning("slow database step %.1fs on %s:\n%s", time.monotonic() - t0,
                                            threading.current_thread().name, "".join(traceback.format_stack(limit=8)))


def mark_interrupted():
    """Jobs that were running when the server stopped will never finish. Only the server's own
    startup calls this — importing the app from a script (tests, maintenance) must never mark the
    running server's work as failed (that is how a scan in progress showed 「伺服器重新啟動」)."""
    with conn() as c:
        c.execute("UPDATE jobs SET status='error', message='伺服器重新啟動，請重試' "
                  "WHERE status IN ('queued','running')")
        c.execute("UPDATE pages SET status='error', error='伺服器重新啟動，請重試' "
                  "WHERE status IN ('queued','running')")


def init():
    with conn() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        for table, col, ddl in MIGRATIONS:
            have = {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
            if col not in have:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
        # One-time move of per-child question state (wrong/flags/review) out
        # of the shared questions table into student_q.
        done = c.execute("SELECT value FROM settings WHERE key='migrated_student_q'").fetchone()
        if not done:
            c.execute("""INSERT OR IGNORE INTO student_q(student_id, question_id, is_wrong, is_highlighted, is_marked,
                is_favorite, note, student_answer, teacher_mark, srs_box, next_review, attempts, correct_count,
                wrong_count, mastered, updated_at)
                SELECT student_id, id, is_wrong, is_highlighted, is_marked, is_favorite, note, student_answer,
                teacher_mark, srs_box, next_review, attempts, correct_count, wrong_count, mastered, updated_at
                FROM questions WHERE student_id IS NOT NULL""")
            c.execute("INSERT INTO settings(key,value) VALUES('migrated_student_q','true')")
        c.execute("UPDATE exams SET status='error' WHERE status='processing'")
        c.execute("UPDATE exams SET status='ready' WHERE status='solving'")
        if not c.execute("SELECT 1 FROM students LIMIT 1").fetchone():
            c.execute("INSERT INTO students(name, grade, created_at) VALUES(?,?,?)",
                      ("小寶貝", 6, now()))


def decode(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    for k in JSON_FIELDS & d.keys():
        v = d[k]
        if isinstance(v, str) and v:
            try:
                d[k] = json.loads(v)
            except ValueError:
                pass
    if isinstance(d.get("bar_model"), str) and d["bar_model"]:
        try:
            d["bar_model"] = json.loads(d["bar_model"])
        except ValueError:
            d["bar_model"] = None
    if isinstance(d.get("bbox"), str) and d["bbox"]:
        try:
            d["bbox"] = json.loads(d["bbox"])
        except ValueError:
            d["bbox"] = None
    return d


def _enc(v):
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool):
        return int(v)
    return v


def q(sql: str, args=()) -> list[dict]:
    with conn() as c:
        return [decode(r) for r in c.execute(sql, args).fetchall()]


def one(sql: str, args=()) -> dict | None:
    with conn() as c:
        return decode(c.execute(sql, args).fetchone())


def scalar(sql: str, args=()):
    with conn() as c:
        r = c.execute(sql, args).fetchone()
        return r[0] if r else None


def execute(sql: str, args=()) -> int:
    with conn() as c:
        cur = c.execute(sql, args)
        return cur.lastrowid


def insert(table: str, data: dict) -> int:
    keys = list(data.keys())
    sql = f"INSERT INTO {table}({','.join(keys)}) VALUES({','.join('?' * len(keys))})"
    return execute(sql, [_enc(data[k]) for k in keys])


def update(table: str, row_id: int, data: dict):
    if not data:
        return
    keys = list(data.keys())
    sql = f"UPDATE {table} SET {','.join(k + '=?' for k in keys)} WHERE id=?"
    execute(sql, [_enc(data[k]) for k in keys] + [row_id])


def columns(table: str) -> set[str]:
    with conn() as c:
        return {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}


def get_setting(key: str, default=None):
    v = scalar("SELECT value FROM settings WHERE key=?", (key,))
    if v is None:
        return default
    try:
        return json.loads(v)
    except ValueError:
        return v


def set_setting(key: str, value):
    execute("INSERT INTO settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)))
