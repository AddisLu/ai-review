"""XP, coins, streaks, levels, badges, daily quests, weekly league and shop
(the Duolingo / KooBits motivation layer)."""
import hashlib
import json
import math
import random
from datetime import date, datetime, timedelta

from . import db

BADGES = {
    "first_scan": ("📸", "第一份試卷", "掃描第一份考卷"),
    "scan_10": ("🗂️", "整理達人", "掃描 10 份考卷"),
    "streak_3": ("🔥", "三天不間斷", "連續學習 3 天"),
    "streak_7": ("🌟", "一週全勤", "連續學習 7 天"),
    "streak_30": ("👑", "月冠軍", "連續學習 30 天"),
    "correct_50": ("✅", "答對 50 題", "累積答對 50 題"),
    "correct_300": ("🏅", "答對 300 題", "累積答對 300 題"),
    "fix_10": ("🩹", "錯題剋星", "10 題錯題變成已精熟"),
    "fix_50": ("🛡️", "錯題終結者", "50 題錯題變成已精熟"),
    "tutor_5": ("✍️", "動手解題", "完成 5 次手寫 AI 批改"),
    "drill_100": ("⚡", "心算小閃電", "心算快打累積答對 100 題"),
    "drill_fast": ("🚀", "神速", "心算快打 60 秒答對 20 題以上"),
    "duel_win_5": ("⚔️", "PK 高手", "PK 對戰贏 5 場"),
    "unit_3star": ("⭐", "單元三星", "任一單元闖關拿到三顆星"),
    "units_10": ("🗺️", "探險家", "完成 10 個單元闖關"),
    "challenge_7": ("🎯", "每日挑戰 7 次", "完成 7 次每日挑戰"),
    "perfect_challenge": ("💯", "全對挑戰", "每日挑戰 10 題全對"),
    "level_10": ("🎓", "等級 10", "升到等級 10"),
    "night_owl": ("🦉", "認真寶寶", "一天獲得 200 XP"),
}

SHOP = [
    {"id": "av_dog", "kind": "avatar", "value": "🐶", "name": "小狗", "price": 30},
    {"id": "av_fox", "kind": "avatar", "value": "🦊", "name": "狐狸", "price": 30},
    {"id": "av_panda", "kind": "avatar", "value": "🐼", "name": "熊貓", "price": 50},
    {"id": "av_koala", "kind": "avatar", "value": "🐨", "name": "無尾熊", "price": 50},
    {"id": "av_rabbit", "kind": "avatar", "value": "🐰", "name": "兔兔", "price": 50},
    {"id": "av_penguin", "kind": "avatar", "value": "🐧", "name": "企鵝", "price": 80},
    {"id": "av_unicorn", "kind": "avatar", "value": "🦄", "name": "獨角獸", "price": 150},
    {"id": "av_dragon", "kind": "avatar", "value": "🐲", "name": "小龍", "price": 200},
    {"id": "av_crown", "kind": "avatar", "value": "👸", "name": "公主", "price": 250},
    {"id": "th_strawberry", "kind": "theme", "value": "strawberry", "name": "草莓牛奶主題", "price": 100},
    {"id": "th_mint", "kind": "theme", "value": "mint", "name": "薄荷主題", "price": 100},
    {"id": "th_lavender", "kind": "theme", "value": "lavender", "name": "薰衣草主題", "price": 120},
    {"id": "th_night", "kind": "theme", "value": "night", "name": "星空夜間主題", "price": 150},
    {"id": "tt_math", "kind": "title", "value": "數學小天才", "name": "稱號：數學小天才", "price": 80},
    {"id": "tt_reader", "kind": "title", "value": "閱讀小書蟲", "name": "稱號：閱讀小書蟲", "price": 80},
    {"id": "tt_scientist", "kind": "title", "value": "小小科學家", "name": "稱號：小小科學家", "price": 80},
    {"id": "tt_master", "kind": "title", "value": "總複習大師", "name": "稱號：總複習大師", "price": 300},
    {"id": "freeze", "kind": "freeze", "value": "1", "name": "連勝保護卡（漏一天不斷火）", "price": 60},
]

QUESTS = [
    ("correct_10", "答對 10 題", 10, 15),
    ("review_5", "複習 5 題錯題", 5, 15),
    ("tutor_1", "完成 1 次手寫解題批改", 1, 15),
    ("drill_1", "玩 1 回合心算快打", 1, 10),
    ("unit_1", "完成 1 個單元闖關", 1, 15),
    ("challenge_1", "完成今日挑戰", 1, 20),
    ("xp_goal", "達成今日 XP 目標", 1, 10),
    ("duel_1", "打 1 場 PK 賽", 1, 10),
]

BOT_NAMES = ["小安", "阿哲", "Mia", "宥宥", "小芸", "Leo", "品妍", "子睿", "Ivy", "柏翰", "語彤", "Ken"]
BOT_AVATARS = ["🐻", "🐯", "🐸", "🐵", "🦁", "🐹", "🐮", "🐷", "🐔", "🐙", "🦉", "🐳"]


def level_of(xp: int) -> dict:
    lvl = int(math.sqrt(max(0, xp) / 40)) + 1
    lo, hi = 40 * (lvl - 1) ** 2, 40 * lvl ** 2
    return {"level": lvl, "cur": xp - lo, "need": hi - lo}


def xp_today(student_id: int) -> int:
    return db.scalar("SELECT COALESCE(SUM(xp),0) FROM xp_log WHERE student_id=? AND day=?",
                     (student_id, db.today())) or 0


def _touch_streak(s: dict):
    t = date.today()
    last = s["last_active"]
    if last == t.isoformat():
        return {}
    upd = {"last_active": t.isoformat()}
    if last:
        gap = (t - date.fromisoformat(last)).days
        if gap == 1:
            upd["streak"] = s["streak"] + 1
        elif gap == 2 and s["freeze"] > 0:
            upd["streak"] = s["streak"] + 1
            upd["freeze"] = s["freeze"] - 1
        else:
            upd["streak"] = 1
    else:
        upd["streak"] = 1
    upd["best_streak"] = max(s["best_streak"], upd["streak"])
    return upd


def current_streak(s: dict) -> int:
    """Streak shown in the UI: still alive if active today or yesterday
    (or two days ago with a freeze card)."""
    if not s["last_active"]:
        return 0
    gap = (date.today() - date.fromisoformat(s["last_active"])).days
    if gap <= 1 or (gap == 2 and s["freeze"] > 0):
        return s["streak"]
    return 0


def award(student_id: int, xp: int, coins: int = 0, reason: str = "") -> dict:
    s = db.one("SELECT * FROM students WHERE id=?", (student_id,))
    if not s:
        return {}
    before = xp_today(student_id)
    upd = _touch_streak(s)
    upd.update({"xp": s["xp"] + xp, "coins": s["coins"] + coins})
    goal_bonus = 0
    if before < s["daily_goal"] <= before + xp:
        goal_bonus = 10
        upd["coins"] += goal_bonus
    db.update("students", student_id, upd)
    db.insert("xp_log", {"student_id": student_id, "day": db.today(), "xp": xp,
                         "coins": coins + goal_bonus, "reason": reason, "created_at": db.now()})
    old, new = level_of(s["xp"]), level_of(s["xp"] + xp)
    return {"xp": xp, "coins": coins + goal_bonus, "goal_reached": bool(goal_bonus),
            "level_up": new["level"] if new["level"] > old["level"] else 0}


def _count(sql, args):
    return db.scalar(sql, args) or 0


def quest_progress(student_id: int) -> list[dict]:
    d = db.today()
    day_start = d + "T00:00:00"
    done = {r["quest"] for r in db.q("SELECT quest FROM quests_done WHERE student_id=? AND day=?",
                                     (student_id, d))}
    att = lambda extra, *a: _count(  # noqa: E731
        f"SELECT COUNT(*) FROM attempts WHERE student_id=? AND created_at>=? {extra}",
        (student_id, day_start, *a))
    values = {
        "correct_10": att("AND correct=1"),
        "review_5": att("AND mode='review'"),
        "tutor_1": att("AND mode='tutor'"),
        "drill_1": att("AND mode='drill'"),
        "unit_1": att("AND mode='unit'"),
        "challenge_1": att("AND mode='challenge_done'"),
        "duel_1": att("AND mode='duel'"),
        "xp_goal": 1 if xp_today(student_id) >= (db.scalar("SELECT daily_goal FROM students WHERE id=?",
                                                            (student_id,)) or 50) else 0,
    }
    # Three quests per day, picked deterministically from the date.
    seed = int(hashlib.md5(f"{d}-{student_id}".encode()).hexdigest(), 16)
    rnd = random.Random(seed)
    picks = rnd.sample(QUESTS, 3)
    out = []
    for qid, name, target, reward in picks:
        v = min(values.get(qid, 0), target)
        out.append({"id": qid, "name": name, "target": target, "value": v, "reward": reward,
                    "done": v >= target, "claimed": qid in done})
    return out


def claim_quest(student_id: int, quest: str) -> dict:
    for q in quest_progress(student_id):
        if q["id"] == quest and q["done"] and not q["claimed"]:
            db.execute("INSERT OR IGNORE INTO quests_done(student_id,day,quest) VALUES(?,?,?)",
                       (student_id, db.today(), quest))
            return award(student_id, 0, q["reward"], f"任務：{q['name']}")
    return {}


def check_badges(student_id: int) -> list[str]:
    s = db.one("SELECT * FROM students WHERE id=?", (student_id,))
    have = {r["badge"] for r in db.q("SELECT badge FROM badges WHERE student_id=?", (student_id,))}
    c = lambda sql: _count(sql, (student_id,))  # noqa: E731
    cond = {
        "first_scan": lambda: c("SELECT COUNT(*) FROM exams WHERE student_id=? AND status='ready'") >= 1,
        "scan_10": lambda: c("SELECT COUNT(*) FROM exams WHERE student_id=? AND status='ready'") >= 10,
        "streak_3": lambda: s["best_streak"] >= 3,
        "streak_7": lambda: s["best_streak"] >= 7,
        "streak_30": lambda: s["best_streak"] >= 30,
        "correct_50": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? AND correct=1") >= 50,
        "correct_300": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? AND correct=1") >= 300,
        "fix_10": lambda: c("SELECT COUNT(*) FROM student_q WHERE student_id=? AND is_wrong=1 AND mastered=1") >= 10,
        "fix_50": lambda: c("SELECT COUNT(*) FROM student_q WHERE student_id=? AND is_wrong=1 AND mastered=1") >= 50,
        "tutor_5": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? AND mode='tutor'") >= 5,
        "drill_100": lambda: (db.scalar("SELECT COALESCE(SUM(CAST(answer AS INTEGER)),0) FROM attempts "
                                        "WHERE student_id=? AND mode='drill'", (student_id,)) or 0) >= 100,
        "drill_fast": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? AND mode='drill' "
                                "AND CAST(answer AS INTEGER)>=20 AND seconds<=60") >= 1,
        "duel_win_5": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? AND mode='duel' AND correct=1") >= 5,
        "unit_3star": lambda: c("SELECT COUNT(*) FROM unit_progress WHERE student_id=? AND stars>=3") >= 1,
        "units_10": lambda: c("SELECT COUNT(*) FROM unit_progress WHERE student_id=? AND stars>=1") >= 10,
        "challenge_7": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? AND mode='challenge_done'") >= 7,
        "perfect_challenge": lambda: c("SELECT COUNT(*) FROM attempts WHERE student_id=? "
                                       "AND mode='challenge_done' AND correct=1") >= 1,
        "level_10": lambda: level_of(s["xp"])["level"] >= 10,
        "night_owl": lambda: xp_today(student_id) >= 200,
    }
    new = []
    for b, fn in cond.items():
        if b not in have and fn():
            db.execute("INSERT OR IGNORE INTO badges(student_id,badge,earned_at) VALUES(?,?,?)",
                       (student_id, b, db.now()))
            new.append(b)
    if new:
        award(student_id, 0, 10 * len(new), "獲得徽章")
    return new


def badge_list(student_id: int) -> list[dict]:
    have = {r["badge"]: r["earned_at"] for r in
            db.q("SELECT badge, earned_at FROM badges WHERE student_id=?", (student_id,))}
    return [{"id": k, "icon": v[0], "name": v[1], "desc": v[2], "earned_at": have.get(k, "")}
            for k, v in BADGES.items()]


def buy(student_id: int, item_id: str) -> dict:
    s = db.one("SELECT * FROM students WHERE id=?", (student_id,))
    item = next((i for i in SHOP if i["id"] == item_id), None)
    if not item:
        return {"error": "找不到商品"}
    owned = s["owned"] or []
    if item["kind"] != "freeze" and item_id in owned:
        return {"error": "已經擁有了"}
    if s["coins"] < item["price"]:
        return {"error": "金幣不夠喔，再多練習幾題吧！"}
    upd = {"coins": s["coins"] - item["price"]}
    if item["kind"] == "freeze":
        upd["freeze"] = s["freeze"] + 1
    else:
        upd["owned"] = owned + [item_id]
    db.update("students", student_id, upd)
    return {"ok": True}


def week_bounds() -> tuple[str, str, float]:
    t = datetime.now()
    start = (t - timedelta(days=t.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = (t - start).total_seconds() / (7 * 86400)
    return start.strftime("%Y-%m-%d"), (start + timedelta(days=7)).strftime("%Y-%m-%d"), elapsed


def league(student_id: int) -> dict:
    """Weekly leaderboard: family members plus friendly bots whose pace is
    scaled to the child's own recent average so the race stays close."""
    start, end, elapsed = week_bounds()
    rows = db.q("SELECT s.id, s.name, s.avatar, COALESCE(SUM(x.xp),0) AS xp FROM students s "
                "LEFT JOIN xp_log x ON x.student_id=s.id AND x.day>=? AND x.day<? "
                "WHERE s.role='student' OR s.id=? GROUP BY s.id",
                (start, end, student_id))
    prev = db.scalar("SELECT COALESCE(SUM(xp),0) FROM xp_log WHERE student_id=? AND day>=? AND day<?",
                     (student_id, (date.fromisoformat(start) - timedelta(days=28)).isoformat(), start)) or 0
    base = max(150, prev / 4)
    rnd = random.Random(f"{start}-{student_id}")
    board = [{"name": r["name"], "avatar": r["avatar"], "xp": r["xp"], "me": r["id"] == student_id}
             for r in rows]
    for i in range(max(3, 10 - len(board))):
        pace = base * rnd.uniform(0.4, 1.6)
        jitter = rnd.uniform(0.85, 1.15)
        board.append({"name": BOT_NAMES[i], "avatar": BOT_AVATARS[i],
                      "xp": int(pace * min(1.0, elapsed * jitter)), "me": False, "bot": True})
    board.sort(key=lambda r: -r["xp"])
    for i, r in enumerate(board, 1):
        r["rank"] = i
    return {"week_start": start, "week_end": end, "board": board,
            "promote": 3, "days_left": max(0, 7 - int(elapsed * 7))}


def summary(student_id: int) -> dict:
    s = db.one("SELECT * FROM students WHERE id=?", (student_id,))
    lv = level_of(s["xp"])
    return {**{k: s[k] for k in ("id", "name", "grade", "avatar", "theme", "title", "xp", "coins",
                                 "daily_goal", "freeze", "best_streak")},
            "owned": s["owned"] or [], "streak": current_streak(s), "level": lv,
            "xp_today": xp_today(student_id), "active_today": s["last_active"] == db.today()}


def activity_calendar(student_id: int, days: int = 84) -> list[dict]:
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    rows = {r["day"]: r["xp"] for r in db.q(
        "SELECT day, SUM(xp) AS xp FROM xp_log WHERE student_id=? AND day>=? GROUP BY day",
        (student_id, since))}
    return [{"day": (date.today() - timedelta(days=i)).isoformat(),
             "xp": rows.get((date.today() - timedelta(days=i)).isoformat(), 0)}
            for i in range(days - 1, -1, -1)]


def dumps(o):
    return json.dumps(o, ensure_ascii=False)
