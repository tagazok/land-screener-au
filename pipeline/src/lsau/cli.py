"""lsau CLI: `lsau fetch` downloads raw sources, `lsau build` produces web artifacts."""

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
    args = p.parse_args()
    if args.cmd == "fetch":
        from .fetch import fetch_all

        fetch_all(RAW)
    else:
        from .build import build

        build(RAW, OUT)


if __name__ == "__main__":
    main()
