"""題庫 search: facets, the 章節 filter (自然 by the review book) and word search over chapter names."""
from fastapi.testclient import TestClient


def _seed(c):
    ids = []
    for subject, unit, stem in [("自然", "水溶液的性質", "糖水是水溶液嗎？"), ("自然", "月亮的變化", "上弦月在什麼時候看得到？"),
                                ("自然", "", "科學家怎麼做實驗？"), ("數學", "分數的乘法", "3/4 × 2 = ?")]:
        r = c.post("/api/questions", json={"subject": subject, "unit": unit, "stem": stem, "answer": "x", "qtype": "選擇題"})
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])
    return ids


def test_chapters_filter_and_facets(client: TestClient):
    ids = _seed(client)
    f = client.get("/api/bank/facets").json()
    keys = {c["key"]: c for c in f["chapters"]}
    assert keys["自然:6"]["n"] >= 1 and keys["自然:6.1"]["n"] >= 1 and keys["自然:11.1"]["n"] >= 1
    assert keys["自然:6"]["group"] == "自然・理化" and keys["自然:11"]["group"] == "自然・地球科學"
    assert "自然:?" in keys and "數學:分數的乘法" in keys
    got = {q["id"] for q in client.get("/api/questions?chapter=自然:6&limit=1000").json()["items"]}
    assert ids[0] in got and ids[1] not in got
    got = {q["id"] for q in client.get("/api/questions?chapter=自然:11.1&limit=1000").json()["items"]}
    assert ids[1] in got and ids[0] not in got
    got = {q["id"] for q in client.get("/api/questions?chapter=自然:?&limit=1000").json()["items"]}
    assert ids[2] in got
    got = {q["id"] for q in client.get("/api/questions?chapter=數學:分數的乘法&limit=1000").json()["items"]}
    assert ids[3] in got and ids[0] not in got
    # a chapter name finds its questions even when the words are not in the question
    got = {q["id"] for q in client.get("/api/questions?q=月球&limit=1000").json()["items"]}
    assert ids[1] in got
    # the label shown on the row
    q = next(q for q in client.get("/api/questions?chapter=自然:6.1&limit=1000").json()["items"] if q["id"] == ids[0])
    assert q["chapter_label"] == "第6單元 水與空氣・水溶液"
    # a parent files one by hand
    assert client.put(f"/api/questions/{ids[2]}", json={"chapter": "1.1"}).status_code == 200
    got = {q["id"] for q in client.get("/api/questions?chapter=自然:1&limit=1000").json()["items"]}
    assert ids[2] in got


def test_chapters_job(client: TestClient):
    import asyncio
    from app import db, pipeline
    ids = _seed(client)
    asyncio.run(pipeline.chapters_job(db.insert("jobs", {"kind": "chapters", "status": "running", "created_at": db.now(), "updated_at": db.now()})))
    ch = {r["id"]: r["chapter"] for r in db.q("SELECT id, chapter FROM questions WHERE subject='自然'")}
    assert ch[ids[0]] == "6.1" and ch[ids[1]] == "-"


def test_multi_select_and_facet_counts(client: TestClient):
    ids = _seed(client)
    tot = lambda q: client.get("/api/questions?limit=1&" + q).json()["total"]
    # a subject with 章節 picked is only those 章節; one without stays whole
    both = tot("subject=數學,自然&chapter=自然:6")
    assert both == tot("subject=數學") + tot("chapter=自然:6")
    # several 章節 / exams / types in one group = any of them
    assert tot("chapter=自然:6,自然:11.1") == tot("chapter=自然:6") + tot("chapter=自然:11.1")
    # each group is counted with the others applied, not itself
    f = client.get("/api/bank/facets?subject=自然").json()
    assert f["total"] == tot("subject=自然")
    assert f["subjects"]["數學"] == tot("subject=數學")      # the subject row ignores the subject picked
    assert f["qtypes"]["選擇題"] == tot("subject=自然&qtype=選擇題")
    ids_found = client.get("/api/questions/ids?chapter=自然:6").json()["ids"]
    assert ids[0] in ids_found and ids[1] not in ids_found


def _upload(client, **form):
    from pathlib import Path
    from tests.test_app import wait
    img = (Path(__file__).parent / "sample_exam.jpg").read_bytes()
    r = client.post("/api/exams", files=[("files", ("p1.jpg", img, "image/jpeg"))], data={"title": "功課", **form})
    assert r.status_code == 200, r.text
    assert wait(client, r.json()["job_id"], 120)["status"] == "done"
    return r.json()["exam_id"]


def test_homework_kept_out_of_the_bank(client: TestClient):
    eid = _upload(client, mode="grade", in_bank="0")
    mine = client.get(f"/api/questions?exam_id={eid}").json()
    assert mine["total"] > 0                                              # the exam itself has its questions
    ids = {q["id"] for q in mine["items"]}
    bank = {q["id"] for q in client.get("/api/questions?limit=1000").json()["items"]}
    assert not ids & bank                                                 # …the 題庫 does not
    assert not set(client.get("/api/questions/ids").json()["ids"]) & ids
    assert next(e for e in client.get("/api/exams").json() if e["id"] == eid)["in_bank"] is False
    assert client.get(f"/api/exams/{eid}").json()["questions"]           # the exam page still shows them
    assert client.put(f"/api/exams/{eid}/bank", json={"in_bank": True}).json()["in_bank"] is True
    bank = {q["id"] for q in client.get("/api/questions?limit=1000").json()["items"]}
    assert ids <= bank


def test_replace_one_page(client: TestClient):
    from tests.test_app import wait
    from pathlib import Path
    eid = _upload(client, mode="grade")
    e = client.get(f"/api/exams/{eid}").json()
    before = {q["number"]: q["id"] for q in e["questions"]}
    assert e["options"].get("grade")
    client.put(f"/api/questions/{next(iter(before.values()))}", json={"note": "記得單位"})
    img = (Path(__file__).parent / "sample_exam.jpg").read_bytes()
    r = client.post(f"/api/exams/{eid}/pages/{e['pages'][0]['id']}/replace", files={"file": ("new.jpg", img, "image/jpeg")})
    assert r.status_code == 200, r.text
    j = wait(client, r.json()["job_id"], 120)
    assert j["status"] == "done", j
    after = client.get(f"/api/exams/{eid}").json()
    assert {q["number"]: q["id"] for q in after["questions"]} == before      # same questions, same ids
    assert next(q for q in after["questions"] if q["id"] == next(iter(before.values())))["note"] == "記得單位"
    assert set(after["options"]["grade"]) == {str(i) for i in before.values()}  # graded again
    assert after["pages"][0]["orig_path"] != e["pages"][0]["orig_path"]


def test_school_exam(client: TestClient):
    eid = _upload(client)
    e = client.get(f"/api/exams/{eid}").json()
    assert e["options"]["school"] is True and e["options"]["school_term"]       # 班級、姓名、座號 seen by the AI
    ids = {q["id"] for q in e["questions"]}
    got = {q["id"] for q in client.get("/api/questions?school=1&limit=1000").json()["items"]}
    assert ids <= got
    f = client.get("/api/bank/facets?school=1").json()
    assert f["total"] == client.get("/api/questions?limit=1&school=1").json()["total"]
    assert f["school"]["1"] >= len(ids)
    assert next(x for x in client.get("/api/exams").json() if x["id"] == eid)["school"] is True
    client.put(f"/api/exams/{eid}", json={"school": False})                        # set by hand
    assert not ids & {q["id"] for q in client.get("/api/questions?school=1&limit=1000").json()["items"]}
    from app import pipeline
    import asyncio
    assert asyncio.run(pipeline.detect_school(eid)) is False                      # the AI does not overrule it
    eid2 = _upload(client, school="0")                                            # chosen when scanning
    assert client.get(f"/api/exams/{eid2}").json()["options"]["school"] is False



def test_scene_picture_is_kept(client):
    """No 還原卷: a 情境插圖 (people, a scene) is kept as the question's own picture — a line drawing
    loses what it is about — with its answer boxes emptied; it is not drawn as SVG."""
    import asyncio
    from app import ai, db, pipeline
    eid = _upload(client)
    q = next(q for q in client.get(f"/api/exams/{eid}").json()["questions"] if q.get("figure_path"))
    real = ai.upgrade_question

    async def photo(qd, crop, figure, zhuyin=None, hint=None):
        r = await real(qd, crop, figure)
        return {**r, "figure_kind": "image", "svg": ""}
    ai.upgrade_question = photo
    try:
        asyncio.run(pipeline.upgrade_question(q["id"]))
    finally:
        ai.upgrade_question = real
    row = db.one("SELECT figure_kind, figure_svg, figure_path FROM questions WHERE id=?", (q["id"],))
    assert row["figure_kind"] == "image" and not row["figure_svg"] and row["figure_path"].endswith("_pic.jpg")
    assert pipeline.media(row["figure_path"]).exists()
    page = client.get(f"/api/exams/{eid}").json()["pages"][0]
    assert not page["clean_path"]


def test_page_corners(client: TestClient):
    """調整四個角: the outline found in a photo, the page photo, and a page scanned again with corners."""
    from pathlib import Path
    from tests.test_app import wait
    img = (Path(__file__).parent / "sample_exam.jpg").read_bytes()
    r = client.post("/api/scan/corners", files={"file": ("p.jpg", img, "image/jpeg")})
    assert r.status_code == 200 and len(r.json()["corners"]) in (0, 4)
    eid = _upload(client, corners='[[[0.02,0.02],[0.98,0.02],[0.98,0.98],[0.02,0.98]]]')
    e = client.get(f"/api/exams/{eid}").json()
    pg = e["pages"][0]
    assert pg["meta"]["scan"]["manual"] and pg["meta"]["corners_set"][0] == [0.02, 0.02]
    c = client.get(f"/api/pages/{pg['id']}/corners").json()
    assert len(c["corners"]) == 4 and c["manual"]
    ph = client.get(f"/api/pages/{pg['id']}/photo")
    assert ph.status_code == 200 and ph.headers["content-type"] == "image/jpeg"
    r = client.post(f"/api/exams/{eid}/pages/{pg['id']}/corners", json={"corners": []})  # the whole photo
    assert wait(client, r.json()["job_id"], 120)["status"] == "done"
    pg = client.get(f"/api/exams/{eid}").json()["pages"][0]
    assert pg["meta"]["corners_set"] == [] and not pg["meta"]["scan"]["warped"]
    assert client.post(f"/api/exams/{eid}/pages/{pg['id']}/corners", json={"corners": [[0, 0]]}).status_code == 400
