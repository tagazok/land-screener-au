"""Build the web artifacts for Greater Adelaide, one record per suburb (ABS SAL 2021).

Outputs (in web/public/data/):
  communes.json     columnar metrics per suburb (the web app's historical file name is kept)
  communes.pmtiles  suburb polygons (vector tiles, layer "communes")
  councils.geojson  council (LGA 2025) outlines inside Greater Adelaide
  metadata.json     sources, vintages, column dictionary, coverage
"""

from __future__ import annotations

import csv
import json
import re
import zipfile
from datetime import date
from pathlib import Path

import numpy as np
import polars as pl
from shapely.geometry import mapping, shape
from shapely.prepared import prep
from shapely.strtree import STRtree

from . import nature

GPO = (138.6007, -34.9285)  # Adelaide GPO, King William St
MIN_POP_RATES = 200         # crime rates are not computed below this population
# Price windows (quarters, inclusive): last 12 months and the same 12 months five years earlier.
NOW = [(2025, 4), (2026, 1), (2026, 2), (2026, 3)]
THEN = [(2020, 4), (2021, 1), (2021, 2), (2021, 3)]
HIST_YEARS = list(range(2015, 2026))
RENT_NOW = ["2025-09", "2025-12", "2026-03", "2026-06"]
RENT_THEN = ["2020-09", "2020-12", "2021-03", "2021-06"]


def norm(name: str) -> str:
    """Suburb key shared by ABS, SA Valuer-General, rental bonds and SAPOL: upper case, no state suffix."""
    s = re.sub(r"\s*\((SA|S\.A\.)\)\s*$", "", str(name).strip(), flags=re.I).upper()
    s = s.replace("’", "'").replace("MT ", "MOUNT ")
    return re.sub(r"\s+", " ", s)


# ---------------------------------------------------------------- spine
def spine(raw: Path) -> tuple[pl.DataFrame, list[dict], list[dict]]:
    """Suburbs whose representative point lies in Greater Adelaide, with their council and SA2."""
    gcc = shape(json.loads((raw / "abs/gccsa-adelaide.geojson").read_text())["features"][0]["geometry"]).buffer(0)
    gp = prep(gcc)
    lgas = [f for f in json.loads((raw / "abs/lga-sa.geojson").read_text())["features"] if f["geometry"]]
    lga_g = [shape(f["geometry"]).buffer(0) for f in lgas]
    lga_t = STRtree(lga_g)
    sa2 = json.loads((raw / "abs/sa2-adelaide.geojson").read_text())["features"]
    sa2_g = [shape(f["geometry"]).buffer(0) for f in sa2]
    sa2_t = STRtree(sa2_g)

    def where(pt, tree, geoms, feats, key):
        for i in tree.query(pt):
            if geoms[i].contains(pt):
                return feats[i]["properties"][key], i
        return None, None

    rows, feats, used_lga = [], [], {}
    for f in json.loads((raw / "abs/sal-sa.geojson").read_text())["features"]:
        p = f["properties"]
        if not f["geometry"]:  # "No usual address", "Migratory - Offshore - Shipping"
            continue
        g = shape(f["geometry"])
        g = g if g.is_valid else g.buffer(0)
        pt = g.representative_point()
        if not gp.contains(pt):
            continue
        lga, li = where(pt, lga_t, lga_g, lgas, "LGA_CODE_2025")
        sa2c, _ = where(pt, sa2_t, sa2_g, sa2, "sa2_code_2021")
        name = p["sal_name_2021"]
        if li is not None:
            used_lga[lga] = lgas[li]["properties"]["LGA_NAME_2025"]
        rows.append({"code": p["sal_code_2021"], "nom": re.sub(r"\s*\(SA\)$", "", name), "key": norm(name),
                     "dep": lga, "council": used_lga.get(lga), "sa2": sa2c, "area_km2": p["area_albers_sqkm"],
                     "lon": round(pt.x, 5), "lat": round(pt.y, 5)})
        feats.append({"type": "Feature", "properties": {"code": p["sal_code_2021"], "nom": rows[-1]["nom"], "dep": lga},
                      "geometry": mapping(g)})
    councils = []
    for f, g in zip(lgas, lga_g):
        c = f["properties"]["LGA_CODE_2025"]
        if c in used_lga:
            clip = g.intersection(gcc.buffer(0.002)).simplify(0.001, preserve_topology=True)
            councils.append({"type": "Feature", "properties": {"code": c, "nom": used_lga[c]}, "geometry": _round(mapping(clip))})
    return pl.DataFrame(rows), feats, councils


def _round(g):
    def r(c):
        return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], float) else [r(x) for x in c]
    return {"type": g["type"], "coordinates": r(g["coordinates"])}


# ---------------------------------------------------------------- house prices (SA Valuer-General)
def _sheet(path: Path) -> list[list]:
    if path.suffix == ".csv":
        return list(csv.reader(path.open(encoding="latin1")))
    from python_calamine import CalamineWorkbook

    w = CalamineWorkbook.from_path(str(path))
    return w.get_sheet_by_name(w.sheet_names[0]).to_python()


def _num(v) -> float | None:
    try:
        x = float(str(v).replace(",", "").replace("$", "").strip())
        return x if x > 0 else None
    except ValueError:
        return None


def house_quarters(folder: Path) -> pl.DataFrame:
    """One row per suburb and quarter: number of house sales and median price (current-year columns)."""
    out = []
    for f in sorted(folder.iterdir()):
        m = re.match(r"q(\d)-(\d{4})", f.name)
        if not m:
            continue
        q, y = int(m[1]), int(m[2])
        rows = _sheet(f)
        for r in rows[1:]:
            if len(r) < 6 or not str(r[1]).strip():
                continue
            n, med = _num(r[4]), _num(r[5])
            if med:
                out.append({"key": norm(r[1]), "year": y, "q": q, "n": n or 0.0, "median": med})
    return pl.DataFrame(out)


def house_metrics(hq: pl.DataFrame) -> pl.DataFrame:
    """Medians over a 4-quarter window = sales-weighted mean of the quarterly medians (an approximation:
    the Valuer-General does not publish the underlying sales)."""
    def window(qs, prefix):
        w = hq.filter(pl.struct("year", "q").is_in([{"year": y, "q": q} for y, q in qs]))
        return w.group_by("key").agg(
            ((pl.col("median") * pl.col("n")).sum() / pl.col("n").sum()).alias(f"{prefix}price"),
            pl.col("n").sum().alias(f"{prefix}n"),
        )
    now = window(NOW, "").rename({"price": "price_median_house", "n": "n_sales_house"})
    then = window(THEN, "t_")
    yearly = hq.filter(pl.col("year").is_in(HIST_YEARS)).group_by("key", "year").agg(
        ((pl.col("median") * pl.col("n")).sum() / pl.col("n").sum()).alias("p"), pl.col("n").sum().alias("n"))
    hist = yearly.with_columns(pl.when(pl.col("n") >= 5).then(pl.col("p")).alias("p")).pivot(
        on="year", index="key", values=["p", "n"], aggregate_function="first")
    hist = hist.rename({c: (f"hist_house_{c.split('_')[-1]}" if c.startswith("p_") else f"nhist_house_{c.split('_')[-1]}")
                        for c in hist.columns if c != "key"})
    out = now.join(then, on="key", how="left").with_columns(
        pl.when((pl.col("n_sales_house") >= 10) & (pl.col("t_n") >= 10))
        .then(pl.col("price_median_house") / pl.col("t_price") - 1).alias("price_trend_5y"),
        pl.when(pl.col("n_sales_house") >= 5).then(pl.col("price_median_house")).alias("price_median_house"),
    ).drop("t_price", "t_n")
    return out.join(hist, on="key", how="left")


# ---------------------------------------------------------------- rents (SA rental bonds)
def _rent_quarter(path: Path) -> list[dict]:
    from python_calamine import CalamineWorkbook

    w = CalamineWorkbook.from_path(str(path))
    rows = w.get_sheet_by_name(w.sheet_names[0]).to_python()
    old = next((i for i, r in enumerate(rows[:20]) if len(r) > 1 and str(r[1]).strip() == "Suburb"), None)
    if old is not None:  # 2020 layout: name in column B, "Total Flats" / "Total Houses" pairs
        top = [str(v).strip() for v in rows[old]]
        col = {"Flats/Units Count": top.index("Total Flats"), "Flats/Units Median": top.index("Total Flats") + 1,
               "Houses Count": top.index("Total Houses"), "Houses Median": top.index("Total Houses") + 1}
        head, name_col = old + 1, 1
    else:
        # Header block: totals row ("Houses Count"...), bedrooms row, Count/Median row; data follows.
        top = next(i for i, r in enumerate(rows) if any(str(c).strip() == "Houses Count" for c in r))
        col = {str(v).strip(): i for i, v in enumerate(rows[top]) if str(v).strip()}
        head = top + 2
        name_col = 0
    out = []
    for r in rows[head + 1:]:
        name = str(r[name_col]).strip()
        if not name or name in ("Metro", "Country", "Grand Total", "Total") or name.lower().startswith(("metro", "country")):
            continue
        rec = {"key": norm(name)}
        for k, label in (("house", "Houses"), ("flat", "Flats/Units")):
            n, med = r[col[f"{label} Count"]], r[col[f"{label} Median"]]
            rec[f"n_{k}"] = 3.0 if str(n).strip() == "*" else (_num(n) or 0.0)  # "*" = 1 to 5 bonds
            rec[f"m_{k}"] = _num(med)
        out.append(rec)
    return out


def rent_metrics(folder: Path) -> pl.DataFrame:
    def window(qs, sfx):
        rows = [r for q in qs if (folder / f"{q}.xlsx").exists() for r in _rent_quarter(folder / f"{q}.xlsx")]
        d = pl.DataFrame(rows)
        aggs = []
        for k in ("house", "flat"):
            ok = pl.col(f"m_{k}").is_not_null()
            aggs += [((pl.col(f"m_{k}") * pl.col(f"n_{k}")).filter(ok).sum() / pl.col(f"n_{k}").filter(ok).sum()).alias(f"rent_week_{k}{sfx}"),
                     pl.col(f"n_{k}").filter(ok).sum().alias(f"n_bonds_{k}{sfx}")]
        return d.group_by("key").agg(aggs)
    now, then = window(RENT_NOW, ""), window(RENT_THEN, "_then")
    out = now.join(then, on="key", how="left").with_columns(
        pl.when(pl.col("n_bonds_house") >= 10).then(pl.col("rent_week_house")).alias("rent_week_house"),
        pl.when(pl.col("n_bonds_flat") >= 10).then(pl.col("rent_week_flat")).alias("rent_week_flat"),
    ).with_columns(
        pl.when((pl.col("n_bonds_house") >= 10) & (pl.col("n_bonds_house_then") >= 10))
        .then(pl.col("rent_week_house") / pl.col("rent_week_house_then") - 1).alias("rent_trend_5y"),
    )
    return out.select("key", "rent_week_house", "n_bonds_house", "rent_week_flat", "n_bonds_flat", "rent_trend_5y")


# ---------------------------------------------------------------- census 2021, SEIFA, ERP
def _sdmx(path: Path, dims: list[str]) -> pl.DataFrame:
    d = pl.read_csv(path, infer_schema_length=0)
    return d.select(*dims, pl.col("OBS_VALUE").cast(pl.Float64, strict=False).alias("v"))


def census(dir_: Path) -> pl.DataFrame:
    g01 = _sdmx(dir_ / "G01.csv", ["REGION"]).rename({"v": "pop"})
    g02 = _sdmx(dir_ / "G02.csv", ["MEDAVG", "REGION"]).pivot(on="MEDAVG", index="REGION", values="v")
    g02 = g02.select("REGION", pl.col("1").alias("median_age"), pl.col("4").alias("median_hh_income_week"),
                     pl.col("6").alias("census_rent_week"), pl.col("8").alias("household_size"))
    g34 = _sdmx(dir_ / "G34.csv", ["VEHD", "SUM", "REGION"]).filter(pl.col("SUM") == "D").pivot(
        on="VEHD", index="REGION", values="v")
    g34 = g34.with_columns((pl.col("1") + 2 * pl.col("2") + 3 * pl.col("3") + 4 * pl.col("4")).alias("_cars"),
                           (pl.col("_T") - pl.col("_N")).alias("_hh")).select(
        "REGION", (pl.col("_cars") / pl.col("_hh")).alias("cars_per_household"),
        (pl.col("0") / pl.col("_hh")).alias("no_car_share"))
    g36 = _sdmx(dir_ / "G36.csv", ["DWTSTRD", "SUM", "REGION"]).filter(pl.col("SUM") == "D").pivot(
        on="DWTSTRD", index="REGION", values="v")
    g36 = g36.select("REGION", pl.col("_T").alias("dwellings"), pl.col("OCC").alias("households"),
                     (pl.col("N_OCC") / pl.col("_T")).alias("unoccupied_share"),
                     (pl.col("11") / pl.col("OCC")).alias("house_share"),
                     (pl.col("3") / pl.col("OCC")).alias("flat_share"))
    g37 = _sdmx(dir_ / "G37.csv", ["TENLLD", "STRD", "REGION"]).filter(pl.col("STRD") == "_T").pivot(
        on="TENLLD", index="REGION", values="v")
    g37 = g37.select("REGION", (pl.col("R_T") / pl.col("_T")).alias("tenant_share"),
                     ((pl.col("4") + pl.col("5")) / pl.col("_T")).alias("social_share"),
                     ((pl.col("1") + pl.col("2")) / pl.col("_T")).alias("owner_share"))
    g43 = _sdmx(dir_ / "G43.csv", ["LFEMP", "REGION"]).pivot(on="LFEMP", index="REGION", values="v")
    g43 = g43.select("REGION", (pl.col("LFS_P1") / 100).alias("unemployment_rate"),
                     ((pl.col("QL_1") + pl.col("QL_2") + pl.col("QL_3")) / pl.col("GE15")).alias("degree_share"))
    out = g01
    for t in (g02, g34, g36, g37, g43):
        out = out.join(t, on="REGION", how="left")
    return out.rename({"REGION": "code"})


def seifa(path: Path) -> pl.DataFrame:
    d = pl.read_csv(path, infer_schema_length=0).filter(pl.col("SEIFAINDEXTYPE") == "IRSAD")
    d = d.with_columns(pl.col("OBS_VALUE").cast(pl.Float64, strict=False)).pivot(
        on="SEIFA_MEASURE", index="SAL", values="OBS_VALUE", aggregate_function="first")
    return d.select(pl.col("SAL").alias("code"), pl.col("SCORE").alias("seifa_irsad"),
                    pl.col("RWSD").cast(pl.Int8, strict=False).alias("seifa_decile_sa"))


def erp_growth(path: Path) -> pl.DataFrame:
    d = pl.read_csv(path, infer_schema_length=0).select(
        pl.col("ASGS_2021").alias("sa2"), pl.col("TIME_PERIOD").cast(pl.Int32),
        pl.col("OBS_VALUE").cast(pl.Float64, strict=False).alias("v"))
    last = int(d["TIME_PERIOD"].max())
    a = d.filter(pl.col("TIME_PERIOD") == 2016).select("sa2", pl.col("v").alias("a"))
    b = d.filter(pl.col("TIME_PERIOD") == last).select("sa2", pl.col("v").alias("b"))
    yrs = last - 2016
    return a.join(b, on="sa2").select(
        "sa2", pl.when(pl.col("a") >= 500).then((pl.col("b") / pl.col("a")) ** (1 / yrs) - 1).alias("pop_cagr"),
        pl.col("b").alias("sa2_pop")), last


# ---------------------------------------------------------------- crime (SAPOL)
CRIME = {
    "crime_burglary": lambda l2, l3: l3 == "SCT - Residence",
    "crime_violence": lambda l2, l3: l2 in ("ASSAULT", "ROBBERY, BLACKMAIL, AND EXTORTION", "HOMICIDE"),
    "crime_damage": lambda l2, l3: l2 == "PROPERTY DAMAGE",
    "crime_theft": lambda l2, l3: l3 in ("Motor vehicle theft and related offences", "Theft from a person", "Other theft"),
}


def crime(path: Path) -> pl.DataFrame:
    from collections import Counter

    acc: dict[str, dict[str, float]] = {}
    pcs: dict[str, Counter] = {}
    for r in csv.DictReader(path.open(encoding="utf-8-sig")):
        k = norm(r["Suburb - Incident"])
        n = float(r["Offence count"] or 0)
        d = acc.setdefault(k, {c: 0.0 for c in CRIME})
        if re.fullmatch(r"5\d{3}", r["Postcode - Incident"].strip()):
            pcs.setdefault(k, Counter())[r["Postcode - Incident"].strip()] += 1
        for c, test in CRIME.items():
            if test(r["Offence Level 2 Description"], r["Offence Level 3 Description"]):
                d[c] += n
    # The postcode most often recorded with the suburb name (SAPOL records both for each incident).
    return pl.DataFrame([{"key": k, "postcodes": pcs[k].most_common(1)[0][0] if k in pcs else None,
                          **{f"_{c}": v for c, v in d.items()}} for k, d in acc.items()])


# ---------------------------------------------------------------- bushfire (planning overlay)
def bushfire(path: Path, feats: list[dict]) -> pl.DataFrame:
    from shapely.ops import unary_union

    z = zipfile.ZipFile(path)
    g = json.loads(z.read("BushfireProtectionAreas_GDA2020.geojson"))
    zones = {"High": [], "Medium": [], "General": []}
    for f in g["features"]:
        k = f["properties"].get("bf_code")
        if k in zones and f["geometry"]:
            s = shape(f["geometry"])
            zones[k].append(s if s.is_valid else s.buffer(0))
    union = {k: unary_union(v) for k, v in zones.items()}
    # Map overlay: the zones clipped to the suburbs, simplified (~30 m).
    extent = unary_union([shape(f["geometry"]) for f in feats]).buffer(0.01)
    overlay = [{"type": "Feature", "properties": {"level": k},
                "geometry": _round(mapping(u.intersection(extent).simplify(0.0003, preserve_topology=True)))}
               for k, u in union.items() if not u.is_empty]
    bushfire.overlay = {"type": "FeatureCollection", "features": overlay}
    rows = []
    for f in feats:
        s = shape(f["geometry"])
        a = s.area
        r = {"code": f["properties"]["code"]}
        for k, u in union.items():
            r[f"bushfire_{k.lower()}_share"] = min(1.0, s.intersection(u).area / a) if a else None
        rows.append(r)
    return pl.DataFrame(rows).with_columns(
        (pl.col("bushfire_high_share") + pl.col("bushfire_medium_share")).alias("bushfire_med_high_share"))


# ---------------------------------------------------------------- assemble
COLUMNS = {
    "price_median_house": ("A$", "Median house sale price, last 4 quarters (Q4 2025 - Q3 2026), SA Valuer-General"),
    "n_sales_house": ("count", "House sales in the last 4 quarters"),
    "price_trend_5y": ("ratio", "Median house price change vs the same 4 quarters five years earlier"),
    "rent_week_house": ("A$/week", "Median weekly rent of new house leases, last 4 quarters (rental bonds)"),
    "n_bonds_house": ("count", "New house leases (bonds) in the last 4 quarters"),
    "rent_week_flat": ("A$/week", "Median weekly rent of new flat/unit leases, last 4 quarters"),
    "n_bonds_flat": ("count", "New flat/unit leases in the last 4 quarters"),
    "rent_trend_5y": ("ratio", "House rent change vs the same 4 quarters five years earlier"),
    "gross_yield_house": ("ratio", "rent_week_house x 52 / price_median_house"),
    "pop": ("people", "Usual residents, Census 2021"),
    "density": ("people/km2", "Residents per km2"),
    "pop_cagr": ("ratio/yr", "Population growth per year 2016 -> latest ERP, of the suburb's SA2 area"),
    "median_age": ("years", "Median age, Census 2021"),
    "median_hh_income_week": ("A$/week", "Median household income, Census 2021"),
    "census_rent_week": ("A$/week", "Median rent paid by renting households, Census 2021"),
    "household_size": ("people", "Average household size"),
    "cars_per_household": ("cars", "Motor vehicles per dwelling (4+ counted as 4)"),
    "no_car_share": ("ratio", "Dwellings with no motor vehicle"),
    "dwellings": ("count", "Private dwellings"),
    "unoccupied_share": ("ratio", "Unoccupied private dwellings on census night"),
    "house_share": ("ratio", "Separate houses / occupied dwellings"),
    "flat_share": ("ratio", "Flats or apartments / occupied dwellings"),
    "tenant_share": ("ratio", "Renting households"),
    "social_share": ("ratio", "Households renting from the state housing authority or a community provider"),
    "owner_share": ("ratio", "Owner-occupied households"),
    "unemployment_rate": ("ratio", "Unemployment rate, Census 2021"),
    "degree_share": ("ratio", "Residents 15+ with a bachelor degree or higher"),
    "seifa_irsad": ("index", "SEIFA 2021 IRSAD score (1000 = Australian average)"),
    "seifa_decile_sa": ("1-10", "IRSAD decile within South Australia"),
    "crime_burglary": ("per 1000 dwellings", "Residential break-ins (SCT - residence), 2025-26"),
    "crime_violence": ("per 1000", "Assault, robbery and homicide offences, 2025-26"),
    "crime_damage": ("per 1000", "Property damage offences, 2025-26"),
    "crime_theft": ("per 1000", "Motor vehicle theft, theft from a person, other theft, 2025-26"),
    "bushfire_high_share": ("ratio", "Share of suburb area in a High bushfire protection area"),
    "bushfire_medium_share": ("ratio", "Share in a Medium bushfire protection area"),
    "bushfire_general_share": ("ratio", "Share in a General bushfire protection area"),
    "bushfire_med_high_share": ("ratio", "Share in a High or Medium bushfire protection area"),
    "alt_mean": ("m", "Mean elevation (Copernicus DEM 90 m)"),
    "alt_min": ("m", "Lowest elevation"),
    "alt_max": ("m", "Highest elevation"),
    "relief_m": ("m", "95th minus 5th percentile of elevation"),
    "low_lying_share": ("ratio", "Share of suburb area below 5 m elevation"),
    "forest_share": ("ratio", "Tree cover (ESA WorldCover 2021)"),
    "forest_around_share": ("ratio", "Tree cover within ~5 km"),
    "cbd_km": ("km", "Straight-line distance to the Adelaide GPO"),
    "council": ("text", "Local council (LGA 2025)"),
    "postcodes": ("text", "Postcode most often recorded with the suburb name in SAPOL crime data"),
}


def build(raw: Path, out: Path) -> None:
    import time

    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    base, feats, councils = spine(raw)
    print(f"spine: {base.height} suburbs, {len(councils)} councils ({time.time() - t0:.0f}s)", flush=True)

    hq = house_quarters(raw / "sa/house")
    keyed = [house_metrics(hq), rent_metrics(raw / "sa/rent"), crime(raw / "sa/crime-2025-26.csv")]
    erp, erp_year = erp_growth(raw / "abs/erp-sa2.csv")
    coded = [census(raw / "abs/census"), seifa(raw / "abs/seifa2021-sal.csv"),
             bushfire(raw / "sa/bushfire-protection-areas.zip", feats)]
    cache = raw / "build"
    cache.mkdir(exist_ok=True)
    for name, fn in (("relief", lambda: nature.relief(sorted((raw / "dem").glob("*.tif")), feats)),
                     ("forest", lambda: nature.forest(feats))):
        p = cache / f"{name}.parquet"
        if not p.exists():
            fn().write_parquet(p)
        coded.append(pl.read_parquet(p))
        print(f"  {name} ok ({time.time() - t0:.0f}s)", flush=True)

    df = base
    report = {}
    keys = set(base["key"].to_list())
    for name, t in zip(("house", "rent", "crime"), keyed):
        k = set(t["key"].to_list())
        report[name] = {"matched": len(k & keys), "unmatched": sorted(k - keys)[:30]}
        df = df.join(t, on="key", how="left")
    for t in coded:
        df = df.join(t, on="code", how="left")
    df = df.join(erp, on="sa2", how="left")

    lon0, lat0 = np.radians(GPO[0]), np.radians(GPO[1])
    lon, lat = np.radians(df["lon"].to_numpy()), np.radians(df["lat"].to_numpy())
    cbd = 6371 * 2 * np.arcsin(np.sqrt(np.sin((lat - lat0) / 2) ** 2 + np.cos(lat) * np.cos(lat0) * np.sin((lon - lon0) / 2) ** 2))
    small = pl.col("pop") < MIN_POP_RATES
    # Suburbs listed in the latest Valuer-General file, with or without sales (a few files
    # occasionally listed outer suburbs such as Mount Barker: those do not count as covered).
    y, q = NOW[-1]
    latest = _sheet(raw / "sa/house" / f"q{q}-{y}.xlsx")
    covered = sorted({norm(r[1]) for r in latest[1:] if len(r) > 1 and str(r[1]).strip()})
    df = df.with_columns(
        pl.Series("cbd_km", np.round(cbd, 1)),
        (pl.col("rent_week_house") * 52 / pl.col("price_median_house")).alias("gross_yield_house"),
        (pl.col("pop") / pl.col("area_km2")).alias("density"),
        pl.when(small | (pl.col("households") < 50)).then(None)
        .otherwise(pl.col("_crime_burglary").fill_null(0) / pl.col("households") * 1000).alias("crime_burglary"),
        *(pl.when(small).then(None).otherwise(pl.col(f"_{c}").fill_null(0) / pl.col("pop") * 1000).alias(c)
          for c in ("crime_violence", "crime_damage", "crime_theft")),
        # Suburbs listed by the Valuer-General with no sale: 0. Not listed at all (councils outside its
        # 19 metropolitan councils, e.g. Mount Barker): unknown, not zero.
        pl.when(pl.col("key").is_in(covered)).then(pl.col("n_sales_house").fill_null(0)).alias("n_sales_house"),
        *(pl.col(c).fill_null(0) for c in ("n_bonds_house", "n_bonds_flat")),
    ).drop([c for c in df.columns if c.startswith("_crime")] + ["key", "sa2", "households", "sa2_pop"])

    floats = [c for c, t in df.schema.items() if t == pl.Float64]
    df = df.with_columns(*(pl.when(pl.col(c).is_finite()).then(pl.col(c)).otherwise(None).round(4).alias(c) for c in floats))
    df = df.sort("nom")
    cols = {c: df[c].to_list() for c in df.columns}
    (out / "communes.json").write_text(json.dumps({"n": df.height, "cols": cols}, ensure_ascii=False,
                                                  separators=(",", ":"), allow_nan=False))
    (out / "councils.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": councils},
                                                     separators=(",", ":")))
    (out / "bushfire.geojson").write_text(json.dumps(bushfire.overlay, separators=(",", ":")))
    write_tiles(raw, out, feats)

    coverage = {c: round(1 - df[c].null_count() / df.height, 3) for c in COLUMNS if c in df.columns}
    meta = {
        "built": date.today().isoformat(),
        "scope": {"label": "Greater Adelaide", "councils": len(councils), "communes": df.height},
        "price_window": "Q4 2025 - Q3 2026",
        "rent_window": "Jul 2025 - Jun 2026",
        "erp_year": erp_year,
        "sources": SOURCES,
        "columns": {k: {"unit": u, "label": l} for k, (u, l) in COLUMNS.items()},
        "coverage": coverage,
        "join_report": report,
    }
    (out / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(f"wrote {df.height} suburbs -> {out} ({time.time() - t0:.0f}s)")
    for k, v in report.items():
        print(f"  {k:6s} matched {v['matched']:4d}  unmatched {len(v['unmatched'])}: {v['unmatched'][:12]}")
    print("  coverage:", {k: v for k, v in coverage.items() if v < 0.9})


SOURCES = [
    {"key": "boundaries", "producer": "Australian Bureau of Statistics - ASGS Edition 3 (Suburbs and Localities 2021, SA2, Greater Capital City Statistical Area), LGA 2025",
     "licence": "CC BY 4.0", "vintage": "2021 / 2025", "url": "https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs-edition-3", "credit": None},
    {"key": "census", "producer": "Australian Bureau of Statistics - Census of Population and Housing 2021, General Community Profile (G01, G02, G34, G36, G37, G43)",
     "licence": "CC BY 4.0", "vintage": "2021", "url": "https://data.api.abs.gov.au/", "credit": None},
    {"key": "seifa", "producer": "Australian Bureau of Statistics - SEIFA 2021 by Suburbs and Localities", "licence": "CC BY 4.0",
     "vintage": "2021", "url": "https://www.abs.gov.au/statistics/people/people-and-communities/socio-economic-indexes-areas-seifa-australia", "credit": None},
    {"key": "erp", "producer": "Australian Bureau of Statistics - Regional population, ERP by SA2", "licence": "CC BY 4.0",
     "vintage": "2016 onwards", "url": "https://www.abs.gov.au/statistics/people/population/regional-population", "credit": None},
    {"key": "house", "producer": "Government of South Australia (Valuer-General) - Metropolitan median house sales, quarterly",
     "licence": "CC BY 4.0", "vintage": "Q1 2015 - Q3 2026", "url": "https://data.sa.gov.au/data/dataset/metro-median-house-sales", "credit": None},
    {"key": "rent", "producer": "SA Housing Trust / Consumer and Business Services - Private rental report (rental bonds lodged)",
     "licence": "CC BY 4.0", "vintage": "Jul 2020 - Jun 2021 and Jul 2025 - Jun 2026", "url": "https://data.sa.gov.au/data/dataset/private-rent-report", "credit": None},
    {"key": "crime", "producer": "South Australia Police - Crime statistics by suburb", "licence": "CC BY 4.0",
     "vintage": "2025-26", "url": "https://data.sa.gov.au/data/dataset/crime-statistics", "credit": None},
    {"key": "bushfire", "producer": "Department for Housing and Urban Development (Plan SA) - Bushfire protection areas",
     "licence": "CC BY 4.0", "vintage": "2008-2013 mapping, extract 2026-08", "url": "https://data.sa.gov.au/data/dataset/bushfire-protection-areas", "credit": None},
    {"key": "relief", "producer": "Copernicus DEM GLO-90 (ESA)", "licence": "Copernicus DEM licence (free use with attribution)",
     "vintage": "2021", "url": "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model",
     "credit": "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA"},
    {"key": "forest", "producer": "ESA WorldCover 10 m 2021 v200", "licence": "CC BY 4.0", "vintage": "2021",
     "url": "https://esa-worldcover.org/", "credit": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium"},
]


def write_tiles(raw: Path, out: Path, feats: list[dict]) -> None:
    import subprocess

    nd = raw / "build" / "suburbs.geojsonl"
    with nd.open("w") as f:
        for ft in feats:
            f.write(json.dumps(ft, separators=(",", ":")) + "\n")
    target = out / "communes.pmtiles"
    subprocess.run(["tippecanoe", "-o", str(target), "--force", "-l", "communes", "-Z6", "-z13",
                    "--detect-shared-borders", "--no-feature-limit", "--no-tile-size-limit",
                    "--simplification=4", "-q", str(nd)], check=True)
    nd.unlink()
    print(f"  tiles: {target.stat().st_size / 1e6:.1f} MB", flush=True)
