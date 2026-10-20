"""刪除題庫資料: only with 家長權限 (the parent's login or the parent PIN on a child's device)."""
P = {"X-Parent-Pin": "0000"}


def _q(client, stem):
    r = client.post("/api/questions", json={"subject": "數學", "stem": stem, "answer": "1", "qtype": "填充題"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_delete_questions_parent_only(client):
    a, b, c = _q(client, "刪除測試 A"), _q(client, "刪除測試 B"), _q(client, "刪除測試 C")
    # the child (the session's login) added them, but may not delete them
    assert client.delete(f"/api/questions/{a}").status_code == 403
    assert client.post("/api/questions/bulk", json={"ids": [b, c], "action": "delete"}).status_code == 403
    assert client.get(f"/api/questions/{a}").status_code == 200
    # with the parent PIN: one, then several
    assert client.delete(f"/api/questions/{a}", headers=P).status_code == 200
    assert client.get(f"/api/questions/{a}").status_code == 404
    r = client.post("/api/questions/bulk", json={"ids": [b, c], "action": "delete"}, headers=P)
    assert r.status_code == 200 and r.json()["deleted"] == 2
    assert client.get("/api/questions?q=刪除測試&limit=10").json()["total"] == 0


def test_delete_exam_parent_only(client):
    from app import db
    eid = db.insert("exams", {"student_id": 1, "title": "刪除考卷測試", "status": "ready", "created_at": db.now()})
    assert client.delete(f"/api/exams/{eid}").status_code == 403
    assert client.delete(f"/api/exams/{eid}", headers=P).status_code == 200
    assert not db.one("SELECT id FROM exams WHERE id=?", (eid,))
