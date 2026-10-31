"""lsau CLI: `lsau fetch` downloads raw sources, `lsau build` produces web artifacts,
`lsau summarize` writes the AI summaries (Amazon Bedrock)."""

from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RAW = ROOT / "raw"
OUT = ROOT / "web" / "public" / "data"


def main() -> None:
    p = argparse.ArgumentParser(prog="lsau")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    sub.add_parser("build")
    s = sub.add_parser("summarize", help="generate AI summaries with Amazon Bedrock (cached)")
    s.add_argument("--limit", type=int)
    s.add_argument("--workers", type=int, default=6, help="parallel Bedrock calls")
    args = p.parse_args()
    if args.cmd == "fetch":
        from .fetch import fetch_all

        fetch_all(RAW)
    elif args.cmd == "build":
        from .build import build

        build(RAW, OUT)
    else:
        from .summarize import summarize

        summarize(OUT, RAW / "ai" / "summaries-cache.json", limit=args.limit, workers=args.workers)


if __name__ == "__main__":
    main()
