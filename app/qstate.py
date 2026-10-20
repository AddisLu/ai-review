"""Shared question bank + personal state.

`questions` holds the shared content (stem, options, answer, explanation…);
`student_q` holds what is personal to each child: wrong/marked/favourite
flags, notes, their own answer on the scanned paper, the review schedule and
how many times they have got the question wrong. Every read goes through
`view(sid)`, which overlays one child's state on the shared content, so the
rest of the code can keep using `is_wrong`, `srs_box`, … as plain columns.
"""
import json

from . import db

PERSONAL = {
    "is_wrong": 0, "is_highlighted": 0, "is_marked": 0, "is_favorite": 0, "note": "''",
    "student_answer": "''", "teacher_mark": "'none'", "srs_box": 0, "next_review": "''", "attempts": 0,
    "correct_count": 0, "wrong_count": 0, "mastered": 0, "last_wrong_at": "''", "wrong_answers": "'[]'",
}
CONTENT = ["id", "student_id", "exam_id", "page_id", "seq", "number", "section", "subject", "grade", "unit",
           "qtype", "stem", "options", "answer", "choice_index", "explanation", "steps", "hints", "key_points",
           "mistakes", "qtype_tip", "bar_model", "difficulty", "bbox", "figure_path", "crop_path", "tags",
           "source", "parent_id", "solved", "visuals", "concept", "figure_facts", "figure_unsure", "fix_note", "figure_kind", "figure_svg", "figure_table", "figure_pos", "option_notes", "upgraded_at", "chapter", "lead",
           "created_at", "updated_at"]

LEVELS = {"basic": "基礎", "advanced": "進階", "challenge": "挑戰"}
# AI sets `level`; older questions fall back to their 1-5 difficulty.
LEVEL_SQL = ("COALESCE(NULLIF(q.level, ''), CASE WHEN q.difficulty <= 2 THEN 'basic' "
             "WHEN q.difficulty = 3 THEN 'advanced' ELSE 'challenge' END) AS level")


def view(everything: bool = False) -> str:
    """Subquery (one `?` = student id) usable as `SELECT * FROM {view()} WHERE …`. It is the 題庫:
    questions of an exam kept out of the bank (homework only photographed to be graded — exams.options
    in_bank false) are left out; `everything=True` keeps them (one exam's own page, a question by id)."""
    cols = ", ".join(f"q.{c}" for c in CONTENT)
    pers = ", ".join(f"COALESCE(s.{k}, {d}) AS {k}" for k, d in PERSONAL.items())
    # vertical: the question comes from a 直書 original (國語) — shown top to bottom, right to left
    vert = ("COALESCE((SELECT json_extract(e.options, '$.layout.direction') = 'vertical' FROM exams e "
            "WHERE e.id = q.exam_id), 0) AS vertical")
    in_bank = ("COALESCE((SELECT json_extract(e.options, '$.in_bank') FROM exams e WHERE e.id = q.exam_id), 1) AS in_bank")
    # 學校考卷: from the school's own test paper (班級、姓名、座號 on it) — what 期中、期末 are made of
    school = ("COALESCE((SELECT json_extract(e.options, '$.school') FROM exams e WHERE e.id = q.exam_id), 0) AS school")
    inner = (f"SELECT {cols}, q.student_id AS owner_id, {LEVEL_SQL}, {vert}, {in_bank}, {school}, {pers} FROM questions q "
             f"LEFT JOIN student_q s ON s.question_id = q.id AND s.student_id = ?")
    return f"({inner}) v" if everything else f"(SELECT * FROM ({inner}) WHERE in_bank != 0) v"


def get(sid: int, qid: int) -> dict | None:
    return db.one(f"SELECT * FROM {view(True)} WHERE id=?", (sid, qid))


def query(sid: int, where: str = "1", args=(), tail: str = "", everything: bool = False) -> list[dict]:
    return db.q(f"SELECT * FROM {view(everything)} WHERE {where} {tail}", (sid, *args))


def set_state(sid: int, qid: int, data: dict):
    data = {k: v for k, v in data.items() if k in PERSONAL}
    if not data:
        return
    data["updated_at"] = db.now()
    for k, v in list(data.items()):
        if isinstance(v, (list, dict)):
            data[k] = json.dumps(v, ensure_ascii=False)
        elif isinstance(v, bool):
            data[k] = int(v)
    cols = ", ".join(data)
    marks = ", ".join("?" * len(data))
    upd = ", ".join(f"{k}=excluded.{k}" for k in data)
    db.execute(f"INSERT INTO student_q(student_id, question_id, {cols}) VALUES(?, ?, {marks}) "
               f"ON CONFLICT(student_id, question_id) DO UPDATE SET {upd}", (sid, qid, *data.values()))


def split(data: dict) -> tuple[dict, dict]:
    """(content fields, personal fields) of an edit."""
    pers = {k: v for k, v in data.items() if k in PERSONAL}
    cont = {k: v for k, v in data.items() if k not in PERSONAL}
    return cont, pers
