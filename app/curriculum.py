"""Topic outline for Taiwan grades 3-6 (108 curriculum). Publishers (康軒/南一/翰林)
order chapters differently, so units are named by topic; the AI files each
scanned question under the closest unit and parents can add their own."""

SUBJECTS = {
    "數學": {"icon": "🔢", "color": "#3b82f6"},
    "國語": {"icon": "📖", "color": "#ef4444"},
    "自然": {"icon": "🔬", "color": "#10b981"},
    "社會": {"icon": "🌏", "color": "#f59e0b"},
    "英語": {"icon": "🔤", "color": "#8b5cf6"},
}

CURRICULUM = {
    "數學": {
        "3上": ["10000 以內的數", "四位數的加減", "乘法（二位數乘一位數）", "公尺與公分", "除法（認識除法與餘數）", "角與正方形、長方形", "公升與毫升", "分數（認識分數）", "時間（時、分、秒）"],
        "3下": ["除法（二、三位數除以一位數）", "乘法（三位數乘一位數）", "公斤與公克", "同分母分數的加減", "圓與圓心、半徑", "一位小數", "面積（平方公分）", "乘除應用（兩步驟）"],
        "4上": ["一億以內的數", "多位數乘法", "多位數除法", "角度與量角器", "三角形分類", "整數四則與括號", "分數（假分數、帶分數）", "垂直與平行"],
        "4下": ["二位小數與小數加減", "四邊形（平行四邊形、梯形）", "周長與面積", "時間的計算", "概數與四捨五入", "立方公分與體積", "統計圖表（長條圖、折線圖）", "等值分數"],
        "5上": ["因數與倍數", "多邊形與扇形", "約分、擴分與通分", "異分母分數的加減",
               "多位數的乘法與除法", "整數四則運算", "三角形與四邊形的面積", "線對稱圖形",
               "容量與重量"],
        "5下": ["分數的乘法", "小數的乘法", "分數除以整數", "長方體與正方體的體積",
               "表面積", "時間的乘除", "比率與百分率", "生活中的大單位(公畝、公頃、平方公里)",
               "柱體、錐體與球體", "容積"],
        "6上": ["質數與質因數分解", "最大公因數與最小公倍數", "分數的除法", "小數的除法",
               "比、比值與成正比", "圓周率與圓周長", "圓面積與扇形面積", "數量關係",
               "放大圖、縮小圖與比例尺", "等量公理與簡易方程式"],
        "6下": ["速率(速度、距離、時間)", "柱體的體積與表面積", "基準量與比較量",
               "代數(用未知數列式)", "怎樣解題(規律、雞兔同籠、植樹問題)", "圓形圖與統計圖表",
               "比例尺應用", "綜合應用題"],
    },
    "國語": {
        "3上": ["注音與國字", "部首查字典", "相似字與多音字", "量詞", "疊字與形容詞", "句型（因為……所以……）", "標點符號（逗號、句號、引號）", "閱讀理解（找重點）"],
        "3下": ["近義詞與反義詞", "成語入門", "譬喻法", "句型（雖然……但是……）", "段落大意", "看圖寫作"],
        "4上": ["形近字與同音字", "四字詞語與成語", "擬人法與誇飾法", "句型（不但……而且……）", "標點符號（頓號、冒號、分號）", "文章結構"],
        "4下": ["詞語解釋", "修辭綜合", "改寫句子", "記敘文", "閱讀理解（推論）", "書信與日記"],
        "5上": ["字音字形", "部首與造字", "詞語解釋", "成語運用", "修辭(譬喻、擬人、誇飾)",
               "標點符號", "句型與照樣造句", "閱讀理解"],
        "5下": ["多音字與形近字", "量詞與疊字", "修辭(設問、排比、映襯)", "關聯詞(連接詞)",
               "段落大意與主旨", "記敘文與說明文", "閱讀理解(推論)"],
        "6上": ["字音字形", "詞性與詞義", "成語與俗語", "修辭(轉化、層遞、對偶、借代)",
               "句型與改寫句子", "文言文入門", "議論文與論點", "閱讀理解"],
        "6下": ["易錯字總整理", "成語總整理", "修辭總整理", "標點符號總整理", "句型總整理",
               "文言文", "作文:審題與架構", "閱讀理解綜合"],
    },
    "自然": {
        "3上": ["植物的身體", "認識空氣", "溫度與溫度計", "動物的身體與運動"],
        "3下": ["磁鐵", "水的三態", "昆蟲與小動物", "認識天氣"],
        "4上": ["月亮的變化", "水生生物", "物質的變化（溶解）", "電路與燈泡"],
        "4下": ["水的移動（毛細現象、虹吸）", "動物的生活與適應", "光的反射與折射", "時間與日晷"],
        "5上": ["太陽與星星的觀測", "植物的構造與功能", "水溶液的性質", "空氣與燃燒"],
        "5下": ["力與運動", "動物的繁殖與生命延續", "時間的測量(擺錘)", "酸鹼與指示劑"],
        "6上": ["天氣變化(雲、風、颱風、鋒面)", "大地的奧秘(岩石、礦物、風化侵蝕)",
               "熱的傳播與保溫", "光與聲音", "電磁作用"],
        "6下": ["簡單機械(槓桿、滑輪、輪軸、齒輪)", "微生物與食品保存", "生物與環境",
               "地球環境與能源", "科學與生活"],
    },
    "社會": {
        "3上": ["我的家庭", "家鄉的環境", "學校生活", "社區的活動"],
        "3下": ["家鄉的產業", "家鄉的交通", "家鄉的節慶與文化", "地圖與方位"],
        "4上": ["家鄉的地理與地圖", "家鄉的歷史與古蹟", "地方政府與公共事務"],
        "4下": ["家鄉的產業發展", "家鄉的人口與聚落", "臺灣的節日與族群文化"],
        "5上": ["臺灣的位置與範圍", "臺灣的自然環境(地形、氣候、水文)", "史前文化與原住民族",
               "大航海時代(荷西、鄭氏)", "清代的臺灣"],
        "5下": ["日治時期的臺灣", "戰後臺灣的發展", "臺灣的產業與經濟", "臺灣的人口與區域"],
        "6上": ["民主政治與政府組織", "法律與生活", "經濟活動與消費", "文化與宗教"],
        "6下": ["科技與生活", "全球化與國際關係", "世界的文化", "永續發展與環境保護"],
    },
    "英語": {
        "3上": ["字母 A-Z", "打招呼與自我介紹", "顏色與數字 1-10", "phonics：短母音"],
        "3下": ["動物與食物單字", "This is / That is", "phonics：子音組合", "Classroom English"],
        "4上": ["數字 11-100", "What time is it?", "家人與職業", "like / don't like"],
        "4下": ["星期與天氣", "There is / There are", "Can you…?", "閱讀短句"],
        "5上": ["自然發音(phonics)", "單字:日常生活", "be 動詞與代名詞", "現在簡單式",
               "疑問詞 What/Where/Who"],
        "5下": ["現在進行式", "時間與日期表達", "數字與價錢", "can / can't", "閱讀短文"],
        "6上": ["過去式(be 動詞)", "過去式(一般動詞)", "未來式 will / be going to",
               "比較級與最高級", "閱讀理解"],
        "6下": ["時態總複習", "介系詞", "常用句型與對話", "看圖寫句子", "閱讀理解綜合"],
    },
}

QTYPES = ["選擇題", "是非題", "填充題", "計算題", "應用題", "簡答題", "配合題", "連連看",
          "圈選題", "改錯題", "造句題", "閱讀測驗", "看圖作答", "作圖題", "其他"]


def term_grade(term: str) -> int:
    return int(term[0])


def units_for(subject: str, grade: int | None = None) -> list[dict]:
    from . import db
    out = []
    for term, units in CURRICULUM.get(subject, {}).items():
        g = term_grade(term)
        if grade and g != grade:
            continue
        for u in units:
            out.append({"subject": subject, "grade": g, "term": term, "unit": u})
    for r in db.q("SELECT * FROM custom_units WHERE subject=?", (subject,)):
        if grade and r["grade"] != grade:
            continue
        out.append({"subject": subject, "grade": r["grade"], "term": f"{r['grade']}自訂",
                    "unit": r["unit"], "custom": True})
    return out


def all_units_text() -> str:
    """Compact outline used in prompts so the AI picks consistent unit names."""
    lines = []
    for subj, terms in CURRICULUM.items():
        for term, units in terms.items():
            lines.append(f"{subj} {term}: " + "、".join(units))
    return "\n".join(lines)


# 自然 章節: the family's review book (目次) — 生物／理化／地球科學 → 第 N 單元 → 主題. Questions keep their
# curriculum `unit`; `questions.chapter` files them here ("6.1" = 第6單元 主題1, "6" = the unit as a
# whole, "-" = nowhere). The AI fills it in the background; until then UNIT_CHAPTER guesses from the unit.
SCIENCE_BOOK = [
    ("生物", 1, "探索生命世界", ["複式顯微鏡", "解剖顯微鏡", "細胞的構造與機能", "生物體的組成層次"]),
    ("生物", 2, "生物的分類", ["生物的分類階層", "原核生物界和原生生物界", "真菌（菌物）界", "植物界", "動物界", "動物的生殖與分類"]),
    ("生物", 3, "植物生理", ["植物的營養器官", "植物的生殖", "植物體內進行的作用"]),
    ("生物", 4, "人體生理", ["人體的消化", "人體的血液循環", "人體的呼吸與排泄"]),
    ("生物", 5, "生態", ["生物與環境的關係", "族群、群集與生態系", "環境汙染及自然保育"]),
    ("理化", 6, "水與空氣", ["水溶液", "空氣"]),
    ("理化", 7, "聲音與光", ["聲音", "光"]),
    ("理化", 8, "熱與物質的變化", ["物理變化與化學變化", "熱對物質的影響與熱傳播"]),
    ("理化", 9, "力與運動、簡單機械", ["力與運動", "簡單機械"]),
    ("理化", 10, "電與磁", ["電", "磁"]),
    ("地球科學", 11, "月亮、太陽和恆星", ["月球", "太陽", "日食與月食", "星星與星座", "銀河系與太陽系"]),
    ("地球科學", 12, "天氣的變化和地表的變化", ["天氣的變化", "地表的變化", "地震", "全球變遷"]),
]
CHAPTER_SUBJECTS = {"自然": SCIENCE_BOOK}

UNIT_CHAPTER = {
    "植物的身體": "3.1", "認識空氣": "6.2", "溫度與溫度計": "8.2", "動物的身體與運動": "2.5", "磁鐵": "10.2",
    "水的三態": "8.1", "昆蟲與小動物": "2.5", "認識天氣": "12.1", "月亮的變化": "11.1", "水生生物": "2",
    "物質的變化（溶解）": "6.1", "電路與燈泡": "10.1", "水的移動（毛細現象、虹吸）": "6.1", "動物的生活與適應": "5.1",
    "光的反射與折射": "7.2", "時間與日晷": "11.2", "太陽與星星的觀測": "11", "植物的構造與功能": "3",
    "水溶液的性質": "6.1", "空氣與燃燒": "6.2", "力與運動": "9.1", "動物的繁殖與生命延續": "2.6",
    "時間的測量(擺錘)": "9.1", "酸鹼與指示劑": "6.1", "天氣變化(雲、風、颱風、鋒面)": "12.1",
    "大地的奧秘(岩石、礦物、風化侵蝕)": "12.2", "熱的傳播與保溫": "8.2", "光與聲音": "7", "電磁作用": "10",
    "簡單機械(槓桿、滑輪、輪軸、齒輪)": "9.2", "微生物與食品保存": "2", "生物與環境": "5",
    "地球環境與能源": "12.4", "地球的運動（晝夜與四季）": "11.2", "人體的消化": "4.1", "人體的排泄系統": "4.3",
}


def chapters(subject: str) -> list[dict]:
    """[{key, label, area, unit, topic}] of a subject's 章節 book, units then their topics."""
    out = []
    for area, n, name, topics in CHAPTER_SUBJECTS.get(subject, []):
        out.append({"key": str(n), "label": f"第{n}單元 {name}", "area": area, "unit": n, "topic": 0})
        out += [{"key": f"{n}.{i}", "label": f"主題{i} {t}", "area": area, "unit": n, "topic": i} for i, t in enumerate(topics, 1)]
    return out


def chapter_of(subject: str, unit: str, chapter: str) -> str:
    """The question's place in the book: the AI's, else a guess from its curriculum unit ("" = none)."""
    if subject not in CHAPTER_SUBJECTS:
        return ""
    if chapter == "-":
        return ""
    return chapter or UNIT_CHAPTER.get(unit or "", "")


def chapter_label(subject: str, unit: str, chapter: str) -> str:
    key = chapter_of(subject, unit, chapter)
    if not key:
        return ""
    n, _, t = key.partition(".")
    for area, num, name, topics in CHAPTER_SUBJECTS[subject]:
        if str(num) == n:
            return f"第{num}單元 {name}" + (f"・{topics[int(t) - 1]}" if t.isdigit() and 0 < int(t) <= len(topics) else "")
    return ""


def book_text(subject: str) -> str:
    """The book for the AI: one line per 主題 with its key."""
    lines = []
    for area, n, name, topics in CHAPTER_SUBJECTS.get(subject, []):
        lines.append(f"【{area}】第{n}單元 {name}（整個單元：{n}）")
        lines += [f"  {n}.{i} {t}" for i, t in enumerate(topics, 1)]
    return "\n".join(lines)
