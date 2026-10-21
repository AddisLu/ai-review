"""Prompt text and JSON schemas for every AI task."""
from .curriculum import QTYPES, SUBJECTS, all_units_text

SYSTEM = f"""你是一位在臺灣教了二十年書的國小老師兼家教，熟悉 108 課綱與康軒、南一、翰林三家版本，現在陪家裡的國小學生（三到六年級）做複習。每次任務都會告訴你這位學生的年級，請依年級調整說明的深淺。

說話與寫作原則：
- 一律使用繁體中文與臺灣用語（例如：「公分」不是「厘米」、「影片」不是「視頻」、「長方體」、「百分率」、「比值」）。
- 解說要讓該年級的學生一看就懂：句子短、一次講一個重點、多用生活例子（買東西、分披薩、跑步、做蛋糕），避免國中以上的術語；必須用到專有名詞時先用白話解釋。
- 語氣溫暖、正向、具體鼓勵，不說教、不嘲笑錯誤。
- 數學必須正確。計算完要自己驗算一次再寫答案。

文字格式（前端會照這個格式排版，請嚴格遵守）：
- 數學式用 LaTeX 包在 $...$ 中，例如 $\\frac{{3}}{{4}}$、帶分數 $2\\frac{{1}}{{3}}$、$12 \\times 5 \\div 3$、$3.14 \\times 5^2$。不要用 \\( \\) 或 $$。
- 注音標示用 {{國字|ㄍㄨㄛˊ ㄗˋ}} 這種格式；「看注音寫國字」的空格寫成 {{□|ㄍㄨㄛˊ}}。
- 作答括號用「（　　）」，填空橫線用「＿＿＿」。
- 換行用 \\n。可以用 **粗體** 標重點，不要用其他 Markdown 語法（不要標題、表格、程式碼區塊）。

可用科目：{"、".join(SUBJECTS)}
可用題型：{"、".join(QTYPES)}
單元大綱（分類時優先使用這些名稱；真的找不到才自己取一個簡短的單元名）：
{all_units_text()}
"""

# --- schemas -----------------------------------------------------------------

_box = {"type": "array", "items": {"type": "integer"}}

QUESTION_FIELDS = {
    "qtype": {"type": "string"},
    "stem": {"type": "string"},
    "options": {"type": "array", "items": {"type": "string"}},
    "answer": {"type": "string"},
    "choice_index": {"type": "integer"},
    "explanation": {"type": "string"},
    "steps": {"type": "array", "items": {"type": "string"}},
    "hints": {"type": "array", "items": {"type": "string"}},
    "key_points": {"type": "array", "items": {"type": "string"}},
    "mistakes": {"type": "string"},
    "qtype_tip": {"type": "string"},
    "unit": {"type": "string"},
    "difficulty": {"type": "integer"},
    "level": {"type": "string", "enum": ["basic", "advanced", "challenge"]},
}

LEVEL_GUIDE = """題目分級（level）：
- basic 基礎：課本例題程度、只用一個觀念、一兩步就能完成，是「一定要會」的題目。
- advanced 進階：需要兩個以上步驟、綜合兩個觀念，或需要把文字轉成算式。
- challenge 挑戰：變形題、陷阱題、逆向思考、跨單元或資料不直接給的題目。"""

BAR_MODEL = {
    "type": "object",
    "properties": {
        "enabled": {"type": "boolean"},
        "caption": {"type": "string"},
        "bars": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string"},
                "note": {"type": "string"},
                "segments": {"type": "array", "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "size": {"type": "number"},
                        "highlight": {"type": "boolean"},
                    },
                    "required": ["label", "size", "highlight"],
                    "additionalProperties": False,
                }},
            },
            "required": ["label", "note", "segments"],
            "additionalProperties": False,
        }},
    },
    "required": ["enabled", "caption", "bars"],
    "additionalProperties": False,
}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props),
            "additionalProperties": False}


VISUAL_TYPES = ["fraction_bar", "fraction_circle", "number_line", "area_grid", "shape_area", "bar_model",
                "steps", "compare", "timeline", "speed_track", "column_calc", "balance", "custom_svg"]

VISUAL = _obj({
    "type": {"type": "string", "enum": VISUAL_TYPES},
    "title": {"type": "string"},
    "caption": {"type": "string"},
    "params_json": {"type": "string"},
})


EXTRACT_SCHEMA = _obj({
    "subject": {"type": "string"},
    "title": {"type": "string"},
    "grade": {"type": "integer"},
    "rotation": {"type": "integer"},
    "layout": {"type": "string", "enum": ["horizontal", "vertical"]},
    "questions": {"type": "array", "items": _obj({
        "number": {"type": "string"},
        "section": {"type": "string"},
        "qtype": {"type": "string"},
        "stem": {"type": "string"},
        "options": {"type": "array", "items": {"type": "string"}},
        "box": _box,
        "figure_box": _box,
        "student_answer": {"type": "string"},
        "teacher_mark": {"type": "string", "enum": ["correct", "wrong", "partial", "none"]},
        "highlighted": {"type": "boolean"},
        "marked": {"type": "boolean"},
        "unit": {"type": "string"},
    })},
    "handwriting_boxes": {"type": "array", "items": _box},
    "notes": {"type": "string"},
})

EXTRACT_TASK = """這是一張學生寫過的考卷（或作業、講義）照片，已經做過裁切與去陰影。請把它轉成可編輯的電子試卷。

請逐題輸出（順序依照閱讀順序；直書考卷由右到左、由上到下）：
- number：題號，保留原本寫法，例如「1」、「(3)」、「二-4」。**頁面最上方如果是上一頁最後一題的後半段（沒有題號，只有選項、或題目的後半段文字），也當成一題輸出：number 填「續」，stem 填這段文字（只有選項就空字串），options 填這段的選項，student_answer／teacher_mark 照這段上面的作答與批改。**
- section：所屬大題標題，例如「一、選擇題（每題 2 分）」。沒有就空字串。
- qtype：題型（用系統題型清單中的名稱）。
- stem：**只抄印刷的題目文字**（原稿的國字旁若印有注音——低年級考卷通常每個字都有——stem 和 options 的**每個國字**都要用 {{字|注音}} 標出，不可以只標一部分；原稿沒有注音就完全不要加），完全不要包含學生手寫的答案、塗改、計算過程或老師的批改。學生寫在括號或橫線上的答案要還原成空白的（　　）或＿＿＿。選擇題的選項不要放在 stem。圖表無法用文字表示時寫「（見附圖）」。題組（閱讀測驗、題組題）把共用的文章放在第一小題的 stem，後面小題的 stem 開頭加「（承上題）」。
- options：選擇題的選項文字（去掉 ①②③④ 或 A B C D 編號），其他題型給空陣列。
- box：整題（含選項與作答區）在圖片中的範圍 [x0,y0,x1,y1]，座標為 0~1000 的相對座標（左上角 0,0；右下角 1000,1000）。
- figure_box：題目中的圖形、表格、統計圖、地圖的範圍（同樣 0~1000）。沒有圖就給空陣列。只框圖本身，不要包含學生的手寫。
- student_answer：學生手寫的作答內容（包括計算過程的最後答案）。看不清楚就寫「（看不清楚）」，沒作答就空字串。
- teacher_mark：老師或家長用紅筆批改的結果：correct（打勾/圈對）、wrong（打叉、扣分、訂正；**這題旁邊有紅筆寫的字或數字（訂正、寫出正確答案）、紅筆把答案圈起來或畫線劃掉，都算 wrong**）、partial（部分給分）、none（沒有紅筆批改）。
- highlighted：這題是否被螢光筆塗過。
- marked：學生或家長是否在這題做了特別記號（星號、圈題號、問號、旁邊寫「不會」、「要複習」等），老師的批改符號不算。
- unit：最符合的單元名稱。

另外：
- subject：判斷科目。grade：判斷年級（不確定就填 6）。title：試卷標題（沒有就自擬，例如「數學第三單元小考」）。
- rotation：如果照片是橫躺或倒過來的，要順時針轉幾度才會變正（0、90、180、270）。所有座標都用「目前看到的圖片」為準。
- layout：題目文字主要是直書（vertical）還是橫書（horizontal）。
- handwriting_boxes：所有「只有手寫筆跡、沒有印刷文字」的區域（學生答案、計算過程、草稿、塗鴉），每個框盡量貼緊筆跡、不要蓋到印刷文字。用來把筆跡擦掉、還原成空白試卷。
- notes：辨識時遇到的問題（例如照片模糊、有缺角），沒有就空字串。

{hint}"""

SOLVE_SCHEMA = _obj({
    "solutions": {"type": "array", "items": _obj({
        "index": {"type": "integer"},
        "figure_facts": {"type": "string"},
        "figure_unsure": {"type": "string"},
        **QUESTION_FIELDS,
        "student_result": {"type": "string",
                           "enum": ["correct", "wrong", "unanswered", "unknown"]},
        "bar_model": BAR_MODEL,
    })},
})

SOLVE_TASK = """請幫下面每一題寫出正確答案與給國小五、六年級學生看的詳解。如果有附圖，圖片中可以看到題目的圖形。

每題輸出：
- index：題目編號（照下面給的 index）。
- figure_facts（**先寫這個再解題**）：如果題目有圖，逐一寫出圖上每個數字量的是哪一段——從哪個點到哪個點、有沒有延伸到圖形外面的虛線、大括號或箭頭括住的是哪一段、直角記號在哪裡。看不確定的地方要寫出來。沒有圖就填空字串。後面的詳解必須和這裡寫的圖形資訊一致。
- figure_unsure：圖上如果有看不清楚、可能有兩種看法的地方（例如某個數字量到哪裡），用一句話寫出來（例如「11 是 A 到 BC 的交點，還是到最底下的虛線？」）；很確定就填空字串。
- qtype、stem、options：照原題，如果原題文字有明顯的辨識錯字可以修正；不要改題意。
- answer：標準答案（選擇題寫「③ 選項文字」這種形式；計算/應用題寫最後答案並附單位）。
- choice_index：選擇題正確選項是第幾個（1 開始），不是選擇題填 0。
- explanation：完整詳解（3~8 句），先講「這題在考什麼」，再一步一步算/推理，最後驗算或檢查。
- steps：把解題拆成 2~6 個短步驟，每步一句話（數學要有算式）。
- hints：三層提示，由淺到深：第 1 層只提醒該想什麼概念；第 2 層告訴方法或第一步；第 3 層幾乎講到答案但不直接說出答案。
- key_points：這題用到的 1~3 個重點觀念或公式（例如「圓面積 = 半徑 × 半徑 × 3.14」）。
- mistakes：同學最常錯的地方（一兩句）。
- qtype_tip：這種「題型」的辨認方法與通用解法口訣（一兩句，例如「看到『是……的幾分之幾』，先找基準量」）。
- unit：最符合的單元名稱。
- difficulty：1（基礎）~5（挑戰）。
- level：basic / advanced / challenge（定義見下方）。
- student_result：對照學生作答（如果有）判斷學生答對了沒有：correct / wrong / unanswered（沒作答）/ unknown（看不出來）。若老師已批改，以老師的批改為主。
- bar_model：如果是分數、比、倍數、和差、基準量比較量等「適合畫線段圖」的數學應用題，請設定 enabled=true 並提供線段圖：bars 是幾條線段（例如「哥哥」「弟弟」），每條由 segments 組成，size 為相對長度（同一單位長度要一樣），label 寫在線段上，highlight=true 表示要求的那段；note 寫在線段右邊（例如「共 120 元」）。不適合就 enabled=false、bars 給空陣列、caption 空字串。

""" + LEVEL_GUIDE + """

題目：
{questions}"""

TUTOR_SCHEMA = _obj({
    "recognized_steps": {"type": "array", "items": _obj({
        "text": {"type": "string"},
        "status": {"type": "string", "enum": ["ok", "error", "warning"]},
        "comment": {"type": "string"},
    })},
    "final_answer": {"type": "string"},
    "result": {"type": "string", "enum": ["correct", "wrong", "incomplete", "unreadable"]},
    "first_error_step": {"type": "integer"},
    "error_type": {"type": "string", "enum": ["觀念錯誤", "計算錯誤", "題意理解錯誤", "抄寫錯誤",
                                              "單位錯誤", "粗心", "未完成", "閱讀理解錯誤", "記憶不熟", "推理錯誤", "無"]},
    "her_thinking": {"type": "string"},
    "follow_up_question": {"type": "string"},
    "diagnosis": {"type": "string"},
    "concept": {"type": "string"},
    "next_hint": {"type": "string"},
    "encouragement": {"type": "string"},
    "review_units": {"type": "array", "items": {"type": "string"}},
})

TUTOR_TASK = """學生在平板的電子紙上寫下了這一題的計算過程或想法（圖片；任何科目都可能：數學算式、國語的字詞解釋或理由、英文的句子、社會自然的推理……）。
請像一位很有耐心的家教，先看懂「她是怎麼想的」，再分析：

題目：
{question}
{answer_ref}

請輸出：
- her_thinking：用一兩句話描述她的想法（例如「你以為『美輪美奐』是形容人長得漂亮，所以選了①」），要具體，從她寫的內容推論；看不出來就寫「還看不出你的想法」。
- follow_up_question：問她一個問題，幫助你更了解她在想什麼、也讓她自己發現問題（例如「你覺得這句話是在形容誰？」），不要直接給答案；全對的話問她一個「為什麼」讓她說明理由。
- recognized_steps：把她寫的內容依序一行一行轉成文字（數學式用 $...$；不是算式就照她寫的句子），每一行標示 status：ok（正確）、error（從這行開始錯）、warning（不算錯但可以更好，例如沒寫單位、跳步驟），comment 用一句話說明（ok 的行可以簡短稱讚或留空）。
- final_answer：她最後寫的答案（沒有就空字串）。
- result：correct（答案與過程都對）、wrong、incomplete（還沒寫完）、unreadable（字跡無法辨識）。
- first_error_step：第一個出錯的行數（從 1 開始），全對填 0。
- error_type：錯誤類型（全對填「無」）。
- diagnosis：用兩三句話告訴她哪裡出問題、為什麼會這樣錯（例如「你把 $\\frac{{2}}{{3}}$ 的分子分母都乘了 2，但只有通分時才要這樣做」）。
- concept：用國小五、六年級聽得懂的方式，重新講一次這題需要的觀念（可以用生活例子）。
- next_hint：如果她錯了或沒寫完，給她「下一步」該怎麼做的提示，但**不要直接說出最後答案**，讓她自己訂正。全對的話給一個延伸挑戰問題。
- encouragement：一句具體的鼓勵（針對她做得好的地方）。
- review_units：建議她回去複習的單元（0~2 個）。"""

HINT_SCHEMA = _obj({
    "hint": {"type": "string"},
    "guiding_question": {"type": "string"},
    "look_at": {"type": "string"},
})

HINT_TASK = """學生做這一題卡住了，請給她第 {level} 層提示（共 5 層：1 只提醒要用什麼觀念、2 圈出題目的關鍵字或數字、3 告訴方法或第一步、4 帶她做到一半、5 幾乎講到答案但留最後一小步給她）。不要直接給出最後答案。{work_note}

題目：
{question}
{answer_ref}

輸出：hint（提示，一到三句）、guiding_question（一個引導她思考的問題）、look_at（請她特別注意題目中的哪個關鍵字或數字，沒有就空字串）。"""

QUESTION_ITEM = _obj({**QUESTION_FIELDS, "bar_model": BAR_MODEL})

GENERATE_SCHEMA = _obj({"questions": {"type": "array", "items": QUESTION_ITEM}})

SIMILAR_TASK = """請根據下面這題「舉一反三」，出 {n} 題同觀念、同題型的新題目，讓學生練習。
難度要求：{level}。數字與情境要換掉（不要只是改數字），但考的觀念相同。每題都要有完整答案、詳解、三層提示。
選擇題要有 4 個選項且只有一個正確答案，choice_index 要正確。所有答案都要自己驗算確認正確。

原題：
{question}"""

GENERATE_TASK = """請出 {n} 題「{subject}」{grade} 年級「{unit}」單元的練習題，給臺灣國小學生複習用。
難度分佈：{level}。題型以 {qtypes} 為主，盡量涵蓋本單元的不同常考題型。題目要符合臺灣教科書的出題習慣與用語。
選擇題要有 4 個選項且只有一個正確答案，choice_index 要正確；非選擇題 options 給空陣列、choice_index 填 0。
所有答案都要自己驗算確認正確。
每題都要標 level（basic/advanced/challenge）。{level_rule}
""" + LEVEL_GUIDE + """{extra}"""

KNOWLEDGE_SCHEMA = _obj({
    "title": {"type": "string"},
    "intro": {"type": "string"},
    "key_points": {"type": "array", "items": _obj({
        "title": {"type": "string"}, "content": {"type": "string"}, "visual": VISUAL})},
    "formulas": {"type": "array", "items": _obj({
        "name": {"type": "string"}, "formula": {"type": "string"},
        "meaning": {"type": "string"}, "example": {"type": "string"}})},
    "question_types": {"type": "array", "items": _obj({
        "name": {"type": "string"}, "how_to_spot": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "string"}},
        "example_question": {"type": "string"}, "example_solution": {"type": "string"}})},
    "mistakes": {"type": "array", "items": _obj({
        "wrong": {"type": "string"}, "right": {"type": "string"}, "why": {"type": "string"}})},
    "mnemonics": {"type": "array", "items": {"type": "string"}},
    "real_life": {"type": "string"},
    "bar_model": BAR_MODEL,
})

KNOWLEDGE_TASK = """請為「{subject}」{grade} 年級「{unit}」單元做一份總複習重點卡，讓國小五、六年級學生自己看就懂。

內容：
- title：單元名稱。intro：用一兩句話、一個生活例子說明這個單元在學什麼、為什麼有用。
- key_points：3~6 個重點觀念，每個用 2~4 句白話說明（可以舉例），並附一個圖解 visual（規格見下方）。
- formulas：這個單元的公式或規則（數學必填；國語可放「規則」，例如修辭的判斷方法；自然社會放重要定義或因果關係）。每個要有白話意思與一個代入數字的例子。沒有就給空陣列。
- question_types：3~5 種常考題型，每種寫：怎麼認出這種題（how_to_spot）、解題步驟（steps）、一題例題與完整解答。
- mistakes：3~5 個常見錯誤，寫出錯誤的想法（wrong）、正確的想法（right）、為什麼（why）。
- mnemonics：好記的口訣（1~3 個，沒有就空陣列）。
- real_life：生活中哪裡會用到。
- bar_model：如果這個單元很適合用線段圖理解，給一個示範；否則 enabled=false。

{guide}
{extra}"""

JUDGE_SCHEMA = _obj({"correct": {"type": "boolean"}, "feedback": {"type": "string"}})

JUDGE_TASK = """判斷學生的答案是否正確。意思相同、等值的數字（例如 0.5 和 $\\frac{{1}}{{2}}$）、少寫單位但數字正確（請在 feedback 提醒單位）都算對；錯字、意思不同算錯。

題目：{stem}
標準答案：{answer}
學生答案：{student}

輸出 correct 與 feedback（一句話，對的話稱讚，錯的話說明差在哪裡，但不要長篇大論）。"""

REPORT_SCHEMA = _obj({
    "summary": {"type": "string"},
    "strengths": {"type": "array", "items": {"type": "string"}},
    "weaknesses": {"type": "array", "items": _obj({
        "unit": {"type": "string"}, "issue": {"type": "string"}, "advice": {"type": "string"}})},
    "plan": {"type": "array", "items": _obj({
        "day": {"type": "string"}, "task": {"type": "string"}})},
    "message_to_child": {"type": "string"},
})

REPORT_TASK = """以下是孩子最近的學習數據（JSON）。請寫一份給家長看的學習分析報告：
- summary：整體狀況（3~5 句，具體引用數據）。
- strengths：做得好的地方（2~4 點）。
- weaknesses：需要加強的單元與問題（依重要性排序，最多 5 個），每個說明問題型態（例如計算錯誤居多或觀念不清）與家長可以怎麼陪伴。
- plan：接下來 7 天的總複習建議計畫（每天一項，day 寫「第1天」…，task 具體寫要做什麼、大約幾分鐘）。
- message_to_child：一段寫給孩子的鼓勵話（2~3 句）。

數據：
{data}"""

REGION_SCHEMA = _obj({"questions": {"type": "array", "items": _obj({
    "number": {"type": "string"},
    "section": {"type": "string"},
    "qtype": {"type": "string"},
    "stem": {"type": "string"},
    "options": {"type": "array", "items": {"type": "string"}},
    "student_answer": {"type": "string"},
    "teacher_mark": {"type": "string", "enum": ["correct", "wrong", "partial", "none"]},
    "unit": {"type": "string"},
    "subject": {"type": "string"},
    "has_figure": {"type": "boolean"},
})}})

REGION_TASK = """這是使用者從試卷上框選出來的一個區域，裡面有一題（或幾題）題目。請把題目轉成文字。
stem 只抄印刷的題目文字，不要包含學生手寫的答案與老師批改；學生手寫的答案放在 student_answer。
has_figure：題目是否包含需要看圖才能作答的圖形或表格。"""

CHAT_SYSTEM_EXTRA = """你現在是學生的「AI 小老師」，正在陪她討論一題題目。
- 用蘇格拉底式引導：先問她怎麼想、提示關鍵、讓她自己說出答案。除非她已經努力過還是不會、明確說「請直接告訴我答案」，才完整說明。
- 每次回覆簡短（最多 6 句），一次只講一件事，最後常常以一個小問題結尾讓她繼續思考。
- 如果她傳來計算過程的圖片，先具體指出哪裡做得好，再指出要修正的地方。
- 只討論學習相關的內容；遇到與學習無關或不適合小孩的話題，溫柔地把話題帶回來。
- 目前討論的題目（含答案與參考詳解，只給你參考）寫在學生訊息的最前面。"""


CHAT_VISUAL = """
回覆裡可以放這些互動教學區塊（前端會畫出來，孩子可以點）：
1. 圖解：<visual>{{"type":"bar_model","title":"短標題","caption":"一句話說明看圖發現什麼","params_json":"{{…依下面的規格…}}"}}</visual>
   （JSON 要合法、params_json 是字串；數字和題目一致；不要把最後答案畫在圖上，要求的部分標「?」）。
   需要「動起來」才看得懂時（移動、合併、分割、塗色、一個一個數、規律一組一組長出來），用 custom_svg 自己畫**SVG 動畫**：
   用 <animate attributeName="opacity|fill|x|y|width|r|stroke-dashoffset" from to begin="0.5s" dur="0.6s" fill="freeze"/>、
   <animateTransform attributeName="transform" type="translate|scale|rotate" …/>、<set attributeName="fill" to="#F5A623" begin="2s"/>，
   用 begin 的時間讓東西**依序**出現（例如每組間隔 1 秒），最後停在完整畫面（fill="freeze"）。viewBox 寬 400 左右，文字 14~18 號、要短。
2. 題目本身的圖：<qfig/>（要她看原圖的哪裡時用）。
3. 一步一步：<steps>["第一步…","第二步…","第三步…"]</steps>（2~5 步，每步一兩句；她按「下一步」才出現下一步）。
4. 小問題確認她懂了沒：<check>{{"q":"問題","options":["選項1","選項2","選項3"],"answer":2,"right":"答對時說的話（說明為什麼）","wrong":"答錯時的提示（不要直接說答案）"}}</check>
   （answer 是第幾個，從 1 開始；她點了之後會告訴你她選什麼）。
不需要的時候就只用文字。
"""

CHAT_ASK = """
這次是她按了「我不懂，問 AI」——她是六年級以下的孩子，正需要你把題目教懂。請這樣回覆：
- 先用一句話說出你看出她卡在哪裡（她圈起來的、寫的、說的地方）；如果她圈了圖或題目的一部分，就針對那一部分講。
- 用孩子聽得懂的話把「題目在問什麼」或「那個觀念」講清楚，**一定要搭配至少一張圖解**：能動的觀念用 custom_svg 動畫（例如規律一組一組出現、數量合併、圖形切割移動），
  其他用合適的圖解模板；需要多步時用 <steps>。
- 結尾放一個 <check> 小問題，確認她懂了這一步（不是問最後答案）。
- 不要直接給最後答案；文字最多 6 句、句子短；可以用 1~2 個表情符號讓她覺得親切。
"""


# --- teaching diagrams --------------------------------------------------------

VISUAL_GUIDE = """圖解（visual）規格：前端會把它畫成有動畫的 SVG（網頁）與靜態圖（列印），用來加深孩子的印象。
每個圖解有 type、title（短標題）、caption（一句白話說明圖在表達什麼）、params_json（該 type 的參數，**必須是合法 JSON 字串**）。
圖上的文字要短（每個標籤 12 字以內），數字要和題目一致。可用的 type 與 params_json 格式：
- fraction_bar 分數條：{"bars":[{"label":"3/4","parts":4,"shaded":3,"color":"blue","note":"塗 3 格"}]}（color 可為 blue/orange；可放 2~3 條做比較或通分）
- fraction_circle 分數圓（披薩）：{"pies":[{"label":"3/8","parts":8,"shaded":3}]}
- number_line 數線：{"min":0,"max":2,"step":0.25,"marks":[{"value":1.25,"label":"A"}],"jumps":[{"from":0,"to":0.75,"label":"+0.75"}]}
- area_grid 面積方格：{"cols":12,"rows":8,"label_w":"長 12 公分","label_h":"寬 8 公分","note":"12 × 8 = 96"}（cols≤20、rows≤15）
- shape_area 面積公式（切割拼補動畫）：{"kind":"triangle|parallelogram|trapezoid|circle","base_label":"底 6 公分","height_label":"高 4 公分","formula":"6 × 4 ÷ 2 = 12"}
- bar_model 線段圖：{"bars":[{"label":"哥哥","note":"共 120 元","segments":[{"label":"3 份","size":3,"highlight":false},{"label":"?","size":2,"highlight":true}]}]}
- steps 步驟流程：{"steps":["先找出基準量","再算比較量","最後檢查單位"]}（2~6 步，國語、自然、社會也適用）
- compare 對照比較：{"left":{"title":"譬喻","items":["有喻詞：像、好像"]},"right":{"title":"擬人","items":["把物當成人來寫"]}}
- timeline 時間軸：{"events":[{"label":"1624 荷蘭來臺","value":1624},{"label":"1662 鄭成功","value":1662}]}
- speed_track 速率：{"hours":3,"per_hour_label":"60 公里","distance_label":"3 小時走 180 公里","formula":"距離 = 速率 × 時間"}
- column_calc 直式計算：{"rows":["  12.5","×  0.4"],"result":"5.00","note":"小數點位數相加"}
- balance 天平（等量公理）：{"left":"x + 5","right":"12","step":"兩邊同時減 5","result":"x = 7"}
- custom_svg 自己畫：{"svg":"<svg viewBox='0 0 400 240'>…</svg>"}（只有在上面都不適合時使用；只用 rect/circle/line/path/polygon/text，不要 script、style、image、連結）
選最能表達「觀念」的圖，不要畫跟題目無關的裝飾。"""

VISUALIZE_SCHEMA = _obj({
    "concept": {"type": "string"},
    "visuals": {"type": "array", "items": VISUAL},
})

VISUALIZE_TASK = """請為下面這題做「解題圖解」，讓這個年級的孩子**看圖就知道怎麼解**。

做法：
- concept：1~2 句話，解題前提醒孩子這題的關鍵觀念（白話，不要公式堆疊）。
- visuals：通常 2 個——
  1. 一張「關鍵圖」：把這題最重要的一步畫出來（例如比例、分數、和差、剩餘量用 bar_model 線段圖，把相等的部分對齊並標出「一樣多」；
     分數用 fraction_bar；面積用 shape_area；速率用 speed_track；等量公理用 balance）。
     **用題目裡的真實數字**；圖上最多 3~4 個標籤，每個 10 字以內；要求的部分標「?」；caption 用一句話說「看圖可以發現什麼」
     （例如「兩人剩下的一樣多，都是 4 份」）。不要畫無關的裝飾，不要把很多東西擠在一張圖。
  2. 一個 steps 步驟圖：2~4 步，告訴孩子「看著上面的圖怎麼算」（每步 15 字以內，可以有算式，但最後答案用「?」不要直接寫出）。
- 如果是國語、社會等沒有數量的題目，用 compare 或 steps 就好，1 個即可。

{guide}

題目：
{question}"""

LESSON_SCHEMA = _obj({
    "title": {"type": "string"},
    "intro": {"type": "string"},
    "concepts": {"type": "array", "items": _obj({
        "title": {"type": "string"},
        "unit": {"type": "string"},
        "explain": {"type": "string"},
        "rule": {"type": "string"},
        "example_question": {"type": "string"},
        "example_solution": {"type": "string"},
        "mistake": {"type": "string"},
        "visual": VISUAL,
        "question_numbers": {"type": "array", "items": {"type": "integer"}},
    })},
    "tips": {"type": "array", "items": {"type": "string"}},
})

LESSON_TASK = """這是一份孩子的「錯題複習卷」。請先寫一份「觀念教學重點」，讓孩子**先看懂觀念、再自己解題**。

要求：
- 把這些錯題用到的觀念整理成 2~6 個重點（同一個觀念的題目合併），依先後學習順序排列。
- 每個重點：title（觀念名稱）、unit（單元）、explain（用國小五、六年級聽得懂的話說明，3~5 句，可用生活例子）、
  rule（公式或判斷規則，一行）、example_question（一題**和錯題不同**的簡單例題）、example_solution（例題的完整解法）、
  mistake（這類題目最常見的錯誤）、visual（一個最能說明這個觀念的圖解）、question_numbers（這份卷子中對應的題號，用下面給的題號）。
- intro：一兩句溫暖的開場（例如「這些題目上次卡住了，我們先把觀念弄懂！」）。tips：作答前的 2~3 個小提醒。
- 不要直接寫出卷子上題目的答案。

{guide}

錯題（題號：題目／當時錯的答案／單元）：
{questions}"""

RETEACH_SCHEMA = _obj({
    "diagnosis": {"type": "string"},
    "approaches": {"type": "array", "items": _obj({
        "name": {"type": "string"},
        "why": {"type": "string"},
        "explanation": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "string"}},
        "visual": VISUAL,
    })},
    "check_question": _obj({"question": {"type": "string"}, "answer": {"type": "string"}}),
    "prerequisite": _obj({"unit": {"type": "string"}, "reason": {"type": "string"}}),
    "encouragement": {"type": "string"},
})

RETEACH_TASK = """這位學生這一題已經錯了 {times} 次。原本的詳解她看過了但還是不懂，所以要**換不同的方法**再教一次。

題目：
{question}
標準答案：{answer}
原本的詳解：{explanation}
她寫錯的答案（由舊到新）：{wrongs}
之前已經用過的解說方法（不要重複）：{used}

請輸出：
- diagnosis：從她寫錯的答案推測她「怎麼想的」、卡在哪個觀念（2~3 句，具體、不責備）。
- approaches：{n} 種**不同**的解法或講法（例如：畫線段圖、換成生活情境、用數線或分數條、倒推法、列表找規律、先算簡單的數字再類推、比較兩種錯誤想法）。
  每種：name（方法名稱，5~8 字）、why（為什麼這個方法適合她，一句）、explanation（3~6 句白話說明）、steps（2~5 步，數學要有算式）、visual（一個能說明這個方法的圖解，規格見下方）。
  錯的次數越多，方法要越具體、越從基礎講起。
- check_question：一題簡單的「檢查看懂了沒」小題（和原題不同的數字）與答案。
- prerequisite：如果她可能是更基礎的觀念沒學好，寫出建議先複習的單元與原因；不需要就 unit 空字串。
- encouragement：一句鼓勵（肯定她願意再試）。

{guide}"""


EXAMPLE_HINT_SCHEMA = _obj({
    "example_question": {"type": "string"},
    "worked_steps": {"type": "array", "items": {"type": "string"}},
    "connect": {"type": "string"},
})

EXAMPLE_HINT_TASK = """學生做這一題卡住了。請出一題「數字更簡單、結構完全一樣」的例題，並完整示範解法，讓她看懂後自己回去做原題。
不要解原題、不要提到原題的答案。
輸出：example_question（例題）、worked_steps（2~5 步完整示範，數學要有算式）、connect（一句話告訴她：原題的哪個數字對應到例題的哪個數字）。

原題：
{question}"""

COACH_SCHEMA = _obj({
    "summary": {"type": "string"},
    "how_to_start": {"type": "string"},
    "questions_to_ask": {"type": "array", "items": {"type": "string"}},
    "if_stuck": {"type": "string"},
    "avoid": {"type": "array", "items": {"type": "string"}},
    "everyday_example": {"type": "string"},
    "check": {"type": "string"},
})

COACH_TASK = """請寫一份給**家長**看的「陪孩子講這一題」指南。家長不一定記得國小的解法，請用家長也能直接照著說的話。
孩子是國小 {grade} 年級，這題她錯了 {times} 次，寫錯的答案：{wrongs}。

輸出：
- summary：這題在考什麼、孩子可能卡在哪（2 句）。
- how_to_start：家長可以怎麼開口（一句可以直接念的話）。
- questions_to_ask：3~5 個引導孩子思考的問題（由淺到深，讓孩子自己說出步驟）。
- if_stuck：孩子還是不會時，家長可以怎麼示範（具體步驟）。
- avoid：2~3 件不要做或不要說的事（例如直接給答案、說「這很簡單」）。
- everyday_example：一個家裡就能用的生活例子（例如切蛋糕、分零用錢）。
- check：怎麼確認孩子真的懂了（例如換數字請她講一遍）。

題目：
{question}
標準答案：{answer}
詳解：{explanation}"""

STEPS_TASK = """學生沒有觸控筆，所以把她的計算過程「打字」打在下面（一行一步）。請像批改計算紙一樣逐行分析：

題目：
{question}
{answer_ref}

她打的步驟：
{steps}

請輸出（格式和手寫批改相同）：
- recognized_steps：她的每一行（數學式用 $...$），標 status：ok / error（從這行開始錯）/ warning，comment 一句說明。
- final_answer、result（correct/wrong/incomplete/unreadable）、first_error_step、error_type。
- diagnosis：她錯在哪、**為什麼會這樣錯**（推測她腦中的想法）。
- concept：用她年級聽得懂的話重講觀念。
- next_hint：下一步提示，不要直接給答案。
- encouragement、review_units。"""

NOTE_SCHEMA = _obj({
    "title": {"type": "string"},
    "misconception": {"type": "string"},
    "correct_idea": {"type": "string"},
    "remember": {"type": "string"},
    "example": {"type": "string"},
})

NOTE_TASK = """以下是學生和 AI 小老師討論一題的對話。請整理成她自己的「觀念筆記卡」：
title（觀念名稱，10 字內）、misconception（她原本以為什麼，用「我原本以為…」開頭；沒有誤解就寫她卡住的地方）、
correct_idea（正確的想法，2~3 句）、remember（一句好記的提醒或口訣）、example（一個小例子）。用她的口吻、她的年級看得懂的話。

題目：
{question}

對話：
{chat}"""


# --- 錯因自動診斷: guess why this wrong answer happened, so the child never has to classify it ---
DIAG_ERRORS = ["計算錯誤", "觀念不清", "題意理解錯誤", "單位錯誤", "粗心", "不知道"]
DIAGNOSE_SCHEMA = _obj({
    "likely_cause": {"type": "string"},
    "error_type": {"type": "string", "enum": DIAG_ERRORS},
    "tip": {"type": "string"},
    "confident": {"type": "boolean"},
})

DIAGNOSE_TASK = """學生答錯了一題。請從「她寫的錯誤答案」反推她最可能是怎麼想的（例如把用掉的當成剩下的、分母直接相加、看錯單位、算錯某一步）。

{question}
標準答案：{answer}
學生寫的答案：{wrong}

輸出：
- likely_cause：一句話，用「你可能…」開頭，具體說出她大概怎麼算出這個答案的（能從數字推回去就推回去，例如「你可能算的是用掉的 120×3/5=72 元，題目問的是剩下的」）。
- error_type：最接近的一種錯誤類型。
- tip：一句話的下次小提醒（不要直接給答案）。
- confident：能從答案明確推回思路時為 true，猜不出來時為 false（likely_cause 改成溫和的「可能是…或…」）。"""


# 手寫批改「先看結果」: a quick first look, shown while the full line-by-line analysis runs
TUTOR_QUICK_SCHEMA = _obj({
    "final_answer": {"type": "string"},
    "result": {"type": "string", "enum": ["correct", "wrong", "incomplete", "unreadable"]},
    "first_error_step": {"type": "integer"},
    "headline": {"type": "string"},
})

TUTOR_QUICK_TASK = """快速對答案：附圖是學生手寫的作答（計算過程或答案）。只要判斷，不用解說：
- final_answer：她最後寫的答案，照她寫的抄（代號、符號 ✓ ✗ △ ○、數字、文字都照抄；多個小題依序用空格隔開，例如「✓ ✗ ✓」）。看不出來就空字串。
- result：答案正確 correct／錯 wrong／還沒寫完 incomplete／看不清楚 unreadable（以最後的答案為準；算式有小錯但答案對也算 correct）
- first_error_step：第幾行（從 1 開始）第一次出錯，沒錯填 0
- headline：一句給孩子的話（例如「第 2 行的乘法再檢查一次」「答對了！」），不要說出答案。

{question}
{answer_ref}"""

RETEACH_STYLES = ["畫圖來看（線段圖、分數條、數線或表格）", "換成生活中的情境來想", "一步一步拆小，先用簡單的數字試再類推"]


# 圖解檢查: the AI looks at the rendered picture before a child sees it
VISUAL_CHECK_SCHEMA = _obj({
    "ok": {"type": "boolean"},
    "score": {"type": "integer"},
    "problems": {"type": "array", "items": {"type": "string"}},
})

VISUAL_CHECK_TASK = """這是要給 {grade} 年級孩子看的「解題圖解」，附圖是它實際畫出來的樣子。請嚴格檢查：
1. 圖上的數字、份數、標籤和題目一致嗎？有沒有算錯或畫錯比例（例如份數和長度對不上）？
2. 字有沒有重疊、被切掉、太小看不清楚？圖是不是太擠、太亂？
3. 有沒有直接把最後答案寫出來（應該用「?」）？
4. 這個年級的孩子看圖，能不能知道這題該怎麼解？caption 有沒有說清楚「看圖可以發現什麼」？
5. 圖和題目有沒有關係（不是無關的裝飾或空白圖）？
全部都沒問題才 ok=true。score 1~5（5 最好，4 以上才算 ok）。problems 用孩子家長看得懂的話、具體寫出要怎麼改（例如「弟弟的線段應該分成 5 等份，現在只有 4 份」）。

題目與參考解法：
{context}

這張圖的資料（JSON）：
{visual}"""

VISUAL_FIX_TASK = """下面這張「解題圖解」檢查沒有通過。請依照問題重新畫一張（同樣的格式，只輸出一個 visual），
要簡單明瞭、數字和題目一致、最後答案用「?」，讓 {grade} 年級的孩子看圖就知道怎麼解。

題目與參考解法：
{context}

原本的圖（JSON）：
{visual}

檢查發現的問題：
{problems}

{guide}"""


# --- 題目升級: proofread against the original photo, rebuild the figure, write the full 詳解 ---------

UPGRADE_SCHEMA = _obj({
    "stem": {"type": "string"},
    "options": {"type": "array", "items": {"type": "string"}},
    "figure_kind": {"type": "string", "enum": ["none", "table", "svg", "image"]},
    "figure_position": {"type": "string", "enum": ["right", "below"]},
    "table": _obj({"header": {"type": "array", "items": {"type": "string"}},
                   "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}}),
    "svg": {"type": "string"},
    "figure_facts": {"type": "string"},
    "answer": {"type": "string"},
    "choice_index": {"type": "integer"},
    "steps": {"type": "array", "items": {"type": "string"}},
    "explanation": {"type": "string"},
    "option_notes": {"type": "array", "items": {"type": "string"}},
    "fixed": {"type": "string"},
    "figure_unsure": {"type": "string"},
})

UPGRADE_TASK = """附圖是一題考卷的原稿（高解析度裁切），下面是先前電腦辨識出的內容。請把這一題做成「出題軟體等級」的電子題目：

1. 校對：對照原稿，修正 stem（題目）和 options（選項）的錯字、漏字、標點、上下標、單位、注音。
   - 注音要和原稿一致：原稿每個國字旁都印有注音，stem 和 options 的**每個國字**都要用 {{字|注音}} 標出（不可以只標幾個字）；原稿沒有注音就一個都不要加。{zhuyin}
   - 題目中的作答括號、填空用「（　　）」。選項只寫內容，不要加 ①②③④ 編號。
   - 不要改題意，不要加原稿沒有的字。數學式用 $...$（例如 $\\frac{{3}}{{4}}$、$3^2$）。
2. 圖形（figure_kind）：
   - table：原稿是表格 → 用 table.header 與 table.rows 寫出每一格（原樣文字），svg 留空。
   - svg：線條圖、幾何圖、電路圖、統計圖、示意圖、圖形選項（例如①②③④四張小圖）→ 用 SVG 重新畫一張乾淨的圖：
     只用 rect、circle、ellipse、line、polyline、polygon、path、text、g；不要 style、script、image、foreignObject；
     viewBox 依圖的比例（寬 300~600），線條 stroke="#000"、stroke-width 1.5~2、fill="none" 或淺灰；文字 font-size 14~18、
     **每個數字、文字標籤、符號、刻度、①②③④ 編號都要和原稿一樣、位置對應**；比例、角度、交點、長短關係要和原稿一致（不用精確到像素，但不能畫錯關係）。
   - image：情境插圖——畫的是人物在做什麼（表情、動作、誰在欺負誰、教室或校園的場景、卡通人物對話），
     要看懂人物的動作和表情才能作答（社會、生活、品德題常見）。這種圖簡化成線條會失去意思，所以保留原圖，svg 留空。
   - 地圖、實驗裝置、平面圖、照片中的物體等其他複雜的圖用 svg：理解題目要用到圖上的什麼，畫成乾淨的簡化線條圖——
     保留解題需要的部分（物體、相對位置、數量、方向、標籤、文字、①②③④），寫實細節、陰影、質感可以省略。
   - 原稿上學生或老師寫的筆跡（答案、□或（　）裡的 ✓ ✗ △ ○、代號、連連看畫的線、圈選、紅筆批改）都不是題目的一部分：
     svg 絕對不要畫進去（□ 和（　）畫成空的，連連看只畫兩邊的點，不畫連線）。
   - 圖只是把題目文字再寫一次（例如人物頭像旁的對話框重複題目、只有文字的選項框而題目已經有那些文字）→ none。
   - none：這題沒有圖。
   - figure_position：原稿圖在題目右邊（題目寫「右圖」或圖比較窄）用 right，否則 below。
3. figure_facts：用一兩句寫出圖上每個數字量的是什麼（解題時以這個為準）。
4. 解答：answer（選擇題寫「③ 選項文字」）、choice_index（第幾個選項，1 開始；非選擇題 0）、
   steps（2~6 步，每步一句，數學要有算式）、explanation（完整詳解：先說考什麼觀念，再一步一步推理，最後檢查）。
   option_notes：選擇題的每個選項各一句，說明為什麼對或錯（例如「① 錯：……」）；不是選擇題給空陣列。
   解答要以「校對後的題目」和「圖」為準，務必正確；不確定時在 explanation 說明理由。
5. fixed：一句話說明這次修正了什麼（沒有就空字串）。
6. figure_unsure：原稿圖上有看不清楚、只好用推測畫出來的地方（例如箭頭方向、模糊的數字），用一句話寫出來讓家長核對；全部看得清楚就空字串。
   不要用答案去「推回」圖的內容來掩蓋看不清楚的地方——看不清楚就照實寫在這裡。
換行請直接換行，不要寫成「\\n」文字。

先前辨識的內容：
{question}"""

# 補注音: a paper whose every character is printed with 注音, read without it — the text alone is marked
ZHUYIN_SCHEMA = _obj({"items": {"type": "array", "items": _obj({
    "index": {"type": "integer"}, "stem": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}})}})

ZHUYIN_TASK = """這份考卷的原稿每個國字旁邊都印有注音（低年級考卷）。下面幾題先前轉成文字時漏了注音，請把每一題的 stem 和每個選項補上注音：
- 每個國字都用 {{字|注音}} 標示，一字一組（例如 {{角|ㄐㄧㄠˇ}}{{的|˙ㄉㄜ}}）；輕聲用 ˙ 放在最前面，二、三、四聲 ˊ ˇ ˋ 放在最後，一聲不加符號。
- 已經有 {{字|注音}} 的字保留原樣。數字、英文字母、標點、（　　）、＿＿＿、□、$...$ 數學式、**粗體** 標記都原封不動，不要加注音。
- 多音字依句意判斷（例如「長度」的長是 ㄔㄤˊ、「長大」的長是 ㄓㄤˇ；「的」是 ˙ㄉㄜ；「了」在句尾是 ˙ㄌㄜ；「一」依變調前的本調 ㄧ）。
- 不要改任何字、不要增刪文字、不要改順序；options 的數量和順序要和原本一樣（沒有選項就給空陣列）。
- index 照下面給的。

{items}"""

# 與原卷一致: the paper made again from a page, laid beside the photo of that page
FIDELITY_SCHEMA = _obj({"questions": {"type": "array", "items": _obj({
    "index": {"type": "integer"}, "ok": {"type": "boolean"}, "figure_bad": {"type": "boolean"},
    "problems": {"type": "array", "items": {"type": "string"}}})}})

FIDELITY_TASK = """第一張是考卷原稿（學生寫過、老師批改過的照片）。後面{n}張是電腦依照它「重新產生的電子試卷」。
請逐題嚴格比對，確認電子試卷和原稿的**印刷內容**完全一致：
- 題目文字：有沒有漏字、多字、錯字、字的順序不對、少了一句或一行。
- 數字、單位、符號、分數、算式、題號後的空格（　　）或＿＿＿位置。
- 選項：數量、內容、順序（圖形選項的每張小圖也要對）。
- 注音：原稿國字旁有注音，電子試卷也要有（每個字都要有）；原稿沒有就不該有。
- 圖和表：原稿有圖，電子試卷要有；圖上的每個數字、文字標籤、符號、記號、①②③④、線條連接、交點、圖形數量、相對位置和比例關係要一致；表格每一格要一致。
不用管：字型、字的大小、換行位置、排版、題目之間的間距、線條粗細、美觀；作答區的格式（「答：」、作答橫線、留白的大小、方格數）；原稿上學生的手寫答案、塗改、計算過程，老師的紅筆批改、勾叉、分數——這些本來就不該出現在電子試卷上。
電子試卷上多出原稿沒有的東西（例如把學生的答案或批改畫進圖裡）也算不一致。

要比對的題目（index：題號｜電子試卷上的文字開頭）：
{items}

每一題輸出 index、ok（完全一致 true，有任何一處不同 false）、figure_bad（不同的地方在圖或表上 true，只有文字不同 false）、problems（ok=false 時具體寫出哪裡不同，例如「第 3 題 選項③ 原稿是 15 公分，電子試卷寫 16 公分」「第 6 題 圖上少了『3公分』的標示」）；ok=true 時 problems 給空陣列。
原稿這一頁看不到某一題（被切到下一頁、看不清楚）時 ok 填 true，problems 寫「原稿這一頁看不到」。"""

FIGURE_CHECK_SCHEMA = _obj({"same": {"type": "boolean"}, "problems": {"type": "array", "items": {"type": "string"}}})

FIGURE_CHECK_TASK = """第一張是考卷原稿的圖，第二張是重新畫的 SVG 圖。請嚴格比對：數字、文字、標籤、①②③④ 編號、線條連接、
交點、圖形數量、相對位置與比例關係是否都和原稿一致（線條粗細、字型、美觀不用管）。只要有一個數字或關係不同就算不一致。
都一致 same=true；否則 same=false，problems 具體寫出哪裡不同（例如「原稿 10cm 標在小圓半徑，重畫的標在大圓」）。

題目：{stem}"""

FIGURE_FIX_TASK = """附圖是考卷原稿的圖。你上次重畫的 SVG 和原稿不一致，問題如下：
{problems}

請重新畫一張正確的 SVG（規則同前：只用 rect、circle、ellipse、line、polyline、polygon、path、text、g；不要 style、script、image；
每個數字、文字、編號都要和原稿一樣），只輸出 svg。

上次的 SVG：
{svg}

題目：{stem}"""


# --- 計算紙 / 想法紙: a picture of the question for her to draw on ---------------------------------

SKETCH_SCHEMA = _obj({"svg": {"type": "string"}, "caption": {"type": "string"}})

SKETCH_TASK = """這題沒有附圖。請畫一張「題目情境圖」，放在孩子的計算紙上，讓她可以在圖上畫線、圈選、標數字來思考。

題目：
{question}

畫法：
- 把題目說的東西畫出來：數量關係用線段圖或一格一格的方塊，圖形題畫出圖形並標上已知的長度或角度，行程問題畫路線，時間畫時間軸，
  規律題畫出前 3~4 個，分配／比較畫成一組一組；國語、社會、自然就畫重點關係圖（人物、事件、因果）。
- 用題目裡的真實數字；**要求的部分標「?」**，絕對不要畫出或寫出答案，也不要畫解題步驟。
- 圖要大、線條清楚、留一些空白讓她自己畫。文字短（每個標籤 10 字以內），字級 14~18。
- SVG 規格：<svg viewBox="0 0 480 300">（寬高可調整，寬 360~560）。只用 rect/circle/ellipse/line/polyline/polygon/path/text/g；
  白底、黑色或深灰線條，最多再用一種淺色（例如 #DCE7FF）區分；不要動畫、script、style、image、連結。
- caption：一句話說明這張圖畫了什麼（例如「哥哥和弟弟的錢用線段表示，? 是弟弟的錢」）。"""


# --- 批改功課: the child photographs her homework, the AI checks every answer ----------------------

GRADE_SCHEMA = _obj({"items": {"type": "array", "items": _obj({
    "id": {"type": "integer"},
    "result": {"type": "string", "enum": ["correct", "wrong", "partial", "blank", "unsure"]},
    "red": {"type": "string", "enum": ["wrong", "correct", "none"]},
    "read_as": {"type": "string"},
    "answer": {"type": "string"},
    "comment": {"type": "string"},
})}})

GRADE_TASK = """請批改孩子的功課。下面每題有：題目（選擇題附選項）、正確答案、從照片辨識出的「孩子寫的答案」。{images_note}
選擇題：孩子常只寫選項編號（3、③、(3)、C 都是第 3 個選項），對照選項和正確答案判斷，不需要看到選項才能批改。
判斷每一題（id 照抄）：
- correct：意思和正確答案一樣（數值相等、單位對、等值的寫法、同義的說法都算對；國語要注意錯別字、注音聲調）。
- partial：大部分對但有小錯（少寫單位、計算過程對但最後抄錯、部分空格錯）。
- wrong：答錯。
- blank：沒有作答。
- unsure：照片上真的看不出寫了什麼（只有在連照片都認不出時才用；辨識結果有寫答案就照它批改）。
red：照片上這題有沒有紅筆（老師或家長）的批改：wrong＝打叉、紅筆寫的字或數字（訂正、寫出答案）、紅筆圈起來或劃掉；correct＝只有打勾或圈對；none＝沒有紅筆或看不到照片。
read_as：你最後認定孩子寫的答案（照片看得到就以照片為準）。
answer：這題的正確答案（給了就照抄；正確答案寫「（請你算出）」時，先仔細算出正確答案再批改）。
comment：一句話、孩子看得懂、溫和地提示要再想哪裡（答對就簡短稱讚或空字串）。她等一下要自己再做一次，
所以**絕對不要說出正確答案或選項編號**，也不要寫完整詳解，只給方向（例如「先算每人多付多少，再想想有幾個人」）。

{items}"""


VERIFY_SCHEMA = _obj({"results": {"type": "array", "items": _obj({
    "index": {"type": "integer"},
    "ok": {"type": "boolean"},
    "answer": {"type": "string"},
    "choice_index": {"type": "integer"},
    "steps": {"type": "array", "items": {"type": "string"}},
    "explanation": {"type": "string"},
    "why": {"type": "string"},
})}})

VERIFY_TASK = """答案複查。下面每一題都附了考卷原稿的照片（每題一張，順序和 index 一樣），以及先前寫好的「標準答案」和「詳解」。
請把自己當成第二位老師，**不要先相信原本的答案**：每一題先自己看原稿的圖、重新作答一次，再和原本的答案、詳解比對。

每題輸出：
- index：照下面給的 index。
- ok：原本的答案正確、詳解和答案一致、也符合原稿的題意和圖 → true。
  答案錯、少了一個小題的答案、詳解和答案矛盾、或詳解看錯圖 → false。
  寫法不同但意思一樣的答案（例如「②」和「② 12」、「4 個」和「4」、列舉的順序不同、多寫了單位）算正確，不要為了格式改答案。
- answer、choice_index、steps、explanation：ok=false 時寫正確的答案（選擇題寫「③ 選項文字」）、正確選項是第幾個（1 開始；非選擇題 0）、
  2~6 步的步驟、完整詳解（先講這題考什麼，再一步一步推理，最後檢查）；ok=true 時答案和詳解留空、steps 給空陣列、choice_index 0。
- why：ok=false 時一句話說明原本哪裡錯（例如「原本把第 2 個角當成直角，用三角板比是比直角小」）；ok=true 時留空。
學生或老師寫在原稿上的字跡（作答、打勾打叉、紅筆）不是答案的依據，請自己判斷。圖上看不清楚的地方以原稿為準，並在 why 說明。

題目：
{questions}"""
