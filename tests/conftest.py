import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["AIREVIEW_DATA"] = tempfile.mkdtemp(prefix="aireview-test-")

from tests import fake_ai  # noqa: E402


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app import db, main
    fake_ai.install()
    db.set_setting("api_key", "sk-ant-test")
    with TestClient(main.app) as c:
        r = c.post("/api/setup", json={"parent_name": "爸爸", "parent_password": "0000",
                                       "child": {"name": "姊姊", "grade": 6, "pin": "1234"}})
        assert r.status_code == 200, r.text
        child = next(p for p in c.get("/api/status").json()["profiles"] if p["role"] == "student")
        assert c.post("/api/auth/login", json={"id": child["id"], "pin": "1234"}).status_code == 200
        yield c


@pytest.fixture(scope="session")
def sample():
    return ROOT / "tests" / "sample_exam.jpg"
