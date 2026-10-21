"""Claude calls. Every structured task goes through `call_json`, which asks
for JSON that matches a schema and records token usage for the parent
dashboard. Two providers:
- "subscription": the parent's claude.ai login via Claude Code (default)
- "api": an Anthropic API key (streamed Messages API requests)"""
import asyncio
import base64
import json
import logging
import os
import time

import anthropic

from . import accounts, claude_sub, db, prompts
from .config import DEFAULT_SETTINGS

log = logging.getLogger("ai")

FALLBACK_BETA = "server-side-fallback-2026-07-01"
_fallbacks_supported = True
import contextvars

# Two lanes for AI calls. Anything a person is doing (chat, hints, handwriting, scanning, explanations
# she asked for) goes in the front lane and never queues behind background work; background jobs
# (題目升級, diagrams and their checks) get the rest — and fewer slots while someone is using the AI.
background = contextvars.ContextVar("ai_background", default=False)
soon = contextvars.ContextVar("ai_soon", default=False)  # ahead-of-time work (jobs.SOON_KINDS)
FRONT_SLOTS = 4
# the calls a child sits waiting on, one after another: a Claude process is kept started for them
# (others start their own — keeping one ready for every kind of call only churned the CPU)
WARM_TASKS = {"hint", "tutor_quick", "tutor", "judge"}


class _Lanes:
    def __init__(self):
        self.cond = None
        self.front = 0
        self.back = 0
        self.seen = 0.0   # when a person last used the site (main.py's middleware calls touch())
        self.soon = 0     # front-lane calls that are ahead-of-time work (SOON_KINDS)
        self.active: dict = {}  # id → (task, background?, started) — what holds a slot right now (/api/debug/ai)

    def _back_slots(self) -> int:
        # Every AI call starts a Claude CLI process, and starting one takes a lot of the Pi's CPU:
        # eight at once made every page slow. While someone is using the site, background work
        # gets one call at a time; when nobody is, it runs at full width (setting upgrade_parallel).
        if self.front or time.monotonic() - self.seen < 45:
            return 1
        try:
            n = int(db.get_setting("upgrade_parallel") or 8)
        except Exception:
            n = 8
        # at most 6 even when idle: what is running when someone arrives keeps going for a minute or two
        return max(1, min(6, n))

    def slot(self, label: str = ""):
        lanes = self

        class _Slot:
            async def __aenter__(self_):
                if lanes.cond is None:
                    lanes.cond = asyncio.Condition()
                self_.bg = background.get()
                self_.soon = soon.get() and not self_.bg
                async with lanes.cond:
                    if self_.bg:
                        while lanes.back >= lanes._back_slots():  # re-looked at every few seconds: the site going quiet frees slots
                            try:
                                await asyncio.wait_for(lanes.cond.wait(), 5)
                            except TimeoutError:
                                pass
                        lanes.back += 1
                    elif self_.soon:
                        await lanes.cond.wait_for(lambda: lanes.soon < 2 and lanes.front < FRONT_SLOTS - 1)
                        lanes.front += 1
                        lanes.soon += 1
                    else:
                        await lanes.cond.wait_for(lambda: lanes.front < FRONT_SLOTS)
                        lanes.front += 1
                lanes.active[id(self_)] = (label + ("·soon" if self_.soon else ""), self_.bg, time.monotonic())

            async def __aexit__(self_, *exc):
                lanes.active.pop(id(self_), None)
                async with lanes.cond:
                    if self_.bg:
                        lanes.back -= 1
                    else:
                        lanes.front -= 1
                        if self_.soon:
                            lanes.soon -= 1
                    lanes.cond.notify_all()
        return _Slot()


_lanes = _Lanes()


def touch():
    """A person is using the site right now (background AI work makes room)."""
    _lanes.seen = time.monotonic()


class AIError(Exception):
    pass


def setting(key):
    return db.get_setting(key, DEFAULT_SETTINGS.get(key))


def provider() -> str:
    p = setting("ai_provider")
    if p in ("subscription", "api"):
        return p
    return "api" if (setting("api_key") or os.environ.get("ANTHROPIC_API_KEY")) else "subscription"


def configured() -> bool:
    if provider() == "subscription":
        return claude_sub.logged_in()
    return bool(setting("api_key") or os.environ.get("ANTHROPIC_API_KEY"))


def client() -> anthropic.AsyncAnthropic:
    key = setting("api_key") or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise AIError("尚未設定 Claude API 金鑰，請到「家長 → 設定」填入。")
    base = setting("base_url") or "https://api.anthropic.com"
    return anthropic.AsyncAnthropic(api_key=key, base_url=base, max_retries=3, timeout=600)


def img_block(data: bytes, media_type: str = "image/jpeg") -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                        "data": base64.standard_b64encode(data).decode()}}


def _system():
    # Stable across all tasks so it is cached once and reused.
    return [{"type": "text", "text": prompts.SYSTEM, "cache_control": {"type": "ephemeral"}}]


def _log_usage_dict(task, model, u: dict):
    try:
        db.insert("ai_usage", {"task": task, "model": model,
                               "input_tokens": (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0),
                               "output_tokens": u.get("output_tokens") or 0,
                               "cache_read": u.get("cache_read_input_tokens") or 0,
                               "created_at": db.now()})
    except Exception:
        log.exception("usage log failed")


def _log_usage(task, msg):
    try:
        u = msg.usage
        db.insert("ai_usage", {"task": task, "model": msg.model,
                               "input_tokens": (u.input_tokens or 0) + (u.cache_creation_input_tokens or 0),
                               "output_tokens": u.output_tokens or 0,
                               "cache_read": u.cache_read_input_tokens or 0,
                               "created_at": db.now()})
    except Exception:  # usage logging must never break a request
        log.exception("usage log failed")


def _friendly(e: Exception) -> AIError:
    if isinstance(e, anthropic.AuthenticationError):
        return AIError("API 金鑰無效，請到設定頁重新輸入。")
    if isinstance(e, anthropic.PermissionDeniedError):
        return AIError("這個 API 金鑰沒有使用此模型的權限。")
    if isinstance(e, anthropic.NotFoundError):
        return AIError("找不到指定的模型，請到設定頁確認模型名稱。")
    if isinstance(e, anthropic.RateLimitError):
        return AIError("AI 使用量暫時達到上限，請稍等一分鐘再試。")
    if isinstance(e, anthropic.BadRequestError):
        msg = str(getattr(e, "message", e))
        if "credit" in msg.lower() or "billing" in msg.lower():
            return AIError("API 帳戶餘額不足，請到 Anthropic Console 儲值。")
        return AIError(f"AI 請求格式錯誤：{msg[:200]}")
    if isinstance(e, anthropic.APIStatusError):
        return AIError(f"AI 服務暫時有問題（{e.status_code}），請稍後再試。")
    if isinstance(e, anthropic.APIConnectionError):
        return AIError("連不上 AI 服務，請檢查樹莓派的網路連線。")
    return AIError(str(e))


async def _stream_final(**kw):
    """One streamed request with refusal fallback; falls back to a plain
    request if this account doesn't accept the fallback beta."""
    global _fallbacks_supported
    c = client()
    use_fb = _fallbacks_supported and setting("use_fallbacks")
    try:
        if use_fb:
            async with c.beta.messages.stream(betas=[FALLBACK_BETA], fallbacks="default", **kw) as s:
                return await s.get_final_message()
        async with c.messages.stream(**kw) as s:
            return await s.get_final_message()
    except anthropic.BadRequestError as e:
        if use_fb and "fallback" in str(e).lower():
            log.warning("fallbacks not accepted, retrying without: %s", e)
            _fallbacks_supported = False
            return await _stream_final(**kw)
        raise


def _model(fast: bool) -> str:
    return (setting("model_fast") if fast else "") or setting("model")


async def call_json(task: str, content: list, schema: dict, effort: str = "high",
                    max_tokens: int = 32000, system_extra: str = "", fast: bool = False) -> dict:
    """fast=True: interactive help a child is waiting for, on the faster model."""
    system_extra = (accounts.grade_note(accounts.current_grade.get()) + "\n" + system_extra).strip()
    model = _model(fast)
    if provider() == "subscription":
        if not claude_sub.logged_in():
            raise AIError("樹莓派上的 Claude 還沒登入：請在終端機執行 claude 並登入你的 claude.ai 帳號。")
        system_text = prompts.SYSTEM + ("\n\n" + system_extra if system_extra else "")
        async with _lanes.slot(task):
            for attempt in range(2):  # one retry: the CLI occasionally drops a call
                try:
                    data, usage = await claude_sub.call_json(system_text, model, content, schema, effort,
                                                             timeout=900 if background.get() else 240 if fast else 600,
                                                             warm=fast and not background.get() and task in WARM_TASKS,
                                                             nice=background.get())  # background: low CPU priority
                    break
                except claude_sub.SubError as e:
                    if attempt or "登入" in str(e):
                        raise AIError(str(e)) from e
                    log.warning("subscription call %s failed, retrying: %s", task, e)
                    await asyncio.sleep(2)
        _log_usage_dict(task, model, usage)
        return data
    system = _system()
    if system_extra:
        system.append({"type": "text", "text": system_extra})
    kw = dict(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": effort,
                       "format": {"type": "json_schema", "schema": schema}},
    )
    async with _lanes.slot():
        try:
            msg = await _stream_final(**kw)
        except AIError:
            raise
        except Exception as e:
            log.exception("AI call %s failed", task)
            raise _friendly(e) from e
    _log_usage(task, msg)
    if msg.stop_reason == "refusal":
        raise AIError("AI 無法處理這個內容，請換一張圖片或修改題目後再試。")
    text = "".join(b.text for b in msg.content if b.type == "text")
    if msg.stop_reason == "max_tokens":
        raise AIError("AI 回覆太長被截斷了，請把試卷分成較少的頁數再試。")
    try:
        return json.loads(text)
    except ValueError as e:
        raise AIError("AI 回覆格式有誤，請重試。") from e


def _flatten_chat(messages: list) -> list:
    """The subscription path takes one user turn: earlier turns become a
    transcript, images from the latest message are kept."""
    *earlier, last = messages
    lines = []
    for m in earlier:
        who = "學生" if m["role"] == "user" else "小老師"
        text = " ".join(b.get("text", "") for b in m["content"] if b.get("type") == "text")
        lines.append(f"{who}：{text}")
    content = [b for b in last["content"] if b.get("type") == "image"]
    for m in earlier[:1]:  # the question figure rides on the first message
        content = [b for b in m["content"] if b.get("type") == "image"] + content
    last_text = " ".join(b.get("text", "") for b in last["content"] if b.get("type") == "text")
    prefix = ("之前的對話：\n" + "\n".join(lines) + "\n\n") if lines else ""
    content.append({"type": "text", "text": f"{prefix}學生現在說：{last_text}\n\n請以小老師的身分回覆（只輸出回覆內容）。"})
    return content


def chat_system(system_extra: str, grade: int) -> str:
    return prompts.SYSTEM + "\n\n" + accounts.grade_note(grade) + "\n" + system_extra


def prewarm_chat(system_extra: str, effort: str, grade: int):
    """A warm Claude process ready for the next chat (問 AI answers sooner)."""
    if provider() == "subscription" and claude_sub.logged_in():
        claude_sub.prewarm(chat_system(system_extra, grade), _model(True), effort, None, True)


async def stream_chat(system_extra: str, messages: list, effort: str = "low", context: str = ""):
    """Yields text chunks for the tutor chat. `context` (the question) goes in the message, not the
    system prompt, so every chat shares one system prompt and a warm Claude process."""
    grade = accounts.current_grade.get()
    if provider() == "subscription":
        if not claude_sub.logged_in():
            yield "⚠️ 樹莓派上的 Claude 還沒登入。"
            return
        async with _lanes.slot("chat"):
            content = _flatten_chat(messages)
            if context:
                content.insert(0, {"type": "text", "text": "目前討論的題目：\n" + context})
            async for chunk in claude_sub.stream_text(chat_system(system_extra, grade), _model(True),
                                                      content, effort, warm=True):
                if isinstance(chunk, dict):
                    _log_usage_dict("chat", _model(True), chunk.get("usage") or {})
                else:
                    yield chunk
        return
    system_extra = accounts.grade_note(grade) + "\n" + system_extra
    if context:
        system_extra += "\n\n目前討論的題目：\n" + context
    system = _system() + [{"type": "text", "text": system_extra}]
    kw = dict(model=_model(True), max_tokens=4000, system=system, messages=messages,
              output_config={"effort": effort})
    async with _lanes.slot():
        try:
            c = client()
            async with c.messages.stream(**kw) as s:
                async for t in s.text_stream:
                    yield t
                msg = await s.get_final_message()
        except AIError as e:
            yield f"\n⚠️ {e}"
            return
        except Exception as e:
            log.exception("chat failed")
            yield f"\n⚠️ {_friendly(e)}"
            return
    _log_usage("chat", msg)
    if msg.stop_reason == "refusal":
        yield "\n（這個問題小老師沒辦法回答，我們回到題目吧！）"


# --- task helpers ---------------------------------------------------------------

def question_text(qd: dict, with_answer: bool = False) -> str:
    parts = []
    lead = qd.get("lead") if isinstance(qd.get("lead"), dict) else {}
    if lead.get("stem"):
        parts.append(f"[題組共用的說明（承上題）] {lead['stem']}")
    if (lead.get("figure_table") or {}).get("rows"):
        t = lead["figure_table"]
        parts.append("[題組的表格] " + " / ".join(" | ".join(map(str, r)) for r in [t.get("header") or []] + t["rows"] if r))
    if qd.get("section"):
        parts.append(f"[{qd['section']}]")
    parts.append(f"({qd.get('qtype') or '題目'}) {qd.get('stem', '')}")
    for i, o in enumerate(qd.get("options") or [], 1):
        parts.append(f"  選項{i}：{o}")
    if qd.get("fix_note"):
        parts.append(f"家長的更正說明（以此為準）：{qd['fix_note']}")
    if with_answer and qd.get("answer"):
        parts.append(f"標準答案：{qd['answer']}")
    return "\n".join(parts)


def reference(qd: dict) -> str:
    """What the graders get: the reference answer, method and reading of the
    figure — with the warning that the reference itself can be wrong."""
    if not qd.get("answer"):
        return ""
    lines = [f"參考答案：{qd['answer']}"]
    if qd.get("figure_facts"):
        lines.append(f"參考的圖形資訊：{qd['figure_facts']}")
    if qd.get("steps"):
        lines.append("參考解法：" + "；".join(qd["steps"]))
    if qd.get("figure_unsure"):
        lines.append(f"注意：參考解法看圖時有不確定的地方（{qd['figure_unsure']}）。如果學生的做法符合另一種合理的看圖方式而且算對了，請判 correct，並在 diagnosis 說明。")
    lines.append("（以上不要直接告訴學生。參考解法也可能看錯圖或算錯：學生的做法和參考不同時，請自己仔細看圖、重新驗算，"
                 "確定是學生錯了才判錯；如果學生是對的，就判對，並在 diagnosis 說明她的方法也正確。）")
    return "\n".join(lines)


async def extract_page(image: bytes, subject_hint: str = "") -> dict:
    hint = f"使用者說這份是「{subject_hint}」。" if subject_hint else ""
    return await call_json("extract", [img_block(image),
                                       {"type": "text", "text": prompts.EXTRACT_TASK.format(hint=hint)}],
                           prompts.EXTRACT_SCHEMA, effort=setting("effort_extract"), max_tokens=64000)


async def read_continuation(question: str, options: list, top: bytes) -> dict:
    """The top of the next page: does the last question of the page before run on there (more options,
    the rest of its text)? {"options": [...], "text": ""} — empty when it does not."""
    schema = {"type": "object", "properties": {"continues": {"type": "boolean"},
                                               "options": {"type": "array", "items": {"type": "string"}},
                                               "text": {"type": "string"}},
              "required": ["continues", "options", "text"], "additionalProperties": False}
    have = "　".join(f"{CIRCLED[i] if i < len(CIRCLED) else i + 1} {o}" for i, o in enumerate(options)) or "（沒有）"
    text = (f"上一頁最後一題是：\n{question[:600]}\n已經讀到的選項：{have}\n\n"
            "照片是下一頁最上面（在下一個題號之前）。這裡如果是這一題接下去的選項或文字（例如 ③ 1350 元 ④ 1800 元，"
            "或題目沒寫完的後半段），continues 填 true，options 只填**新的**選項（去掉 ①②③④ 編號），text 填接下去的題目文字"
            "（沒有就空字串）；這裡是別的東西（下一題、標題、頁首）就 continues false。")
    res = await call_json("continuation", [img_block(top), {"type": "text", "text": text}], schema, effort="low",
                          max_tokens=800, fast=True)
    if not res.get("continues"):
        return {"options": [], "text": ""}
    return {"options": [str(o).strip() for o in res.get("options") or [] if str(o).strip()], "text": str(res.get("text") or "").strip()}


async def page_turn(image: bytes) -> int:
    """How far a photo has to be turned (clockwise) for its print to read upright: 0, 90, 180 or 270."""
    schema = {"type": "object", "properties": {"rotation": {"type": "integer", "enum": [0, 90, 180, 270]}},
              "required": ["rotation"], "additionalProperties": False}
    text = ("這是一張考卷（可能是左右兩頁攤開）的照片。看印刷文字的「字頭」朝哪個方向：\n"
            "- 字頭朝上（文字是正的）→ 0\n- 字頭朝左（整張往左躺）→ 90（順時針轉 90 度就正了）\n"
            "- 字頭朝下（倒過來）→ 180\n- 字頭朝右（整張往右躺）→ 270\n只回答 0、90、180 或 270。")
    res = await call_json("page_turn", [img_block(image), {"type": "text", "text": text}], schema, effort="low",
                          max_tokens=100, fast=True)
    r = int(res.get("rotation") or 0)
    return r if r in (0, 90, 180, 270) else 0


async def detect_layout(images: list[bytes]) -> dict:
    """How the photographed exam is printed: 直書 or 橫書, page landscape or portrait, 注音 beside
    the text — so the editable file looks like the original."""
    schema = {"type": "object", "properties": {
        "direction": {"type": "string", "enum": ["vertical", "horizontal"]},
        "orientation": {"type": "string", "enum": ["landscape", "portrait"]},
        "zhuyin": {"type": "boolean"}}, "required": ["direction", "orientation", "zhuyin"], "additionalProperties": False}
    text = ("這是同一份考卷的頁面照片（第一張可能是封面）。請看題目內文（不是封面）判斷：\n"
            "direction：題目文字是直書（字由上往下、行由右往左，國語考卷常見）還是橫書（由左往右）。\n"
            "orientation：考卷紙張是橫放（寬比高大，例如 A4 橫印）還是直放。\n"
            "zhuyin：題目正文的國字旁邊是不是大多都印有注音。")
    return await call_json("layout", [*[img_block(b) for b in images[:2]], {"type": "text", "text": text}],
                           schema, effort="low", max_tokens=300, fast=True)


async def school_header(image: bytes) -> dict:
    """學校考卷: is this the school's own test paper — a header with 班級、姓名、座號 to fill in?"""
    schema = {"type": "object", "properties": {
        "school": {"type": "boolean"}, "evidence": {"type": "string"}, "term": {"type": "string"}},
        "required": ["school", "evidence", "term"], "additionalProperties": False}
    text = ("這是一份考卷的第一頁照片。請判斷它是不是「學校的考卷」：卷頭有讓學生填寫的「班級（年 班）」「姓名」「座號」欄位"
            "（三個裡至少有兩個，例如「＿年＿班 ＿號 姓名：＿＿」）。補習班講義、參考書、評量本、自己印的練習卷通常沒有。\n"
            "school：是不是。evidence：你看到的欄位文字（簡短）。term：卷頭寫的學期或考試名稱（例如「115學年度上學期 期中評量」），沒有就空字串。")
    return await call_json("school", [img_block(image), {"type": "text", "text": text}], schema, effort="low", max_tokens=300)


async def extract_region(image: bytes) -> dict:
    return await call_json("region", [img_block(image), {"type": "text", "text": prompts.REGION_TASK}],
                           prompts.REGION_SCHEMA, effort=setting("effort_extract"))


async def solve(items: list[dict], images: list[bytes], effort: str | None = None) -> list[dict]:
    # (each item may carry fix_note: a parent's correction, e.g. what a number in the figure measures)
    """items: [{index, qtype, stem, options, student_answer, teacher_mark, section}]"""
    lines = []
    for it in items:
        lines.append(f"--- index {it['index']} ---\n{question_text(it)}")
        if it.get("student_answer"):
            lines.append(f"學生作答：{it['student_answer']}")
        if it.get("teacher_mark") and it["teacher_mark"] != "none":
            lines.append(f"老師批改：{it['teacher_mark']}")
    content = [img_block(i) for i in images]
    content.append({"type": "text", "text": prompts.SOLVE_TASK.format(questions="\n".join(lines))})
    res = await call_json("solve", content, prompts.SOLVE_SCHEMA,
                          effort=effort or setting("effort_solve"), max_tokens=64000)
    return res.get("solutions", [])


async def tutor(qd: dict, work_image: bytes, figure: bytes | None = None) -> dict:
    ref = reference(qd)
    content = []
    if figure:
        content += [{"type": "text", "text": "題目附圖："}, img_block(figure)]
    content += [{"type": "text", "text": "學生的計算過程："}, img_block(work_image, "image/png"),
                {"type": "text", "text": prompts.TUTOR_TASK.format(question=question_text(qd), answer_ref=ref)}]
    return await call_json("tutor", content, prompts.TUTOR_SCHEMA, effort=setting("effort_tutor"), fast=not figure)


async def hint(qd: dict, level: int, work_image: bytes | None = None, figure: bytes | None = None) -> dict:
    ref = f"（參考答案，不要說出來：{qd['answer']}）" if qd.get("answer") else ""
    content = []
    if figure:
        content.append(img_block(figure))
    note = ""
    if work_image:
        content.append(img_block(work_image, "image/png"))
        note = "附圖是她目前寫到一半的計算過程，請針對她卡住的地方給提示。"
    content.append({"type": "text", "text": prompts.HINT_TASK.format(
        level=level, work_note=note, question=question_text(qd), answer_ref=ref)})
    return await call_json("hint", content, prompts.HINT_SCHEMA, effort="medium", max_tokens=8000, fast=True)


def _level_text(difficulty: str) -> str:
    return {"easy": "基礎（課本練習題程度）", "same": "和原題差不多",
            "hard": "進階挑戰（段考難題程度）"}.get(difficulty, "由易到難混合")


async def similar(qd: dict, n: int = 3, difficulty: str = "same", figure: bytes | None = None) -> list[dict]:
    """舉一反三: one new question per request, all at once."""
    async def one(i: int):
        content = [img_block(figure)] if figure else []
        content.append({"type": "text", "text": prompts.SIMILAR_TASK.format(
            n=1, level=_level_text(difficulty), question=question_text(qd, with_answer=True))
            + f"\n（這是第 {i + 1} 題，共 {n} 題：情境要和其他題不同，例如{['買東西或錢', '長度、重量或容量', '時間、速度或分組'][i % 3]}。）"})
        res = await call_json("similar", content, prompts.GENERATE_SCHEMA, effort=setting("effort_content"), max_tokens=12000, fast=True)
        return res.get("questions", [])[:1]
    parts = await asyncio.gather(*(one(i) for i in range(n)), return_exceptions=True)
    out = [q for r in parts if isinstance(r, list) for q in r]
    if not out:
        err = next((r for r in parts if isinstance(r, Exception)), None)
        raise err if isinstance(err, AIError) else AIError("AI 暫時無法出題，請稍後再試。")
    return out


LEVEL_RULE = {"basic": "這次全部出 basic（基礎、一定要會）的題目。",
              "advanced": "這次全部出 advanced（進階）的題目。",
              "challenge": "這次全部出 challenge（挑戰、變形題）的題目。"}


async def generate(subject: str, grade: int, unit: str, n: int = 5, difficulty: str = "mix",
                   qtypes: str = "選擇題、填充題、計算題、應用題", extra: str = "", level: str = "") -> list[dict]:
    text = prompts.GENERATE_TASK.format(n=n, subject=subject, grade=grade, unit=unit,
                                        level=_level_text(difficulty), qtypes=qtypes, extra=extra,
                                        level_rule=LEVEL_RULE.get(level, "依難度分佈標記。"))
    res = await call_json("generate", [{"type": "text", "text": text}], prompts.GENERATE_SCHEMA,
                          effort=setting("effort_content"), max_tokens=48000, fast=True)
    return res.get("questions", [])


KNOWLEDGE_PARTS = [
    ("title", "intro", "key_points", "formulas", "mnemonics", "real_life"),
    ("question_types", "mistakes", "bar_model"),
]


async def knowledge(subject: str, grade: int, unit: str, extra: str = "") -> dict:
    """單元重點卡 in two halves written at the same time (觀念・公式 / 題型・易錯), merged."""
    text = prompts.KNOWLEDGE_TASK.format(subject=subject, grade=grade, unit=unit, extra=extra,
                                         guide=prompts.VISUAL_GUIDE)
    props = prompts.KNOWLEDGE_SCHEMA["properties"]

    async def part(keys):
        schema = prompts._obj({k: props[k] for k in keys})
        note = f"\n\n（這次只需要寫這幾個欄位：{'、'.join(keys)}；其他部分由別人負責。）"
        return await call_json("knowledge", [{"type": "text", "text": text + note}], schema,
                               effort=setting("effort_content"), max_tokens=16000)

    parts = await asyncio.gather(*(part(k) for k in KNOWLEDGE_PARTS), return_exceptions=True)
    if all(isinstance(r, Exception) for r in parts):
        raise parts[0] if isinstance(parts[0], AIError) else AIError(str(parts[0]))
    out = {"title": unit, "intro": "", "key_points": [], "formulas": [], "mnemonics": [], "real_life": "",
           "question_types": [], "mistakes": [], "bar_model": {"enabled": False}}
    for r in parts:
        if isinstance(r, dict):
            out.update({k: v for k, v in r.items() if v not in (None, "", [])})
    return out


async def visualize(qd: dict, figure: bytes | None = None) -> dict:
    content = [img_block(figure)] if figure else []
    content.append({"type": "text", "text": prompts.VISUALIZE_TASK.format(
        guide=prompts.VISUAL_GUIDE, question=question_text(qd, with_answer=True) +
        ("\n解題步驟：" + "；".join(qd.get("steps") or []) if qd.get("steps") else ""))})
    return await call_json("visualize", content, prompts.VISUALIZE_SCHEMA, effort="medium", max_tokens=16000, fast=True)


async def lesson(items: list[dict]) -> dict:
    """觀念教學重點 for a paper: the questions are split by unit and each group's
    concepts are written in parallel, then merged in paper order."""
    groups: dict = {}
    for it in items:
        groups.setdefault(it.get("unit") or it.get("qtype") or "其他", []).append(it)
    chunks = list(groups.values())
    while len(chunks) > 4:  # at most 4 requests: fold the smallest groups together
        chunks.sort(key=len)
        chunks = [chunks[0] + chunks[1]] + chunks[2:]

    async def one(group: list[dict]) -> dict:
        lines = []
        for it in group:
            wrongs = "、".join(a for a in (it.get("wrong_answers") or []) if a) or it.get("student_answer") or "（無）"
            lines.append(f"第 {it['n']} 題：{question_text(it)}\n  錯過 {it.get('wrong_count') or 1} 次；寫錯的答案：{wrongs}／單元：{it.get('unit') or ''}")
        text = prompts.LESSON_TASK.format(guide=prompts.VISUAL_GUIDE, questions="\n".join(lines))
        if len(chunks) > 1:
            text += "\n\n（這份卷子的其他單元由別人負責，這次只整理上面這幾題的觀念，1~2 個重點即可。）"
        return await call_json("lesson", [{"type": "text", "text": text}], prompts.LESSON_SCHEMA,
                               effort="medium", max_tokens=12000, fast=True)

    parts = await asyncio.gather(*(one(g) for g in chunks), return_exceptions=True)
    ok = [r for r in parts if isinstance(r, dict)]
    if not ok:
        err = next((r for r in parts if isinstance(r, Exception)), None)
        raise err if isinstance(err, AIError) else AIError("AI 暫時無法整理觀念，請稍後再試。")
    concepts = sorted((c for r in ok for c in r.get("concepts") or []), key=lambda c: min(c.get("question_numbers") or [999]))
    tips = list(dict.fromkeys(t for r in ok for t in r.get("tips") or []))[:3]
    return {"title": ok[0].get("title", ""), "intro": ok[0].get("intro", ""), "concepts": concepts, "tips": tips}


async def example_hint(qd: dict, figure: bytes | None = None) -> dict:
    content = ([img_block(figure)] if figure else []) + [{"type": "text", "text": prompts.EXAMPLE_HINT_TASK.format(
        question=question_text(qd))}]
    return await call_json("example_hint", content, prompts.EXAMPLE_HINT_SCHEMA, effort="medium", max_tokens=8000, fast=True)


async def coach(qd: dict, grade: int) -> dict:
    wrongs = "、".join(a for a in (qd.get("wrong_answers") or []) if a) or qd.get("student_answer") or "（無紀錄）"
    text = prompts.COACH_TASK.format(grade=grade, times=max(1, qd.get("wrong_count") or 1), wrongs=wrongs,
                                     question=question_text(qd), answer=qd.get("answer", ""),
                                     explanation=(qd.get("explanation") or "")[:800])
    return await call_json("coach", [{"type": "text", "text": text}], prompts.COACH_SCHEMA, effort="medium", max_tokens=8000, fast=True)


async def steps_text(qd: dict, steps: str) -> dict:
    ref = reference(qd)
    text = prompts.STEPS_TASK.format(question=question_text(qd), answer_ref=ref, steps=steps[:3000])
    return await call_json("steps", [{"type": "text", "text": text}], prompts.TUTOR_SCHEMA, effort=setting("effort_tutor"), fast=True)


async def chat_note(qd: dict, history: list[dict]) -> dict:
    chat = "\n".join(f"{'學生' if m['role'] == 'user' else '小老師'}：{m.get('text', '')}" for m in history[-20:])
    text = prompts.NOTE_TASK.format(question=question_text(qd, with_answer=True), chat=chat[:6000])
    return await call_json("note", [{"type": "text", "text": text}], prompts.NOTE_SCHEMA, effort="low", max_tokens=4000, fast=True)


async def diagnose(qd: dict, wrong: str, figure: bytes | None = None) -> dict:
    text = prompts.DIAGNOSE_TASK.format(question=question_text(qd), answer=qd.get("answer", ""), wrong=wrong[:500])
    content = [{"type": "text", "text": text}]
    if figure:
        content += [{"type": "text", "text": "題目附圖："}, img_block(figure)]
    return await call_json("diagnose", content, prompts.DIAGNOSE_SCHEMA, effort="low", max_tokens=2000, fast=True)


async def reteach(qd: dict, used: list[str], n: int = 3, figure: bytes | None = None) -> dict:
    """n different explanations, written in parallel (one request per approach,
    each told its own style) and merged — about the time of a single one."""
    wrongs = "、".join(a for a in (qd.get("wrong_answers") or []) if a) or qd.get("student_answer") or "（沒有紀錄）"

    async def one(i: int) -> dict:
        style = prompts.RETEACH_STYLES[i % len(prompts.RETEACH_STYLES)]
        text = prompts.RETEACH_TASK.format(
            times=max(1, qd.get("wrong_count") or 1), question=question_text(qd), answer=qd.get("answer", ""),
            explanation=(qd.get("explanation") or "")[:800], wrongs=wrongs, used="、".join(used) or "（無）",
            n=1, guide=prompts.VISUAL_GUIDE) + f"\n\n這一種解說請用「{style}」的方式。"
        content = ([img_block(figure)] if figure else []) + [{"type": "text", "text": text}]
        return await call_json("reteach", content, prompts.RETEACH_SCHEMA, effort="medium", max_tokens=12000, fast=True)

    parts = [r for r in await asyncio.gather(*(one(i) for i in range(n)), return_exceptions=True) if isinstance(r, dict)]
    if not parts:
        raise AIError("AI 暫時無法換方法解說，請稍後再試。")
    out = dict(parts[0])
    seen, approaches = set(), []
    for r in parts:
        for a in r.get("approaches") or []:
            if a.get("name") and a["name"] not in seen:
                seen.add(a["name"]); approaches.append(a)
    out["approaches"] = approaches
    return out


async def tutor_quick(qd: dict, work_image: bytes, figure: bytes | None = None) -> dict:
    ref = reference(qd)
    content = ([{"type": "text", "text": "題目附圖："}, img_block(figure)] if figure else []) + [img_block(work_image, "image/png"),
               {"type": "text", "text": prompts.TUTOR_QUICK_TASK.format(question=question_text(qd), answer_ref=ref)}]
    return await call_json("tutor_quick", content, prompts.TUTOR_QUICK_SCHEMA, effort="low", max_tokens=1500, fast=True)


async def judge(stem: str, answer: str, student: str) -> dict:
    text = prompts.JUDGE_TASK.format(stem=stem, answer=answer, student=student)
    return await call_json("judge", [{"type": "text", "text": text}], prompts.JUDGE_SCHEMA,
                           effort="low", max_tokens=2000, fast=True)


async def report(data: dict) -> dict:
    text = prompts.REPORT_TASK.format(data=json.dumps(data, ensure_ascii=False))
    return await call_json("report", [{"type": "text", "text": text}], prompts.REPORT_SCHEMA,
                           effort="medium", max_tokens=16000)


async def ping() -> str:
    if provider() == "subscription":
        out = []
        async for c in claude_sub.stream_text("你是測試助理。", setting("model"),
                                              [{"type": "text", "text": "用繁體中文回一句：連線成功！"}], "low"):
            if isinstance(c, str):
                out.append(c)
        text = "".join(out).strip()
        if not text or text.startswith("⚠️"):
            raise AIError(text.lstrip("⚠️ ").strip() or "沒有回應")
        return text
    msg = await client().messages.create(model=setting("model"), max_tokens=300,
                                         output_config={"effort": "low"},
                                         messages=[{"role": "user", "content": "用繁體中文回一句：連線成功！"}])
    _log_usage("ping", msg)
    return "".join(b.text for b in msg.content if b.type == "text")


async def check_visual(context: str, visual: dict, png: bytes, grade: int = 6) -> dict:
    text = prompts.VISUAL_CHECK_TASK.format(grade=grade, context=context[:2500],
                                            visual=json.dumps(visual, ensure_ascii=False)[:3000])
    res = await call_json("visual_check", [img_block(png, "image/png"), {"type": "text", "text": text}],
                          prompts.VISUAL_CHECK_SCHEMA, effort="low", max_tokens=2000, fast=True)
    res["ok"] = bool(res.get("ok")) and int(res.get("score") or 0) >= 4
    return res


async def fix_visual(context: str, visual: dict, problems: list, grade: int = 6) -> dict:
    text = prompts.VISUAL_FIX_TASK.format(grade=grade, context=context[:2500], guide=prompts.VISUAL_GUIDE,
                                          visual=json.dumps(visual, ensure_ascii=False)[:3000],
                                          problems="\n".join(f"- {p}" for p in problems) or "- （不夠清楚）")
    return await call_json("visual_fix", [{"type": "text", "text": text}], prompts.VISUAL, effort="medium",
                           max_tokens=6000, fast=True)


async def read_answers(questions: list[dict], images: list[bytes]) -> list[dict]:
    """批改 a redone paper: her answer to each question, read from the photos of the paper she wrote."""
    schema = {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object", "properties": {"id": {"type": "integer"}, "answer": {"type": "string"}},
        "required": ["id", "answer"], "additionalProperties": False}}}, "required": ["items"], "additionalProperties": False}
    lines = "\n".join(f"[id {q['id']}] 第 {q.get('number') or '?'} 題：{q['stem']}" for q in questions)
    text = ("這些照片是孩子重新寫完的考卷。下面是這份考卷的題目（id、題號、題目開頭）。\n"
            "請在照片中找到每一題，抄下孩子手寫的答案（選擇題寫她選的選項，例如 ③；計算題寫最後答案；"
            "沒寫就空字串；看不清楚寫「（看不清楚）」）。不要自己解題。id 照抄。\n\n" + lines)
    res = await call_json("read_answers", [*[img_block(b) for b in images[:8]], {"type": "text", "text": text}],
                          schema, effort="low", max_tokens=8000, fast=True)
    return res.get("items") or []


CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩"


def _grade_line(it: dict) -> str:
    opts = it.get("options") or []
    o = ("\n選項：" + "　".join(f"{CIRCLED[i] if i < len(CIRCLED) else i + 1} {x[:80]}" for i, x in enumerate(opts))) if opts else ""
    return (f"[id {it['id']}] 第 {it.get('number') or '?'} 題（{it.get('qtype') or ''}）\n題目：{it['stem'][:600]}{o}\n"
            f"正確答案：{it['answer'][:300] or '（請你算出）'}\n孩子寫的答案：{it.get('student') or '（沒有辨識到）'}")


async def grade_answers(items: list[dict], images: list[bytes], closeups: dict | None = None, careful: bool = False) -> list[dict]:
    """批改功課: every answer she wrote checked against the right answer (photos to re-read her writing).
    closeups: {question id: a close photo of that question} — for the ones hard to read on the page."""
    lines = "\n\n".join(_grade_line(it) for it in items)
    content = [img_block(b) for b in images[:3]]
    if closeups:
        note = "每一題都附上那一題的放大照片（標了 id）：仔細看孩子手寫的答案和紅筆，以照片為準。"
        if careful:
            note += ("這幾題前一次沒能判斷：請盡力認出孩子寫的字（數字、選項編號、文字），寫得潦草也試著判斷最可能的答案再批改；"
                     "只有完全看不出寫了什麼才用 unsure。")
        for it in items:
            if it["id"] in closeups:
                content += [{"type": "text", "text": f"[id {it['id']}] 第 {it.get('number') or '?'} 題的放大照片："}, img_block(closeups[it["id"]])]
    else:
        note = "也附上這幾題所在頁面的照片，辨識有疑問時以照片上孩子的字跡為準，紅筆批改也看照片。" if images else ""
    text = prompts.GRADE_TASK.format(items=lines, images_note=note)
    unsolved = any(not it["answer"] for it in items)  # it has to work some answers out: think a little more
    res = await call_json("grade", [*content, {"type": "text", "text": text}],
                          prompts.GRADE_SCHEMA, effort="high" if careful else "medium" if unsolved or closeups else "low",
                          max_tokens=16000, fast=not careful)
    return res.get("items") or []


async def sketch(qd: dict) -> dict:
    """計算紙: a picture of what a question without a figure describes, for her to draw on."""
    text = prompts.SKETCH_TASK.format(question=question_text(qd)[:2500])
    return await call_json("sketch", [{"type": "text", "text": text}], prompts.SKETCH_SCHEMA, effort="low",
                           max_tokens=6000, fast=True)


async def chapters(subject: str, items: list[dict]) -> dict:
    """{question id: "6.1" | "6" | "-"}: where each question belongs in the family's review book (章節)."""
    from . import curriculum
    lines = "\n".join(f"[id {q['id']}]（原單元：{q.get('unit') or '無'}）{(q.get('stem') or '')[:220]}" for q in items)
    text = (f"下面是{subject}參考書的目次（章節代號在前）：\n{curriculum.book_text(subject)}\n\n"
            "請把每一題歸到最適合的「主題」（例如 6.1）。題目同時涵蓋同一單元好幾個主題才填單元（例如 6）；"
            "和目次都無關才填 -。id 照抄。\n\n" + lines)
    schema = {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object", "properties": {"id": {"type": "integer"}, "chapter": {"type": "string"}},
        "required": ["id", "chapter"], "additionalProperties": False}}}, "required": ["items"], "additionalProperties": False}
    res = await call_json("chapters", [{"type": "text", "text": text}], schema, effort="low", max_tokens=4000)
    keys = {c["key"] for c in curriculum.chapters(subject)}
    return {int(it["id"]): (it["chapter"].strip() if it["chapter"].strip() in keys else "-") for it in res.get("items") or []}


async def classify_exam(title: str, header: str, kinds: list[dict]) -> str:
    """Which of the parent's own exam types (by name) this scanned exam is; "" when none fits."""
    opts = "\n".join(f"- {k['id']}：{k['name']}" for k in kinds)
    text = (f"考卷名稱：{title}\n考卷開頭的文字：{header[:300]}\n\n家長自己設定的考卷類型：\n{opts}\n\n"
            "這份考卷屬於哪一個類型？只有很確定時才選，不確定就回答 none。")
    schema = {"type": "object", "properties": {"kind": {"type": "string"}}, "required": ["kind"], "additionalProperties": False}
    res = await call_json("classify_exam", [{"type": "text", "text": text}], schema, effort="low", max_tokens=200, fast=True)
    k = str(res.get("kind") or "")
    return k if any(x["id"] == k for x in kinds) else ""


async def upgrade_question(qd: dict, crop: bytes, figure: bytes | None, zhuyin: bool | None = None) -> dict:
    """題目升級: proofread against the original, rebuild the figure (table / SVG), full 詳解."""
    content = [{"type": "text", "text": "題目原稿："}, img_block(crop, "image/png")]
    if figure:
        content += [{"type": "text", "text": "其中的圖："}, img_block(figure, "image/png")]
    note = (f"\n\n【家長的說明，一定正確、以這個為準】{qd['fix_note']}\n（請照這個說明修正題目、圖形（SVG 要照說明重畫）、答案和詳解；"
            "原稿看不清楚的地方以家長的說明為準。）") if qd.get("fix_note") else ""
    # what the whole paper looks like (ai.detect_layout): a 注音 paper gets 注音 on every character, a plain one none
    zy = "這份考卷的國字旁都印有注音：每個國字都要標。" if zhuyin else "這份考卷沒有印注音：不要加注音。" if zhuyin is False else ""
    content.append({"type": "text", "text": prompts.UPGRADE_TASK.format(question=question_text(qd, with_answer=True), zhuyin=zy) + note})
    return await call_json("upgrade", content, prompts.UPGRADE_SCHEMA, effort=setting("effort_solve"), max_tokens=32000)


async def verify_answers(items: list[dict], images: list[bytes]) -> list[dict]:
    """答案複查: each question solved again from its own photo by a second look that is told not to
    trust the answer it has, then compared with it. items: [{index, qtype, stem, options, answer,
    explanation, steps, section, lead, fix_note}], one image per item."""
    content, lines = [], []
    for it, img in zip(items, images):
        content += [{"type": "text", "text": f"index {it['index']} 的原稿："}, img_block(img, "image/png")]
        lines.append(f"--- index {it['index']} ---\n{question_text(it, with_answer=True)}"
                     + (f"\n原本的詳解：{it['explanation']}" if it.get("explanation") else "")
                     + ("\n原本的步驟：" + "；".join(it["steps"]) if it.get("steps") else ""))
    content.append({"type": "text", "text": prompts.VERIFY_TASK.format(questions="\n".join(lines))})
    res = await call_json("verify", content, prompts.VERIFY_SCHEMA, effort=setting("effort_solve"), max_tokens=32000)
    return res.get("results", [])


async def check_figure(original: bytes, redrawn: bytes, stem: str) -> dict:
    content = [img_block(original, "image/png"), img_block(redrawn, "image/png"),
               {"type": "text", "text": prompts.FIGURE_CHECK_TASK.format(stem=stem[:600])}]
    return await call_json("figure_check", content, prompts.FIGURE_CHECK_SCHEMA, effort="medium", max_tokens=3000)


async def fix_figure(original: bytes, svg: str, problems: list, stem: str) -> str:
    content = [img_block(original, "image/png"), {"type": "text", "text": prompts.FIGURE_FIX_TASK.format(
        problems="\n".join(f"- {p}" for p in problems), svg=svg[:12000], stem=stem[:600])}]
    res = await call_json("figure_fix", content, {"type": "object", "properties": {"svg": {"type": "string"}},
                                                  "required": ["svg"], "additionalProperties": False},
                          effort="medium", max_tokens=16000)
    return res.get("svg", "")
