"""Network / AirPrint printing through CUPS on the Pi.

- Printers already set up in CUPS (USB or network) are listed with status.
- AirPrint / IPP Everywhere / Mopria printers on the LAN are discovered via
  DNS-SD and added driverless (`lpadmin -m everywhere`).
- Jobs are sent with `lp` (A4, copies, duplex, B&W) and can be cancelled.
- Printers can be shared so iPhones/iPads see them as AirPrint printers.
The server user must be in the `lpadmin` group to add/enable printers.
"""
import asyncio
import re
import shutil
import urllib.parse
from pathlib import Path


class PrintError(Exception):
    pass


def available() -> bool:
    return bool(shutil.which("lp") and shutil.which("lpstat"))


async def _run(*args, timeout=30) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={"LANG": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except FileNotFoundError as e:
        raise PrintError("這台樹莓派沒有安裝 CUPS 列印系統（sudo apt install cups）") from e
    except asyncio.TimeoutError as e:
        proc.kill()
        raise PrintError("印表機沒有回應（逾時）") from e
    if proc.returncode != 0:
        msg = (err or out).decode(errors="ignore").strip()
        raise PrintError(_friendly(msg))
    return out.decode(errors="ignore")


def _friendly(msg: str) -> str:
    low = msg.lower()
    if "forbidden" in low or "not authorized" in low or "permission" in low:
        return "權限不足：伺服器帳號需要加入 lpadmin 群組（sudo usermod -aG lpadmin $USER）"
    if "unable to connect" in low or "no route" in low:
        return "連不到印表機，請確認印表機已開機並連上同一個網路"
    if "does not exist" in low or "unknown printer" in low or "invalid destination" in low:
        return "找不到這台印表機"
    return msg[:300] or "列印失敗"


_STATE = {"idle": "待機中", "processing": "列印中", "disabled": "已停用"}


async def printers() -> dict:
    if not available():
        return {"cups": False, "printers": [], "default": ""}
    try:
        default = (await _run("lpstat", "-d")).split(":")[-1].strip()
    except PrintError:
        default = ""
    if "no system default" in default:
        default = ""
    try:
        status = await _run("lpstat", "-l", "-p")
    except PrintError:
        status = ""
    out = []
    cur = None
    for line in status.splitlines():
        m = re.match(r"printer (\S+) (?:is )?(idle|disabled|now printing\S*)", line)
        if m:
            st = "processing" if m.group(2).startswith("now printing") else m.group(2)
            cur = {"name": m.group(1), "state": st, "state_text": _STATE.get(st, st),
                   "message": "", "default": m.group(1) == default, "uri": "", "shared": False,
                   "info": "", "duplex": False}
            if " - " in line:
                cur["since"] = line.split(" since ", 1)[-1].split(" -")[0] if " since " in line else ""
            out.append(cur)
        elif cur and line.startswith("\t") and line.strip() and not line.strip().startswith(("Form", "Content", "Printer types", "Alerts")):
            txt = line.strip()
            if txt.startswith("Description:"):
                cur["info"] = txt.split(":", 1)[1].strip()
            elif not cur["message"] and ":" not in txt[:12]:
                cur["message"] = _translate(txt)
    for p in out:
        try:
            v = await _run("lpstat", "-v", p["name"], timeout=5)
            p["uri"] = v.split(":", 1)[1].strip() if ":" in v else ""
            opts = await _run("lpoptions", "-p", p["name"], timeout=5)
            p["shared"] = "printer-is-shared=true" in opts
            p["accepting"] = "printer-is-accepting-jobs=true" in opts or "printer-is-accepting-jobs" not in opts
            detail = await _run("lpoptions", "-p", p["name"], "-l", timeout=5)
            p["duplex"] = bool(re.search(r"^(Duplex|sides)\b.*(DuplexNoTumble|two-sided)", detail, re.M | re.I))
        except PrintError:
            pass
    return {"cups": True, "printers": out, "default": default}


def _translate(msg: str) -> str:
    table = {
        "unplugged or turned off": "印表機沒接上或沒開機",
        "waiting for printer to become available": "等待印表機…",
        "paused": "已暫停",
        "media-empty": "沒有紙了",
        "toner-low": "碳粉不足",
        "media-jam": "卡紙",
        "door-open": "機蓋沒關",
    }
    low = msg.lower()
    for k, v in table.items():
        if k in low:
            return v
    return msg


def _name_from_uri(uri: str) -> str:
    host = urllib.parse.urlparse(uri).netloc or uri
    host = urllib.parse.unquote(host.split("._")[0])
    return host


async def discover() -> list[dict]:
    """Network printers that speak IPP / AirPrint, excluding ones already added."""
    if not available():
        raise PrintError("這台樹莓派沒有安裝 CUPS")
    have = {p["uri"] for p in (await printers())["printers"]}
    found, seen = [], set()
    try:
        txt = await _run("lpinfo", "--timeout", "8", "-v", timeout=20)
    except PrintError:
        txt = ""
    for line in txt.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        uri = parts[1].strip()
        if not re.match(r"(dnssd|ipps?)://", uri) or uri in ("ipp", "ipps") or "://" not in uri:
            continue
        if uri in have:
            continue
        name = _name_from_uri(uri)
        if "@ " in name or name.endswith(" @ " + "raspberrypi"):
            continue  # our own shared queues
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        found.append({"name": name, "uri": uri, "kind": "AirPrint/IPP" if uri.startswith("dnssd") else "IPP"})
    return found


def _queue_name(name: str) -> str:
    q = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")[:60]
    return q or "Printer"


async def add(name: str, uri: str, make_default: bool = False, share: bool = True) -> str:
    if not re.match(r"^(dnssd|ipps?|socket|lpd|usb|http)://", uri):
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", uri.strip()):
            uri = f"ipp://{uri.strip()}/ipp/print"
        else:
            raise PrintError("網址格式不正確，例如 ipp://192.168.1.50/ipp/print")
    q = _queue_name(name)
    await _run("lpadmin", "-p", q, "-E", "-v", uri, "-m", "everywhere",
               "-o", "media-default=iso_a4_210x297mm", "-o", "PageSize=A4",
               "-o", f"printer-is-shared={'true' if share else 'false'}", timeout=90)
    await _run("cupsenable", q)
    await _run("cupsaccept", q)
    if make_default:
        await _run("lpadmin", "-d", q)
    return q


async def remove(name: str):
    await _run("lpadmin", "-x", name)


async def set_default(name: str):
    await _run("lpadmin", "-d", name)


async def enable(name: str):
    await _run("cupsenable", name)
    await _run("cupsaccept", name)


async def share(name: str, on: bool):
    await _run("lpadmin", "-p", name, "-o", f"printer-is-shared={'true' if on else 'false'}")
    if on:
        await _run("cupsctl", "--share-printers")


async def test_page(name: str) -> str:
    for p in ("/usr/share/cups/data/testprint", "/usr/share/cups/data/default-testpage.pdf"):
        if Path(p).exists():
            return await send(name, Path(p), title="測試頁")
    raise PrintError("找不到 CUPS 測試頁")


async def send(name: str, pdf: Path, copies: int = 1, duplex: str = "one", color: bool = True,
               landscape: bool = False, title: str = "AI 總複習") -> str:
    args = ["lp", "-t", title[:60], "-n", str(max(1, min(50, int(copies)))), "-o", "media=A4",
            "-o", "fit-to-page"]
    if name:
        args += ["-d", name]
    if duplex == "two":
        args += ["-o", "sides=two-sided-short-edge" if landscape else "sides=two-sided-long-edge"]
    else:
        args += ["-o", "sides=one-sided"]
    if not color:
        args += ["-o", "print-color-mode=monochrome", "-o", "ColorModel=Gray"]
    out = await _run(*args, str(pdf))
    m = re.search(r"request id is (\S+)", out)
    return m.group(1) if m else out.strip()


async def jobs() -> list[dict]:
    if not available():
        return []
    try:
        txt = await _run("lpstat", "-o")
    except PrintError:
        return []
    out = []
    for line in txt.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            out.append({"id": parts[0], "user": parts[1], "size": parts[2],
                        "time": " ".join(parts[3:])})
    return out


async def cancel(job_id: str):
    await _run("cancel", job_id)
