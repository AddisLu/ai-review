import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("AIREVIEW_DATA", ROOT / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
MEDIA_DIR = DATA_DIR / "media"
# generated PDF / Word files (made again whenever asked for): in RAM, not on the Pi's slow SD card
# (one folder per data folder, so tests never share it with the real site)
import hashlib as _h
OLD_EXPORT_DIR = DATA_DIR / "exports"
EXPORT_DIR = (Path("/dev/shm") / f"ai-review-exports-{_h.sha1(str(DATA_DIR).encode()).hexdigest()[:8]}"
              if Path("/dev/shm").is_dir() else OLD_EXPORT_DIR)
STATIC_DIR = ROOT / "static"
DB_PATH = DATA_DIR / "app.db"
PORT = int(os.environ.get("AIREVIEW_PORT", "8000"))

for d in (DATA_DIR, UPLOAD_DIR, MEDIA_DIR, EXPORT_DIR):
    d.mkdir(parents=True, exist_ok=True)

DEFAULT_MODEL = "claude-opus-5-5"

# Defaults for every setting the parent can change on the settings page.
DEFAULT_SETTINGS = {
    "ai_provider": "auto",   # auto / subscription (claude.ai login via Claude Code) / api
    "api_key": "",
    "model": DEFAULT_MODEL,
    "use_fallbacks": True,
    "effort_extract": "medium",
    "effort_solve": "high",
    "effort_tutor": "medium",
    # interactive help (chat, hints, handwriting grading, re-teaching, diagrams) runs on a
    # faster model; question writing, solutions and summaries stay on `model`
    "model_fast": "claude-sonnet-5-5",
    "effort_chat": "low",
    "effort_content": "medium",
    "site_password": "",
    "parent_pin": "0000",
    "remove_color_ink": True,
    "remove_handwriting": True,
    "textbook": "康軒",
}
