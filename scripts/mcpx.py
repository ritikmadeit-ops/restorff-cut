"""mcpx: one RestorffCut MCP call through scripts/mcp-call.ts, logged — the recreation / replay harness.

Moved here from docs/restorff/recreations/warm-moody/harness/mcpx.py by the revise-safety agent (2026-10-21): no
hard-coded paths (the warm-moody-oat replay had to edit REPO and LOG by hand, and Git Bash paths failed on the server).

usage (from anywhere; Python 3.11+, no packages; the dev server must be up on :8791):
  python -I scripts/mcpx.py <tool> <@args.json | inline json> [--images <dir outside the repo>] [--timeout s]
                            [--note "..."] [--log <calls.jsonl>]
  python -I scripts/mcpx.py wait-render <render_id> [--polls 20] [--log <calls.jsonl>]

- runs `bun scripts/mcp-call.ts call <tool> @<args file>` in this repo (the folder above scripts/)
- Git Bash paths are converted for the Windows server: "/c/Users/..." -> "C:/Users/..." in the @args path and in
  every string value of the args that looks like one (path_hint, file, …)
- saves the raw result + stderr to $RC_WORK/calls/NNN-<tool>.json / .err (RC_WORK defaults to
  <temp>/restorffcut-mcpx; never inside the repo: results can carry frames from local reel tests)
- appends one line to the log (--log, else $RC_LOG, else $RC_WORK/calls.jsonl): n, at, tool, args (base64 / strings >
  300 chars -> sha256 prefix + length), ok, exit, status, error, key result fields, seconds, images, raw_result
- prints the result (truncated at 6000 chars)
- wait-render: polls render {render_id, wait_s: 25} (the render tool waits at most 25 s per call) until
  render.status is done / error / failed, at most --polls times; prints one line per poll and the last result
Windows: bun resolves to bun.CMD through shutil.which.
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent  # scripts -> restorffcut

KEY_FIELDS = {
    "status", "ok", "commit", "commit_id", "head", "head_commit", "render_id", "job_id", "element_id", "media_id",
    "timeline_id", "url", "file", "duration", "duration_s", "loudness", "verdict", "label", "preset", "removed_s",
    "chunks", "message", "editor_url", "upload_id", "approved", "rows", "versions", "findings", "not_understood",
    "understood", "ops", "applied", "summary", "words", "cuts", "error", "code", "progress", "state", "name", "kind",
    "style", "conflict", "reason", "frames", "count", "total", "ops_count", "word_fixes", "caption_spans", "mixed_spans",
}

GITBASH = re.compile(r"^/([a-zA-Z])/(.*)$")


def winpath(value):
    """'/c/Users/x' -> 'C:/Users/x' on Windows (Git Bash style); anything else unchanged."""
    if os.name != "nt" or not isinstance(value, str):
        return value
    m = GITBASH.match(value)
    return f"{m.group(1).upper()}:/{m.group(2)}" if m else value


WORK = Path(winpath(os.environ.get("RC_WORK") or str(Path(tempfile.gettempdir()) / "restorffcut-mcpx")))
CALLS = WORK / "calls"


def convert_paths(v):
    if isinstance(v, str):
        return winpath(v)
    if isinstance(v, dict):
        return {k: convert_paths(x) for k, x in v.items()}
    if isinstance(v, list):
        return [convert_paths(x) for x in v]
    return v


def sanitize(v, key=""):
    if isinstance(v, str):
        if key in ("data_base64", "source", "data") or len(v) > 300:
            return {"sha256": hashlib.sha256(v.encode("utf-8")).hexdigest()[:16], "len": len(v)}
        return v
    if isinstance(v, dict):
        return {k: sanitize(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [sanitize(x, key) for x in v]
    return v


def short(v):
    if isinstance(v, str):
        return v if len(v) <= 240 else v[:237] + "..."
    if isinstance(v, list):
        if all(not isinstance(x, (dict, list)) for x in v) and len(json.dumps(v)) <= 240:
            return v
        return {"list_len": len(v)}
    if isinstance(v, dict):
        return v if len(json.dumps(v, ensure_ascii=False)) <= 240 else {"keys": list(v.keys())[:20]}
    return v


def key_fields(res):
    if not isinstance(res, dict):
        return {"type": type(res).__name__}
    out = {k: short(v) for k, v in res.items() if k in KEY_FIELDS}
    nxt = res.get("next")
    if isinstance(nxt, dict):
        out["next"] = {"do": short(nxt.get("do", "")), "tool": nxt.get("tool")}
    return out


def call(tool, args, images=None, timeout=None, note=None, log=None, quiet=False):
    """One call: returns (result dict or None, exit code, path of the raw result)."""
    CALLS.mkdir(parents=True, exist_ok=True)
    log_path = Path(winpath(log or os.environ.get("RC_LOG") or str(WORK / "calls.jsonl")))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    args = convert_paths(args)
    n = len(list(CALLS.glob("*.err"))) + 1
    stem = f"{n:03d}-{tool}"
    argfile = CALLS / f"{stem}.args.json"
    argfile.write_text(json.dumps(args), encoding="utf-8")
    cmd = [shutil.which("bun") or "bun", "scripts/mcp-call.ts", "call", tool, f"@{argfile}"]
    if images:
        cmd += ["--images", winpath(images)]
    if timeout:
        cmd += ["--timeout", str(timeout)]
    t0 = time.time()
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
    secs = round(time.time() - t0, 2)
    (CALLS / f"{stem}.json").write_text(r.stdout, encoding="utf-8")
    (CALLS / f"{stem}.err").write_text(r.stderr, encoding="utf-8")
    try:
        res = json.loads(r.stdout) if r.stdout.strip() else None
    except Exception:
        res = {"unparsed": r.stdout[:300]}
    err = None
    if isinstance(res, dict) and isinstance(res.get("error"), dict):
        err = {"code": res["error"].get("code"), "message": short(res["error"].get("message", ""))}
    if err is None and r.returncode != 0:
        if isinstance(res, dict) and res.get("state") == "error":
            err = {"code": "job_error", "message": short(str(res.get("error")))}
        else:
            last = [l for l in r.stderr.strip().splitlines() if l.startswith("mcp-call:")]
            err = {"code": "transport", "message": short(last[-1] if last else r.stderr.strip()[-240:])}
    m = re.search(r"images (\d+)", r.stderr)
    line = {
        "n": n, "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tool": tool, "args": sanitize(args),
        "ok": r.returncode == 0 and err is None, "exit": r.returncode,
        "status": res.get("status") if isinstance(res, dict) else None, "error": err, "key": key_fields(res),
        "seconds": secs, "images": int(m.group(1)) if m else 0, "raw_result": f"$RC_WORK/calls/{stem}.json",
    }
    if note:
        line["note"] = note
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")
    if not quiet:
        print(f"#{n} {tool} exit={r.returncode} {secs}s -> {CALLS / (stem + '.json')}")
        print(r.stderr.strip()[-800:])
        print(r.stdout if len(r.stdout) < 6000 else r.stdout[:6000] + f"\n... [{len(r.stdout)} chars]")
    return res, r.returncode, CALLS / f"{stem}.json"


def wait_render(render_id, polls=20, log=None):
    status = None
    res = None
    for i in range(1, polls + 1):
        res, code, path = call("render", {"render_id": render_id, "wait_s": 25}, log=log, quiet=True)
        # the status sits at result.render.status (reading result.status cost 19 redundant polls in warm-moody)
        status = ((res or {}).get("render") or {}).get("status") if isinstance(res, dict) else None
        print(f"poll {i}: {status} ({path})")
        if status in ("done", "error", "failed") or code != 0:
            break
    print(json.dumps(res, ensure_ascii=False)[:6000])
    return 0 if status == "done" else 1


def main():
    argv = sys.argv[1:]
    if not argv:
        raise SystemExit(__doc__)
    opts = {"--images": None, "--timeout": None, "--note": None, "--log": None, "--polls": None}
    positional = []
    i = 0
    while i < len(argv):
        if argv[i] in opts:
            opts[argv[i]] = argv[i + 1]
            i += 2
        else:
            positional.append(argv[i])
            i += 1
    if positional[0] == "wait-render":
        raise SystemExit(wait_render(positional[1], int(opts["--polls"] or 20), opts["--log"]))
    tool, raw = positional[0], positional[1]
    args = json.loads(Path(winpath(raw[1:])).read_text(encoding="utf-8")) if raw.startswith("@") else json.loads(raw)
    _, code, _ = call(tool, args, opts["--images"], opts["--timeout"], opts["--note"], opts["--log"])
    raise SystemExit(code)


sys.stdout.reconfigure(encoding="utf-8", errors="replace")
main()
