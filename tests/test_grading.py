"""批改: unclear answers looked at again close up, red pen = wrong, two-page spreads read page by page,
and 漏拍提醒 (question numbers that do not run on)."""
import asyncio

import numpy as np

from app import ai, db, pipeline


def _exam(client, sample, mode="grade"):
    with open(sample, "rb") as f:
        r = client.post("/api/exams", files=[("files", ("p1.jpg", f, "image/jpeg"))], data={"mode": mode})
    assert r.status_code == 200, r.text
    from tests.test_app import wait
    assert wait(client, r.json()["job_id"])["status"] == "done"
    return r.json()["exam_id"]


def test_closeup_and_red_pen(client, sample, monkeypatch):
    eid = _exam(client, sample)
    qs = db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (eid,))
    first, second = qs[0]["id"], qs[1]["id"]
    seen = {"closeups": [], "options": None, "careful": []}

    third = qs[2]["id"]

    async def fake(items, images, closeups=None, careful=False):
        if closeups:  # the close look reads them (the third one: not even the careful look)
            seen["closeups"] += sorted(closeups)
            seen["careful"] += sorted(closeups) if careful else []
            return [{"id": it["id"], "result": "unsure" if it["id"] == third else "correct", "read_as": "3", "comment": "",
                     "answer": "", "red": "none"} for it in items]
        seen["options"] = [it.get("options") for it in items]
        out = []
        for it in items:
            if it["id"] in (first, third):
                out.append({"id": it["id"], "result": "unsure", "read_as": "", "comment": "", "answer": "", "red": "none"})
            elif it["id"] == second:  # she was right by the key, but the teacher corrected it in red
                out.append({"id": it["id"], "result": "correct", "read_as": "4", "comment": "", "answer": "", "red": "wrong"})
            else:
                out.append({"id": it["id"], "result": "correct", "read_as": "1", "comment": "", "answer": "", "red": "none"})
        return out

    monkeypatch.setattr(ai, "grade_answers", fake)
    asyncio.run(pipeline.grade_exam(eid))
    g = db.one("SELECT options FROM exams WHERE id=?", (eid,))["options"]["grade"]
    assert first in (seen["closeups"] or [])            # the unclear one was looked at close up
    assert g[str(first)]["result"] == "correct"
    assert g[str(second)]["result"] == "wrong"         # red pen on the paper: to be redone
    assert all(isinstance(o, list) for o in seen["options"])  # the choices go to the grader
    assert g[str(third)]["result"] == "ask"            # no 「?」: a parent decides
    assert seen["careful"] == [third]                  # looked at again, harder, before asking
    from app.main import app  # noqa: F401  (the client below is the session's)


def test_parent_decides(client, sample):
    eid = _exam(client, sample)
    qid = db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (eid,))[0]["id"]
    assert client.put(f"/api/exams/{eid}/grade/{qid}", json={"result": "wrong"}).status_code == 403  # a child may not
    r = client.put(f"/api/exams/{eid}/grade/{qid}", json={"result": "wrong"}, headers={"X-Parent-Pin": "0000"})
    assert r.status_code == 200 and r.json()["summary"]["wrong"] >= 1
    g = db.one("SELECT options FROM exams WHERE id=?", (eid,))["options"]["grade"][str(qid)]
    assert g["result"] == "wrong" and g["by"] == "parent"


def test_read_spread_boxes(monkeypatch):
    calls = []

    async def fake_extract(image, subject_hint=""):
        calls.append(1)
        n = len(calls)
        return {"rotation": 0, "title": "考卷" if n == 1 else "", "subject": "數學",
                "questions": [{"number": str(n), "box": [100, 100, 900, 200], "figure_box": []}],
                "handwriting_boxes": [[0, 0, 500, 500]], "notes": ""}

    monkeypatch.setattr(ai, "extract_page", fake_extract)
    img = np.full((1000, 1400, 3), 255, np.uint8)
    d = asyncio.run(pipeline._read_spread(img, 0.5, ""))
    assert [q["number"] for q in d["questions"]] == ["1", "2"]      # left page first, then right
    assert d["questions"][0]["box"] == [50, 100, 450, 200]           # back in the whole picture's frame
    assert d["questions"][1]["box"] == [550, 100, 950, 200]
    assert d["title"] == "考卷"


def test_find_gaps():
    eid = db.insert("exams", {"student_id": 1, "title": "漏拍測試", "status": "ready", "created_at": db.now()})
    pids = [db.insert("pages", {"exam_id": eid, "idx": i, "orig_path": f"x{i}.jpg", "status": "done"}) for i in range(3)]
    rows = [(0, "一、選擇題", "1", "3 × 4 = ?"), (0, "一、選擇題", "2", "5 × 6 = ?"), (0, "一、選擇題", "3", "7 × 8 = ?"),
            (1, "一、選擇題", "7", "9 × 9 = ?"),                       # 4–6 missing between pages: a page not taken
            (1, "一、選擇題", "8", "283 元，買 5 籃？"), (1, "一、選擇題", "9", "283 元，買 5 籃？"),  # read twice
            (2, "二、填充題", "1", "在□裡填入正確的數字。"), (2, "二、填充題", "2", "在□裡填入正確的數字。"),  # on purpose
            (2, "二、填充題", "3", "a"), (2, "二、填充題", "5", "b")]   # 4 missing on one page
    for i, (pg, sec, num, stem) in enumerate(rows):
        db.insert("questions", {"student_id": 1, "exam_id": eid, "page_id": pids[pg], "seq": pg * 1000 + i, "section": sec,
                                "number": num, "stem": stem, "subject": "數學", "created_at": db.now(), "updated_at": db.now()})
    g = pipeline.find_gaps(eid)
    kinds = [(x["kind"], x["from"], x["to"]) for x in g]
    assert ("missed_page", 4, 6) in kinds and ("twice", 9, 9) in kinds and ("missed", 4, 4) in kinds
    assert len(g) == 3                                       # the repeated instruction is not flagged
    assert "第 1 頁和第 2 頁之間" in next(x["text"] for x in g if x["kind"] == "missed_page")


def test_spread_becomes_two_pages(client, monkeypatch):
    """An upside-down two-page spread: turned, cut in two, the right half the next page (later pages move on)."""
    import cv2
    from app import imaging, scanner
    from app.config import MEDIA_DIR
    eid = db.insert("exams", {"student_id": 1, "title": "攤開測試", "status": "processing", "created_at": db.now()})
    (MEDIA_DIR / f"exam_{eid}").mkdir(parents=True, exist_ok=True)
    img = np.full((700, 1000, 3), 255, np.uint8)
    cv2.putText(img, "L", (200, 350), cv2.FONT_HERSHEY_SIMPLEX, 6, (0, 0, 0), 12)
    cv2.putText(img, "R", (700, 350), cv2.FONT_HERSHEY_SIMPLEX, 6, (0, 0, 0), 12)
    cv2.imwrite(str(MEDIA_DIR / f"exam_{eid}/p0_orig.jpg"), img)
    cv2.imwrite(str(MEDIA_DIR / f"exam_{eid}/p1_orig.jpg"), img[:, :500])
    a = db.insert("pages", {"exam_id": eid, "idx": 0, "orig_path": f"exam_{eid}/p0_orig.jpg", "status": "queued"})
    b = db.insert("pages", {"exam_id": eid, "idx": 1, "orig_path": f"exam_{eid}/p1_orig.jpg", "status": "queued"})
    # the photo is a spread (fold in the middle) and upside down
    monkeypatch.setattr(imaging, "scan", lambda path, c=None, sp=None, dg=None: (imaging.load(path),
                        {"spread": "p0_" in str(path) and sp is not False, "gutter": 0.5}))

    async def turned(image):
        return 180
    monkeypatch.setattr(ai, "page_turn", turned)
    made = asyncio.run(pipeline._prepare_pages(eid, db.q("SELECT * FROM pages WHERE exam_id=? ORDER BY idx", (eid,))))
    assert len(made) == 1
    pages = db.q("SELECT id, idx, meta FROM pages WHERE exam_id=? ORDER BY idx", (eid,))
    assert [p["id"] for p in pages] == [a, made[0], b] and [p["idx"] for p in pages] == [0, 1, 2]
    left, right = pages[0]["meta"], pages[1]["meta"]
    assert left["half"] == "L" and right["half"] == "R" and left["turn"] == 180 and left["pair"] == made[0]
    # turned upright: the left page now holds what was on the right of the upside-down photo ("R" upside down)
    lim = imaging.load(MEDIA_DIR / left["prepared"]["scan"])
    assert lim.shape[1] == 500
    # read again later: the half is cut from the photo the same way
    pm = dict(right)
    pm.pop("prepared")
    monkeypatch.setattr(imaging, "scan", lambda path, c=None, sp=None, dg=None: (imaging.load(path), {"spread": False}))
    rim, info = asyncio.run(pipeline._page_image(db.one("SELECT * FROM pages WHERE id=?", (made[0],)), pm))
    assert rim.shape[1] == 500 and info["from_spread"]


def test_merge_continued_and_delete_page(client):
    eid = db.insert("exams", {"student_id": 1, "title": "跨頁測試", "status": "ready", "created_at": db.now()})
    p1 = db.insert("pages", {"exam_id": eid, "idx": 0, "orig_path": "a.jpg", "status": "done"})
    p2 = db.insert("pages", {"exam_id": eid, "idx": 1, "orig_path": "b.jpg", "status": "done"})
    p3 = db.insert("pages", {"exam_id": eid, "idx": 2, "orig_path": "c.jpg", "status": "done"})
    mk = lambda pg, seq, num, stem, opts=None: db.insert("questions", {"student_id": 1, "exam_id": eid, "page_id": pg, "seq": seq,
                                                                        "number": num, "stem": stem, "options": opts or [], "subject": "數學",
                                                                        "section": "二、選擇題", "created_at": db.now(), "updated_at": db.now()})
    q7 = mk(p1, 6, "7", "「378+378+378」用乘法算式表示，下面何者正確？")
    cont = mk(p2, 1000, "續", "", ["300×3", "378×3", "78×3", "378−3"])
    mk(p2, 1001, "8", "「30×3」的答案和哪一個算式的答案相同？", ["15×6", "20×4", "18×4", "11×9"])
    from app import qstate
    qstate.set_state(1, cont, {"student_answer": "2"})
    grown = pipeline.merge_continued(eid)
    assert grown == [q7]
    q = db.one("SELECT options, solved FROM questions WHERE id=?", (q7,))
    assert q["options"] == ["300×3", "378×3", "78×3", "378−3"] and q["solved"] == 0
    assert not db.one("SELECT id FROM questions WHERE id=?", (cont,))
    assert qstate.get(1, q7)["student_answer"] == "2"          # her answer was next to the options
    # 刪除這一頁: parents only; the pages after it move up
    assert client.delete(f"/api/exams/{eid}/pages/{p2}").status_code == 403
    r = client.delete(f"/api/exams/{eid}/pages/{p2}", headers={"X-Parent-Pin": "0000"})
    assert r.status_code == 200 and r.json()["removed"] == 1
    assert db.one("SELECT idx FROM pages WHERE id=?", (p3,))["idx"] == 1


def test_fix_pairs_swaps_upside_down_spread():
    eid = db.insert("exams", {"student_id": 1, "title": "倒過來", "status": "ready", "created_at": db.now()})
    common = {"turn": 90, "gutter": 0.4, "rotation": 180}
    l_ = db.insert("pages", {"exam_id": eid, "idx": 0, "orig_path": "a.jpg", "status": "done", "meta": {**common, "half": "L"}})
    r_ = db.insert("pages", {"exam_id": eid, "idx": 1, "orig_path": "a.jpg", "status": "done", "meta": {**common, "half": "R", "pair": l_}})
    db.update("pages", l_, {"meta": {**common, "half": "L", "pair": r_}})
    ql = db.insert("questions", {"student_id": 1, "exam_id": eid, "page_id": l_, "seq": 3, "number": "20", "stem": "x", "created_at": db.now(), "updated_at": db.now()})
    qr = db.insert("questions", {"student_id": 1, "exam_id": eid, "page_id": r_, "seq": 1002, "number": "8", "stem": "y", "created_at": db.now(), "updated_at": db.now()})
    assert pipeline.fix_pairs(eid) == 1
    a, b = db.one("SELECT idx, meta FROM pages WHERE id=?", (l_,)), db.one("SELECT idx, meta FROM pages WHERE id=?", (r_,))
    assert (a["idx"], b["idx"]) == (1, 0) and a["meta"]["half"] == "R" and b["meta"]["half"] == "L"
    assert a["meta"]["turn"] == 270 and abs(a["meta"]["gutter"] - 0.6) < 1e-6 and a["meta"]["rotation"] == 0
    assert db.one("SELECT seq FROM questions WHERE id=?", (qr,))["seq"] == 2 and db.one("SELECT seq FROM questions WHERE id=?", (ql,))["seq"] == 1003
    assert pipeline.fix_pairs(eid) == 0  # once


def test_fill_continuations(client, monkeypatch):
    import cv2
    from app.config import MEDIA_DIR
    eid = db.insert("exams", {"student_id": 1, "title": "跨頁選項", "status": "ready", "created_at": db.now()})
    (MEDIA_DIR / f"exam_{eid}").mkdir(parents=True, exist_ok=True)
    for i in range(2):
        cv2.imwrite(str(MEDIA_DIR / f"exam_{eid}/s{i}.jpg"), np.full((1000, 700, 3), 255, np.uint8))
    p1 = db.insert("pages", {"exam_id": eid, "idx": 0, "orig_path": "a.jpg", "scan_path": f"exam_{eid}/s0.jpg", "status": "done"})
    p2 = db.insert("pages", {"exam_id": eid, "idx": 1, "orig_path": "b.jpg", "scan_path": f"exam_{eid}/s1.jpg", "status": "done"})
    mk = lambda pg, seq, num, opts, bbox: db.insert("questions", {"student_id": 1, "exam_id": eid, "page_id": pg, "seq": seq, "number": num,
                                                                 "qtype": "選擇題", "stem": "s", "options": opts, "bbox": bbox,
                                                                 "created_at": db.now(), "updated_at": db.now()})
    q19 = mk(p1, 11, "19", ["454 元", "900 元"], [0, 800, 1000, 950])
    mk(p2, 1000, "20", ["300 元", "1100 元", "3000 元", "3500 元"], [0, 120, 1000, 200])
    seen = {}

    async def fake(question, options, top):
        seen["opts"] = options
        return {"options": ["1350 元", "1800 元"], "text": ""}
    monkeypatch.setattr(ai, "read_continuation", fake)
    assert asyncio.run(pipeline.fill_continuations(eid)) == [q19]
    assert seen["opts"] == ["454 元", "900 元"]
    assert db.one("SELECT options FROM questions WHERE id=?", (q19,))["options"] == ["454 元", "900 元", "1350 元", "1800 元"]
    assert asyncio.run(pipeline.fill_continuations(eid)) == []  # 4 options now: not asked again


def test_verify_answers(client, sample):
    """答案複查: a parent's job; the second look's different answer replaces the first, is listed on the
    exam, and the mark that was made with the old answer becomes 請你確認."""
    eid = _exam(client, sample)
    db.execute("UPDATE questions SET upgraded_at=? WHERE exam_id=?", (db.now(), eid))
    qs = db.q("SELECT id, stem FROM questions WHERE exam_id=? ORDER BY seq", (eid,))
    first = next(q["id"] for q in qs if "最大公因數" in q["stem"])
    opts = db.one("SELECT options FROM exams WHERE id=?", (eid,))["options"]
    db.update("exams", eid, {"options": {**opts, "grade": {str(first): {"result": "correct", "read_as": "2"}}}})
    assert client.post(f"/api/exams/{eid}/verify").status_code == 403       # a child may not
    r = client.post(f"/api/exams/{eid}/verify", headers={"X-Parent-Pin": "0000"})
    assert r.status_code == 200, r.text
    from tests.test_app import wait
    j = wait(client, r.json()["job_id"])
    assert j["status"] == "done", j
    o = db.one("SELECT options FROM exams WHERE id=?", (eid,))["options"]
    assert o["verify"]["checked"] == len(qs) and [c["id"] for c in o["verify"]["changed"]] == [first]
    assert db.scalar("SELECT answer FROM questions WHERE id=?", (first,)) == "複查後的答案"
    assert o["grade"][str(first)]["result"] == "ask" and o["grade_summary"]["ask"] == 1
