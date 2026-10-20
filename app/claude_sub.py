"""Claude through the parent's claude.ai subscription.

Uses the Claude Agent SDK, which drives the Claude Code CLI installed on the
Pi and its saved claude.ai login (~/.claude/.credentials.json). No API key
is needed; usage counts against the subscription's limits. Tools, user
settings and CLAUDE.md files are all disabled so each call is a plain model
request with our own system prompt and JSON schema.
"""
import logging
import os
import shutil
import tempfile
from pathlib import Path

log = logging.getLogger("claude_sub")

_WORKDIR = Path(tempfile.gettempdir()) / "ai-review-claude"


class SubError(Exception):
    pass


def cli_path() -> str | None:
    for p in (shutil.which("claude"), str(Path.home() / ".local/bin/claude"), "/usr/local/bin/claude"):
        if p and Path(p).exists():
            return p
    return None


def logged_in() -> bool:
    if not cli_path():
        return False
    cred = Path.home() / ".claude" / ".credentials.json"
    return cred.exists() or bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))


def _friendly(text: str) -> str:
    low = (text or "").lower()
    if "usage limit" in low or "rate limit" in low or "limit reached" in low or "429" in low:
        return "Claude 訂閱的使用額度暫時用完了，請稍後再試（額度會在幾小時內恢復）。"
    if "login" in low or "auth" in low or "401" in low or "credentials" in low:
        return "Claude 登入已過期：請在樹莓派終端機執行 claude，輸入 /login 重新登入。"
    if "overloaded" in low or "529" in low or "500" in low:
        return "Claude 服務暫時忙碌，請稍後再試。"
    return f"AI 呼叫失敗：{(text or '未知錯誤')[:200]}"


def _nice_cli() -> str | None:
    """The Claude CLI at low CPU priority, for background work: a child's question gets the CPU first."""
    real = cli_path()
    if not real:
        return None
    w = _WORKDIR / "claude-nice"
    body = f'#!/bin/sh\nexec nice -n 10 "{real}" "$@"\n'
    if not w.exists() or w.read_text() != body:
        _WORKDIR.mkdir(exist_ok=True)
        w.write_text(body)
        w.chmod(0o755)
    return str(w)


def _options(system: str, model: str, effort: str, schema: dict | None, partial: bool = False, nice: bool = False):
    from claude_agent_sdk import ClaudeAgentOptions
    _WORKDIR.mkdir(exist_ok=True)
    kw = dict(system_prompt=system, tools=[], setting_sources=[], max_turns=4, model=model,
              effort=effort, cwd=str(_WORKDIR), cli_path=(_nice_cli() if nice else None) or cli_path(),
              include_partial_messages=partial,
              # plain model calls: no MCP servers or claude.ai connectors
              mcp_servers={}, strict_mcp_config=True,
              env={"ENABLE_CLAUDEAI_MCP_SERVERS": "false"},
              # one-shot calls are never resumed: don't save a transcript of each one (thousands a
              # day filled the Pi's SD card)
              extra_args={"no-session-persistence": None})
    if schema:
        kw["output_format"] = {"type": "json_schema", "schema": schema}
    return ClaudeAgentOptions(**kw)


def _user_stream(content: list):
    async def gen():
        yield {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None}
    return gen()


# --- warm Claude processes ---------------------------------------------------------------------
# Starting the Claude CLI for a call costs seconds of the Pi's CPU before the model even starts.
# For the calls a person is waiting on, a CLI with the same settings (system prompt, model,
# schema) is started ahead of time and sits connected; the next such call goes straight to the
# model. Each warm process answers exactly one call (no conversation carries over between
# children or questions) and a fresh one is started for the next. The SDK requires a client to be
# used from the task that connected it, so each warm process lives in its own task.

_WARM_MAX = 3        # warm processes kept at most (each is ~200 MB)
_WARM_TTL = 15 * 60  # a warm process nobody used for this long is closed
_END = object()
_pool: dict = {}     # key → _Warm


class _Warm:
    def __init__(self, key: str, opts):
        import asyncio
        import time
        self.key, self.opts = key, opts
        self.born = time.monotonic()
        self.jobs: asyncio.Queue = asyncio.Queue(maxsize=1)
        self.ready = asyncio.Event()
        self.failed = False
        self.task = asyncio.get_running_loop().create_task(self._run())

    async def _run(self):
        import asyncio
        from claude_agent_sdk import ClaudeSDKClient
        c = ClaudeSDKClient(options=self.opts)
        try:
            try:
                await c.connect()
            except Exception as e:
                log.warning("warm claude did not start: %s", e)
                self.failed = True
                return
            finally:
                self.ready.set()
            try:
                job = await asyncio.wait_for(self.jobs.get(), _WARM_TTL)
            except TimeoutError:
                return
            if job is None:
                return
            content, out = job
            try:
                await c.query(_user_stream(content))
                async for m in c.receive_response():
                    await out.put(m)
            except Exception as e:
                await out.put(e)
            finally:
                await out.put(_END)
        finally:
            if _pool.get(self.key) is self:
                del _pool[self.key]
            try:
                await asyncio.shield(c.disconnect())
            except BaseException:
                pass

    def close(self):
        if not self.task.done() and self.jobs.empty():
            try:
                self.jobs.put_nowait(None)
            except Exception:
                self.task.cancel()


def _key(*parts) -> str:
    import hashlib
    import json
    return hashlib.sha1(json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def prewarm(system: str, model: str, effort: str, schema: dict | None = None, partial: bool = False):
    """Start a warm process for calls with exactly these settings (e.g. the chat, at startup)."""
    _refill(_key(system, model, effort, schema, partial), _options(system, model, effort, schema, partial))


def _refill(key: str, opts):
    if key in _pool:
        return
    while len(_pool) >= _WARM_MAX:  # the one waiting longest makes room
        old = min(_pool.values(), key=lambda w: w.born)
        _pool.pop(old.key, None)
        old.close()
    _pool[key] = _Warm(key, opts)


async def _messages(system: str, model: str, effort: str, schema: dict | None, partial: bool, content: list, warm: bool,
                    nice: bool = False):
    """The SDK messages of one call — through a warm process when `warm` (and one is started for
    the next call like it), otherwise a CLI started just for this call (at low priority when `nice`)."""
    from claude_agent_sdk import query
    opts = _options(system, model, effort, schema, partial, nice=nice and not warm)
    if not warm:
        async for m in query(prompt=_user_stream(content), options=opts):
            yield m
        return
    import asyncio
    key = _key(system, model, effort, schema, partial)
    w = _pool.pop(key, None)
    if w is None or w.failed or w.task.done():
        w = _Warm(key, opts)
    await w.ready.wait()
    if w.failed:  # could not start one: the ordinary way
        async for m in query(prompt=_user_stream(content), options=opts):
            yield m
        return
    out: asyncio.Queue = asyncio.Queue()
    await w.jobs.put((content, out))
    _refill(key, opts)  # the next call like this one finds its CLI ready
    try:
        while True:
            m = await out.get()
            if m is _END:
                break
            if isinstance(m, Exception):
                raise m
            yield m
    finally:
        if not w.task.done():  # given up on (timeout, she left): stop that process
            w.task.cancel()


async def call_json(system: str, model: str, content: list, schema: dict, effort: str,
                    timeout: float = 600, warm: bool = False, nice: bool = False) -> tuple[dict, dict]:
    """Returns (structured_output, usage). A CLI that hangs is given up on after `timeout` s."""
    import asyncio
    from claude_agent_sdk import ResultMessage
    result = None
    try:
        async with asyncio.timeout(timeout):
            async for m in _messages(system, model, effort, schema, False, content, warm, nice):
                if isinstance(m, ResultMessage):
                    result = m
    except TimeoutError as e:
        log.warning("subscription call timed out after %ss", timeout)
        raise SubError("AI 太久沒有回應，請再試一次。") from e
    except Exception as e:  # CLI crashed, not logged in, network down…
        log.exception("subscription call failed")
        raise SubError(_friendly(str(e))) from e
    if result is None:
        raise SubError("AI 沒有回應，請重試。")
    if result.is_error or result.subtype != "success":
        raise SubError(_friendly(" ".join(str(x) for x in (result.errors or [])) or (result.result or result.subtype)))
    if not isinstance(result.structured_output, dict):
        raise SubError("AI 回覆格式有誤，請重試。")
    return result.structured_output, result.usage or {}


async def stream_text(system: str, model: str, content: list, effort: str, warm: bool = False):
    """Yields text chunks, then a final {'usage': ...} dict."""
    from claude_agent_sdk import AssistantMessage, ResultMessage, StreamEvent
    got_delta = False
    try:
        async for m in _messages(system, model, effort, None, True, content, warm):
            if isinstance(m, StreamEvent):
                ev = m.event or {}
                d = ev.get("delta") or {}
                if ev.get("type") == "content_block_delta" and d.get("type") == "text_delta":
                    got_delta = True
                    yield d.get("text", "")
            elif isinstance(m, AssistantMessage) and not got_delta:
                for b in m.content:
                    if getattr(b, "text", None):
                        yield b.text
            elif isinstance(m, ResultMessage):
                if m.is_error:
                    yield "\n⚠️ " + _friendly(" ".join(str(x) for x in (m.errors or [])) or (m.result or ""))
                yield {"usage": m.usage or {}}
    except Exception as e:
        log.exception("subscription chat failed")
        yield "\n⚠️ " + _friendly(str(e))
