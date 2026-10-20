"""Learning analysis for parents: where a child is weak, why, and what to do.

Per unit: accuracy (overall, by level), recent trend, wrong questions still
open, AI-detected error types and the child's own reasons, giving a mastery
score and a plain-language suggestion. Plus study time per day and
"guessing" (very fast wrong answers)."""
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta

from . import db, qstate

STATUS = [(90, "精熟", "mastered"), (75, "熟練", "good"), (50, "練習中", "practice"), (0, "待加強", "weak")]
SELF_REASONS = {"careless": "粗心", "misread": "看錯題目", "concept": "觀念不懂", "calc": "算錯",
                "unit": "單位", "unknown": "不知道"}


def _status(score):
    if score is None:
        return "尚未練習", "none"
    for th, label, key in STATUS:
        if score >= th:
            return label, key
    return "待加強", "weak"


def units(sid: int, days: int = 90) -> list[dict]:
    since = (date.today() - timedelta(days=days)).isoformat()
    recent = (date.today() - timedelta(days=14)).isoformat()
    rows = db.q("SELECT a.subject, a.unit, a.correct, a.created_at, a.error_type, a.self_reason, a.seconds, "
                "COALESCE(NULLIF(q.level,''), CASE WHEN q.difficulty<=2 THEN 'basic' WHEN q.difficulty=3 "
                "THEN 'advanced' ELSE 'challenge' END) AS level "
                "FROM attempts a LEFT JOIN questions q ON q.id=a.question_id "
                "WHERE a.student_id=? AND a.created_at>=? AND a.unit!='' AND a.correct IS NOT NULL "
                "AND a.mode NOT IN ('drill','challenge_done','duel','unit')", (sid, since))
    agg: dict = defaultdict(lambda: {"n": 0, "ok": 0, "lv": defaultdict(lambda: [0, 0]), "rec": [0, 0], "old": [0, 0],
                                     "errors": Counter(), "reasons": Counter()})
    for r in rows:
        a = agg[(r["subject"], r["unit"])]
        a["n"] += 1
        a["ok"] += r["correct"]
        a["lv"][r["level"]][0] += 1
        a["lv"][r["level"]][1] += r["correct"]
        bucket = a["rec"] if r["created_at"] >= recent else a["old"]
        bucket[0] += 1
        bucket[1] += r["correct"]
        if r["error_type"] and r["error_type"] != "無":
            a["errors"][r["error_type"]] += 1
        if r["self_reason"]:
            a["reasons"][SELF_REASONS.get(r["self_reason"], r["self_reason"])] += 1
    wrong = {(r["subject"], r["unit"]): r for r in db.q(
        f"SELECT subject, unit, SUM(is_wrong AND NOT mastered) AS open_wrong, SUM(wrong_count) AS wrong_times, "
        f"SUM(mastered) AS mastered, COUNT(*) AS bank FROM {qstate.view()} WHERE unit!='' GROUP BY subject, unit", (sid,))}
    keys = set(agg) | {k for k, v in wrong.items() if (v["open_wrong"] or 0) or (v["wrong_times"] or 0)}
    out = []
    for key in keys:
        a, w = agg.get(key), wrong.get(key) or {}
        n = a["n"] if a else 0
        acc = round(100 * a["ok"] / n) if n else None
        lv = {k: round(100 * v[1] / v[0]) if v[0] else None for k, v in (a["lv"].items() if a else [])}
        open_wrong = int(w.get("open_wrong") or 0)
        score = None
        if acc is not None:
            score = max(0, min(100, acc - min(30, open_wrong * 5)))
        elif open_wrong:
            score = max(0, 50 - open_wrong * 10)
        trend = None
        if a and a["rec"][0] >= 3 and a["old"][0] >= 3:
            trend = round(100 * a["rec"][1] / a["rec"][0] - 100 * a["old"][1] / a["old"][0])
        label, key_ = _status(score)
        errors = a["errors"].most_common(3) if a else []
        reasons = a["reasons"].most_common(3) if a else []
        out.append({"subject": key[0], "unit": key[1], "attempts": n, "accuracy": acc, "level_accuracy": lv,
                    "open_wrong": open_wrong, "wrong_times": int(w.get("wrong_times") or 0),
                    "bank": int(w.get("bank") or 0), "score": score, "status": label, "status_key": key_,
                    "trend": trend, "errors": errors, "reasons": reasons,
                    "advice": advice(acc, lv, errors, reasons, open_wrong)})
    out.sort(key=lambda u: (u["score"] if u["score"] is not None else 101, -u["open_wrong"]))
    return out


def advice(acc, lv, errors, reasons, open_wrong) -> str:
    basic, adv = lv.get("basic"), lv.get("advanced")
    top_err = errors[0][0] if errors else (reasons[0][0] if reasons else "")
    if acc is None:
        return "還沒有練習紀錄，先做幾題基礎題。" if open_wrong else ""
    if basic is not None and basic < 70:
        return "基礎觀念還不穩：先看單元重點卡，再做基礎題，錯題請用「換個方法解說」。"
    if top_err in ("計算錯誤", "算錯", "粗心"):
        return "觀念大致會了，錯多在計算／粗心：練心算快打、寫完要驗算。"
    if top_err in ("題意理解錯誤", "看錯題目"):
        return "常看錯題意：作答前圈出關鍵字和單位，先畫線段圖。"
    if adv is not None and adv < 60:
        return "基礎會了，變形題還不熟：多練進階／挑戰題。"
    if acc >= 85:
        return "很熟練了，偶爾複習即可，可以挑戰變形題。"
    return "持續練習，把錯題複習到精熟。"


def study_time(sid: int, days: int = 14) -> list[dict]:
    """Minutes per day, estimated from answer timestamps (gaps over 10
    minutes start a new session; each answer counts at least 1 minute)."""
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    rows = db.q("SELECT created_at FROM attempts WHERE student_id=? AND created_at>=? ORDER BY created_at", (sid, since))
    per_day: dict = defaultdict(float)
    prev = None
    for r in rows:
        t = datetime.fromisoformat(r["created_at"])
        if prev and prev.date() == t.date() and (t - prev).total_seconds() < 600:
            per_day[t.date().isoformat()] += (t - prev).total_seconds() / 60
        else:
            per_day[t.date().isoformat()] += 1
        prev = t
    return [{"day": (date.today() - timedelta(days=i)).isoformat(),
             "minutes": round(per_day.get((date.today() - timedelta(days=i)).isoformat(), 0))}
            for i in range(days - 1, -1, -1)]


def minutes_today(sid: int) -> int:
    return study_time(sid, 1)[-1]["minutes"]


def guesses(sid: int, days: int = 14) -> dict:
    since = (date.today() - timedelta(days=days)).isoformat()
    r = db.one("SELECT COUNT(*) AS n, SUM(CASE WHEN seconds>0 AND seconds<4 AND correct=0 THEN 1 ELSE 0 END) AS fast "
               "FROM attempts WHERE student_id=? AND created_at>=? AND question_id>0 AND correct IS NOT NULL", (sid, since))
    return {"answers": r["n"] or 0, "fast_wrong": r["fast"] or 0}


def week_summary(sid: int) -> dict:
    today = date.today()
    start = today - timedelta(days=today.weekday())
    prev = start - timedelta(days=7)

    def span(a, b):
        r = db.one("SELECT COUNT(*) AS n, SUM(correct) AS ok FROM attempts WHERE student_id=? AND created_at>=? "
                   "AND created_at<? AND question_id>0 AND correct IS NOT NULL", (sid, a.isoformat(), b.isoformat()))
        xp = db.scalar("SELECT COALESCE(SUM(xp),0) FROM xp_log WHERE student_id=? AND day>=? AND day<?",
                       (sid, a.isoformat(), b.isoformat())) or 0
        mins = sum(d["minutes"] for d in study_time(sid, 21) if a.isoformat() <= d["day"] < b.isoformat())
        n = r["n"] or 0
        return {"answers": n, "accuracy": round(100 * (r["ok"] or 0) / n) if n else None, "xp": xp, "minutes": mins}

    this, last = span(start, today + timedelta(days=1)), span(prev, start)
    mastered = db.scalar("SELECT COUNT(*) FROM student_q WHERE student_id=? AND mastered=1 AND updated_at>=?",
                         (sid, start.isoformat())) or 0
    us = units(sid, 28)
    improved = [u for u in us if u["trend"] is not None and u["trend"] >= 10][:3]
    declined = [u for u in us if u["trend"] is not None and u["trend"] <= -10][:3]
    return {"this": this, "last": last, "mastered_this_week": mastered,
            "improved": [{"unit": u["unit"], "trend": u["trend"]} for u in improved],
            "declined": [{"unit": u["unit"], "trend": u["trend"]} for u in declined]}


def full(sid: int) -> dict:
    us = units(sid)
    subj: dict = defaultdict(lambda: {"units": 0, "weak": 0, "good": 0, "open_wrong": 0})
    for u in us:
        s = subj[u["subject"]]
        s["units"] += 1
        s["open_wrong"] += u["open_wrong"]
        if u["status_key"] in ("weak", "practice"):
            s["weak"] += 1
        elif u["status_key"] in ("good", "mastered"):
            s["good"] += 1
    errs: Counter = Counter()
    reasons: Counter = Counter()
    for u in us:
        errs.update(dict(u["errors"]))
        reasons.update(dict(u["reasons"]))
    return {"units": us, "subjects": dict(subj), "errors": errs.most_common(6), "reasons": reasons.most_common(6),
            "time": study_time(sid), "guesses": guesses(sid), "week": week_summary(sid)}
