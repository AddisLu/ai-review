"""Family accounts: each child (and each parent) logs in with their own
profile. Kids use a short PIN, parents a password. The login is a signed
cookie, so one tablet can be shared by switching users."""
import base64
import contextvars
import hashlib
import hmac
import os
import time

from . import db

COOKIE = "uid"
COOKIE_AGE = 365 * 86400

# Grade of the child the current request/job is for (AI wording adapts to it).
current_grade: contextvars.ContextVar[int] = contextvars.ContextVar("current_grade", default=6)

_fails: dict[int, list[float]] = {}


def _secret() -> bytes:
    s = db.get_setting("secret")
    if not s:
        s = base64.b64encode(os.urandom(32)).decode()
        db.set_setting("secret", s)
    return s.encode()


def hash_secret(pw: str) -> str:
    salt = os.urandom(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, 120_000)
    return "pbkdf2$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(h).decode()


def check_secret(pw: str, stored: str) -> bool:
    if not stored or not stored.startswith("pbkdf2$"):
        return False
    _, salt, h = stored.split("$")
    got = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(salt), 120_000)
    return hmac.compare_digest(got, base64.b64decode(h))


def sign(uid: int) -> str:
    mac = hmac.new(_secret(), f"uid:{uid}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{uid}.{mac}"


def verify(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    uid, mac = token.split(".", 1)
    if not uid.isdigit() or not hmac.compare_digest(sign(int(uid)), token):
        return None
    return db.one("SELECT id, name, grade, avatar, role, theme FROM students WHERE id=?", (int(uid),))


def rate_limited(uid: int) -> bool:
    now = time.time()
    recent = [t for t in _fails.get(uid, []) if now - t < 300]
    _fails[uid] = recent
    return len(recent) >= 6


def note_failure(uid: int):
    _fails.setdefault(uid, []).append(time.time())


def setup_needed() -> bool:
    return not db.scalar("SELECT 1 FROM students WHERE role='parent'")


def check_parent_secret(pw: str) -> bool:
    return any(check_secret(pw, r["pin_hash"]) for r in
               db.q("SELECT pin_hash FROM students WHERE role='parent'"))


def grade_note(grade: int) -> str:
    if grade <= 2:
        level = "用非常簡單的字和很短的句子，多用圖像和生活例子，避免抽象名詞"
    elif grade <= 4:
        level = "用簡單的字、短句子，一次只講一個步驟；避免分數乘除、比與比值等高年級觀念，除非題目本身就是"
    else:
        level = "用國小高年級聽得懂的方式說明"
    return f"這位學生是國小 {grade} 年級。所有解說、提示、例題的難度與用語都要配合 {grade} 年級：{level}。"
