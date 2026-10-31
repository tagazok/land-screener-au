"""Generate a short AI summary per suburb with Amazon Bedrock (offline, cached).

The web app is static, so summaries are produced once here and shipped as
web/public/data/summaries.json (fetched by the app when a suburb is opened).
Each summary is cached by a hash of the facts, model and prompt version:
re-running only calls Bedrock for suburbs whose data changed.

    (cd web && npx vite-node scripts/strategy-fit.ts)   # the screener's verdicts first
    uv run lsau summarize --limit 5                      # try a few
    uv run lsau summarize                                # all suburbs
"""

from __future__ import annotations

import hashlib
import re
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

MODEL_ID = "us.anthropic.claude-haiku-5-5"
REGION = "us-east-1"
PROMPT_VERSION = "2026-10-31.3"

# (column, label, kind) — kind drives formatting.
FACTS: list[tuple[str, str, str]] = [
    ("council", "Council", "text"),
    ("pop", "Residents (Census 2021)", "int"),
    ("pop_cagr", "Population growth per year since 2016 (SA2 area)", "pct2"),
    ("density", "Density (people/km²)", "int"),
    ("cbd_km", "Distance to the Adelaide CBD (km, straight line)", "dec"),
    ("median_age", "Median age", "int"),
    ("median_hh_income_week", "Median household income (A$/week, 2021)", "int"),
    ("seifa_decile_sa", "SEIFA advantage decile within SA (1 most disadvantaged – 10 most advantaged)", "int"),
    ("unemployment_rate", "Unemployment (2021)", "pct"),
    ("tenant_share", "Renting households", "pct"),
    ("social_share", "Social housing households", "pct"),
    ("unoccupied_share", "Unoccupied dwellings on census night", "pct"),
    ("house_share", "Separate houses among dwellings", "pct"),
    ("price_median_house", "Median house price (A$, last 4 quarters)", "int"),
    ("n_sales_house", "House sales in the last 4 quarters", "int"),
    ("price_trend_5y", "House price change over 5 years", "pct"),
    ("rent_week_house", "Median weekly rent of new house leases (A$)", "int"),
    ("rent_trend_5y", "House rent change over 5 years", "pct"),
    ("gross_yield_house", "Gross rental yield, house", "pct"),
    ("crime_burglary", "Residential break-ins per 1,000 dwellings (2025-26)", "dec"),
    ("crime_violence", "Assault, robbery and homicide offences per 1,000 residents (2025-26)", "dec"),
    ("crime_theft", "Vehicle and personal theft per 1,000 residents (2025-26)", "dec"),
    ("bushfire_high_share", "Share of area in a High bushfire protection area", "pct"),
    ("bushfire_med_high_share", "Share of area in a High or Medium bushfire protection area", "pct"),
    ("low_lying_share", "Share of area below 5 m elevation (coastal flooding)", "pct"),
    ("relief_m", "Relief (m, 95th − 5th percentile of elevation)", "int"),
    ("forest_around_share", "Tree cover within 5 km", "pct"),
]

SYSTEM = """You are a factual, careful property analyst in Adelaide. You get open data about ONE suburb of Greater Adelaide, with the median of all Greater Adelaide suburbs for comparison, and the screener's verdict for 3 strategies.

Write a summary in Australian English of 5 sentences, 130 words at most, as one paragraph, with no heading or list. Sentences 1 to 3 total 70 words at most, with the 2 most telling figures each.
1. What characterises the suburb (council, size, distance to the CBD, population trend).
2. Its main strengths, with figures.
3. Its main things to watch (bushfire, low-lying land, crime, prices, data gaps), with figures.
4. Which strategy or strategies the screener keeps it for, and what makes it suitable.
5. Which strategies it is removed from, with the deciding criterion and its figure (for example "removed for long-term rental: gross yield 2.6%, below the 3.5% required"). If it is removed everywhere, say so and give the two most blocking criteria. If it is kept everywhere, say so.

Strict rules:
- The "SCREENER VERDICT" block is authoritative: never say a strategy suits the suburb if the screener removes it, or the opposite. Do not explain a removal with any criterion other than those listed.
- Each of the 3 strategies must appear in sentence 4 or 5.
- Group strategies removed for the same reason in one clause.
- Use ONLY the data provided. Invent no fact, place or feature (no "beaches", "wineries", "schools", "train line" unless it is in the data).
- Missing data ("n/a") is unknown: do not comment on it. Exception: when house sales are "n/a", the Valuer-General does not publish prices for this council (it covers the 19 metropolitan councils only): say so once, and never write that no house was sold.
- Only call a value "high", "low", "strong" or "weak" when it clearly differs from the metro median provided. Compare with the metro median at most 3 times in the whole summary, writing "metro median" only once; do not repeat the comparison after every figure.
- A high price is not a strength in itself: present prices neutrally (affordable or expensive for Adelaide).
- Under 100 residents, the suburb is mostly non-residential (airport, port, industry, parkland): say so in sentence 1 and keep the rest short.
- No firm investment advice, no sales superlatives. Neutral, clear tone.
- Write numbers the Australian way ($850,000, 3.8%, 12 km)."""

STRATEGY_NAMES = {
    "long": "long-term rental",
    "growth": "capital growth",
    "live": "living there long term",
}

MAX_WORDS = 150


def _fmt(v, kind: str) -> str:
    if v is None:
        return "n/a"
    if kind == "text":
        return str(v)
    if kind == "int":
        return f"{v:,.0f}"
    if kind == "dec":
        return f"{v:.1f}"
    if kind == "pct":
        return f"{v * 100:.1f}%"
    if kind == "pct2":
        return f"{v * 100:.2f}%"
    return str(v)


def facts_text(row: dict, medians: dict) -> str:
    lines = [f"Suburb: {row['nom']} (SA {row.get('postcodes') or ''}, ABS suburb code {row['code']})",
             "Comparisons in brackets are the median of Greater Adelaide suburbs (the metro median)."]
    for col, label, kind in FACTS:
        v = row.get(col)
        line = f"- {label}: {_fmt(v, kind)}"
        if kind != "text" and col in medians and v is not None:
            line += f" (metro median: {_fmt(medians[col], kind)})"
        lines.append(line)
    return "\n".join(lines)


def verdict_text(fit: dict) -> str:
    lines = ["SCREENER VERDICT (default settings, authoritative):"]
    for sid, name in STRATEGY_NAMES.items():
        f = fit.get(sid)
        if f:
            lines.append(f"- {name}: " + ("KEPT" if f["pass"] else "REMOVED — " + "; ".join(f["why"])))
    return "\n".join(lines)


def compute_medians(rows: list[dict]) -> dict:
    out = {}
    for col, _, kind in FACTS:
        if kind != "text":
            vals = [r[col] for r in rows if isinstance(r.get(col), (int, float))]
            if vals:
                out[col] = statistics.median(vals)
    return out


def _key(text: str) -> str:
    return hashlib.sha256(f"{MODEL_ID}|{PROMPT_VERSION}|{SYSTEM}|{text}".encode()).hexdigest()[:20]


def _converse(client, messages: list) -> tuple[str, dict]:
    for attempt in range(6):
        try:
            r = client.converse(
                modelId=MODEL_ID, system=[{"text": SYSTEM}], messages=messages,
                inferenceConfig={"maxTokens": 600},
                additionalModelRequestFields={"thinking": {"type": "disabled"}},
            )
            parts = [b["text"] for b in r["output"]["message"]["content"] if "text" in b]
            if not parts:
                raise RuntimeError("no text in response")
            return "\n".join(parts).strip(), r["usage"]
        except Exception as e:  # throttling / transient
            if attempt == 5:
                raise
            time.sleep(2 * (attempt + 1) + (2 if "Throttl" in str(e) else 0))
    raise RuntimeError("unreachable")


NO_SALES = re.compile(r"no house sales|0 house sales|zero house sales|sales are 0|no sales|zero sales", re.I)


def _call(client, text: str, uncovered: bool = False) -> tuple[str, dict]:
    """Generate, then ask once for a fix if the model ran long or claimed no sales where prices are just not published."""
    messages = [{"role": "user", "content": [{"text": text}]}]
    summary, usage = _converse(client, messages)
    fixes = []
    if len(summary.split()) > MAX_WORDS:
        fixes.append("Too long: rewrite it in 130 words at most, 5 sentences, keeping the verdict for each strategy and the deciding criterion of each removal.")
    if uncovered and NO_SALES.search(summary):
        fixes.append("Wrong: houses do sell here, but the Valuer-General publishes no prices for this council. Never say there were no or zero sales; say house prices are not published for this council.")
    if fixes:
        messages += [{"role": "assistant", "content": [{"text": summary}]},
                     {"role": "user", "content": [{"text": " ".join(fixes)}]}]
        summary, u2 = _converse(client, messages)
        usage = {k: usage.get(k, 0) + u2.get(k, 0) for k in ("inputTokens", "outputTokens")}
    return summary, usage


def write_summaries(data_dir: Path, cache: dict, codes: set[str]) -> int:
    head = {"model": MODEL_ID, "prompt_version": PROMPT_VERSION, "generated": date.today().isoformat()}
    summaries = {c: v["text"] for c, v in sorted(cache.items()) if c in codes}
    blob = json.dumps({**head, "summaries": summaries}, ensure_ascii=False, separators=(",", ":"))
    for d in (data_dir, data_dir.parents[1] / "dist" / "data"):
        if d.is_dir():
            tmp = d / "summaries.json.tmp"
            tmp.write_text(blob)
            tmp.replace(d / "summaries.json")  # atomic: the browser never reads a half-written file
    return len(summaries)


def summarize(data_dir: Path, cache_path: Path, limit: int | None = None, workers: int = 6) -> None:
    import boto3

    d = json.loads((data_dir / "communes.json").read_text())
    rows = [dict(zip(d["cols"], vals)) for vals in zip(*d["cols"].values())]
    medians = compute_medians(rows)
    fit_path = cache_path.parent / "strategy-fit.json"
    if not fit_path.exists():
        raise SystemExit(f"{fit_path} missing: run `npx vite-node scripts/strategy-fit.ts` in web/ first")
    fit = json.loads(fit_path.read_text())["fit"]
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    todo = []
    for r in rows[: limit or len(rows)]:
        text = facts_text(r, medians) + "\n" + verdict_text(fit.get(r["code"], {}))
        k = _key(text)
        if cache.get(r["code"], {}).get("key") != k:
            todo.append((r["code"], text, k, r.get("n_sales_house") is None))
    print(f"{len(rows)} suburbs, {len(todo)} to (re)generate with {MODEL_ID}", flush=True)

    client = boto3.client("bedrock-runtime", region_name=REGION)
    tokens_in = tokens_out = done = failed = 0
    codes = {r["code"] for r in rows}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_call, client, text, unc): (code, k) for code, text, k, unc in todo}
        for fut in as_completed(futs):
            code, k = futs[fut]
            try:
                summary, usage = fut.result()
            except Exception as e:
                failed += 1
                print(f"  ! {code}: {str(e)[:200]}", flush=True)
                continue
            cache[code] = {"key": k, "text": summary}
            tokens_in += usage.get("inputTokens", 0)
            tokens_out += usage.get("outputTokens", 0)
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(todo)} done, {failed} failed", flush=True)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=0))
    n = write_summaries(data_dir, cache, codes)
    print(f"FINISHED: {done} generated, {failed} failed (re-run to retry), {n} published; "
          f"{tokens_in} input + {tokens_out} output tokens", flush=True)
