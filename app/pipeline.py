"""Exam scanning and AI content jobs."""
import asyncio
import json
import logging
import re
from pathlib import Path

from . import ai, db, gamify, imaging, jobs, qstate, scanner, vischeck
from .config import MEDIA_DIR, DEFAULT_SETTINGS

log = logging.getLogger("pipeline")

SOLVE_BATCH = 3  # small batches run in parallel → faster wall time


def media(rel: str) -> Path:
    return MEDIA_DIR / rel


def _box(b):
    if isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) for v in b):
        b = [max(0, min(1000, int(v))) for v in b]
        if b[2] - b[0] > 3 and b[3] - b[1] > 3:
            return b
    return None


def _as_list(v):
    """A JSON list column (already parsed by db, or still text)."""
    if isinstance(v, str):
        try:
            v = json.loads(v or "[]")
        except ValueError:
            return []
    return v if isinstance(v, list) else []


def owner_view(qid: int) -> dict | None:
    """A question as seen by the child who scanned/created it (their answer
    on the paper and the teacher's marking matter when solving)."""
    owner = db.scalar("SELECT student_id FROM questions WHERE id=?", (qid,))
    return qstate.get(owner, qid) if owner is not None else None


def new_question(student_id: int, d: dict, **extra) -> int:
    """Insert an AI-produced question dict (any of the schemas) and return id."""
    row = {
        "student_id": student_id,
        "qtype": d.get("qtype", ""), "stem": d.get("stem", ""),
        "options": d.get("options") or [], "answer": d.get("answer", ""),
        "choice_index": int(d.get("choice_index") or 0),
        "explanation": d.get("explanation", ""), "steps": d.get("steps") or [],
        "hints": d.get("hints") or [], "key_points": d.get("key_points") or [],
        "mistakes": d.get("mistakes", ""), "qtype_tip": d.get("qtype_tip", ""),
        "unit": d.get("unit", ""), "difficulty": int(d.get("difficulty") or 2),
        "level": d.get("level") if d.get("level") in ("basic", "advanced", "challenge") else "",
        "solved": 1 if d.get("answer") else 0,
        "created_at": db.now(), "updated_at": db.now(),
    }
    bm = d.get("bar_model")
    if isinstance(bm, dict) and bm.get("enabled") and bm.get("bars"):
        row["bar_model"] = json.dumps(bm, ensure_ascii=False)
    row.update(extra)
    content, personal = qstate.split(row)
    qid = db.insert("questions", content)
    if personal:
        qstate.set_state(student_id, qid, personal)
    return qid


def apply_solution(qid: int, sol: dict, keep_stem: bool = True):
    raw = db.one("SELECT student_id FROM questions WHERE id=?", (qid,))
    if not raw:
        return
    owner = raw["student_id"]
    q = qstate.get(owner, qid)
    if not q:
        return
    upd = {
        "answer": sol.get("answer", ""), "choice_index": int(sol.get("choice_index") or 0),
        "explanation": sol.get("explanation", ""), "steps": sol.get("steps") or [],
        "hints": sol.get("hints") or [], "key_points": sol.get("key_points") or [],
        "mistakes": sol.get("mistakes", ""), "qtype_tip": sol.get("qtype_tip", ""),
        "difficulty": int(sol.get("difficulty") or 2), "solved": 1, "updated_at": db.now(),
        "figure_facts": sol.get("figure_facts", ""),
        # a parent's correction settles the figure: no more doubt to show
        "figure_unsure": "" if q.get("fix_note") else sol.get("figure_unsure", ""),
    }
    if sol.get("level") in ("basic", "advanced", "challenge"):
        upd["level"] = sol["level"]
    if sol.get("unit") and not q["unit"]:
        upd["unit"] = sol["unit"]
    if not keep_stem:
        upd.update({"stem": sol.get("stem") or q["stem"], "options": sol.get("options") or q["options"]})
    bm = sol.get("bar_model")
    upd["bar_model"] = json.dumps(bm, ensure_ascii=False) if isinstance(bm, dict) and bm.get("enabled") and bm.get("bars") else ""
    res = sol.get("student_result")
    if q["source"] == "scan" and (res == "wrong" or q["teacher_mark"] in ("wrong", "partial")):
        if not q["is_wrong"]:
            # the scanning child got it wrong on paper: counts as her first miss
            qstate.set_state(owner, qid, {"is_wrong": 1, "next_review": db.today(), "srs_box": 0,
                                          "wrong_count": max(1, q["wrong_count"]), "last_wrong_at": db.now(),
                                          "wrong_answers": [q["student_answer"]] if q["student_answer"] else []})
    db.update("questions", qid, upd)


async def solve_ids(qids: list[int], job_id: int | None = None, base: int = 0, span: int = 100):
    """Generate answers + explanations for questions, batching by page so the
    page image (with figures) can be sent along."""
    rows = [r for r in (owner_view(i) for i in qids) if r]
    groups: dict = {}
    for r in rows:
        groups.setdefault(r["page_id"] or 0, []).append(r)
    batches = []
    for page_id, qs in groups.items():
        for i in range(0, len(qs), SOLVE_BATCH):
            batches.append((page_id, qs[i:i + SOLVE_BATCH]))
    done = 0
    errors = []

    async def run(page_id, qs):
        nonlocal done
        images = []
        page = db.one("SELECT * FROM pages WHERE id=?", (page_id,)) if page_id else None
        if page and page.get("scan_path"):
            images.append(await asyncio.to_thread(imaging.file_for_ai, media(page["scan_path"]), 2000))
        # each figure close up too: on a whole page a small diagram's labels are only a few
        # pixels tall, which is how a "11" that spans the whole height gets misread
        for q in qs:
            if q.get("figure_path") and media(q["figure_path"]).exists():
                images.append(await asyncio.to_thread(imaging.file_for_ai, media(q["figure_path"]), 1400))
        items = [{"index": i, "qtype": q["qtype"], "stem": q["stem"], "options": q["options"],
                  "section": q["section"], "student_answer": q["student_answer"],
                  "teacher_mark": q["teacher_mark"], "fix_note": q.get("fix_note", "")} for i, q in enumerate(qs)]
        subj = qs[0].get("subject") or ""
        try:
            sols = await ai.solve(items, images, effort=None if subj in ("數學", "") else "medium")
        except ai.AIError as e:
            errors.append(str(e))
            return
        for s in sols:
            idx = s.get("index")
            if isinstance(idx, int) and 0 <= idx < len(qs):
                apply_solution(qs[idx]["id"], s)
        done += 1
        if job_id:
            jobs.progress(job_id, base + int(span * done / max(1, len(batches))),
                          f"AI 產生詳解中（{done}/{len(batches)}）")

    await asyncio.gather(*(run(p, qs) for p, qs in batches))
    if errors and len(errors) == len(batches):
        raise ai.AIError(errors[0])
    return {"solved": len(rows), "errors": errors}


# --- every page one page: a two-page spread is turned upright and cut in two before it is read --------

def _meta(page: dict) -> dict:
    m = page.get("meta")
    return dict(m) if isinstance(m, dict) else json.loads(m or "{}")


HALF_KEYS = ("half", "pair", "gutter", "turn")


async def _prepare_pages(exam_id: int, pages: list[dict]) -> list[int]:
    """Before the AI reads anything: each new photo flattened, and a two-page spread (an open booklet)
    turned the right way up and cut into its left and right page, the right one becoming the next page
    (pages and questions after it move one on). Afterwards every page is one page — numbered, shown,
    read and laid out on its own. Returns the ids of the right pages made."""
    folder = f"exam_{exam_id}"
    todo = [p for p in pages if not _meta(p).get("half")]
    scans = await asyncio.gather(*(asyncio.to_thread(imaging.scan, media(p["orig_path"]), _meta(p).get("corners_set"),
                                                     _meta(p).get("spread"), _meta(p).get("digital")) for p in todo))
    # which way up each photo is (one quick look): a booklet photographed sideways or upside down is
    # turned first, so that its two pages side by side can be seen (and read the right way round)

    async def turn_of(p, img):
        if _meta(p).get("digital") is True:
            return 0
        try:
            return await ai.page_turn(await asyncio.to_thread(imaging.for_ai, img, 1000))
        except ai.AIError:
            return 0
    turns = await asyncio.gather(*(turn_of(p, img) for p, (img, _) in zip(todo, scans)))
    made = []
    for p, (img, sinfo), turn in sorted(zip(todo, scans, turns), key=lambda t: -t[0]["idx"]):  # from the last: moves do not disturb
        page = db.one("SELECT * FROM pages WHERE id=?", (p["id"],))
        pmeta = {k: v for k, v in _meta(page).items() if k not in ("turn", "gutter", "half", "pair")}
        if turn == 180:  # upside down: the fold found already, now on the other side
            img = imaging.rotate(img, 180)
            sinfo = {**sinfo, "gutter": round(1 - sinfo["gutter"], 4) if sinfo.get("gutter") else None, "turned": turn}
        elif turn:  # sideways: only now can two pages side by side be seen
            img = imaging.rotate(img, turn)
            gx0 = await asyncio.to_thread(scanner.find_gutter, img) if pmeta.get("spread") is not False else None
            sinfo = {**sinfo, "spread": gx0 is not None, "gutter": round(gx0 / img.shape[1], 4) if gx0 else None, "turned": turn}
        spread = bool(sinfo.get("spread") and sinfo.get("gutter"))
        if not spread:
            rel = f"{folder}/pg{page['id']}_prep.jpg"
            await asyncio.to_thread(imaging.save, img, media(rel))
            db.update("pages", page["id"], {"meta": {**pmeta, "turn": turn, "prepared": {"scan": rel, "info": sinfo}}})
            continue
        g = sinfo["gutter"]
        gx = int(img.shape[1] * g)
        idx = page["idx"]
        db.execute("UPDATE pages SET idx=idx+1 WHERE exam_id=? AND idx>?", (exam_id, idx))
        db.execute("UPDATE questions SET seq=seq+1000 WHERE exam_id=? AND seq>=?", (exam_id, (idx + 1) * 1000))
        common = {k: pmeta[k] for k in ("corners_set", "digital") if k in pmeta} | {"gutter": round(g, 4), "turn": turn}
        info = {**sinfo, "spread": False, "from_spread": True}
        rid = db.insert("pages", {"exam_id": exam_id, "idx": idx + 1, "orig_path": page["orig_path"], "status": "queued", "meta": {}})
        rel_l, rel_r = f"{folder}/pg{page['id']}_prep.jpg", f"{folder}/pg{rid}_prep.jpg"
        await asyncio.to_thread(imaging.save, img[:, :gx], media(rel_l))
        await asyncio.to_thread(imaging.save, img[:, gx:], media(rel_r))
        db.update("pages", page["id"], {"meta": {**pmeta, **common, "half": "L", "pair": rid, "prepared": {"scan": rel_l, "info": info}}})
        db.update("pages", rid, {"meta": {**common, "half": "R", "pair": page["id"], "prepared": {"scan": rel_r, "info": info}}})
        made.append(rid)
    return made


async def _page_image(page: dict, pmeta: dict):
    """The flat scan of a page: prepared just before (once), or made again from its photo — a half of a
    spread cut again at its fold, turned as before."""
    prep = pmeta.pop("prepared", None)
    if prep and media(prep["scan"]).exists():
        img = await asyncio.to_thread(imaging.load, media(prep["scan"]))
        return img, dict(prep.get("info") or {})
    half = pmeta.get("half")
    img, sinfo = await asyncio.to_thread(imaging.scan, media(page["orig_path"]), pmeta.get("corners_set"),
                                         False if half or pmeta.get("turn") else pmeta.get("spread"), pmeta.get("digital"))
    if pmeta.get("turn") in (90, 180, 270):  # turned upright as when it was first read
        img = imaging.rotate(img, int(pmeta["turn"]))
    if half:
        gx = int(img.shape[1] * float(pmeta.get("gutter") or 0.5))
        img = img[:, :gx] if half == "L" else img[:, gx:]
        sinfo = {**sinfo, "spread": False, "from_spread": True}
    return img, sinfo


def fix_pairs(exam_id: int) -> int:
    """The two pages of a spread read upside down (each half needed turning 180° when read): the photo
    was turned the wrong way round, so its left and right page are swapped back — and the turn kept for
    later is corrected. Returns how many spreads were swapped."""
    n = 0
    pages = {p["id"]: p for p in db.q("SELECT * FROM pages WHERE exam_id=?", (exam_id,))}
    for p in pages.values():
        m = _meta(p)
        if m.get("half") != "L" or m.get("pair") not in pages:
            continue
        r = pages[m["pair"]]
        rm = _meta(r)
        if int(m.get("rotation") or 0) != 180 or int(rm.get("rotation") or 0) != 180:
            continue
        li, ri = p["idx"], r["idx"]
        for page, meta, half, idx in ((p, m, "R", ri), (r, rm, "L", li)):
            meta = {**meta, "half": half, "turn": (int(meta.get("turn") or 0) + 180) % 360,
                    "gutter": round(1 - float(meta.get("gutter") or 0.5), 4), "rotation": 0}
            db.update("pages", page["id"], {"idx": idx, "meta": meta})
            for q in db.q("SELECT id, seq FROM questions WHERE page_id=?", (page["id"],)):
                db.update("questions", q["id"], {"seq": idx * 1000 + q["seq"] % 1000})
        n += 1
    return n


async def fill_continuations(exam_id: int) -> list[int]:
    """A 選擇題 that is the last one on its page and has fewer than 3 options: the top of the next page
    (above its first numbered question) is looked at for the rest of it. Returns the questions that got more."""
    pages = db.q("SELECT id, idx, scan_path FROM pages WHERE exam_id=? AND scan_path!='' ORDER BY idx", (exam_id,))
    grown = []
    for a, b in zip(pages, pages[1:]):
        last = db.one("SELECT * FROM questions WHERE page_id=? ORDER BY seq DESC LIMIT 1", (a["id"],))
        if not last or "選擇" not in (last["qtype"] or "") or len(_as_list(last["options"])) >= 3:
            continue
        first = db.one("SELECT bbox FROM questions WHERE page_id=? ORDER BY seq LIMIT 1", (b["id"],))
        y0 = (_box(_as_list(first["bbox"])) or [0, 0, 0, 0])[1] if first else 300
        if y0 < 30:  # the next page starts with a numbered question right at the top: nothing in between
            continue
        f = media(b["scan_path"])
        if not f.exists():
            continue
        img = await asyncio.to_thread(imaging.load, f)
        top = imaging.crop(img, [0, 0, 1000, min(400, y0 + 15)], pad=0, trim=False)
        if top is None:
            continue
        try:
            got = await ai.read_continuation(last["stem"] or "", _as_list(last["options"]), imaging.for_ai(top, max_side=1600))
        except ai.AIError as e:
            log.warning("continuation exam %s page %s: %s", exam_id, b["id"], e)
            continue
        if not got["options"] and not got["text"]:
            continue
        upd = {"solved": 0, "updated_at": db.now()}
        if got["options"]:
            upd["options"] = _as_list(last["options"]) + got["options"]
        if got["text"]:
            upd["stem"] = f"{(last['stem'] or '').rstrip()}\n{got['text']}"
        db.update("questions", last["id"], upd)
        grown.append(last["id"])
    return grown


def merge_continued(exam_id: int) -> list[int]:
    """A question running on to the next page (its options at the top of the next page, read there as
    「續」): put together into the question it belongs to. Returns the questions that got more."""
    rows = db.q("SELECT * FROM questions WHERE exam_id=? ORDER BY seq, id", (exam_id,))
    owner = db.scalar("SELECT student_id FROM exams WHERE id=?", (exam_id,))
    grown = []
    for i, q in enumerate(rows):
        if str(q["number"] or "").strip() != "續" or i == 0:
            continue
        prev = next((r for r in reversed(rows[:i]) if str(r["number"] or "").strip() != "續"), None)
        if not prev:
            continue
        upd = {"solved": 0, "updated_at": db.now()}
        if _as_list(q["options"]) and not _as_list(prev["options"]):
            upd["options"] = _as_list(q["options"])
        if (q["stem"] or "").strip():
            upd["stem"] = f"{(prev['stem'] or '').rstrip()}\n{q['stem'].strip()}"
        db.update("questions", prev["id"], upd)
        mine = qstate.get(owner, q["id"]) or {}
        theirs = qstate.get(owner, prev["id"]) or {}
        pers = {}
        if mine.get("student_answer") and not theirs.get("student_answer"):
            pers["student_answer"] = mine["student_answer"]
        if mine.get("teacher_mark") in ("wrong", "partial") and theirs.get("teacher_mark") in (None, "", "none"):
            pers.update(teacher_mark=mine["teacher_mark"], is_wrong=1)
        if pers:
            qstate.set_state(owner, prev["id"], pers)
        db.execute("DELETE FROM student_q WHERE question_id=?", (q["id"],))
        db.execute("DELETE FROM questions WHERE id=?", (q["id"],))
        grown.append(prev["id"])
    return grown


# --- 漏拍提醒: question numbers run on (1, 2, 3 … within a part; a new 題型 starts again) ---------------

def _num(n) -> int | None:
    m = re.match(r"\s*(\d{1,3})", str(n or ""))
    return int(m.group(1)) if m else None


def find_gaps(exam_id: int) -> list[dict]:
    """Numbers missing in a run of questions (a page not photographed, or a question the AI did not
    see) and numbers read twice: [{kind: missed_page|missed|twice, from, to, pages, section, text}]."""
    rows = db.q("SELECT q.number, q.section, q.stem, q.seq, q.options, q.figure_path, q.figure_svg, q.figure_table, "
                "p.idx AS page, p.id AS page_id FROM questions q "
                "LEFT JOIN pages p ON p.id = q.page_id WHERE q.exam_id=? ORDER BY q.seq, q.id", (exam_id,))
    out = []
    prev = None
    norm = lambda t: re.sub(r"\s+", "", t or "")
    plain = lambda t: re.sub(r"^[（(]\s*[）)]", "", norm(re.sub(r"\{([^|{}]*)\|[^{}]*\}", r"\1", t or "")))
    # the same sheet photographed twice: (most of) the same questions on two pages
    sets, pid_of, full = {}, {}, {}
    for r in rows:
        pg = r["page"] if r["page"] is not None else -1
        sets.setdefault(pg, set()).add((norm(r["section"]), str(r["number"] or "").strip(), plain(r["stem"])[:14]))
        pid_of[pg] = r["page_id"]
        full[pg] = full.get(pg, 0) + (1 if _as_list(r["options"]) else 0)  # how complete it was read
    twice = set()
    pgs = sorted(p for p in sets if p >= 0)
    for i, a in enumerate(pgs):
        for b in pgs[i + 1:]:
            A, B = sets[a], sets[b]
            if a not in twice and b not in twice and min(len(A), len(B)) >= 3 and len(A & B) >= 0.7 * min(len(A), len(B)):
                # the copy to drop: the one read less completely (fewer questions, fewer choices found), else the later one
                drop = a if (len(A), full.get(a, 0)) < (len(B), full.get(b, 0)) else b
                twice.add(drop)
                out.append({"kind": "dup_page", "from": 0, "to": 0, "pages": [a + 1, b + 1], "drop": drop + 1, "page_id": pid_of[drop], "section": "",
                            "text": f"第 {a + 1} 頁和第 {b + 1} 頁是同一頁（拍了兩次）：題目會重複算兩次，可以刪掉第 {drop + 1} 頁"
                                    + ("（另一頁辨識得比較完整）" if drop == a else "")})
    rows = [r for r in rows if (r["page"] if r["page"] is not None else -1) not in twice]
    for r in rows:
        n = _num(r["number"])
        if n is None:
            continue
        sec = norm(r["section"])
        page = (r["page"] or 0) + 1
        body = plain(r["stem"])  # 注音 and the answer ( ) dropped
        shared = re.search(r"\d+\s*[～~\-－至到]\s*\d+\s*題|聽力|[Ll]isten", body) or len(re.findall(r"\d+\s*[.．]\s*[（(]", body)) > 1
        # an instruction alone (「在□裡填入正確的數字」, the rest in a figure) repeats on purpose, and so does
        # one that comes with its own figure each time (「把三角形的 3 個角圈起來」 over four triangles); a
        # question with its own numbers or a long text read twice is a mix-up
        own_fig = bool(r["figure_path"] or r["figure_svg"] or (r["figure_table"] or {}).get("rows"))
        if prev and n != prev["n"] and body == prev["body"] and not shared and not (own_fig and prev["fig"]) \
                and (re.search(r"\d", body) or len(body) >= 30):
            out.append({"kind": "twice", "from": n, "to": n, "pages": [page], "section": r["section"] or "",
                        "text": f"第 {page} 頁的第 {prev['n']} 題和第 {n} 題內容一樣：可能把旁邊的題目認錯、漏了一題，請「檢查題目」或「換這一頁」重拍"})
        if prev and prev["sec"] == sec and n > prev["n"]:
            if n > prev["n"] + 1 and n - prev["n"] <= 40:
                a, b = prev["n"] + 1, n - 1
                rng = f"第 {a} 題" if a == b else f"第 {a}–{b} 題"
                if page != prev["page"]:
                    out.append({"kind": "missed_page", "from": a, "to": b, "pages": [prev["page"], page], "section": r["section"] or "",
                                "text": f"第 {prev['page']} 頁和第 {page} 頁之間少了{rng}：可能漏拍了一頁"})
                else:
                    out.append({"kind": "missed", "from": a, "to": b, "pages": [page], "section": r["section"] or "",
                                "text": f"第 {page} 頁少了{rng}：可能沒辨識到，可以在「原卷照片」用「框選新增」補上"})
        elif prev and prev["sec"] == sec and n == prev["n"] and str(r["number"]).strip() == prev["raw"] \
                and norm(r["stem"])[:30] == prev["stem"][:30]:
            out.append({"kind": "twice", "from": n, "to": n, "pages": [page], "section": r["section"] or "",
                        "text": f"第 {page} 頁的第 {n} 題辨識了兩次（內容一樣）：可能把旁邊的題目認錯了，請「檢查題目」"})
        elif not prev and 1 < n <= 30:
            out.append({"kind": "missed_page", "from": 1, "to": n - 1, "pages": [page], "section": r["section"] or "",
                        "text": f"第一題是第 {n} 題：前面的第 1–{n - 1} 題可能沒拍到" if n > 2 else "第一題是第 2 題：第 1 題可能沒拍到"})
        prev = {"n": n, "sec": sec, "page": page, "raw": str(r["number"]).strip(), "stem": norm(r["stem"]), "body": body, "fig": own_fig}
    return out


async def _read_spread(img, gutter: float, subject: str) -> dict | None:
    """The left and the right page of a spread read separately, put back together as one page
    (boxes in the whole picture's 0–1000 frame). None when a half looks turned (read it whole)."""
    w = img.shape[1]
    gx = int(w * gutter)
    halves = [(0, gx), (gx, w)]
    jpgs = [await asyncio.to_thread(imaging.for_ai, img[:, x0:x1]) for x0, x1 in halves]
    res = await asyncio.gather(*(ai.extract_page(j, subject) for j in jpgs))
    if any(int(r.get("rotation") or 0) for r in res):
        return None

    def back(b, x0, x1):
        b = _box(b)
        if not b:
            return []
        sx = (x1 - x0) / w
        return [round(x0 / w * 1000 + b[0] * sx), b[1], round(x0 / w * 1000 + b[2] * sx), b[3]]

    out = {k: v for k, v in res[0].items() if k not in ("questions", "handwriting_boxes")}
    out["questions"], out["handwriting_boxes"] = [], []
    for (x0, x1), r in zip(halves, res):
        for q in r.get("questions", []):
            q["box"] = back(q.get("box"), x0, x1)
            q["figure_box"] = back(q.get("figure_box"), x0, x1)
            out["questions"].append(q)
        out["handwriting_boxes"] += [bb for bb in (back(b, x0, x1) for b in r.get("handwriting_boxes", [])) if bb]
    out["title"] = res[0].get("title") or res[1].get("title") or ""
    out["subject"] = res[0].get("subject") or res[1].get("subject") or ""
    out["notes"] = "\n".join(n for n in (res[0].get("notes"), res[1].get("notes")) if n)
    return out


async def _process_page(job_id: int, exam: dict, page: dict, opts: dict, report):
    exam_id = exam["id"]
    folder = f"exam_{exam_id}"
    idx = page["idx"]
    db.update("pages", page["id"], {"status": "running"})
    report(f"第 {idx + 1} 頁：校正、去陰影")
    pmeta = _meta(page)
    img, sinfo = await _page_image(page, pmeta)
    report(f"第 {idx + 1} 頁：AI 辨識題目")
    data = None
    if sinfo.get("spread") and sinfo.get("gutter"):
        # two pages side by side (an open booklet): each read on its own — on one dense picture the AI
        # mixed up the two pages' numbers (left 8–19 and right 20–25 interleaved, questions doubled)
        data = await _read_spread(img, sinfo["gutter"], opts.get("subject", ""))
    if data is None:
        data = await ai.extract_page(await asyncio.to_thread(imaging.for_ai, img), opts.get("subject", ""))
    rot = int(data.get("rotation") or 0)
    if rot in (90, 180, 270):
        img = imaging.rotate(img, rot)
        for q in data.get("questions", []):
            q["box"] = imaging.rotate_box(_box(q.get("box")), rot)
            q["figure_box"] = imaging.rotate_box(_box(q.get("figure_box")), rot)
        data["handwriting_boxes"] = [imaging.rotate_box(_box(b), rot)
                                     for b in data.get("handwriting_boxes", []) if _box(b)]
    scan_rel = f"{folder}/pg{page['id']}_scan.jpg"  # by page id: page numbers move when a spread is cut in two
    await asyncio.to_thread(imaging.save, img, media(scan_rel))

    report(f"第 {idx + 1} 頁：偵測螢光筆")
    highlights = await asyncio.to_thread(imaging.find_highlights, img)
    fig_boxes = [b for b in (_box(q.get("figure_box")) for q in data.get("questions", [])) if b]
    cleaned = img  # no 還原卷 any more: the paper is made again (電子試卷), crops come from the photo
    h, w = img.shape[:2]

    subject = exam["subject"] or data.get("subject") or ""
    if not exam["subject"] and subject:
        db.update("exams", exam_id, {"subject": subject})
        exam["subject"] = subject
    if (not exam["title"] or exam["title"] == "未命名試卷") and data.get("title") and idx == 0:
        db.update("exams", exam_id, {"title": data["title"]})

    qids = []
    for i, q in enumerate(data.get("questions", [])):
        box, fbox = _box(q.get("box")), _box(q.get("figure_box"))
        hl = bool(q.get("highlighted"))
        if box and not hl:
            hl = any(imaging.overlap(hb["box"], box) > 0.5 for hb in highlights)
        mark = q.get("teacher_mark") or "none"
        qid = new_question(exam["student_id"], q, exam_id=exam_id, page_id=page["id"],
                           seq=idx * 1000 + i, number=q.get("number", ""),
                           section=q.get("section", ""), subject=subject,
                           grade=int(data.get("grade") or 6),
                           bbox=json.dumps(box) if box else "",
                           student_answer=q.get("student_answer", ""), teacher_mark=mark,
                           is_highlighted=int(hl), is_marked=int(bool(q.get("marked"))),
                           is_wrong=int(mark in ("wrong", "partial")),
                           next_review=db.today() if mark in ("wrong", "partial") else "",
                           source="scan", solved=0)
        upd = {}
        if box:
            c = imaging.crop(cleaned, box, pad=4, trim=False)
            if c is not None:
                rel = f"{folder}/q{qid}_crop.jpg"
                await asyncio.to_thread(imaging.save, c, media(rel))
                upd["crop_path"] = rel
        if fbox:
            c = imaging.crop(cleaned, fbox, pad=4)
            if c is not None:
                rel = f"{folder}/q{qid}_fig.jpg"
                await asyncio.to_thread(imaging.save, c, media(rel))
                upd["figure_path"] = rel
        db.update("questions", qid, upd)
        qids.append(qid)

    db.update("exams", exam_id, {"status": "solving"})
    db.update("pages", page["id"], {
        "scan_path": scan_rel, "clean_path": "", "width": w, "height": h,
        "status": "solving",
        "meta": json.dumps({"warped": sinfo.get("warped"), "scan": sinfo, "corners": sinfo.get("corners"),
                            **({"corners_set": pmeta["corners_set"]} if pmeta.get("corners_set") is not None else {}),
                            **({"spread": pmeta["spread"]} if pmeta.get("spread") is not None else {}),
                            **({"digital": pmeta["digital"]} if pmeta.get("digital") is not None else {}),
                            **{k: pmeta[k] for k in HALF_KEYS if k in pmeta},
                            "rotation": rot, "layout": data.get("layout"),
                            "highlights": highlights, "figure_boxes": fig_boxes,
                            "notes": data.get("notes", ""), "edits": []}, ensure_ascii=False)})
    if opts.get("mode") == "grade":
        # 批改: she is waiting for the marks, not the 詳解 — those are written later, in the background
        db.update("pages", page["id"], {"status": "done", "error": ""})
        report(f"第 {idx + 1} 頁看完了")
        return qids
    # Start this page's explanations right away instead of waiting for the
    # other pages; the exam page already shows the questions meanwhile.
    report(f"第 {idx + 1} 頁：AI 產生答案與詳解（{len(qids)} 題）")
    solve_err = ""
    try:
        await solve_ids(qids)
    except ai.AIError as e:
        solve_err = str(e)
    db.update("pages", page["id"], {"status": "done", "error": solve_err})
    report(f"第 {idx + 1} 頁完成")
    return qids



async def process_exam(job_id: int, exam_id: int):
    exam = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    opts = json.loads(exam["options"] or "{}") if isinstance(exam["options"], str) else exam["options"]
    grading = (opts or {}).get("mode") == "grade"
    if not grading:
        # an exam photographed for the bank: nobody is waiting on it — background work, it never
        # slows down what someone is doing (批改 is different: she is waiting for her marks)
        ai.background.set(True)
    # only pages not yet processed: "再拍一頁" appends pages to an existing exam
    pages = db.q("SELECT * FROM pages WHERE exam_id=? AND status IN ('queued','error') ORDER BY idx", (exam_id,))
    jobs.progress(job_id, 3, "校正照片、找出攤開的兩頁")
    await _prepare_pages(exam_id, pages)
    pages = db.q("SELECT * FROM pages WHERE exam_id=? AND status IN ('queued','error') ORDER BY idx", (exam_id,))
    total = len(pages)
    state = {"msg": ""}

    def report(m):
        state["msg"] = m
        st = [p["status"] for p in db.q("SELECT status FROM pages WHERE exam_id=?", (exam_id,))]
        pct = sum(0.5 if x == "solving" else 1.0 if x == "done" else 0.1 if x == "running" else 0 for x in st)
        jobs.progress(job_id, 5 + int(93 * pct / max(1, total)), m)

    results = await asyncio.gather(*(_process_page(job_id, exam, p, opts, report) for p in pages),
                                   return_exceptions=True)
    all_ids, first_err = [], None
    for p, r in zip(pages, results):
        if isinstance(r, Exception):
            first_err = first_err or r
            db.update("pages", p["id"], {"status": "error", "error": str(r)})
        else:
            all_ids += r
    if not all_ids and first_err:
        db.update("exams", exam_id, {"status": "error"})
        raise first_err if isinstance(first_err, ai.AIError) else ai.AIError(str(first_err))
    fix_pairs(exam_id)  # a spread turned the wrong way round: its two pages swapped back
    grown = merge_continued(exam_id)  # a question running on to the next page: one question again
    grown += [i for i in await fill_continuations(exam_id) if i not in grown]
    all_ids = [i for i in all_ids if db.scalar("SELECT 1 FROM questions WHERE id=?", (i,))]
    all_ids += [i for i in grown if i not in all_ids]
    solve_err = next((p["error"] for p in db.q("SELECT error FROM pages WHERE exam_id=? AND status='done'", (exam_id,))
                      if p["error"]), "")
    db.update("exams", exam_id, {"status": "ready"})
    link_groups(exam_id)
    if not all_ids and merge_empty(exam_id):  # only a cover page: it joined the next part of the exam
        return {"questions": 0, "merged": True}
    await _classify(exam_id)
    await detect_layout(exam_id)
    await detect_school(exam_id)
    if grading:
        jobs.progress(job_id, 92, f"AI 批改中（{len(all_ids)} 題）")
        await grade_exam(exam_id, job_id=job_id)  # 批改功課: every answer checked before she opens it
    gamify.award(exam["student_id"], 20, 5, "掃描試卷")
    from . import nas
    nas.mark_dirty()
    gamify.check_badges(exam["student_id"])
    # the exam is ready to read and edit now; in the background each question is then proofread
    # against the photo, its figure rebuilt (table / SVG) and its 詳解 written in full, then the
    # teaching diagrams are drawn (批改: the 詳解 not written yet come first, also in the background)
    if grading:
        jobs.start("solve_bg", exam_id, solve_then_upgrade_job, exam_id, all_ids)
    else:
        jobs.start("upgrade", exam_id, upgrade_then_visuals_job, exam_id, all_ids)
    return {"questions": len(all_ids), "solve_error": solve_err,
            "page_errors": [str(r) for r in results if isinstance(r, Exception)]}


async def region_job(job_id: int, page_id: int, box: list, student_id: int):
    page = db.one("SELECT * FROM pages WHERE id=?", (page_id,))
    exam = db.one("SELECT * FROM exams WHERE id=?", (page["exam_id"],))
    scan = await asyncio.to_thread(imaging.load, media(page["scan_path"]))
    cleaned = await asyncio.to_thread(imaging.load, media(page["scan_path"]))
    part = imaging.crop(scan, box, pad=2, trim=False)
    if part is None:
        raise ai.AIError("框選範圍太小")
    jobs.progress(job_id, 20, "AI 辨識框選的題目…")
    data = await ai.extract_region(imaging.for_ai(part, 1600))
    maxseq = db.scalar("SELECT MAX(seq) FROM questions WHERE page_id=?", (page_id,)) or page["idx"] * 1000
    ids = []
    for i, q in enumerate(data.get("questions", [])):
        mark = q.get("teacher_mark") or "none"
        qid = new_question(student_id, q, exam_id=exam["id"], page_id=page_id, seq=maxseq + 1 + i,
                           number=q.get("number", ""), section=q.get("section", ""),
                           subject=exam["subject"] or q.get("subject", ""),
                           bbox=json.dumps(box), student_answer=q.get("student_answer", ""),
                           teacher_mark=mark, is_wrong=1, next_review=db.today(),
                           source="scan", solved=0)
        c = imaging.crop(cleaned, box, pad=2, trim=False)
        upd = {}
        if c is not None:
            rel = f"exam_{exam['id']}/q{qid}_crop.jpg"
            imaging.save(c, media(rel))
            upd["crop_path"] = rel
            if q.get("has_figure"):
                upd["figure_path"] = rel
        db.update("questions", qid, upd)
        ids.append(qid)
    jobs.progress(job_id, 50, "AI 產生詳解…")
    await solve_ids(ids, job_id, 50, 48)
    return {"question_ids": ids}


async def solve_job(job_id: int, qids: list[int]):
    res = await solve_ids(qids, job_id, 5, 93)
    # explanations and diagrams built on the old solution would repeat its mistake
    for qid in qids:
        db.execute("DELETE FROM explanations WHERE question_id=? AND kind IN ('reteach','hint','example','diag','coach')", (qid,))
        db.execute("UPDATE questions SET visuals='', concept='' WHERE id=?", (qid,))
    return res


def figure_bytes(q: dict) -> bytes | None:
    if q.get("figure_path") and media(q["figure_path"]).exists():
        return imaging.file_for_ai(media(q["figure_path"]), 1200)
    return None


async def similar_job(job_id: int, qid: int, n: int, difficulty: str, student_id: int):
    q = qstate.get(student_id, qid)
    jobs.progress(job_id, 15, "AI 出題中（舉一反三）…")
    fig = await asyncio.to_thread(figure_bytes, q)
    items = await ai.similar(q, n, difficulty, fig)
    ids = [new_question(student_id, it, subject=q["subject"], grade=q["grade"],
                        unit=it.get("unit") or q["unit"], source="similar", parent_id=qid)
           for it in items]
    return {"question_ids": ids}


GEN_BATCH = 2


async def generate_job(job_id: int, student_id: int, subject: str, grade: int, unit: str,
                       n: int, difficulty: str, source: str = "ai", level: str = "", focus: str = ""):
    jobs.progress(job_id, 15, f"AI 正在出「{unit}」的題目…")
    wrong = qstate.query(student_id, "subject=? AND unit=? AND is_wrong=1", [subject, unit],
                         "ORDER BY wrong_count DESC, id DESC LIMIT 3")
    extra = ""
    if wrong:
        extra = "\n學生在這個單元曾經錯過這些題目，請多出能練到同樣觀念的題目：\n" + \
                "\n".join("- " + w["stem"][:150] for w in wrong)
    qtypes = "選擇題、填充題、計算題、應用題" if subject == "數學" else "選擇題、是非題、填充題、簡答題"
    if focus:
        extra += "\n" + focus
    # Each question carries a full explanation, hints and a diagram (~1.5k tokens), so one
    # request for 6 takes a minute. Small batches in parallel finish in about a third of
    # that, and giving each batch its own question types keeps them from repeating.
    kinds = [t for t in qtypes.split("、") if t]
    sizes = [GEN_BATCH] * (n // GEN_BATCH) + ([n % GEN_BATCH] if n % GEN_BATCH else [])
    done = {"n": 0}

    async def batch(i: int, k: int):
        focus_types = "、".join(kinds[i % len(kinds):] + kinds[:i % len(kinds)]) if len(sizes) > 1 else qtypes
        more = extra + (f"\n這一批請以「{kinds[i % len(kinds)]}」為主，和其他批次的題目情境不要重複。" if len(sizes) > 1 else "")
        items = await ai.generate(subject, grade, unit, k, difficulty, focus_types, more, level)
        # saved as each batch lands, so a round can start with the first ones
        ids = [new_question(student_id, it, subject=subject, grade=grade, unit=unit, source=source,
                            **({"level": level} if level else {})) for it in items]
        done["n"] += 1
        jobs.progress(job_id, 15 + int(80 * done["n"] / len(sizes)), f"AI 出好 {done['n']}/{len(sizes)} 批題目…")
        return ids

    results = await asyncio.gather(*(batch(i, k) for i, k in enumerate(sizes)), return_exceptions=True)
    ids = [i for r in results if not isinstance(r, Exception) for i in r]
    if not ids:
        err = next(r for r in results if isinstance(r, Exception))
        raise err if isinstance(err, ai.AIError) else ai.AIError(str(err))
    return {"question_ids": ids}


async def knowledge_job(job_id: int, subject: str, grade: int, unit: str):
    jobs.progress(job_id, 15, f"AI 正在整理「{unit}」重點…")
    data = await ai.knowledge(subject, grade, unit)
    _pend(data.get("key_points"))
    db.execute("INSERT INTO knowledge(subject,grade,unit,content,created_at) VALUES(?,?,?,?,?) "
               "ON CONFLICT(subject,grade,unit) DO UPDATE SET content=excluded.content, created_at=excluded.created_at",
               (subject, grade, unit, json.dumps(data, ensure_ascii=False), db.now()))
    kid = db.scalar("SELECT id FROM knowledge WHERE subject=? AND grade=? AND unit=?", (subject, grade, unit))
    jobs.start("vischeck", kid, vischeck_job, "knowledge", kid)
    return {"ok": True}


async def report_job(job_id: int, student_id: int, data: dict):
    jobs.progress(job_id, 20, "AI 分析學習狀況中…")
    rep = await ai.report(data)
    db.set_setting(f"report_{student_id}", {"at": db.now(), "report": rep})
    return rep


async def visualize_job(job_id: int, qid: int):
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    q = qstate.get(q["student_id"], qid)
    jobs.progress(job_id, 20, "AI 正在畫圖解…")
    await _draw_visuals(q, lambda m: jobs.progress(job_id, 60, m))
    return {"ok": True}


def _q_context(q: dict) -> str:
    return ai.question_text(q, with_answer=True) + (
        "\n解題步驟：" + "；".join(q.get("steps") or []) if q.get("steps") else "")


async def _draw_visuals(q: dict, say=None):
    """Draw a question's 圖解, have the AI look at each picture (redraw if it is
    unclear or wrong), and keep only the ones that pass."""
    res = await ai.visualize(q, await asyncio.to_thread(figure_bytes, q))
    say and say("AI 正在檢查圖解畫得清不清楚…")
    kept = await vischeck.refine_all(_q_context(q), res.get("visuals") or [], _grade(q))
    db.update("questions", q["id"], {"visuals": kept, "concept": res.get("concept", ""), "updated_at": db.now()})
    if not kept:  # no diagram passed the check: the background jobs don't try this one again
        tried = set(db.get_setting("visuals_tried") or [])
        db.set_setting("visuals_tried", sorted(tried | {q["id"]}))
    return kept


def _grade(q: dict) -> int:
    return int(q.get("grade") or db.scalar("SELECT grade FROM students WHERE id=?", (q.get("student_id"),)) or 6)


async def lesson_job(job_id: int, paper_id: int):
    p = db.one("SELECT * FROM papers WHERE id=?", (paper_id,))
    qs = [q for q in (qstate.get(p["student_id"], i) for i in p["question_ids"]) if q]
    numbering = number_questions(qs, (p["config"] or {}).get("group_by_type", True))
    items = [{**q, "n": numbering[q["id"]]["n"]} for q in qs]
    jobs.progress(job_id, 15, f"AI 正在整理 {len(qs)} 題的觀念教學重點…")
    les = await ai.lesson(items)
    _pend(les.get("concepts"))
    db.update("papers", paper_id, {"lesson": les})
    jobs.start("vischeck", paper_id, vischeck_job, "lesson", paper_id)
    return {"ok": True}


QTYPE_ORDER = ["是非題", "選擇題", "填充題", "配合題", "連連看", "圈選題", "改錯題", "計算題", "應用題",
               "看圖作答", "作圖題", "簡答題", "造句題", "閱讀測驗", "其他"]
CN_NUM = "一二三四五六七八九十"


def number_questions(qs: list[dict], by_type: bool = True, per_section: bool = True) -> dict:
    """Paper numbering: group by question type (Taiwan exam order) and give
    each question a new number. Returns {qid: {section, n, label}}."""
    out = {}
    if not by_type:
        for i, q in enumerate(qs, 1):
            out[q["id"]] = {"section": "", "n": i, "label": str(i)}
        return out
    groups: dict[str, list] = {}
    for q in qs:
        groups.setdefault(q.get("qtype") or "其他", []).append(q)
    order = sorted(groups, key=lambda t: QTYPE_ORDER.index(t) if t in QTYPE_ORDER else 99)
    n = 0
    for si, t in enumerate(order):
        for i, q in enumerate(groups[t], 1):
            n += 1
            num = i if per_section else n
            out[q["id"]] = {"section": f"{CN_NUM[si] if si < 10 else si + 1}、{t}（共 {len(groups[t])} 題）",
                            "n": n, "label": str(num), "order": n}
    return out


async def reteach_job(job_id: int, qid: int, student_id: int):
    """Different ways to explain a question a child keeps getting wrong,
    built from her own wrong answers; earlier approaches are not repeated."""
    q = qstate.get(student_id, qid)
    used = []
    for r in db.q("SELECT content FROM explanations WHERE question_id=? AND student_id=?", (qid, student_id)):
        used += [a.get("name", "") for a in (r["content"] or {}).get("approaches", [])]
    jobs.progress(job_id, 15, f"AI 正在想不同的解說方法（她錯了 {max(1, q['wrong_count'])} 次）…")
    fig = await asyncio.to_thread(figure_bytes, q)
    res = await ai.reteach(q, used, 3 if q["wrong_count"] >= 2 else 2, fig)
    _pend(res.get("approaches"))
    eid = db.insert("explanations", {"question_id": qid, "student_id": student_id, "wrong_count": q["wrong_count"],
                                     "content": res, "created_at": db.now()})
    jobs.start("vischeck", eid, vischeck_job, "explanation", eid)
    return {"id": eid}


MIX = {"basic": 0.6, "advanced": 0.3, "challenge": 0.1}


async def plan_job(job_id: int, student_id: int, n: int, units: list | None, mix: dict | None,
                   title: str, creator: int):
    """依分析出題: take the weakest units, fill a basic/advanced/challenge mix
    from the shared bank (open wrongs first, then unseen), let the AI write
    whatever is missing, and save it as a paper with a concept lesson."""
    from . import analysis, practice
    grade = practice.grade_of(student_id)
    if not units:
        weak = [u for u in analysis.units(student_id) if u["status_key"] in ("weak", "practice")][:3]
        units = [[u["subject"], u["unit"]] for u in weak]
    if not units:
        raise ai.AIError("還沒有足夠的練習紀錄可以分析弱點，請先選擇要練習的單元。")
    mix = mix or MIX
    quota = {lv: max(0, round(n * r)) for lv, r in mix.items()}
    quota["basic"] += n - sum(quota.values())
    chosen: list[int] = []
    missing: list[tuple] = []
    for lv, want in quota.items():
        # spread this level's questions evenly over the chosen units
        shares = [want // len(units) + (1 if i < want % len(units) else 0) for i in range(len(units))]
        for (subject, unit), k in zip(units, shares):
            if k <= 0:
                continue
            rows = qstate.query(student_id, "subject=? AND unit=? AND level=? AND solved=1 AND mastered=0",
                                [subject, unit, lv], "ORDER BY is_wrong DESC, wrong_count DESC, attempts LIMIT 20")
            got = [r["id"] for r in rows if r["id"] not in chosen][:k]
            chosen += got
            if len(got) < k:
                missing.append((subject, unit, lv, k - len(got)))
    jobs.progress(job_id, 20, "已從題庫挑選題目，AI 補出不足的題目…" if missing else "整理中…")
    weak_info = {(u["subject"], u["unit"]): u for u in analysis.units(student_id)}
    for i, (subject, unit, lv, k) in enumerate(missing):
        u = weak_info.get((subject, unit), {})
        focus = ""
        if u.get("errors") or u.get("reasons"):
            focus = "她在這個單元常見的錯誤：" + "、".join(e for e, _ in (u.get("errors") or []) + (u.get("reasons") or []))
        res = await generate_job(job_id, student_id, subject, grade, unit, k, "same", "plan", lv, focus)
        chosen += res["question_ids"]
        jobs.progress(job_id, 20 + int(70 * (i + 1) / len(missing)), f"AI 出題中（{unit}・{lv}）…")
    pid = db.insert("papers", {"student_id": student_id, "title": title or "弱點加強練習卷", "kind": "plan",
                               "config": {"group_by_type": True, "lesson": True, "answers": "end", "explanations": True},
                               "question_ids": chosen, "created_at": db.now()})
    return {"paper_id": pid, "questions": len(chosen), "units": units}


async def coach_job(job_id: int, qid: int, student_id: int):
    from . import practice
    q = qstate.get(student_id, qid)
    jobs.progress(job_id, 20, "AI 正在寫家長陪伴指南…")
    res = await ai.coach(q, practice.grade_of(student_id))
    eid = db.insert("explanations", {"question_id": qid, "student_id": student_id, "wrong_count": q["wrong_count"],
                                     "content": res, "kind": "coach", "created_at": db.now()})
    return {"id": eid}


DIAG_REASON = {"計算錯誤": "calc", "觀念不清": "concept", "題意理解錯誤": "misread", "單位錯誤": "unit", "粗心": "careless"}


async def diagnose_job(job_id: int, qid: int, student_id: int, attempt_id: int, wrong: str):
    """Why did this wrong answer happen? Shared cache per (question, answer):
    two children writing the same wrong answer usually made the same mistake."""
    from . import practice
    key = practice._norm(wrong)
    hit = next((r for r in db.q("SELECT content FROM explanations WHERE question_id=? AND kind='diag'", (qid,))
                if (r["content"] or {}).get("answer") == key), None)
    if hit:
        res = hit["content"]
    else:
        q = qstate.get(student_id, qid)
        jobs.progress(job_id, 30, "AI 正在看你的答案…")
        res = await ai.diagnose(q, wrong, figure_bytes(q))
        res["answer"] = key
        db.insert("explanations", {"question_id": qid, "student_id": 0, "wrong_count": 0, "content": res,
                                   "kind": "diag", "created_at": db.now()})
    if attempt_id and res.get("error_type") and res["error_type"] != "不知道":
        db.execute("UPDATE attempts SET error_type=? WHERE id=? AND (error_type IS NULL OR error_type='')",
                   (res["error_type"], attempt_id))
    return {**res, "reason": DIAG_REASON.get(res.get("error_type", ""), "")}


async def hint_job(job_id: int, qid: int, student_id: int, level: int):
    """A hint level prepared before she asks (shared by every child: no work image)."""
    q = qstate.get(student_id, qid)
    res = await ai.hint(q, level, None, await asyncio.to_thread(figure_bytes, q))
    db.insert("explanations", {"question_id": qid, "student_id": 0, "wrong_count": level, "content": res,
                               "kind": "hint", "created_at": db.now()})
    return res


async def example_job(job_id: int, qid: int, student_id: int):
    q = qstate.get(student_id, qid)
    res = await ai.example_hint(q, await asyncio.to_thread(figure_bytes, q))
    db.insert("explanations", {"question_id": qid, "student_id": 0, "wrong_count": 0, "content": res,
                               "kind": "example", "created_at": db.now()})
    return res


VISUAL_SUBJECTS = ("數學", "自然")


async def visuals_job(job_id: int, qids: list[int]):
    """解題圖解 for a freshly scanned exam, after the questions and explanations are
    already on screen: three at a time, wrong questions first. Math and science get
    one for every question; other subjects only for the ones she got wrong."""
    qs = []
    tried = set(db.get_setting("visuals_tried") or [])  # drawn before and nothing passed the check
    for qid in qids:
        if qid in tried:
            continue
        raw = db.one("SELECT student_id FROM questions WHERE id=?", (qid,))
        q = raw and qstate.get(raw["student_id"], qid)
        if q and q["solved"] and not q.get("visuals") and (q["subject"] in VISUAL_SUBJECTS or q["is_wrong"]):
            qs.append(q)
    qs.sort(key=lambda q: (not q["is_wrong"], q["seq"]))
    sem = asyncio.Semaphore(3)
    done = {"n": 0}

    async def one(q):
        await _wait_for_upgrade()
        async with sem:
            try:
                q = qstate.get(q["student_id"], q["id"]) or q   # the upgraded text, if it changed meanwhile
                await _draw_visuals(q)
            except ai.AIError as e:
                log.warning("visual for q%s failed: %s", q["id"], e)
            done["n"] += 1
            jobs.progress(job_id, int(100 * done["n"] / max(1, len(qs))), f"圖解 {done['n']}/{len(qs)}")

    await asyncio.gather(*(one(q) for q in qs))
    return {"visuals": done["n"]}


# --- 圖解檢查: every diagram is looked at by the AI before a child sees it ----------------------
# Questions get their diagrams only after the check (_draw_visuals). Diagrams inside
# longer content (unit cards, paper lessons, re-teach explanations) are saved as
# "pending" so the text shows at once, and appear once they pass (vischeck.refine).

def _pend(items, key="visual"):
    for it in items or []:
        if isinstance(it, dict) and isinstance(it.get(key), dict):
            it[key] = {**it[key], "pending": True}


async def _check_slots(slots: list, grade: int, force: bool = False) -> int:
    """slots: (container, key, context). Each diagram is checked (redrawn if needed);
    one that passes is kept and marked checked, one that still fails is removed."""
    sem = asyncio.Semaphore(3)

    async def one(c, k, ctx):
        v = c[k]
        if not isinstance(v, dict) or not v.get("type") or (v.get("checked") and not force):
            return 0
        clean = {x: y for x, y in v.items() if x not in ("checked", "pending")}
        async with sem:
            good, verdict = await vischeck.refine(ctx, clean, grade)
        c[k] = None if good is None else good if verdict.get("unchecked") else {**good, "checked": True}
        return 1

    return sum(await asyncio.gather(*(one(*s) for s in slots)))


def _drop_none(items, key="visual"):
    for it in items or []:
        if isinstance(it, dict) and key in it and it[key] is None:
            it.pop(key)


async def _check_row(table: str, row_id: int, col: str, build, grade: int, force: bool) -> int:
    row = db.one(f"SELECT * FROM {table} WHERE id=?", (row_id,))
    if not row or not row.get(col):
        return 0
    data = json.loads(json.dumps(row[col]))
    before = json.dumps(row[col], sort_keys=True)
    slots, tidy = build(row, data)
    n = await _check_slots(slots, grade, force)
    if not n:
        return 0
    tidy(data)
    now = db.one(f"SELECT {col} FROM {table} WHERE id=?", (row_id,))
    if now and json.dumps(now[col], sort_keys=True) == before:  # not regenerated meanwhile
        db.update(table, row_id, {col: data})
    return n


def _student_grade(sid_: int) -> int:
    return int(db.scalar("SELECT grade FROM students WHERE id=?", (sid_,)) or 6)


async def check_question(qid: int, force: bool = False) -> int:
    raw = db.one("SELECT student_id FROM questions WHERE id=?", (qid,))
    q = raw and qstate.get(raw["student_id"], qid)
    if not q:
        return 0
    ctx = _q_context(q)

    def build(row, vis):
        return [(vis, i, ctx) for i in range(len(vis))], lambda d: d.__setitem__(slice(None), [v for v in d if v])
    return await _check_row("questions", qid, "visuals", build, _grade(q), force)


async def check_knowledge(kid: int, force: bool = False) -> int:
    def build(row, c):
        pts = c.get("key_points") or []
        return ([(p, "visual", f"{row['subject']} {row['grade']} 年級「{row['unit']}」的觀念說明圖（不是考題，可以寫出例子的答案）。\n"
                  f"重點：{p.get('title', '')}：{p.get('content', '')}") for p in pts if isinstance(p, dict) and "visual" in p],
                lambda d: _drop_none(d.get("key_points")))
    row = db.one("SELECT grade FROM knowledge WHERE id=?", (kid,))
    return await _check_row("knowledge", kid, "content", build, int((row or {}).get("grade") or 6), force)


async def check_lesson(pid: int, force: bool = False) -> int:
    def build(row, les):
        cs = les.get("concepts") or []
        return ([(c, "visual", f"錯題複習卷的觀念教學圖（說明觀念和例題，不是卷子上的題目）。\n觀念：{c.get('title', '')}\n"
                  f"說明：{c.get('explain', '')}\n規則：{c.get('rule', '')}\n例題：{c.get('example_question', '')}\n"
                  f"例題解法：{c.get('example_solution', '')}") for c in cs if isinstance(c, dict) and "visual" in c],
                lambda d: _drop_none(d.get("concepts")))
    row = db.one("SELECT student_id FROM papers WHERE id=?", (pid,))
    return await _check_row("papers", pid, "lesson", build, _student_grade((row or {}).get("student_id")), force)


async def check_explanation(eid: int, force: bool = False) -> int:
    row = db.one("SELECT question_id, student_id FROM explanations WHERE id=?", (eid,))
    q = row and qstate.get(row["student_id"], row["question_id"])
    if not q:
        return 0
    base = _q_context(q)

    def build(r, c):
        aps = c.get("approaches") or []
        return ([(a, "visual", f"{base}\n這張圖用「{a.get('name', '')}」的方法解說：{a.get('explanation', '')}")
                 for a in aps if isinstance(a, dict) and "visual" in a], lambda d: _drop_none(d.get("approaches")))
    return await _check_row("explanations", eid, "content", build, _grade(q), force)


async def check_note(nid: int, force: bool = False) -> int:
    def build(row, c):
        return ([(c, "visual", f"錯題筆記「{row.get('title') or ''}」的圖解。\n{c.get('correct_idea', '')}\n"
                  + "；".join(c.get("steps") or []))] if "visual" in c else [],
                lambda d: d.pop("visual") if d.get("visual", 0) is None else None)
    row = db.one("SELECT student_id FROM notes WHERE id=?", (nid,))
    return await _check_row("notes", nid, "content", build, _student_grade((row or {}).get("student_id")), force)


async def vischeck_job(job_id: int, kind: str, row_id: int):
    jobs.progress(job_id, 20, "AI 正在檢查圖解畫得清不清楚…")
    fn = {"knowledge": check_knowledge, "lesson": check_lesson, "explanation": check_explanation}[kind]
    return {"checked": await fn(row_id)}


async def vischeck_all_job(job_id: int, force: bool = False):
    """Look at every diagram already in the app (only the unchecked ones unless force)."""
    todo = [(check_question, r["id"]) for r in db.q("SELECT id FROM questions WHERE visuals NOT IN ('', '[]') AND visuals IS NOT NULL")]
    todo += [(check_knowledge, r["id"]) for r in db.q("SELECT id FROM knowledge WHERE content LIKE '%\"visual\"%'")]
    todo += [(check_lesson, r["id"]) for r in db.q("SELECT id FROM papers WHERE lesson LIKE '%\"visual\"%'")]
    todo += [(check_explanation, r["id"]) for r in db.q("SELECT id FROM explanations WHERE content LIKE '%\"visual\"%'")]
    todo += [(check_note, r["id"]) for r in db.q("SELECT id FROM notes WHERE content LIKE '%\"visual\"%'")]
    n = 0
    for i, (fn, rid) in enumerate(todo):
        if _upgrading():
            jobs.progress(job_id, int(100 * i / max(1, len(todo))), "等題目升級完成再檢查圖解…")
            await _wait_for_upgrade()
        try:
            n += await fn(rid, force)
        except ai.AIError as e:
            log.warning("vischeck %s %s: %s", fn.__name__, rid, e)
        jobs.progress(job_id, int(100 * (i + 1) / max(1, len(todo))), f"已檢查 {i + 1}/{len(todo)} 份內容的圖解")
    return {"checked": n}



async def similar_many_job(job_id: int, qids: list[int], student_id: int) -> dict:
    """One AI look-alike for each question, made at the same time (three at once)."""
    sem = asyncio.Semaphore(3)
    done = {"n": 0}

    async def one(qid):
        async with sem:
            q = qstate.get(student_id, qid)
            if not q:
                return []
            try:
                items = await ai.similar(q, 1, "same", await asyncio.to_thread(figure_bytes, q))
            except ai.AIError as e:
                log.warning("similar for q%s failed: %s", qid, e)
                return []
            done["n"] += 1
            jobs.progress(job_id, int(100 * done["n"] / max(1, len(qids))), f"AI 類似題 {done['n']}/{len(qids)}")
            return [new_question(student_id, it, subject=q["subject"], grade=q["grade"],
                                 unit=it.get("unit") or q["unit"], source="similar", parent_id=qid) for it in items]

    res = await asyncio.gather(*(one(i) for i in qids))
    return {"question_ids": [i for r in res for i in r]}


async def task_similar_job(job_id: int, paper_id: int, student_id: int):
    """指派「AI 類似題」: the wrong questions plus a look-alike for each, added to the task."""
    p = db.one("SELECT question_ids, config FROM papers WHERE id=?", (paper_id,))
    ids = list(p["question_ids"] or [])
    res = await similar_many_job(job_id, ids[:8], student_id)
    cfg = p["config"] or {}
    cfg.setdefault("task", {})["generating"] = False
    db.update("papers", paper_id, {"question_ids": ids + res["question_ids"], "config": cfg})
    return res



def move_exam(exam_id: int, to: int):
    """Give a scanned exam to another child: the exam, its questions, her marks on them
    (wrong / highlighted / SRS), answers, explanations, notes and help requests."""
    e = db.one("SELECT student_id FROM exams WHERE id=?", (exam_id,))
    old = e["student_id"]
    if old == to:
        return
    qids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=?", (exam_id,))]
    marks = ",".join("?" * len(qids)) or "NULL"
    with db.conn() as c:  # one transaction
        c.execute("UPDATE exams SET student_id=? WHERE id=?", (to, exam_id))
        c.execute("UPDATE questions SET student_id=? WHERE exam_id=? AND student_id=?", (to, exam_id, old))
        # her marks: the new owner's own row wins if she already has one for that question
        c.execute(f"DELETE FROM student_q WHERE student_id=? AND question_id IN ({marks}) AND question_id IN "
                  f"(SELECT question_id FROM student_q WHERE student_id=?)", [old] + qids + [to])
        c.execute(f"UPDATE student_q SET student_id=? WHERE student_id=? AND question_id IN ({marks})", [to, old] + qids)
        for table in ("attempts", "explanations", "notes", "help_requests"):
            c.execute(f"UPDATE {table} SET student_id=? WHERE student_id=? AND question_id IN ({marks})", [to, old] + qids)



async def regenerate_job(job_id: int, ids: list[int]):
    """依範本重新產生: each exam's Word paper and answer key in its current template (diagrams
    included); the NAS 考卷 folders are rewritten on the next sync, started right after."""
    from . import exporters, nas, templates
    done = 0
    for eid in ids:
        e = db.one("SELECT * FROM exams WHERE id=?", (eid,))
        qids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (eid,))]
        if not e or not qids:
            continue
        t = templates.for_exam(e)
        jobs.progress(job_id, int(100 * done / max(1, len(ids))), f"重新產生「{e['title'][:16]}」（{t['name']}）")
        for extra in ({}, {"key_only": True}):
            tok = exporters.make_spec(e["title"], qids, {**t["config"], "template": t["id"], **extra}, eid)
            await exporters.prepare_visuals(tok)
            await asyncio.to_thread(exporters.docx, tok)
        nas.forget_exam(eid)
        done += 1
    nas.mark_dirty()
    return {"exams": done}



async def grade_exam(exam_id: int, answers: dict | None = None, photos: list | None = None,
                     job_id: int | None = None, only: list[int] | None = None) -> dict:
    """批改: her answers checked against the answers, kept with the exam as {question id: {result,
    read_as, comment}} — nothing goes into the 錯題本 until she (or a parent) confirms which ones to
    redo. answers / photos: a redone paper photographed again (her new answers, read from those
    photos); otherwise the answers on the exam's own photos."""
    owner = db.scalar("SELECT student_id FROM exams WHERE id=?", (exam_id,))
    qs = qstate.query(owner, "exam_id=?", [exam_id], "ORDER BY seq", everything=True)  # her answers are hers (student_q)
    items = [{"id": q["id"], "number": q["number"], "stem": q["stem"] or "", "answer": q["answer"] or "",
              "qtype": q["qtype"] or "", "options": _as_list(q.get("options")),
              "page_id": q["page_id"], "bbox": _box(_as_list(q.get("bbox"))), "teacher_mark": q.get("teacher_mark") or "none",
              "student": (answers.get(q["id"], "") if answers is not None else q["student_answer"]) or ""}
             for q in qs if only is None or q["id"] in only]  # no answer yet (批改 right after the scan): the grader works it out
    pages = {p["id"]: p for p in db.q("SELECT id, idx, scan_path FROM pages WHERE exam_id=? AND scan_path!=''", (exam_id,))}
    page_jpg: dict = {}

    async def page_img(pid):  # the page she wrote on, for the AI to read her writing and the red pen
        if pid not in page_jpg:
            f = media(pages[pid]["scan_path"]) if pid in pages else None
            page_jpg[pid] = await asyncio.to_thread(imaging.file_for_ai, f, 1600) if f and f.exists() else None
        return page_jpg[pid]

    # batches of up to 15 questions on the same page (that page's photo goes along)
    chunks, cur = [], []
    for it in items:
        if cur and (len(cur) >= 15 or it["page_id"] != cur[-1]["page_id"]):
            chunks.append(cur)
            cur = []
        cur.append(it)
    if cur:
        chunks.append(cur)
    out = {}
    done = {"n": 0}
    gate = asyncio.Semaphore(2)  # two batches at a time: a big 批改 leaves room for the children's questions

    def keep(chunk, res):
        for r in res:
            if any(it["id"] == r.get("id") for it in chunk):
                out[str(r["id"])] = {"result": r.get("result", "unsure"), "read_as": r.get("read_as", ""),
                                     "comment": r.get("comment", ""), "answer": r.get("answer", ""), "red": r.get("red", "none")}

    async def one(chunk):  # the chunks go in parallel (the front lane allows a few at once)
        if photos is not None:
            imgs = photos[:3]
        else:
            imgs = [b for b in [await page_img(chunk[0]["page_id"])] if b]
        try:
            async with gate:
                res = await ai.grade_answers(chunk, imgs)
        except ai.AIError as e:
            log.warning("grade exam %s: %s", exam_id, e)
            res = []
        keep(chunk, res)
        done["n"] += len(chunk)
        if job_id:
            jobs.progress(job_id, 40 + int(45 * done["n"] / max(1, len(items))), f"AI 批改中 {done['n']}/{len(items)} 題")

    await asyncio.gather(*(one(c) for c in chunks))
    # the ones still unclear: looked at again close up (that question's part of the page, enlarged)
    if photos is None:
        unclear = [it for it in items if out.get(str(it["id"]), {}).get("result", "unsure") == "unsure" and it["bbox"] and it["page_id"] in pages]
        scans: dict = {}
        closeups = {}
        for it in unclear:
            pid = it["page_id"]
            if pid not in scans:
                f = media(pages[pid]["scan_path"])
                scans[pid] = await asyncio.to_thread(imaging.load, f) if f.exists() else None
            if scans[pid] is None:
                continue
            c = imaging.upscale_crop(scans[pid], it["bbox"], pad=14, scale=2.0)
            if c is not None:
                closeups[it["id"]] = imaging.for_ai(c, max_side=1400)
        # twice: close up, then (the ones still not clear) close up again, thinking harder
        for careful in (False, True):
            todo = [it for it in unclear if it["id"] in closeups and out.get(str(it["id"]), {}).get("result", "unsure") == "unsure"]
            for i in range(0, len(todo), 6):
                part = todo[i:i + 6]
                if job_id:
                    jobs.progress(job_id, 86 + int(12 * i / max(1, len(todo))), f"看不清楚的 {len(todo)} 題放大再看{'仔細一點' if careful else '一次'}")
                try:
                    async with gate:
                        res = await ai.grade_answers(part, [], closeups={it["id"]: closeups[it["id"]] for it in part}, careful=careful)
                except ai.AIError as e:
                    log.warning("grade closeup exam %s: %s", exam_id, e)
                    continue
                keep(part, [r for r in res if r.get("result") != "unsure" or not out.get(str(r.get("id")))])
    # red pen on the paper (a teacher's ✗, a correction, the answer written in red): wrong, to be redone
    for it in items:
        g = out.get(str(it["id"]))
        if not g:
            continue
        if it["teacher_mark"] in ("wrong", "partial") or g.get("red") == "wrong":
            if g["result"] not in ("wrong", "partial") or (g.get("red") == "wrong" and g["result"] == "partial"):
                g["result"] = "wrong" if it["teacher_mark"] != "partial" else "partial"
                g["comment"] = "紅筆訂正過的題目，再自己做一次看看。" if not g.get("comment") or g["result"] == "wrong" else g["comment"]
            g["red"] = "wrong"
        elif (it["teacher_mark"] == "correct" or g.get("red") == "correct") and g["result"] == "unsure":
            g["result"] = "correct"
        if g["result"] == "unsure":  # no 「?」: what the AI could not decide, a parent decides (請你確認)
            g["result"] = "ask"
    for it in items:  # anything the AI left out: to be looked at
        out.setdefault(str(it["id"]), {"result": "unsure", "read_as": it["student"], "comment": ""})
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    if only is not None:  # one page graded again: the rest of the marks stay
        live = {str(r["id"]) for r in db.q("SELECT id FROM questions WHERE exam_id=?", (exam_id,))}
        out = {k: v for k, v in {**(opts.get("grade") or {}), **out}.items() if k in live}
    n = grade_counts(out)
    db.update("exams", exam_id, {"options": {**opts, "grade": out, "grade_summary": n,
                                             "graded_at": db.now(), "grade_source": "photos" if photos is not None else "scan"}})
    return n


def grade_counts(g: dict) -> dict:
    """How many of each mark (an old 「?」 counts as 請你確認)."""
    n = {k: 0 for k in ("correct", "wrong", "partial", "blank", "ask")}
    for v in g.values():
        r = "ask" if v.get("result") == "unsure" else v.get("result")
        if r in n:
            n[r] += 1
    return n


def _stale(oid: int, new: dict) -> dict:
    """A question read again whose text changed (a misread page read right): its answer and 詳解 were
    for the other text — cleared, to be written again."""
    old = db.one("SELECT stem, options FROM questions WHERE id=?", (oid,))
    norm = lambda t: re.sub(r"\s+|\{([^|{}]*)\|[^{}]*\}", lambda m: m.group(1) or "", t or "")[:60]
    if norm(old["stem"]) == norm(new["stem"]) and _as_list(old["options"]) == _as_list(new["options"]):
        return {}
    return {"answer": "", "solved": 0, "choice_index": 0, "explanation": "", "steps": []}


# what a new photo of a page may change in a question already there (its answer and 詳解 stay)
_PAGE_FIELDS = ("stem", "options", "qtype", "section", "bbox", "crop_path", "figure_path", "seq", "page_id")


async def replace_page_job(job_id: int, exam_id: int, page_id: int):
    """換這一頁: the page read again from its new photo. A question found again (same section and
    number) keeps its id — so her wrong marks, attempts and notes stay — and takes the new photo's
    text and crops; questions no longer on the page go; new ones are added (and solved). A graded
    exam gets this page graded again."""
    exam = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    opts = exam["options"] if isinstance(exam["options"], dict) else json.loads(exam["options"] or "{}")
    page = db.one("SELECT * FROM pages WHERE id=?", (page_id,))
    old = db.q("SELECT id, number, section FROM questions WHERE page_id=? ORDER BY seq", (page_id,))
    graded = bool(opts.get("grade")) or opts.get("mode") == "grade"
    jobs.progress(job_id, 5, f"第 {page['idx'] + 1} 頁：重新辨識")
    # a photo that turns out to be two pages side by side: cut in two first (the right one a new page)
    made = await _prepare_pages(exam_id, [page])
    page = db.one("SELECT * FROM pages WHERE id=?", (page_id,))
    # read like a 批改 page (no per-page solve): new questions are solved below, in the background
    new_ids = await _process_page(job_id, exam, page, {**opts, "mode": "grade"}, lambda m: jobs.progress(job_id, 30, m))
    for rid in made:  # its right page: read too; questions that were on the photo before are matched below
        new_ids += await _process_page(job_id, exam, db.one("SELECT * FROM pages WHERE id=?", (rid,)), {**opts, "mode": "grade"},
                                       lambda m: jobs.progress(job_id, 45, m))
    key = lambda r: (re.sub(r"\s+", "", r["section"] or ""), re.sub(r"\s+", "", str(r["number"] or "")))
    left = {}
    for r in old:
        left.setdefault(key(r), r["id"])
    kept, added = [], []
    owner = exam["student_id"]
    for nid in new_ids:
        n = db.one("SELECT * FROM questions WHERE id=?", (nid,))
        oid = left.pop(key(n), None) if n["number"] else None
        if oid is None:
            added.append(nid)
            continue
        db.update("questions", oid, {k: n[k] for k in _PAGE_FIELDS} | {"updated_at": db.now()} | _stale(oid, n))
        st = db.one("SELECT student_answer, teacher_mark FROM student_q WHERE question_id=? AND student_id=?", (nid, owner))
        if st:
            qstate.set_state(owner, oid, {"student_answer": st["student_answer"], "teacher_mark": st["teacher_mark"]})
        db.execute("DELETE FROM student_q WHERE question_id=?", (nid,))
        db.execute("DELETE FROM questions WHERE id=?", (nid,))
        kept.append(oid)
    # read again with another part name (「選擇題」 / 「二、選出正確的答案」): matched by the number alone
    by_num = {}
    for k, oid in left.items():
        by_num.setdefault(k[1], []).append(k)
    for nid in list(added):
        n = db.one("SELECT * FROM questions WHERE id=?", (nid,))
        num = re.sub(r"\s+", "", str(n["number"] or ""))
        ks = by_num.get(num) or []
        if not num or len(ks) != 1:
            continue
        oid = left.pop(ks[0])
        by_num[num] = []
        db.update("questions", oid, {k: n[k] for k in _PAGE_FIELDS} | {"updated_at": db.now()} | _stale(oid, n))
        st = db.one("SELECT student_answer, teacher_mark FROM student_q WHERE question_id=? AND student_id=?", (nid, owner))
        if st:
            qstate.set_state(owner, oid, {"student_answer": st["student_answer"], "teacher_mark": st["teacher_mark"]})
        db.execute("DELETE FROM student_q WHERE question_id=?", (nid,))
        db.execute("DELETE FROM questions WHERE id=?", (nid,))
        added.remove(nid)
        kept.append(oid)
    for oid in left.values():  # not on the new photo any more
        db.execute("DELETE FROM student_q WHERE question_id=?", (oid,))
        db.execute("DELETE FROM questions WHERE id=?", (oid,))
    db.update("pages", page_id, {"status": "done", "error": ""})
    for rid in made:
        db.update("pages", rid, {"status": "done", "error": ""})
    db.update("exams", exam_id, {"status": "ready"})
    fix_pairs(exam_id)
    link_groups(exam_id)
    grown = merge_continued(exam_id)
    grown += [i for i in await fill_continuations(exam_id) if i not in grown]
    kept = [i for i in kept if db.scalar("SELECT 1 FROM questions WHERE id=?", (i,))] + [i for i in grown if i not in kept]
    added = [i for i in added if db.scalar("SELECT 1 FROM questions WHERE id=?", (i,))]
    if graded:
        jobs.progress(job_id, 60, f"AI 批改第 {page['idx'] + 1} 頁")
        await grade_exam(exam_id, job_id=job_id, only=kept + added)
    redo = added + [i for i in kept if not db.scalar("SELECT solved FROM questions WHERE id=?", (i,))]
    if redo:
        jobs.start("solve_bg", exam_id, solve_then_upgrade_job, exam_id, redo)
    from . import nas
    nas.mark_dirty()
    return {"kept": len(kept), "added": len(added), "removed": len(left), "graded": graded, "split": len(made)}


async def rescan_exam_job(job_id: int, exam_id: int):
    """Every page of an exam scanned again with the current scanner (corners placed by hand kept)."""
    pages = db.q("SELECT id, idx FROM pages WHERE exam_id=? AND orig_path!='' ORDER BY idx", (exam_id,))
    out = {"pages": 0, "kept": 0, "added": 0, "removed": 0}
    for i, p in enumerate(pages):
        jobs.progress(job_id, int(100 * i / max(1, len(pages))), f"用新的前處理重做第 {p['idx'] + 1} 頁（{i + 1}/{len(pages)}）")
        try:
            r = await replace_page_job(job_id, exam_id, p["id"])
        except ai.AIError as err:
            log.warning("rescan exam %s page %s: %s", exam_id, p["id"], err)
            continue
        out["pages"] += 1
        for k in ("kept", "added", "removed"):
            out[k] += r.get(k, 0)
    return out


async def reread_then_grade_job(job_id: int, exam_id: int, page_ids: list[int]):
    """Pages read wrongly read again (a two-page spread now split; the camera's 單頁 guess dropped so
    the fold is looked for), then the whole exam graded again with the current grader."""
    out = {"pages": 0, "kept": 0, "added": 0, "removed": 0}
    for i, pid in enumerate(page_ids):
        page = db.one("SELECT * FROM pages WHERE id=? AND exam_id=?", (pid, exam_id))
        if not page:
            continue
        meta = page["meta"] if isinstance(page["meta"], dict) else json.loads(page["meta"] or "{}")
        meta.pop("spread", None)
        db.update("pages", pid, {"meta": meta, "status": "queued", "error": ""})
        jobs.progress(job_id, int(60 * i / max(1, len(page_ids))), f"重新辨識第 {page['idx'] + 1} 頁（{i + 1}/{len(page_ids)}）")
        try:
            r = await replace_page_job(job_id, exam_id, pid)
        except ai.AIError as e:
            log.warning("reread exam %s page %s: %s", exam_id, pid, e)
            continue
        out["pages"] += 1
        for k in ("kept", "added", "removed"):
            out[k] += r.get(k, 0)
    jobs.progress(job_id, 60, "全部重新批改中")
    out["grade"] = await grade_exam(exam_id, job_id=job_id)
    return out


async def resolve_pages_job(job_id: int, exam_id: int, page_ids: list[int]):
    """The answers on pages that were misread before: cleared, graded again (the grader works them out),
    then written again in the background."""
    ids = [r["id"] for pid in page_ids for r in db.q("SELECT id FROM questions WHERE page_id=?", (pid,))]
    for i in ids:
        db.update("questions", i, {"answer": "", "solved": 0, "choice_index": 0, "explanation": "", "steps": [], "updated_at": db.now()})
    jobs.progress(job_id, 20, f"重新批改 {len(ids)} 題")
    n = await grade_exam(exam_id, job_id=job_id, only=ids)
    jobs.start("solve_bg", exam_id, solve_then_upgrade_job, exam_id, ids)
    return {"questions": len(ids), "grade": n}


async def continuations_job(job_id: int, exam_id: int):
    """Questions running on to the next page put together, graded again (their 詳解 written again)."""
    jobs.progress(job_id, 10, "找跨頁的題目")
    grown = await fill_continuations(exam_id)
    if grown:
        jobs.progress(job_id, 50, f"重新批改跨頁的 {len(grown)} 題")
        e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
        if isinstance(e["options"], dict) and e["options"].get("grade"):
            await grade_exam(exam_id, job_id=job_id, only=grown)
        jobs.start("solve_bg", exam_id, solve_then_upgrade_job, exam_id, grown)
    return {"grown": len(grown)}


async def fix_spread_job(job_id: int, exam_id: int, page_ids: list[int]):
    """A spread already cut in two but turned the wrong way round: pages swapped back, each read again."""
    fix_pairs(exam_id)
    out = {"pages": 0}
    for pid in page_ids:
        r = await replace_page_job(job_id, exam_id, pid)
        out["pages"] += 1
        for k in ("kept", "added", "removed"):
            out[k] = out.get(k, 0) + r.get(k, 0)
    return out


async def solve_then_upgrade_job(job_id: int, exam_id: int, qids: list[int]):
    """After 批改: the answers and 詳解 not written yet, then the usual upgrade — all in the background."""
    todo = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? AND solved=0", (exam_id,))]
    if todo:
        jobs.progress(job_id, 5, f"在背景寫詳解（{len(todo)} 題）")
        try:
            await solve_ids(todo, job_id, 5, 60)
        except ai.AIError as e:
            log.warning("background solve exam %s: %s", exam_id, e)
    return await upgrade_then_visuals_job(job_id, exam_id, qids)


async def resume_grade_job(job_id: int, exam_id: int):
    """A 批改 cut off by a restart (questions already read): grade now, the 詳解 later in the background."""
    db.execute("UPDATE pages SET status='done' WHERE exam_id=? AND status IN ('solving','running')", (exam_id,))
    db.update("exams", exam_id, {"status": "ready"})
    n = await grade_exam(exam_id, job_id=job_id)
    qids = [r["id"] for r in db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (exam_id,))]
    jobs.start("solve_bg", exam_id, solve_then_upgrade_job, exam_id, qids)
    return n


async def grade_job(job_id: int, exam_id: int):
    """批改 an exam already in the bank, with the answers on its own photos."""
    jobs.progress(job_id, 20, "AI 批改中…")
    return await grade_exam(exam_id, job_id=job_id)


async def regrade_photos_job(job_id: int, exam_id: int, files: list[str]):
    """She did the paper again: her new answers are read from the new photos (matched to this exam's
    questions), then checked."""
    imgs = []
    for f in files:
        imgs.append(await asyncio.to_thread(imaging.file_for_ai, media(f), 1600))
    owner = db.scalar("SELECT student_id FROM exams WHERE id=?", (exam_id,))
    qs = qstate.query(owner, "exam_id=?", [exam_id], "ORDER BY seq", everything=True)
    jobs.progress(job_id, 15, "AI 正在看你寫的答案…")
    answers: dict = {}
    for i in range(0, len(qs), 40):
        part = [{"id": q["id"], "number": q["number"], "stem": (q["stem"] or "")[:80]} for q in qs[i:i + 40]]
        try:
            for r in await ai.read_answers(part, imgs):
                if r.get("id") is not None:
                    answers[int(r["id"])] = r.get("answer", "")
        except ai.AIError as e:
            log.warning("read answers exam %s: %s", exam_id, e)
    return await grade_exam(exam_id, answers=answers, photos=imgs, job_id=job_id)


async def detect_layout(exam_id: int) -> dict:
    """直書／橫書、橫放／直放 of the original (from the first pages' photos), kept in the exam's
    options: the Word paper, PDF and print then follow it."""
    pages = db.q("SELECT scan_path FROM pages WHERE exam_id=? AND scan_path!='' ORDER BY idx LIMIT 3", (exam_id,))
    imgs = []
    for p in pages[:3]:
        f = media(p["scan_path"])
        if f.exists():
            imgs.append(await asyncio.to_thread(imaging.file_for_ai, f, 1400))
    if not imgs:
        return {}
    # a cover page tells nothing: look at the first page or two of questions
    use = imgs[1:3] if len(imgs) > 1 else imgs
    try:
        lay = await ai.detect_layout(use)
    except ai.AIError as e:
        log.warning("layout of exam %s: %s", exam_id, e)
        return {}
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    db.update("exams", exam_id, {"options": {**opts, "layout": lay}})
    return lay


async def detect_school(exam_id: int) -> bool | None:
    """學校考卷: a header with 班級、姓名、座號 on the first page. A parent's own choice is never overwritten."""
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    if opts.get("school_set"):
        return opts.get("school")
    p = db.one("SELECT scan_path FROM pages WHERE exam_id=? AND scan_path!='' ORDER BY idx LIMIT 1", (exam_id,))
    if not p or not media(p["scan_path"]).exists():
        return None
    try:
        r = await ai.school_header(await asyncio.to_thread(imaging.file_for_ai, media(p["scan_path"]), 1400))
    except ai.AIError as err:
        log.warning("school header of exam %s: %s", exam_id, err)
        return None
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))  # read again: the scan went on meanwhile
    opts = e["options"] if isinstance(e["options"], dict) else {}
    if opts.get("school_set"):
        return opts.get("school")
    db.update("exams", exam_id, {"options": {**opts, "school": bool(r.get("school")), "school_why": str(r.get("evidence") or "")[:80],
                                             "school_term": str(r.get("term") or "")[:60]}})
    return bool(r.get("school"))


# --- 題組: 「2-(1) … 2-(4)」「3-① … 3-⑤」 share the first part's text (an option list A~F, a table, a
# picture). Each later part keeps a copy of it (`lead`), shown above its own question and given to the AI.
_FIRST_PART = re.compile(r"[（(]\s*[1１一]\s*[）)]|①|(?<![\d.])1[.．、](?!\d)")


def _lead_text(stem: str) -> str:
    """The shared part of a group's first question: everything before its own 「(1)」."""
    lines = (stem or "").split("\n")
    for i, ln in enumerate(lines[1:], 1):
        if _FIRST_PART.match(re.sub(r"^[\s（(　）)]*(?=[（(①1])", "", ln.strip())) or \
                re.match(r"^[（(][\s　]*[）)]\s*[①(（1ㄅ]", ln.strip()):
            return "\n".join(lines[:i]).strip()
    m = _FIRST_PART.search(stem or "")
    if m and m.start() >= 8:
        return stem[:m.start()].rstrip("（( 　")
    return (stem or "").strip()


def _svg_repeats(svg: str, text: str) -> bool:
    """The drawing is only the option list the text already has (A.… B.… in boxes)."""
    flat = re.sub(r"\s", "", text or "")
    bits = [re.sub(r"\s", "", b) for b in re.findall(r">([^<>]+)<", svg or "")]
    bits = [b for b in bits if len(b) >= 2]
    return bool(bits) and sum(b in flat for b in bits) >= 0.8 * len(bits)


def link_groups(exam_id: int) -> int:
    rows = db.q("SELECT id, seq, number, section, stem, figure_kind, figure_svg, figure_table, figure_path, lead "
                "FROM questions WHERE exam_id=? ORDER BY seq, id", (exam_id,))
    groups: dict = {}
    for r in rows:
        num = str(r["number"] or "")
        if "-" not in num:
            continue
        groups.setdefault((r["section"] or "", num.split("-")[0].strip()), []).append(r)
    n = 0
    for parts in groups.values():
        first = parts[0]
        text = _lead_text(first["stem"])
        has_table = bool(first["figure_table"] and (first["figure_table"] or {}).get("rows"))
        for r in parts[1:]:
            own_fig = bool(r["figure_svg"] or (r["figure_table"] and (r["figure_table"] or {}).get("rows")) or
                           (r["figure_kind"] == "image" and r["figure_path"]))
            lead = {"stem": text if text and re.sub(r"\s", "", text)[:12] not in re.sub(r"\s", "", r["stem"] or "") else ""}
            if not own_fig:
                if has_table:
                    lead["figure_table"] = first["figure_table"]
                elif first["figure_svg"] and not _svg_repeats(first["figure_svg"], text):
                    lead["figure_svg"] = first["figure_svg"]
                elif first["figure_kind"] == "image" and first["figure_path"]:
                    lead["figure_path"] = first["figure_path"]
            lead = lead if any(lead.values()) else {}
            if (r["lead"] or {}) != lead:
                db.update("questions", r["id"], {"lead": lead or ""})
                n += 1
    return n


async def redraw_figures_job(job_id: int):
    """Once: every figure still kept as a photo is drawn again (SVG or table), then those exams' Word
    papers are made again — the 電子試卷 never uses the original photo."""
    rows = db.q("SELECT id, exam_id FROM questions WHERE COALESCE(figure_path,'')!='' "
                "AND COALESCE(figure_kind,'') IN ('', 'none') AND COALESCE(figure_svg,'')='' "
                "AND COALESCE(figure_table,'') IN ('', '[]', '{}') ORDER BY exam_id, seq")
    done = 0
    for i, r in enumerate(rows):
        jobs.progress(job_id, int(90 * i / max(1, len(rows))), f"重畫圖形 {i + 1}/{len(rows)}")
        try:
            await upgrade_question(r["id"])
            done += 1
        except ai.AIError as err:
            log.warning("redraw q%s: %s", r["id"], err)
    exams = sorted({r["exam_id"] for r in rows if r["exam_id"]})
    if exams:
        jobs.progress(job_id, 92, "重新產生電子試卷")
        await regenerate_job(job_id, exams)
    return {"figures": done, "exams": len(exams)}


async def school_all_job(job_id: int):
    """Once: every exam photographed before 學校考卷 existed is looked at (first page only)."""
    ids = [r["id"] for r in db.q("SELECT id FROM exams WHERE status='ready' AND json_extract(options, '$.school') IS NULL ORDER BY id")]
    found = 0
    for i, eid in enumerate(ids):
        jobs.progress(job_id, int(100 * i / max(1, len(ids))), f"看是不是學校考卷 {i + 1}/{len(ids)}")
        found += bool(await detect_school(eid))
    return {"exams": len(ids), "school": found}


async def refresh_all_job(job_id: int, resume: bool = False):
    """全部跑一遍: every exam's layout read from its photos, every question proofread against its
    photo again (國語 first), then every Word paper / answer key / NAS folder made again in the
    original's layout."""
    ids = [r["id"] for r in db.q("SELECT id FROM exams WHERE status='ready' ORDER BY id")]
    if not resume:  # (resume: cut off by a restart — carry on with the questions not done yet)
        for i, eid in enumerate(ids):
            jobs.progress(job_id, int(5 * i / max(1, len(ids))), f"看原稿的排版 {i + 1}/{len(ids)}")
            await detect_layout(eid)
        db.execute("UPDATE questions SET upgraded_at='' WHERE exam_id IN (SELECT id FROM exams WHERE status='ready')")
    zh = [r["id"] for r in db.q("SELECT id FROM exams WHERE status='ready' AND subject='國語' ORDER BY id DESC")]
    for eid in reversed(zh):  # 國語 exams at the front of the queue (oldest first among them)
        prioritize(eid)
    ensure_pool()
    total = db.scalar("SELECT COUNT(*) FROM questions WHERE exam_id IN (SELECT id FROM exams WHERE status='ready')") or 1
    while True:
        left = sum(_exam_left(e) for e in ids)
        if not left:
            break
        jobs.progress(job_id, 5 + int(80 * (total - left) / total), f"AI 對照原稿重新校對 {total - left}/{total} 題（國語先）")
        await asyncio.sleep(10)
        ensure_pool()
    jobs.progress(job_id, 86, "依原稿排版重新產生 Word、解答與 NAS")
    return await regenerate_job(job_id, ids)


async def layout_all_job(job_id: int):
    """Once: the layout of every exam photographed before this existed, then every Word paper and
    answer key made again in it (依範本重新產生)."""
    ids = [r["id"] for r in db.q("SELECT id FROM exams WHERE status='ready' ORDER BY id")]
    for i, eid in enumerate(ids):
        jobs.progress(job_id, int(80 * i / max(1, len(ids))), f"看原稿的排版 {i + 1}/{len(ids)}")
        await detect_layout(eid)
    jobs.progress(job_id, 85, "依原稿排版重新產生 Word 與解答")
    return await regenerate_job(job_id, ids)


async def chapters_job(job_id: int):
    """自然 章節: every question not yet placed in the review book gets its 主題 (30 at a time)."""
    from . import curriculum
    done = 0
    for subject in curriculum.CHAPTER_SUBJECTS:
        todo = db.q("SELECT id, unit, stem FROM questions WHERE subject=? AND COALESCE(chapter,'')='' ORDER BY id", (subject,))
        for i in range(0, len(todo), 30):
            jobs.progress(job_id, int(100 * i / max(1, len(todo))), f"{subject}章節 {i}/{len(todo)}")
            try:
                got = await ai.chapters(subject, todo[i:i + 30])
            except ai.AIError as err:
                log.warning("chapters: %s", err)
                return {"done": done, "error": str(err)}
            with db.conn() as c:
                for qid, ch in got.items():
                    c.execute("UPDATE questions SET chapter=? WHERE id=? AND subject=?", (ch, qid, subject))
            done += len(got)
    return {"done": done}


async def _classify(exam_id: int):
    """AI 自動判斷 against the parent's own types (only when no keyword already says which)."""
    from . import templates
    types = templates._types()
    if not types:
        return
    e = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    if opts.get("template") not in (None, "", "auto") or any(any(k and k in (e["title"] or "") for k in t.get("keywords", [])) for t in types):
        return
    head = " ".join(q["stem"][:60] for q in db.q("SELECT stem FROM questions WHERE exam_id=? ORDER BY seq LIMIT 2", (exam_id,)))
    try:
        kind = await ai.classify_exam(e["title"] or "", head, types)
    except ai.AIError as err:
        log.warning("classify exam %s: %s", exam_id, err)
        return
    if kind:
        db.update("exams", exam_id, {"options": {**opts, "kind_ai": kind}})



def merge_empty(exam_id: int) -> int | None:
    """「完成」 pressed after only the cover page: that part has no questions. When the same
    child's next exam was sent within 15 minutes, the empty one's pages (and its usually fuller
    title) join it, and the empty exam goes away. Returns the exam it joined."""
    e = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    if not e or db.scalar("SELECT COUNT(*) FROM questions WHERE exam_id=?", (exam_id,)):
        return None
    nxt = db.one("SELECT * FROM exams WHERE student_id=? AND id>? AND datetime(created_at)<=datetime(?, '+15 minutes') ORDER BY id LIMIT 1",
                 (e["student_id"], exam_id, e["created_at"]))
    if not nxt:
        return None
    first = db.scalar("SELECT MIN(idx) FROM pages WHERE exam_id=?", (nxt["id"],)) or 0
    for i, pg in enumerate(db.q("SELECT id FROM pages WHERE exam_id=? ORDER BY idx", (exam_id,))):
        db.update("pages", pg["id"], {"exam_id": nxt["id"], "idx": first - 100 + i})
    if len(e["title"] or "") > len(nxt["title"] or "") and e["title"] != "未命名試卷":
        db.update("exams", nxt["id"], {"title": e["title"]})
    db.execute("DELETE FROM exams WHERE id=?", (exam_id,))
    log.info("empty exam %s joined exam %s", exam_id, nxt["id"])
    return nxt["id"]


# --- 題目升級: every scanned question made 出題軟體 quality (in the background) ------------------------

def _png(img) -> bytes:
    import cv2
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes() if ok else b""


def _question_images(q: dict):
    """(the question region enlarged from the page scan, the figure enhanced) as images."""
    pg = db.one("SELECT scan_path FROM pages WHERE id=?", (q.get("page_id"),)) if q.get("page_id") else None
    region = None
    if pg and q.get("bbox"):
        box = json.loads(q["bbox"]) if isinstance(q["bbox"], str) else q["bbox"]
        src = pg["scan_path"]
        if src and media(src).exists():
            region = imaging.upscale_crop(imaging.load(media(src)), box)
    fig = imaging.load(media(q["figure_path"])) if q.get("figure_path") and media(q["figure_path"]).exists() else None
    if region is None and q.get("crop_path") and media(q["crop_path"]).exists():
        region = imaging.load(media(q["crop_path"]))
    return region, fig


def keep_picture(q: dict, fig=None) -> str:
    """The question's own figure as the picture shown (figure_kind 'image'): its answer boxes emptied,
    saved next to the original. '' when there is no figure photo to keep."""
    if fig is None:
        src = q.get("figure_path") or ""
        if not src or not media(src).exists():
            return ""
        fig = imaging.load(media(src))
    clean, _ = imaging.blank_answer_boxes(fig)
    rel = f"exam_{q.get('exam_id') or 0}/q{q['id']}_pic.jpg"
    media(rel).parent.mkdir(parents=True, exist_ok=True)
    imaging.save(clean, media(rel), quality=92)
    return rel


async def _redraw_ok(svg: str, original: bytes, stem: str) -> tuple[bool, list]:
    png = await vischeck.render({"type": "custom_svg", "title": "", "caption": "", "params_json": json.dumps({"svg": svg})})
    if png is None:
        return True, []          # renderer down: trust the drawing, it is checked again later
    if not png:
        return False, ["SVG 畫不出來（格式錯誤）"]
    v = await ai.check_figure(original, png, stem)
    return bool(v.get("same")), v.get("problems") or []


async def upgrade_question(qid: int, hint: list | None = None) -> dict:
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        return {}
    region, fig = await asyncio.to_thread(_question_images, q)
    if region is None:
        db.update("questions", qid, {"upgraded_at": "skipped " + db.now()})  # nothing to compare with: not taken again
        return {"skipped": "沒有原稿影像"}
    fig_png = _png(fig) if fig is not None else None
    ex = db.one("SELECT options FROM exams WHERE id=?", (q["exam_id"],)) if q.get("exam_id") else None
    lay = ((ex["options"] if ex and isinstance(ex["options"], dict) else {}).get("layout") or {})
    res = await ai.upgrade_question(q, _png(region), fig_png, lay.get("zhuyin") if "zhuyin" in lay else None, hint)
    # the AI sometimes writes "\n" as text — but never touch a LaTeX command (\neq, \ne, \not…)
    unesc = lambda x: re.sub(r"\\n(?![A-Za-z])", "\n", x) if isinstance(x, str) else x
    for k in ("stem", "explanation", "figure_facts", "answer"):
        res[k] = unesc(res.get(k) or "")
    res["options"] = [unesc(o) for o in res.get("options") or []]
    res["steps"] = [unesc(o) for o in res.get("steps") or []]
    upd = {"upgraded_at": db.now(), "updated_at": db.now()}
    for k in ("stem", "answer", "explanation", "figure_facts"):
        if res.get(k):
            upd[k] = res[k]
    if res.get("options") is not None and (q.get("options") or res["options"]):
        upd["options"] = res["options"]
    if res.get("steps"):
        upd["steps"] = res["steps"]
    upd["choice_index"] = int(res.get("choice_index") or 0)
    upd["option_notes"] = res.get("option_notes") or []
    # every figure is drawn again (the paper is made anew, the photo is never used): a table, or an SVG
    # checked against the original; a photo or realistic picture becomes a simple line drawing
    kind = res.get("figure_kind") or ("svg" if q.get("figure_path") else "none")
    if kind == "none" and q.get("figure_path"):
        kind = "svg"
    if kind == "image":
        # 情境插圖 (people, scenes, cartoons): a line drawing loses what the question asks about —
        # the original picture is kept, with what was written in its answer boxes taken out
        rel = keep_picture(q, fig)
        if rel:
            upd.update({"figure_path": rel, "figure_svg": ""})
        else:
            kind = "svg"
    upd["figure_pos"] = res.get("figure_position") or "below"
    if kind == "table" and (res.get("table") or {}).get("rows"):
        upd["figure_table"] = res["table"]
    elif kind == "svg":
        original = fig_png or _png(region)
        stem_for_check = (upd.get("stem") or q["stem"]) + (f"\n【家長說明，以此為準（原稿被塗改或看不清楚時照這個判斷）】{q['fix_note']}" if q.get("fix_note") else "")
        svg = res.get("svg") or ""
        if not svg:
            svg = await ai.fix_figure(original, "", ["還沒有畫：請把原稿的圖畫成簡化線條 SVG（保留解題需要的部分、標籤、文字）"], stem_for_check)
        ok, problems = False, []
        for attempt in range(3):
            ok, problems = await _redraw_ok(svg, original, stem_for_check)
            if ok or attempt == 2:
                break
            svg = await ai.fix_figure(original, svg, problems, stem_for_check)
        if svg:
            upd["figure_svg"] = svg
            if not ok:  # the closest drawing it could make: kept, and the parent is told what may differ
                res["figure_unsure"] = (res.get("figure_unsure") or "") + ("；" if res.get("figure_unsure") else "") + \
                    "重畫的圖可能和原稿不完全一樣：" + "；".join(problems[:2])
                log.info("q%s figure kept as best SVG: %s", qid, problems[:2])
        else:
            kind = "none"
    upd["figure_kind"] = kind
    if res.get("figure_unsure"):
        upd["figure_unsure"] = res["figure_unsure"]  # shown on the question: 「AI 看圖不太確定」
    db.update("questions", qid, upd)
    if q.get("exam_id"):
        link_groups(q["exam_id"])  # a 題組's shared part may have just been proofread
    return {"kind": kind, "fixed": res.get("fixed", "")}


def _upgrading() -> bool:
    return bool(db.scalar("SELECT 1 FROM jobs WHERE kind='upgrade_all' AND status IN ('queued','running')"))


async def _wait_for_upgrade():
    """Teaching diagrams wait while questions are being upgraded: the AI's capacity goes to the
    upgrade first, and the diagrams are then drawn from the proofread questions."""
    while _upgrading():
        await asyncio.sleep(30)


def _scanning() -> bool:
    return bool(db.scalar("SELECT 1 FROM jobs WHERE kind='exam' AND status IN ('queued','running')"))


_in_progress: set[int] = set()  # questions some session is upgrading right now


def _priority() -> list[int]:
    return [int(x) for x in (db.get_setting("upgrade_priority") or [])]


def prioritize(exam_id: int):
    """優先升級: this exam's questions are taken next (also while the upgrade is running)."""
    db.set_setting("upgrade_priority", [exam_id] + [x for x in _priority() if x != exam_id])


def _next_question() -> int | None:
    """The next question to upgrade: prioritized exams first (in the order they were asked for),
    then the newest exams, in question order."""
    pri = _priority()
    order = " ".join(f"WHEN {int(e)} THEN {i}" for i, e in enumerate(pri))
    case = f"CASE q.exam_id {order} ELSE 9999 END" if pri else "q.exam_id * 0"  # (a bare number would mean "column N")
    skip = ",".join(str(i) for i in _in_progress) or "0"
    r = db.one(f"SELECT q.id FROM questions q JOIN exams e ON e.id=q.exam_id WHERE e.status='ready' "
               f"AND (q.upgraded_at='' OR q.upgraded_at IS NULL) AND q.id NOT IN ({skip}) "
               f"ORDER BY {case}, q.exam_id DESC, q.seq LIMIT 1")
    return r["id"] if r else None


def _exam_left(exam_id: int) -> int:
    return db.scalar("SELECT COUNT(*) FROM questions WHERE exam_id=? AND (upgraded_at='' OR upgraded_at IS NULL)", (exam_id,)) or 0


def upgrade_parallel() -> int:
    return max(1, min(12, int(db.get_setting("upgrade_parallel") or 8)))


async def upgrade_all_job(job_id: int, force: bool = False):
    """題目升級 with parallel sessions: N workers each take the highest-priority question still to
    do, so a priority set meanwhile applies at once and one slow exam does not hold the rest up.
    Whenever an exam is being scanned the workers wait (the new scan goes first). When an exam's
    last question is done its Word / PDF / NAS folder is made again."""
    from . import nas
    if force:
        db.execute("UPDATE questions SET upgraded_at='' WHERE exam_id IN (SELECT id FROM exams)")
    total = db.scalar("SELECT COUNT(*) FROM questions q JOIN exams e ON e.id=q.exam_id WHERE e.status='ready' "
                      "AND (q.upgraded_at='' OR q.upgraded_at IS NULL)") or 0
    done = {"n": 0}

    async def worker():
        while True:
            while _scanning():
                jobs.progress(job_id, int(100 * done["n"] / max(1, total)), "有考卷正在掃描，先讓它處理…")
                await asyncio.sleep(15)
            qid = _next_question()
            if qid is None:
                return
            _in_progress.add(qid)
            eid = db.scalar("SELECT exam_id FROM questions WHERE id=?", (qid,))
            try:
                await upgrade_question(qid)
            except Exception as e:  # one hard question must not stop the rest
                log.warning("upgrade q%s failed: %s", qid, e)
                db.update("questions", qid, {"upgraded_at": "failed " + db.now()})  # not taken again in this run
            finally:
                _in_progress.discard(qid)
            done["n"] += 1
            if eid and not _exam_left(eid):
                nas.forget_exam(eid)
                nas.mark_dirty()
                db.set_setting("upgrade_priority", [x for x in _priority() if x != eid])
            title = db.scalar("SELECT title FROM exams WHERE id=?", (eid,)) or ""
            jobs.progress(job_id, int(100 * done["n"] / max(1, total)),
                          f"已升級 {done['n']}/{total} 題（{upgrade_parallel()} 個同時）・正在做「{title[:16]}」")

    await asyncio.gather(*(worker() for _ in range(upgrade_parallel())))
    return {"questions": done["n"]}


def ensure_pool():
    if not _upgrading_pool():
        jobs.start("upgrade_all", 0, upgrade_all_job, False)


async def upgrade_exam(job_id: int | None, exam_id: int, force: bool = False) -> int:
    """One exam (right after it was scanned, or 「AI 重新校對」): it goes to the front of the
    queue and the shared pool of parallel sessions does it; this waits until it is done."""
    if force:
        db.execute("UPDATE questions SET upgraded_at='' WHERE exam_id=?", (exam_id,))
    prioritize(exam_id)
    ensure_pool()
    n = db.scalar("SELECT COUNT(*) FROM questions WHERE exam_id=?", (exam_id,)) or 0
    while _exam_left(exam_id):
        if job_id:
            jobs.progress(job_id, int(100 * (n - _exam_left(exam_id)) / max(1, n)), f"升級題目 {n - _exam_left(exam_id)}/{n}")
        await asyncio.sleep(5)
        ensure_pool()
    return n


async def upgrade_then_visuals_job(job_id: int, exam_id: int, qids: list[int]):
    n = await upgrade_exam(job_id, exam_id)
    await zhuyin_after_upgrade(exam_id)
    jobs.start("visuals", exam_id, visuals_job, qids)
    return {"questions": n}


async def upgrade_exam_job(job_id: int, exam_id: int):
    return {"questions": await upgrade_exam(job_id, exam_id)}


# --- 補注音 --------------------------------------------------------------------------------------
# A 低年級 paper prints 注音 beside every character (ai.detect_layout keeps that on the exam). The AI
# that read it, or upgraded it, does not always write the marks; this pass adds them from the text
# alone — the sentence tells how a character is read — so the Word / PDF look like the original.
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_ZY_MARK = re.compile(r"\{([^{}|]+)\|[^{}]+\}")


def zhuyin_missing(text) -> int:
    """How many Chinese characters of a text are not inside a {字|注音} mark (math left out)."""
    bare = _ZY_MARK.sub("", str(text or ""))
    bare = re.sub(r"\$[^$]*\$", "", bare)
    return len(_CJK.findall(bare))


def _bare(text) -> str:
    """The characters of a text without its 注音 marks and spaces: what must not change when marks are added."""
    return re.sub(r"\s+", "", _ZY_MARK.sub(r"\1", str(text or "")))


def _zhuyin_flag(exam_id: int):
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if e and isinstance(e["options"], dict) else {}
    return (opts.get("layout") or {}).get("zhuyin")


ZHUYIN_BATCH = 8


async def zhuyin_job(job_id: int | None, exam_id: int) -> dict:
    """補注音 for one exam: every question whose stem or options still have bare characters."""
    if not _zhuyin_flag(exam_id):
        return {"skipped": "這份考卷沒有標記為有注音", "done": 0, "failed": 0, "total": 0}
    qs = [{**q, "options": _as_list(q.get("options"))} for q in db.q("SELECT id, stem, options FROM questions WHERE exam_id=? ORDER BY seq, id", (exam_id,))]
    qs = [q for q in qs if zhuyin_missing(q["stem"]) or any(zhuyin_missing(o) for o in q["options"])]
    n, done, failed = len(qs), 0, 0
    sem = asyncio.Semaphore(3)

    async def batch(group: list[dict]):
        nonlocal done, failed
        async with sem:
            try:
                res = await ai.add_zhuyin([{"index": i, "stem": q["stem"], "options": q["options"]} for i, q in enumerate(group)])
            except ai.AIError as err:
                log.warning("zhuyin exam %s: %s", exam_id, err)
                failed += len(group)
                return
            by = {}
            for r in res:
                try:
                    by[int(r.get("index"))] = r
                except (TypeError, ValueError):
                    pass
            for i, q in enumerate(group):
                r = by.get(i) or {}
                opts = [str(o) for o in (r.get("options") or [])]
                # nothing but marks may change: the same characters, the same options in the same order
                ok = (r.get("stem") and _bare(r["stem"]) == _bare(q["stem"]) and len(opts) == len(q["options"])
                      and all(_bare(a) == _bare(b) for a, b in zip(opts, q["options"])))
                if not ok:
                    failed += 1
                    continue
                upd = {"stem": r["stem"], "updated_at": db.now()}
                if q["options"]:
                    upd["options"] = opts
                db.update("questions", q["id"], upd)
                done += 1
            if job_id:
                jobs.progress(job_id, int(100 * (done + failed) / max(1, n)), f"補注音 {done + failed}/{n} 題")

    await asyncio.gather(*(batch(qs[i:i + ZHUYIN_BATCH]) for i in range(0, n, ZHUYIN_BATCH)))
    if done:
        from . import nas
        nas.mark_dirty()
    return {"done": done, "failed": failed, "total": n}


async def zhuyin_after_upgrade(exam_id: int):
    """After the upgrade of a 注音 paper: whatever the proofreading left bare gets its marks."""
    if _zhuyin_flag(exam_id):
        try:
            await zhuyin_job(None, exam_id)
        except Exception as err:  # noqa: BLE001 — a background nicety must never stop the rest
            log.warning("zhuyin after upgrade %s: %s", exam_id, err)


# --- 與原卷一致 ------------------------------------------------------------------------------------
# Every page of a scanned exam is made again as the paper the family prints (print.html → PDF → PNG)
# and laid beside the photo of that page; the AI says, question by question, whether the printed
# content is the same (text, numbers, options, 注音, figure / table). A question that is not is
# upgraded again with what was found, and its page looked at once more; what still differs is kept on
# the exam (options.fidelity) for the parent.
FIDELITY_PARALLEL = 2


async def _page_regenerated(exam: dict, page: dict, ids: list[int]) -> list[bytes]:
    from . import exporters, templates
    opts = exam["options"] if isinstance(exam["options"], dict) else {}
    tok = exporters.make_spec(f"{exam['title']}（第 {page['idx'] + 1} 頁）", ids,
                              {"template": opts.get("template") or "auto", "keep_original": True, "header": False,
                               "answers": "none", "explanations": False}, exam["id"])
    pdf = await exporters.pdf(tok)
    pngs = await templates.pdf_pages(pdf, 110)
    out = [await asyncio.to_thread(imaging.file_for_ai, p, 1600) for p in pngs[:3]]
    for p in pngs:
        p.unlink(missing_ok=True)
    pdf.unlink(missing_ok=True)
    return out


async def _check_page(exam: dict, page: dict, qs: list[dict]) -> dict:
    """{question id: problems} for the questions of a page that differ from the photo."""
    regen = await _page_regenerated(exam, page, [q["id"] for q in qs])
    if not regen:
        return {}
    original = await asyncio.to_thread(imaging.file_for_ai, media(page["scan_path"]), 2000)
    items = [{"index": i, "number": q.get("number") or i + 1,
              "text": re.sub(r"\{([^{}|]+)\|[^{}]+\}", r"\1", q.get("stem") or "")[:40].replace("\n", " ")} for i, q in enumerate(qs)]
    res = await ai.check_page_fidelity(original, regen, items)
    bad = {}
    for r in res:
        try:
            i = int(r.get("index"))
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(qs) and r.get("ok") is False:
            bad[qs[i]["id"]] = {"problems": [str(x) for x in (r.get("problems") or [])][:6] or ["和原稿不一致"],
                                "figure": bool(r.get("figure_bad"))}
    return bad


async def fidelity_exam(job_id: int | None, exam_id: int, redo: bool = True, report=None) -> dict:
    exam = db.one("SELECT * FROM exams WHERE id=?", (exam_id,))
    if not exam:
        return {}
    pages = db.q("SELECT * FROM pages WHERE exam_id=? AND scan_path!='' ORDER BY idx", (exam_id,))
    byp = {}
    for q in db.q("SELECT * FROM questions WHERE exam_id=? AND source='scan' ORDER BY seq, id", (exam_id,)):
        q["options"] = _as_list(q.get("options"))
        byp.setdefault(q["page_id"], []).append(q)
    pages = [p for p in pages if byp.get(p["id"]) and media(p["scan_path"]).exists()]
    sem = asyncio.Semaphore(FIDELITY_PARALLEL)
    found, seen, errors = {}, 0, []

    async def look(p, only=None):
        nonlocal seen
        async with sem:
            try:
                bad = await _check_page(exam, p, byp[p["id"]])  # the whole page; afterwards only the redone ones count
            except (ai.AIError, RuntimeError) as err:
                errors.append(f"第 {p['idx'] + 1} 頁：{err}")
                return {}
            seen += 1
            if report:
                report(seen)
            return {k: v for k, v in bad.items() if only is None or k in only}

    for d in await asyncio.gather(*(look(p) for p in pages)):
        found.update(d)
    first = dict(found)
    fixed, pictured, still = [], [], dict(found)
    rsem = asyncio.Semaphore(3)

    async def again(qid, pr):
        async with rsem:
            try:
                await upgrade_question(qid, pr["problems"])
            except ai.AIError as err:
                log.warning("fidelity redo q%s: %s", qid, err)

    def refresh(ids):
        for q in db.q(f"SELECT * FROM questions WHERE id IN ({','.join('?' * len(ids))})", tuple(ids)):
            q["options"] = _as_list(q.get("options"))
            byp[q["page_id"]] = [q if x["id"] == q["id"] else x for x in byp[q["page_id"]]]

    for rnd in range(2 if redo else 0):
        if not still:
            break
        todo = dict(still)
        if rnd == 1:
            # the second time a figure is still not the same, the original picture is used instead (its
            # answer boxes emptied): the paper then shows exactly what was printed
            for qid, pr in list(todo.items()):
                q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
                if pr["figure"] and q and q.get("figure_path") and media(q["figure_path"]).exists():
                    rel = await asyncio.to_thread(keep_picture, q)
                    if rel:
                        db.update("questions", qid, {"figure_path": rel, "figure_svg": "", "figure_table": None,
                                                     "figure_kind": "image", "updated_at": db.now()})
                        pictured.append(qid)
                        todo.pop(qid)  # not upgraded again (that would draw an SVG over the picture); looked at once more below
        await asyncio.gather(*(again(qid, pr) for qid, pr in todo.items()))
        refresh(list(still))
        redo_pages = [p for p in pages if any(q["id"] in still for q in byp[p["id"]])]
        after = {}
        for d in await asyncio.gather(*(look(p, set(still)) for p in redo_pages)):
            after.update(d)
        fixed += [qid for qid in still if qid not in after]
        still = after
    num = {q["id"]: q.get("number") or "" for qs in byp.values() for q in qs}
    summary = {"checked_at": db.now(), "pages": len(pages), "questions": sum(len(byp[p["id"]]) for p in pages),
               "found": len(first), "fixed": len(fixed), "pictured": len(pictured), "errors": errors[:5],
               "still": [{"id": qid, "number": num.get(qid, ""), "problems": pr["problems"]} for qid, pr in still.items()]}
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if isinstance(e["options"], dict) else {}
    db.update("exams", exam_id, {"options": {**opts, "fidelity": summary}})
    for qid, pr in still.items():  # shown on the question as 「AI 看圖不太確定」 for the parent to check
        db.update("questions", qid, {"figure_unsure": "和原卷比對仍不一致：" + "；".join(pr["problems"][:2])})
    if fixed:
        from . import nas
        nas.mark_dirty()
    return summary


async def fidelity_exam_job(job_id: int, exam_id: int):
    n = db.scalar("SELECT COUNT(DISTINCT page_id) FROM questions WHERE exam_id=? AND source='scan'", (exam_id,)) or 1
    return await fidelity_exam(job_id, exam_id, True,
                               lambda seen: jobs.progress(job_id, min(95, int(90 * seen / n)), f"和原卷比對 {seen}/{n} 頁"))


async def fidelity_all_job(job_id: int):
    """Every exam (newest first), one after the other."""
    ids = [r["id"] for r in db.q("SELECT id FROM exams WHERE status='ready' ORDER BY id DESC")]
    total = {"exams": 0, "pages": 0, "questions": 0, "found": 0, "fixed": 0, "pictured": 0, "still": 0, "errors": 0}
    for k, eid in enumerate(ids):
        title = db.scalar("SELECT title FROM exams WHERE id=?", (eid,)) or ""
        jobs.progress(job_id, int(100 * k / max(1, len(ids))), f"第 {k + 1}/{len(ids)} 份：{title[:20]}")
        try:
            s = await fidelity_exam(None, eid, True,
                                    lambda seen, k=k, title=title: jobs.progress(job_id, int(100 * k / max(1, len(ids))),
                                                                                f"第 {k + 1}/{len(ids)} 份：{title[:20]}（{seen} 頁）"))
        except Exception as err:  # noqa: BLE001 — one exam must not stop the rest
            log.warning("fidelity exam %s: %s", eid, err)
            total["errors"] += 1
            continue
        total["exams"] += 1
        for key in ("pages", "questions", "found", "fixed", "pictured"):
            total[key] += s.get(key, 0)
        total["still"] += len(s.get("still", []))
        total["errors"] += len(s.get("errors", []))
    return total


def _upgrading_pool() -> bool:
    return bool(db.scalar("SELECT 1 FROM jobs WHERE kind='upgrade_all' AND status IN ('queued','running')"))



VERIFY_BATCH = 4      # questions (each with its photo) in one 複查 call
VERIFY_PARALLEL = 3


async def verify_job(job_id: int, exam_id: int):
    """答案複查 (before a paper is printed): every question is solved again from its own photo by a
    second look that does not trust the answer it has. Where the two differ the answer and 詳解 are
    replaced, the change is kept on the exam (options.verify) for the parent to see, and a 批改 mark
    that was built on the old answer becomes 請你確認."""
    from . import nas
    qs = db.q("SELECT * FROM questions WHERE exam_id=? ORDER BY seq, id", (exam_id,))
    n = len(qs)
    done = {"seen": 0, "checked": 0, "error": ""}
    changed: list = []
    sem = asyncio.Semaphore(VERIFY_PARALLEL)

    async def batch(group: list[dict]):
        items, images = [], []
        for i, q in enumerate(group):
            region, _ = await asyncio.to_thread(_question_images, q)
            if region is None:  # no photo to check against: left as it is
                continue
            items.append({"index": i, **{k: q.get(k) for k in ("qtype", "stem", "options", "answer", "explanation",
                                                                 "steps", "section", "lead", "fix_note")}})
            images.append(_png(region))
        res = []
        if items:
            async with sem:
                try:
                    res = await ai.verify_answers(items, images)
                except Exception as e:  # one hard batch must not stop the rest
                    log.warning("verify batch failed: %s", e)
                    done["error"] = str(e)
        for r in res:
            try:
                q = group[int(r.get("index"))]
            except (TypeError, ValueError, IndexError):
                continue
            done["checked"] += 1
            if r.get("ok") or not r.get("answer"):
                continue
            upd = {"answer": r["answer"], "choice_index": int(r.get("choice_index") or 0), "updated_at": db.now()}
            if r.get("explanation"):
                upd["explanation"] = r["explanation"]
            if r.get("steps"):
                upd["steps"] = r["steps"]
            db.update("questions", q["id"], upd)
            # explanations and diagrams built on the old answer would repeat its mistake
            db.execute("DELETE FROM explanations WHERE question_id=? AND kind IN ('reteach','hint','example','diag','coach')", (q["id"],))
            db.execute("UPDATE questions SET visuals='', concept='' WHERE id=?", (q["id"],))
            changed.append({"id": q["id"], "number": q.get("number") or "", "old": q.get("answer") or "",
                            "new": r["answer"], "why": r.get("why") or ""})
        done["seen"] += len(group)
        jobs.progress(job_id, int(100 * done["seen"] / max(1, n)), f"複查答案 {done['seen']}/{n} 題…"
                      + (f"（已改 {len(changed)} 題）" if changed else ""))

    jobs.progress(job_id, 1, f"複查答案 0/{n} 題…")
    await asyncio.gather(*(batch(qs[i:i + VERIFY_BATCH]) for i in range(0, n, VERIFY_BATCH)))
    if n and not done["checked"]:
        raise ai.AIError("複查沒有成功：" + (done["error"] or "沒有可以對照的原稿照片"))
    e = db.one("SELECT options FROM exams WHERE id=?", (exam_id,))
    opts = e["options"] if e and isinstance(e["options"], dict) else {}
    g = opts.get("grade") or {}
    same = lambda a, b: re.sub(r"\s+", "", a or "") == re.sub(r"\s+", "", b or "")
    for c in changed:  # a mark made with an answer that changed: not trusted any more (a 詳解 rewrite alone keeps it)
        m = g.get(str(c["id"]))
        if m and m.get("result") in ("correct", "wrong", "partial") and not same(c["old"], c["new"]):
            g[str(c["id"])] = {**m, "result": "ask", "comment": "答案複查後有更改，請再看一次她寫的對不對"}
    opts["verify"] = {"at": db.now(), "checked": done["checked"], "changed": changed}
    if g:
        opts["grade"], opts["grade_summary"] = g, grade_counts(g)
    db.update("exams", exam_id, {"options": opts})
    if changed:
        nas.forget_exam(exam_id)
        nas.mark_dirty()
    return {"checked": done["checked"], "changed": len(changed), "unchecked": n - done["checked"]}


async def fix_question_job(job_id: int, qid: int):
    """這題有問題: a parent (or the child) described what is wrong; the question is redone from the
    photo with that description as the final word — text, figure (redrawn), answer and 詳解 —
    and its teaching diagrams are drawn again."""
    from . import nas
    jobs.progress(job_id, 15, "AI 依照你的說明重新整理這一題…")
    res = await upgrade_question(qid)
    db.update("questions", qid, {"visuals": [], "concept": "", "figure_unsure": "", "updated_at": db.now()})
    eid = db.scalar("SELECT exam_id FROM questions WHERE id=?", (qid,))
    if eid:
        nas.forget_exam(eid)
        nas.mark_dirty()
    return res
