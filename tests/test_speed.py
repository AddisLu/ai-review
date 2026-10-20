"""The exam page over slow Wi-Fi: a light exam (long parts left out), just the explanations, and 304s."""
from fastapi.testclient import TestClient


def test_exam_lite_only_and_etag(client: TestClient):
    from app import db
    eid = db.insert("exams", {"student_id": 1, "title": "速度測試", "subject": "數學", "status": "ready", "created_at": db.now()})
    r = client.post("/api/questions", json={"subject": "數學", "stem": "1+1=?", "answer": "2", "qtype": "填充題",
                                             "explanation": "一加一等於二", "steps": ["1+1", "=2"], "exam_id": eid})
    assert r.status_code == 200, r.text
    qid = r.json()["id"]
    db.execute("UPDATE questions SET exam_id=? WHERE id=?", (eid, qid))
    full = client.get(f"/api/exams/{eid}").json()
    q = next(x for x in full["questions"] if x["id"] == qid)
    assert q["explanation"] == "一加一等於二" and "lite" not in full
    lite = client.get(f"/api/exams/{eid}?lite=1").json()
    ql = next(x for x in lite["questions"] if x["id"] == qid)
    assert "explanation" not in ql and "steps" not in ql and ql["stem"] == "1+1=?" and "explanation" in lite["lite"]
    only = client.get(f"/api/exams/{eid}?only=explanation,steps,stem").json()
    assert only["questions"] == [{"id": qid, "explanation": "一加一等於二", "steps": ["1+1", "=2"]}]  # stem: not a long part
    # unchanged → 304 with the same ETag; changed → a new one
    r1 = client.get(f"/api/exams/{eid}?lite=1")
    tag = r1.headers["etag"]
    assert r1.headers["cache-control"] == "private, no-cache"
    r2 = client.get(f"/api/exams/{eid}?lite=1", headers={"If-None-Match": tag})
    assert r2.status_code == 304 and not r2.content
    client.put(f"/api/questions/{qid}", json={"stem": "1+2=?"})
    r3 = client.get(f"/api/exams/{eid}?lite=1", headers={"If-None-Match": tag})
    assert r3.status_code == 200 and r3.headers["etag"] != tag


def test_page_thumb_sizes(client: TestClient, sample):
    import shutil
    from app.config import MEDIA_DIR
    (MEDIA_DIR / "speedtest").mkdir(parents=True, exist_ok=True)
    shutil.copy(sample, MEDIA_DIR / "speedtest" / "p0_scan.jpg")
    sizes = {}
    for w in (240, 480, 1200, 5000):
        r = client.get(f"/api/thumb/speedtest/p0_scan.jpg?w={w}")
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
        sizes[w] = len(r.content)
    assert sizes[240] < sizes[480] <= sizes[1200] and sizes[5000] == sizes[1200]  # 1200 at most
    assert client.get("/api/thumb/../app.db?w=240").status_code == 404
