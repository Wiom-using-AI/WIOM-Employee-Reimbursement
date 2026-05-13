"""
Standalone worker script for Keka automation.

Runs as a subprocess so it gets its own ProactorEventLoop (needed on Windows
for Playwright to launch Chrome). Uvicorn's SelectorEventLoop is not inherited
by a fresh process, so the NotImplementedError is avoided entirely.

Usage:
    python keka_auto_worker.py <from_date> <to_date> <out_dir> <status_path> [--company <name>]

Writes step messages to status_path JSON and prints JSON result to stdout on success.
Exits with code 1 and prints error to stderr on failure.
"""
import sys
import os
import json
import argparse

# ── Windows: fix "Assertion failed: process_title" in libuv ─────────────────
# When spawned with piped stdout/stderr the process has no console.
# libuv's uv_set_process_title() calls GetConsoleTitle() which asserts.
# AllocConsole() gives the process a hidden console so the call succeeds.
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW("keka_worker")
    except Exception:
        pass
    # Also force ProactorEventLoop so Playwright can launch subprocesses
    import asyncio
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

# Add backend dir to path so imports work
sys.path.insert(0, os.path.dirname(__file__))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("from_date")
    parser.add_argument("to_date")
    parser.add_argument("out_dir")
    parser.add_argument("status_path")
    parser.add_argument("--company", default=None)
    args = parser.parse_args()

    def on_step(msg: str):
        try:
            with open(args.status_path, "r", encoding="utf-8") as f:
                s = json.load(f)
            s["current_step"] = msg
            with open(args.status_path, "w", encoding="utf-8") as f:
                json.dump(s, f, indent=2)
        except Exception:
            pass

    from services.keka_postman import download_bulk_receipts_fully_auto
    result = download_bulk_receipts_fully_auto(
        args.from_date, args.to_date, args.out_dir,
        company=args.company, on_step=on_step,
    )
    print(json.dumps(result))

if __name__ == "__main__":
    main()
