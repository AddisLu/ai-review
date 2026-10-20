"""刷題: answers checked here first (代號、✓✗△), the quick handwriting check is the graded try,
answers on a parent's device count for the child, and every exam keeps its 錯題紀錄."""
from pathlib import Path

from app import ai, db, pipeline, practice
from tests.test_bank_search import _upload


def test_local_check_codes_and_marks():
    L = practice.local_check
    assert L({"answer": "ㄅ、ㄇ、ㄈ", "stem": ""}, "ㄅ、ㄈ、ㄇ") is True       # a set: any order
    assert L({"answer": "ㄅ、ㄇ、ㄈ", "stem": ""}, "ㄅ、ㄈ") is False
    assert L({"answer": "ㄆ→ㄊ→ㄇ", "stem": ""}, "ㄊㄆㄇ") is False           # an order
    assert L({"answer": "E（主持會議）", "stem": ""}, "E") is True             # the note in brackets is not needed
    assert L({"answer": "△（是霸凌行為）", "stem": ""}, "✕") is False
    assert L({"answer": "(1)✓ (2)✓ (3)✗", "stem": ""}, "✓ ✓ ✗") is True
    assert L({"answer": "① 舉手表決 ✓ ② 猜拳 ✗", "stem": ""}, "✓✗") is True
    assert L({"answer": "∨（符合）", "stem": ""}, "✓") is True
    assert L({"answer": "cat", "stem": ""}, "act") is None                       # a word, not codes: the AI decides


def test_quick_check_is_the_graded_try(client, monkeypatch):
    eid = _upload(client)
    q = client.get(f"/api/exams/{eid}").json()["questions"][0]
    db.update("questions", q["id"], {"answer": "C、F", "choice_index": 0, "options": []})
    png = (Path(__file__).parent / "sample_exam.jpg").read_bytes()

    async def read(qd, img, figure=None):  # the AI read her answer and (wrongly) said it was wrong
        return {"final_answer": "F、C", "result": "wrong", "first_error_step": 0, "headline": "再看看"}
    monkeypatch.setattr(ai, "tutor_quick", read)
    n0 = db.scalar("SELECT COUNT(*) FROM attempts WHERE question_id=?", (q["id"],))
    r = client.post(f"/api/questions/{q['id']}/tutor/quick", files={"image": ("w.png", png, "image/png")},
                    data={"record": "1"}).json()
    assert r["result"] == "correct" and r["checked"] == "local" and r["attempt_id"] and r["reward"]["xp"] == 15
    assert db.scalar("SELECT COUNT(*) FROM attempts WHERE question_id=?", (q["id"],)) == n0 + 1
    # 「AI 幫我看哪裡錯」 afterwards fills in the same try, nothing counted twice
    r2 = client.post(f"/api/questions/{q['id']}/tutor", files={"image": ("w.png", png, "image/png")},
                     data={"attempt": str(r["attempt_id"])}).json()
    assert r2["reward"]["xp"] == 0
    assert db.scalar("SELECT COUNT(*) FROM attempts WHERE question_id=?", (q["id"],)) == n0 + 1


def test_parent_device_and_wrong_record(client):
    eid = _upload(client)
    qs = client.get(f"/api/exams/{eid}").json()["questions"]
    a, b = qs[0], qs[1]
    for x in (a, b):
        db.update("questions", x["id"], {"answer": "ㄅ", "choice_index": 0, "options": []})
    from fastapi.testclient import TestClient

    from app import main
    child = db.one("SELECT student_id FROM exams WHERE id=?", (eid,))["student_id"]
    with TestClient(main.app) as pc:  # the parent's login, the child chosen: she answers on that device
        parent = next(p for p in pc.get("/api/status").json()["profiles"] if p["role"] == "parent")
        assert pc.post("/api/auth/login", json={"id": parent["id"], "pin": "0000"}).status_code == 200
        h = {"X-Student-Id": str(child)}
        n0 = db.scalar("SELECT COUNT(*) FROM attempts WHERE question_id=?", (a["id"],))
        assert pc.post(f"/api/questions/{a['id']}/answer", json={"answer": "ㄆ"}, headers=h).json()["preview"]  # 家長試做
        assert db.scalar("SELECT COUNT(*) FROM attempts WHERE question_id=?", (a["id"],)) == n0
        pc.post(f"/api/questions/{a['id']}/answer", json={"answer": "ㄆ", "as_child": True}, headers=h)
        pc.post(f"/api/questions/{a['id']}/answer", json={"answer": "ㄇ", "as_child": True}, headers=h)
        pc.post(f"/api/questions/{b['id']}/answer", json={"answer": "ㄅ", "as_child": True}, headers=h)
        assert db.scalar("SELECT COUNT(*) FROM attempts WHERE question_id=? AND student_id=?", (a["id"], child)) == n0 + 2
    pr = client.get("/api/practice/progress", params={"source": f"exam:{eid}"}).json()
    assert b["id"] in pr["right"] and a["id"] in pr["wrong"]
    assert pr["wrong_counts"][str(a["id"])] == 2 and str(b["id"]) not in pr["wrong_counts"]


def test_question_group_shares_its_lead(client):
    eid = _upload(client)
    qs = db.q("SELECT id FROM questions WHERE exam_id=? ORDER BY seq", (eid,))
    first, second = qs[0]["id"], qs[1]["id"]
    db.update("questions", first, {"number": "2-(1)", "section": "", "figure_svg": "", "figure_table": "",
                                   "stem": "請將代號填入（　　）裡：\nA.主持會議\nB.記錄\n(1)阿偉是老師，負責（　　）。"})
    db.update("questions", second, {"number": "2-(2)", "section": "", "figure_svg": "", "figure_table": "",
                                    "stem": "（2）小君是主席，負責（　　）。"})
    pipeline.link_groups(eid)
    lead = client.get(f"/api/questions/{second}").json()["lead"]
    assert "A.主持會議" in lead["stem"] and "阿偉" not in lead["stem"]
    assert "題組共用" in ai.question_text(db.one("SELECT * FROM questions WHERE id=?", (second,)))
