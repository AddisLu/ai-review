"""Answer checking, spaced repetition and question selection."""
import random
import re
import unicodedata
from datetime import date, timedelta
from fractions import Fraction

from . import ai, db, qstate

# Leitner boxes: days until the next review after a correct answer.
INTERVALS = [0, 1, 2, 4, 7, 15]
MASTER_BOX = 5

TRUE_WORDS = {"○", "o", "對", "是", "true", "t", "y", "yes", "◯", "〇", "v", "✓", "✔"}
FALSE_WORDS = {"×", "x", "✕", "✗", "錯", "否", "false", "f", "n", "no", "╳"}


_CN_DIGIT = {"零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_CN_UNIT = {"十": 10, "百": 100, "千": 1000}
_CN_RUN = re.compile(r"[零〇一二兩三四五六七八九十百千萬]+")


def _cn_int(t: str) -> int | None:
    """四十八 → 48, 一百二十 → 120, 三萬五千 → 35000, 十二 → 12."""
    total, section, num = 0, 0, 0
    for ch in t:
        if ch in _CN_DIGIT:
            num = _CN_DIGIT[ch]
        elif ch in _CN_UNIT:
            section += (num or 1) * _CN_UNIT[ch]
            num = 0
        elif ch == "萬":
            total += (section + num) * 10000
            section, num = 0, 0
        else:
            return None
    return total + section + num


def cn_numbers(s: str) -> str:
    """Kids write answers in words too: 四十八元, 五分之三, 二又三分之一, 3分之2."""
    s = _CN_RUN.sub(lambda m: str(_cn_int(m.group(0))) if _cn_int(m.group(0)) is not None else m.group(0), s)
    s = re.sub(r"(\d+)分之(\d+)", r"\2/\1", s)  # 5分之3 → 3/5
    return s


UNITS = set("元 個 人 位 隻 條 張 本 枝 支 次 天 年 月 日 週 歲 分 秒 度 倍 頁 題 顆 箱 包 盒 瓶 杯 台 輛 份 組 種 片 塊 公分 公尺 公里 公斤 公克 克 公升 毫升 毫米 公頃 小時 分鐘 平方公分 平方公尺 立方公分 立方公尺 cm m km kg g ml l".split())


def _numeric(t: str) -> bool:
    """A number (whole, decimal, fraction, mixed, percent) with at most a unit."""
    rest = re.sub(r"\d+(?:\.\d+)?(?:又\d+/\d+|/\d+(?:\.\d+)?)?%?", "", t, count=1)
    return bool(re.search(r"\d", t)) and (rest == "" or rest in UNITS)


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").strip().lower()
    s = latex_to_text(s)
    s = re.sub(r"[\s，,。．、;；:：「」『』（）()\[\]【】!！?？]", "", s)
    return s


def latex_to_text(s: str) -> str:
    s = re.sub(r"(\d+)\s*\\frac\{([^{}]*)\}\{([^{}]*)\}", r"\1又\2/\3", s)
    s = re.sub(r"\\d?frac\{([^{}]*)\}\{([^{}]*)\}", r"\1/\2", s)
    s = s.replace("\\times", "×").replace("\\div", "÷").replace("\\pi", "π")
    s = s.replace("\\le", "≤").replace("\\ge", "≥").replace("\\neq", "≠").replace("\\ne ", "≠").replace("\\cdots", "…")
    s = s.replace("\\angle", "∠").replace("\\perp", "⊥").replace("\\parallel", "∥").replace("\\circ", "°").replace("\\triangle", "△")
    s = s.replace("^°", "°")
    s = re.sub(r"\\text\{([^{}]*)\}", r"\1", s)
    s = re.sub(r"\\(left|right|,|;|!|quad)", "", s)
    s = s.replace("$", "").replace("{", "").replace("}", "")
    return s


_NUM = re.compile(r"(\d+)又(\d+)/(\d+)|(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)%|(\d+(?:\.\d+)?)")


def numbers(s: str) -> list[Fraction]:
    out = []
    s = s.replace(",", "")
    for m in _NUM.finditer(s):
        try:
            if m.group(1):
                out.append(int(m.group(1)) + Fraction(int(m.group(2)), int(m.group(3))))
            elif m.group(4):
                out.append(Fraction(m.group(4)) / Fraction(m.group(5)))
            elif m.group(6):
                out.append(Fraction(m.group(6)) / 100)
            else:
                out.append(Fraction(m.group(7)))
        except (ZeroDivisionError, ValueError):
            pass
    return out


def local_check(q: dict, answer) -> bool | None:
    """True/False when the answer can be judged without AI, None otherwise."""
    if q.get("choice_index") and q.get("options"):
        try:
            return int(answer) == int(q["choice_index"])
        except (TypeError, ValueError):
            return None
    student = _norm(str(answer))
    key = _norm(q.get("answer", ""))
    # 四十八元 / 五分之三: read Chinese numerals only when the answer is a number
    # (so 三角形 vs 正三角形 is never reduced to "3 = 3")
    if _numeric(cn_numbers(key)) and _numeric(cn_numbers(student)):
        student, key = cn_numbers(student), cn_numbers(key)
    if not student:
        return False
    if not key:
        return None
    if (q.get("qtype") == "是非題" or key in TRUE_WORDS | FALSE_WORDS) and len(_marks(key) or "x") == 1:
        if key in TRUE_WORDS or key[:1] in TRUE_WORDS:
            return student in TRUE_WORDS
        if key in FALSE_WORDS or key[:1] in FALSE_WORDS:
            return student in FALSE_WORDS
    if student == key:
        return True
    # 代號題／打勾題 (social studies, 自然): the key often carries a note — 「E（主持會議）」「△（是霸凌行為）」
    raw = q.get("answer", "")
    main = _norm(_PAREN.sub("", raw))
    if main and main != key and student == main:
        return True
    km, sm = _marks(main or key), _marks(student)
    if km and sm:
        return km == sm
    kc, sc = _codes(raw, key=True), _codes(str(answer))
    if kc and sc:
        ordered = len(kc) < 2 or not re.search(r"[、,，;；\s]", _PAREN.sub("", raw).strip()) or \
            bool(re.search(r"順序|先後|依序|排列", q.get("stem") or ""))
        return kc == sc if ordered else sorted(kc) == sorted(sc)
    kn, sn = numbers(key), numbers(student)
    if sn and kn and len(sn) == len(kn) and all(a == b for a, b in zip(sn, kn)):
        # same numbers; text differs only by units / wording
        return True
    if kn and sn and len(kn) == 1 and len(sn) == 1 and kn[0] != sn[0]:
        return False
    return None


_PAREN = re.compile(r"[（(][^（）()]*[）)]")
# a mark she taps or writes → what it means (yes / no / △)
_SYM = {"○": "Y", "◯": "Y", "〇": "Y", "o": "Y", "✓": "Y", "✔": "Y", "v": "Y", "√": "Y", "∨": "Y", "ˇ": "Y", "對": "Y",
        "✗": "N", "✕": "N", "×": "N", "x": "N", "╳": "N", "✘": "N", "錯": "N", "△": "T", "▲": "T"}
_SYM_ONLY = set("○◯〇✓✔√∨ˇ✗✕×╳✘△▲")  # the ones that cannot be part of a word


def _marks(s: str) -> str | None:
    """「(1)✓ (2)✗ (3)✓」, 「①✗ ②✓」 or just 「✓✗✓」 → "YNY"; None when it is not a list of marks.
    A key that also names each item (「① 舉手表決 ✓ ② 猜拳 ✗」) gives its marks in order."""
    t = re.sub(r"[\d第題小]", "", s or "")
    if t and all(ch in _SYM for ch in t):
        return "".join(_SYM[ch] for ch in t)
    marks = [ch for ch in t if ch in _SYM_ONLY]
    return "".join(_SYM[ch] for ch in marks) if len(marks) >= 2 else None


_CODE = re.compile(r"[ㄅ-ㄩa-z1-9甲乙丙丁戊己庚辛壬癸]")


def _codes(raw: str, key: bool = False) -> list[str] | None:
    """代號: 「ㄅ、ㄇ、ㄈ」「C、F」「ㄆ→ㄊ→ㄇ」「ACD」 → their codes; None when it is anything else.
    In the key a run of small letters is a word (cat), not codes."""
    s = unicodedata.normalize("NFKC", _PAREN.sub("", raw or "")).strip()
    toks = [t for t in re.split(r"[\s、,，;；。.→>\-—與和及]+", s) if t]
    if len(toks) == 1 and len(toks[0]) > 1 and not re.search(r"\d", toks[0]) and not (key and re.search(r"[a-z]", toks[0])):
        toks = list(toks[0])
    toks = [t.lower() for t in toks]
    if toks and all(len(t) == 1 and _CODE.fullmatch(t) for t in toks):
        return toks
    return None


async def check(q: dict, answer) -> dict:
    ok = local_check(q, answer)
    feedback = ""
    if ok is None:
        if ai.configured() and q.get("answer"):
            try:
                r = await ai.judge(ai.question_text(q), q["answer"], str(answer))
                ok, feedback = bool(r.get("correct")), r.get("feedback", "")
            except ai.AIError as e:
                ok, feedback = False, f"（無法自動批改：{e}）"
        else:
            ok = False
    return {"correct": bool(ok), "feedback": feedback}


def srs_update(sid: int, q: dict, correct: bool, answer: str = "") -> dict:
    """Update one child's review schedule for a question. `q` is the
    question as seen by that child (qstate.get)."""
    upd = {"attempts": q["attempts"] + 1}
    if correct:
        upd["correct_count"] = q["correct_count"] + 1
        box = min(MASTER_BOX, q["srs_box"] + 1)
        upd["srs_box"] = box
        upd["next_review"] = (date.today() + timedelta(days=INTERVALS[box])).isoformat()
        if q["is_wrong"] and box >= 3 and not q["mastered"]:
            upd["mastered"] = 1
    else:
        upd["wrong_count"] = q["wrong_count"] + 1
        upd["srs_box"] = 0
        upd["mastered"] = 0
        upd["is_wrong"] = 1
        upd["last_wrong_at"] = db.now()
        upd["next_review"] = (date.today() + timedelta(days=1)).isoformat()
        if answer:
            prev = q.get("wrong_answers") or []
            upd["wrong_answers"] = (prev + [str(answer)[:120]])[-6:]
    qstate.set_state(sid, q["id"], upd)
    return upd


def grade_of(sid: int) -> int:
    return db.scalar("SELECT grade FROM students WHERE id=?", (sid,)) or 6


def grade_sql(sid: int) -> tuple[str, list]:
    """Shared bank, but practice sets stay at the child's level: this year
    and last year's questions."""
    g = grade_of(sid)
    return "grade BETWEEN ? AND ?", [g - 1, g]


def due_review(student_id: int, limit: int = 20, subject: str = "") -> list[dict]:
    where = "is_wrong=1 AND mastered=0 AND solved=1 AND (next_review='' OR next_review<=?)"
    args = [db.today()]
    if subject:
        where += " AND subject=?"
        args.append(subject)
    # Most-missed first within the same review box.
    return qstate.query(student_id, where, args + [limit], "ORDER BY srs_box, wrong_count DESC, next_review LIMIT ?")


def unit_accuracy(student_id: int, days: int = 60) -> list[dict]:
    since = (date.today() - timedelta(days=days)).isoformat()
    return db.q(
        "SELECT subject, unit, COUNT(*) AS n, SUM(correct) AS ok, "
        "ROUND(100.0*SUM(correct)/COUNT(*)) AS pct FROM attempts "
        "WHERE student_id=? AND created_at>=? AND unit!='' AND correct IS NOT NULL "
        "AND mode NOT IN ('drill','challenge_done','duel') GROUP BY subject, unit ORDER BY pct",
        (student_id, since))


def target_difficulty(student_id: int) -> int:
    rows = db.q("SELECT correct FROM attempts WHERE student_id=? AND correct IS NOT NULL "
                "AND mode IN ('practice','review','challenge','unit') ORDER BY id DESC LIMIT 20",
                (student_id,))
    if len(rows) < 5:
        return 2
    acc = sum(r["correct"] for r in rows) / len(rows)
    return 4 if acc > 0.85 else 3 if acc > 0.65 else 2 if acc > 0.4 else 1


def _recent_ids(student_id: int, days: int = 2) -> set[int]:
    since = (date.today() - timedelta(days=days)).isoformat()
    return {r["question_id"] for r in db.q(
        "SELECT DISTINCT question_id FROM attempts WHERE student_id=? AND created_at>=?",
        (student_id, since))}


def daily_challenge(student_id: int, subject: str = "", n: int = 10) -> dict:
    """KooBits-style 10-question adaptive set: due mistakes, weak units, then
    fresh questions near the target difficulty."""
    seed = random.Random(f"{db.today()}-{student_id}-{subject}")
    picked: list[dict] = []
    seen = _recent_ids(student_id, 0)

    stems: set[str] = set()  # the same exam photographed twice gives the same question twice

    def add(rows, k, allow_seen=False):
        for r in rows:
            if len(picked) >= n or k <= 0:
                break
            key = re.sub(r"\s+", "", r.get("stem") or "")[:80]
            if (allow_seen or r["id"] not in seen) and r["id"] not in {p["id"] for p in picked} and key not in stems:
                picked.append(r)
                stems.add(key)
                k -= 1

    add(due_review(student_id, 10, subject), 3)
    weak = [u for u in unit_accuracy(student_id) if (not subject or u["subject"] == subject)][:3]
    for u in weak:
        rows = qstate.query(student_id, "subject=? AND unit=? AND solved=1 AND mastered=0",
                            [u["subject"], u["unit"]], "ORDER BY attempts, RANDOM() LIMIT 6")
        add(rows, 2)
    td = target_difficulty(student_id)
    gw, ga = grade_sql(student_id)
    where, args = f"solved=1 AND mastered=0 AND {gw}", ga
    if subject:
        where += " AND subject=?"
        args = args + [subject]
    pool = qstate.query(student_id, where, args + [td], "ORDER BY attempts, ABS(difficulty-?) LIMIT 80")
    recent = _recent_ids(student_id, 3)
    pool = [p for p in pool if p["id"] not in recent] or pool
    seed.shuffle(pool)
    add(pool, n)
    # A second round on the same day may reuse today's questions.
    add(pool, n, allow_seen=True)
    done = db.scalar("SELECT COUNT(*) FROM attempts WHERE student_id=? AND mode='challenge_done' "
                     "AND created_at>=?", (student_id, db.today())) or 0
    weak_unit = weak[0] if weak else None
    return {"questions": picked, "done_today": bool(done), "target_difficulty": td,
            "weak_unit": weak_unit}


def unit_set(student_id: int, subject: str, grade: int, unit: str, n: int = 5) -> list[dict]:
    return qstate.query(student_id, "subject=? AND unit=? AND solved=1", [subject, unit, n],
                        "ORDER BY mastered, attempts, RANDOM() LIMIT ?")


def record(student_id: int, q: dict | None, mode: str, answer: str, correct, seconds: int = 0,
           analysis: dict | None = None, error_type: str = "", image_path: str = "") -> int:
    return db.insert("attempts", {
        "student_id": student_id, "question_id": q["id"] if q else 0, "mode": mode,
        "subject": q["subject"] if q else "", "unit": q["unit"] if q else "",
        "answer": str(answer)[:2000], "correct": None if correct is None else int(bool(correct)),
        "seconds": seconds, "analysis": analysis or {}, "error_type": error_type,
        "image_path": image_path, "created_at": db.now()})
