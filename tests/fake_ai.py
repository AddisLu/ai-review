"""Deterministic stand-ins for the Claude calls so the whole app can be tested
offline. Shapes match the JSON schemas in app/prompts.py."""
from app import ai

PAGE = {
    "subject": "數學", "title": "六年級數學 第三單元 小考", "grade": 6, "rotation": 0, "layout": "horizontal",
    "notes": "",
    "handwriting_boxes": [[355, 400, 500, 445]],
    "questions": [
        {"number": "1", "section": "一、選擇題（每題 10 分）", "qtype": "選擇題",
         "stem": "（　　）下列哪一個是 24 和 36 的最大公因數？", "options": ["6", "12", "18", "72"],
         "box": [20, 140, 1000, 215], "figure_box": [], "student_answer": "2", "teacher_mark": "correct",
         "highlighted": False, "marked": False, "unit": "最大公因數與最小公倍數"},
        {"number": "2", "section": "一、選擇題（每題 10 分）", "qtype": "選擇題",
         "stem": "（　　）一個圓的半徑是 5 公分，圓面積是多少平方公分？（圓周率 3.14）",
         "options": ["31.4", "78.5", "15.7", "314"], "box": [20, 215, 1000, 300], "figure_box": [],
         "student_answer": "1", "teacher_mark": "wrong", "highlighted": False, "marked": False,
         "unit": "圓面積與扇形面積"},
        {"number": "3", "section": "二、計算題（每題 20 分）", "qtype": "計算題",
         "stem": "計算 $\\frac{2}{3} + \\frac{3}{4}$ = ＿＿＿", "options": [], "box": [20, 320, 1000, 365],
         "figure_box": [], "student_answer": "17/12", "teacher_mark": "none", "highlighted": False,
         "marked": False, "unit": "異分母分數的加減"},
        {"number": "4", "section": "二、計算題（每題 20 分）", "qtype": "應用題",
         "stem": "小明有 120 元，買書用了 $\\frac{3}{5}$，還剩下多少元？", "options": [],
         "box": [20, 385, 1000, 600], "figure_box": [60, 430, 360, 560], "student_answer": "48",
         "teacher_mark": "none", "highlighted": False, "marked": True, "unit": "分數的乘法"},
        {"number": "5", "section": "二、計算題（每題 20 分）", "qtype": "應用題",
         "stem": "上圖長方形長 12 公分、寬 8 公分，面積是多少？", "options": [],
         "box": [20, 580, 1000, 620], "figure_box": [], "student_answer": "", "teacher_mark": "none",
         "highlighted": False, "marked": False, "unit": "三角形與四邊形的面積"},
    ],
}

ANSWERS = ["② 12", "② 78.5", "$1\\frac{5}{12}$", "48 元", "96 平方公分"]
CHOICES = [2, 2, 0, 0, 0]

calls = []


def _q(i, unit="分數的乘法"):
    return {"qtype": "填充題", "stem": f"練習題 {i}：$\\frac{{1}}{{2}} + \\frac{{1}}{{4}}$ = ？", "options": [],
            "answer": "$\\frac{3}{4}$", "choice_index": 0, "explanation": "通分後相加。",
            "steps": ["通分", "相加"], "hints": ["想想通分", "分母變 4", "2/4 + 1/4"],
            "key_points": ["通分"], "mistakes": "分母直接相加", "qtype_tip": "先通分", "unit": unit,
            "difficulty": 2, "level": "basic", "bar_model": {"enabled": False, "caption": "", "bars": []}}


async def extract_page(image, subject_hint=""):
    calls.append("extract")
    assert image[:2] == b"\xff\xd8"  # JPEG
    return PAGE


async def extract_region(image):
    calls.append("region")
    return {"questions": [{"number": "6", "section": "", "qtype": "填充題", "stem": "框選出來的題目",
                           "options": [], "student_answer": "", "teacher_mark": "wrong", "unit": "",
                           "subject": "數學", "has_figure": False}]}


async def solve(items, images, effort=None):
    calls.append("solve")
    out = []
    for it in items:
        n = int(PAGE["questions"][[q["stem"] for q in PAGE["questions"]].index(it["stem"])]["number"]) - 1 \
            if it["stem"] in [q["stem"] for q in PAGE["questions"]] else 0
        out.append({"index": it["index"], "qtype": it["qtype"], "stem": it["stem"], "options": it["options"],
                    "answer": ANSWERS[n], "choice_index": CHOICES[n], "explanation": "詳解內容",
                    "steps": ["步驟一", "步驟二"], "hints": ["提示1", "提示2", "提示3"], "key_points": ["重點"],
                    "mistakes": "常見錯誤", "qtype_tip": "題型解析", "unit": "", "difficulty": 2,
                    "student_result": "wrong" if n == 3 else "unknown",
                    "bar_model": {"enabled": n == 3, "caption": "120 元", "bars": [
                        {"label": "全部", "note": "120 元", "segments": [
                            {"label": "用掉", "size": 3, "highlight": False},
                            {"label": "剩下", "size": 2, "highlight": True}]}] if n == 3 else []}})
    return out


async def verify_answers(items, images):
    calls.append("verify")
    assert len(items) == len(images) and all(i[:8] == b"\x89PNG\r\n\x1a\n" for i in images)
    return [{"index": it["index"], "ok": "最大公因數" not in it["stem"], "choice_index": 0, "steps": ["看圖", "再算一次"],
             "answer": "" if "最大公因數" not in it["stem"] else "複查後的答案",
             "explanation": "" if "最大公因數" not in it["stem"] else "複查後的詳解", "why": "原本看錯圖"} for it in items]


async def tutor(qd, work_image, figure=None):
    calls.append("tutor")
    return {"recognized_steps": [{"text": "$120 \\times \\frac{3}{5} = 72$", "status": "ok", "comment": ""},
                                 {"text": "$120 - 72 = 48$", "status": "ok", "comment": ""}],
            "final_answer": "48 元", "result": "correct", "first_error_step": 0, "error_type": "無",
            "diagnosis": "", "concept": "用掉的是全部的 3/5", "next_hint": "挑戰題", "encouragement": "很棒",
            "her_thinking": "你先算用掉的錢，再用全部減掉", "follow_up_question": "為什麼要用 120 減掉 72？",
            "review_units": []}


async def hint(qd, level, work_image=None, figure=None):
    calls.append("hint")
    return {"hint": f"AI 提示 {level}", "guiding_question": "想想看？", "look_at": ""}


async def similar(qd, n=3, difficulty="same", figure=None):
    calls.append("similar")
    return [_q(i, qd.get("unit") or "分數的乘法") for i in range(n)]


async def generate(subject, grade, unit, n=5, difficulty="mix", qtypes="", extra="", level=""):
    calls.append("generate")
    return [_q(i, unit) for i in range(n)]


async def knowledge(subject, grade, unit, extra=""):
    calls.append("knowledge")
    return {"title": unit, "intro": "介紹", "key_points": [{"title": "重點", "content": "內容"}],
            "formulas": [{"name": "圓面積", "formula": "$r \\times r \\times 3.14$", "meaning": "意思", "example": "例"}],
            "question_types": [{"name": "題型", "how_to_spot": "看到", "steps": ["一", "二"],
                                "example_question": "例題", "example_solution": "解答"}],
            "mistakes": [{"wrong": "錯", "right": "對", "why": "因為"}], "mnemonics": ["口訣"],
            "real_life": "生活", "bar_model": {"enabled": False, "caption": "", "bars": []}}


async def judge(stem, answer, student):
    calls.append("judge")
    return {"correct": "48" in student, "feedback": "AI 判斷"}


async def report(data):
    calls.append("report")
    return {"summary": "整體不錯", "strengths": ["計算"], "weaknesses": [{"unit": "圓", "issue": "公式", "advice": "多練"}],
            "plan": [{"day": "第1天", "task": "複習圓"}], "message_to_child": "加油"}


async def stream_chat(system_extra, messages, effort="low", context=""):
    calls.append("chat")
    for t in ["你好，", "我們一起想想看！"]:
        yield t


async def read_answers(questions, images):
    calls.append("read_answers")
    return [{"id": q["id"], "answer": "③"} for q in questions]


async def school_header(image):
    calls.append("school")
    return {"school": True, "evidence": "＿年＿班 ＿號 姓名", "term": "上學期 期中評量"}


async def chapters(subject, items):
    calls.append("chapters")
    return {q["id"]: "6.1" if "水" in (q.get("stem") or "") else "-" for q in items}


async def grade_answers(items, images, closeups=None, careful=False):
    calls.append("grade")
    return [{"id": it["id"], "result": "correct" if i % 2 == 0 else "wrong", "read_as": it.get("student") or "8",
             "comment": "" if i % 2 == 0 else "單位要寫"} for i, it in enumerate(items)]


async def detect_layout(images):
    calls.append("layout")
    return {"direction": "horizontal", "orientation": "portrait", "zhuyin": False}


async def sketch(qd):
    calls.append("sketch")
    return {"svg": "<svg viewBox='0 0 300 120'><rect x='10' y='10' width='200' height='60' fill='#DCE7FF' stroke='#000'/><text x='220' y='45'>?</text></svg>",
            "caption": "線段圖"}


VIS = {"type": "fraction_bar", "title": "分數條", "caption": "用掉 3 份、剩 2 份",
       "params_json": '{"bars":[{"label":"全部","parts":5,"shaded":3}]}'}


async def visualize(qd, figure=None):
    calls.append("visualize")
    return {"concept": "先想清楚「全部」是多少，再算其中的幾分之幾。", "visuals": [VIS]}


async def lesson(items):
    calls.append("lesson")
    return {"title": "觀念教學重點", "intro": "先把觀念弄懂！", "tips": ["看清楚單位"],
            "concepts": [{"title": "分數的乘法", "unit": "分數的乘法", "explain": "全部 × 幾分之幾", "rule": "全部 × 分數",
                          "example_question": "100 的 1/4 是多少？", "example_solution": "100 × 1/4 = 25",
                          "mistake": "忘記先算剩下的部分", "visual": VIS, "question_numbers": [it["n"] for it in items[:2]]}]}


async def reteach(qd, used, n=3, figure=None):
    calls.append("reteach")
    return {"diagnosis": "可能把用掉的當成剩下的", "approaches": [
        {"name": f"方法{i}", "why": "比較直觀", "explanation": "說明", "steps": ["一", "二"], "visual": VIS} for i in range(n)],
        "check_question": {"question": "100 的 1/4？", "answer": "25"}, "prerequisite": {"unit": "", "reason": ""},
        "encouragement": "再試一次一定行"}


async def example_hint(qd, figure=None):
    calls.append("example_hint")
    return {"example_question": "60 元用了 1/3，剩多少？", "worked_steps": ["1 − 1/3 = 2/3", "60 × 2/3 = 40"], "connect": "60 對應 120"}


async def coach(qd, grade):
    calls.append("coach")
    return {"summary": "考分數乘法", "how_to_start": "我們一起畫畫看", "questions_to_ask": ["全部是多少？"], "if_stuck": "畫 5 格",
            "avoid": ["直接說答案"], "everyday_example": "分披薩", "check": "換數字再講一次"}


async def steps_text(qd, steps):
    calls.append("steps")
    return {"recognized_steps": [{"text": s, "status": "ok", "comment": ""} for s in steps.splitlines()],
            "final_answer": steps.splitlines()[-1], "result": "wrong", "first_error_step": 2, "error_type": "計算錯誤",
            "diagnosis": "第二步乘錯", "concept": "先算 1 份", "next_hint": "120 ÷ 5 = ?", "encouragement": "第一步很好", "review_units": []}


async def chat_note(qd, history):
    calls.append("note")
    return {"title": "剩下的分數", "misconception": "我原本以為…", "correct_idea": "先算剩下幾份", "remember": "先找全部", "example": "例"}


async def diagnose(qd, wrong, figure=None):
    calls.append("diagnose")
    return {"likely_cause": "你可能算的是用掉的錢，題目問的是剩下的", "error_type": "題意理解錯誤",
            "tip": "先圈出題目問的是「剩下」還是「用掉」", "confident": True}


async def tutor_quick(qd, work_image, figure=None):
    calls.append("tutor_quick")
    return {"result": "correct", "first_error_step": 0, "headline": "看起來全部都對！"}


async def check_visual(context, visual, png, grade=6):
    calls.append("check_visual")
    bad = "亂" in (visual.get("title") or "")
    return {"ok": not bad, "score": 2 if bad else 5, "problems": ["標籤重疊、份數和題目對不上"] if bad else []}


async def fix_visual(context, visual, problems, grade=6):
    calls.append("fix_visual")
    if "壞到底" in (visual.get("title") or ""):
        return visual  # still bad: gets dropped
    return {**VIS, "title": "重畫的分數條"}


async def render(visual):
    calls.append("render")
    return b"\x89PNG fake"


async def classify_exam(title, header, kinds):
    calls.append("classify_exam")
    return next((k["id"] for k in kinds if k["name"][:2] in title), "")


async def upgrade_question(qd, crop, figure):
    calls.append("upgrade")
    fig = bool(figure)
    return {"stem": (qd.get("stem") or "").strip() + "", "options": qd.get("options") or [],
            "figure_kind": "svg" if fig else "none", "figure_position": "right",
            "table": {"header": [], "rows": []},
            "svg": "<svg viewBox='0 0 200 100'><rect x='10' y='10' width='80' height='60' fill='none' stroke='#000'/><text x='20' y='90'>10cm</text></svg>" if fig else "",
            "figure_facts": qd.get("figure_facts") or "", "answer": qd.get("answer") or "1",
            "choice_index": int(qd.get("choice_index") or 0), "steps": qd.get("steps") or ["一", "二"],
            "explanation": qd.get("explanation") or "詳細說明", "option_notes": ["① 對：…", "② 錯：…"] if qd.get("options") else [], "fixed": ""}


async def check_figure(original, redrawn, stem):
    calls.append("figure_check")
    return {"same": True, "problems": []}


async def fix_figure(original, svg, problems, stem):
    return svg or "<svg viewBox='0 0 200 100'><circle cx='50' cy='50' r='30' fill='none' stroke='#000'/></svg>"


async def read_continuation(question, options, top):
    calls.append("continuation")
    return {"options": [], "text": ""}


async def page_turn(image):
    calls.append("page_turn")
    return 0


def install():
    from app import vischeck
    vischeck.render = render
    for name in ("check_visual", "fix_visual", "classify_exam", "upgrade_question", "check_figure", "fix_figure"):
        setattr(ai, name, globals()[name])
    for name in ("extract_page", "extract_region", "solve", "tutor", "hint", "similar", "generate",
                 "knowledge", "judge", "report", "stream_chat", "visualize", "lesson", "reteach", "verify_answers",
                 "example_hint", "coach", "steps_text", "chat_note", "diagnose", "tutor_quick", "sketch", "detect_layout", "grade_answers", "read_answers", "chapters", "school_header", "page_turn", "read_continuation"):
        setattr(ai, name, globals()[name])
