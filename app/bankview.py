"""錯題頁: what the child needs to work on (by concept, not question by question)
and, for a parent, the weaknesses behind it plus the tasks she has given."""
import json
from collections import defaultdict
from datetime import date

from . import analysis, db, qstate

TASK_KINDS = {"lesson": "觀念＋練習", "redo": "重做錯題", "similar": "舉一反三", "paper": "紙本複習卷"}


def _diag_by_question(qids: list[int]) -> dict:
    if not qids:
        return {}
    out = {}
    marks = ",".join("?" * len(qids))
    for r in db.q(f"SELECT question_id, content FROM explanations WHERE kind='diag' AND question_id IN ({marks}) "
                  "ORDER BY id DESC", qids):
        c = r["content"] if isinstance(r["content"], dict) else json.loads(r["content"] or "{}")
        if r["question_id"] not in out and c.get("likely_cause"):
            out[r["question_id"]] = c["likely_cause"]
    return out


def overview(sid: int, parent: bool = False) -> dict:
    today = date.today().isoformat()
    V = qstate.view()
    t = db.one(f"SELECT COALESCE(SUM(is_wrong),0) AS wrong, COALESCE(SUM(is_wrong AND mastered),0) AS mastered, "
               f"COALESCE(SUM(is_wrong AND NOT mastered),0) AS open, "
               f"COALESCE(SUM(is_wrong AND NOT mastered AND (next_review IS NULL OR next_review='' OR next_review<=?)),0) AS due, "
               f"COALESCE(SUM(is_wrong AND NOT mastered AND wrong_count>=2),0) AS wrong2, "
               f"COALESCE(SUM(NOT mastered AND (is_highlighted OR is_marked)),0) AS marks FROM {V}", (today, sid))
    rows = db.q(f"SELECT id, subject, unit, mastered, wrong_count, solved FROM {V} WHERE is_wrong=1 AND unit!=''", (sid,))
    per: dict = defaultdict(lambda: {"open": [], "mastered": 0, "times": 0})
    for r in rows:
        p = per[(r["subject"], r["unit"])]
        if r["mastered"]:
            p["mastered"] += 1
        elif r["solved"]:
            p["open"].append(r["id"])
        p["times"] += r["wrong_count"] or 0
    diag = _diag_by_question([i for p in per.values() for i in p["open"]])
    last = {(r["subject"], r["unit"]): r["at"] for r in db.q(
        "SELECT subject, unit, MAX(created_at) AS at FROM attempts WHERE student_id=? AND unit!='' GROUP BY subject, unit", (sid,))}
    units = analysis.units(sid)
    by_key = {(u["subject"], u["unit"]): u for u in units}
    concepts = []
    for key, p in per.items():
        if not p["open"]:
            continue
        u = by_key.get(key, {})
        cause = next((diag[i] for i in p["open"] if i in diag), "")
        err = (u.get("errors") or [[None]])[0][0] or (u.get("reasons") or [[None]])[0][0]
        concepts.append({"subject": key[0], "unit": key[1], "open": len(p["open"]), "mastered": p["mastered"],
                         "total": len(p["open"]) + p["mastered"], "wrong_times": p["times"], "ids": p["open"],
                         "accuracy": u.get("accuracy"), "score": u.get("score"), "status": u.get("status", "待加強"),
                         "cause": cause[:40], "error": err or "", "advice": u.get("advice", ""),
                         "last": (last.get(key) or "")[:10]})
    concepts.sort(key=lambda c: (c["mastered"] / max(1, c["total"]), -c["wrong_times"]))
    full_errs = analysis.full(sid) if parent else None
    errs: dict = defaultdict(int)
    for u in units:
        for name, n in (u.get("errors") or []) + (u.get("reasons") or []):
            errs[name] += n
    top_err = max(errs.items(), key=lambda kv: kv[1]) if errs else None
    ex = db.one("SELECT id, title FROM exams WHERE student_id=? AND status='ready' ORDER BY id DESC LIMIT 1", (sid,))
    ex_wrong = db.scalar(f"SELECT COUNT(*) FROM {V} WHERE exam_id=? AND is_wrong=1 AND NOT mastered", (sid, ex["id"])) if ex else 0
    week = analysis.week_summary(sid)
    out = {
        "stats": {"wrong": t["wrong"], "mastered": t["mastered"], "open": t["open"], "due": t["due"],
                  "pct": round(100 * t["mastered"] / t["wrong"]) if t["wrong"] else 0,
                  "week_mastered": week["mastered_this_week"],
                  "top_error": {"name": top_err[0], "n": top_err[1]} if top_err else None},
        "concepts": concepts,
        "picks": {"wrong2": t["wrong2"], "marks": t["marks"], "mastered": t["mastered"],
                  "exam": {"id": ex["id"], "title": ex["title"], "n": ex_wrong} if ex else None},
    }
    if parent:
        total = sum(errs.values()) or 1
        rep = db.get_setting(f"report_{sid}") or {}
        weak = [{"subject": w.get("subject", ""), "unit": w.get("unit", ""), "issue": w.get("issue", ""),
                 "advice": w.get("advice", "")} for w in ((rep.get("report") or {}).get("weaknesses") or [])][:3]
        if not weak:
            weak = [{"subject": c["subject"], "unit": c["unit"], "issue": c["cause"] or (f"常見錯誤：{c['error']}" if c["error"] else ""),
                     "advice": c["advice"]} for c in concepts[:3]]
        for w in weak:
            c = next((c for c in concepts if c["unit"] == w["unit"]), None) or by_key.get((w["subject"], w["unit"])) or {}
            w["subject"] = w["subject"] or c.get("subject", "")
            w["accuracy"] = c.get("accuracy")
            w["open"] = c.get("open", c.get("open_wrong", 0))
            w["wrong_times"] = c.get("wrong_times", 0)
        table = []
        for u in units[:24]:
            p = per.get((u["subject"], u["unit"]), {"open": [], "mastered": 0})
            table.append({"subject": u["subject"], "unit": u["unit"], "score": u["score"], "accuracy": u["accuracy"],
                          "open": len(p["open"]), "ids": p["open"], "last": (last.get((u["subject"], u["unit"])) or "")[:10],
                          "trend": u["trend"], "status": u["status"]})
        out.update({
            "weaknesses": weak, "report_at": rep.get("at", ""),
            "errors": [{"name": k, "pct": round(100 * v / total)} for k, v in sorted(errs.items(), key=lambda kv: -kv[1])[:5]],
            "week": week, "table": table, "tasks": tasks(sid), "attempts_30": sum(u["attempts"] for u in units),
            "subjects": full_errs["subjects"] if full_errs else {},
        })
    return out


def tasks(sid: int, limit: int = 8) -> list[dict]:
    today = date.today().isoformat()
    out = []
    for p in db.q("SELECT * FROM papers WHERE student_id=? AND kind='homework' ORDER BY id DESC LIMIT ?", (sid, limit)):
        ids = p["question_ids"] or []
        done = ok = 0
        if ids:
            marks = ",".join("?" * len(ids))
            r = db.one(f"SELECT COUNT(DISTINCT question_id) AS n, COUNT(DISTINCT CASE WHEN correct=1 THEN question_id END) AS ok "
                       f"FROM attempts WHERE student_id=? AND created_at>=? AND question_id IN ({marks})",
                       [sid, p["created_at"] or ""] + list(ids))
            done, ok = r["n"] or 0, r["ok"] or 0
        cfg = p["config"] or {}
        task = cfg.get("task") or {}
        status = "done" if p["status"] == "done" else "late" if p["due_date"] and p["due_date"] < today else \
            "today" if p["due_date"] == today else "open"
        out.append({"id": p["id"], "title": p["title"], "due_date": p["due_date"], "status": status, "n": len(ids),
                    "done": done, "ok": ok, "kind": task.get("kind", ""), "kind_name": TASK_KINDS.get(task.get("kind", ""), "作業"),
                    "message": task.get("message", ""), "reward": task.get("reward", 0), "generating": bool(task.get("generating"))})
    return out


def pick_questions(sid: int, units: list, n: int) -> list[int]:
    """The task's questions: her open wrong questions of those concepts first, then others from them."""
    V = qstate.view()
    ids: list[int] = []
    for subject, unit in units:
        ids += [r["id"] for r in db.q(f"SELECT id FROM {V} WHERE subject=? AND unit=? AND is_wrong=1 AND NOT mastered "
                                      "AND solved=1 ORDER BY wrong_count DESC, id DESC", (sid, subject, unit))]
    if len(ids) < n:
        for subject, unit in units:
            ids += [r["id"] for r in db.q(f"SELECT id FROM {V} WHERE subject=? AND unit=? AND solved=1 AND NOT is_wrong "
                                          "ORDER BY id DESC LIMIT ?", (sid, subject, unit, n))]
    return list(dict.fromkeys(ids))[:n]
