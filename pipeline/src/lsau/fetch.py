"""Download the raw sources for Greater Adelaide into raw/ (skips files already present).

Sources (all open, CC BY 4.0 unless noted):
- ABS ASGS 2021 boundaries (suburbs SAL, SA2, Greater Adelaide GCCSA) and LGA 2025, from the ABS ArcGIS services.
- ABS Census 2021 tables by suburb, SEIFA 2021 by suburb, ERP by SA2 (ABS Data API, SDMX CSV).
- data.sa.gov.au: metro median house sales (quarterly), private rental report (quarterly),
  crime statistics, bushfire protection areas.
- Copernicus DEM GLO-90 tiles (ESA, free licence) for relief.
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = {"User-Agent": "land-screener-au/0.1 (open-data research)"}
ARCGIS = "https://geo.abs.gov.au/arcgis/rest/services"
ABS_API = "https://data.api.abs.gov.au/rest/data"
CKAN = "https://data.sa.gov.au/data/api/3/action/package_show?id="
HOUSE_DATASET = "0d447195-1158-4a3c-8cc7-0e333b87eb72"
RENT_DATASET = "8eb97a72-9919-448b-8de6-fc1530b3f7ec"
CRIME_2025 = ("https://data.sa.gov.au/data/dataset/860126f7-eeb5-4fbc-be44-069aa0467d11/resource/"
              "cfce21c4-9712-454f-b32d-0f7c989accda/download/data_sa_crime_q1_q2_q3_q4_2025-26.csv")
BUSHFIRE = "https://www.dptiapps.com.au/dataportal/BushfireProtectionAreas_geojson.zip"
DEM = ("https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_{t}_DEM/"
       "Copernicus_DSM_COG_30_{t}_DEM.tif")
DEM_TILES = [f"{lat}_00_{lon}_00" for lat in ("S35", "S36") for lon in ("E138", "E139")]

# Census 2021 tables used (General Community Profile, by suburb).
# SDMX keys: dimensions in order, empty = all; the last two are REGION_TYPE=SAL and STATE=4 (SA).
CENSUS = {
    "G01": "3.P_1..SAL.4",   # persons: total
    "G02": "..SAL.4",        # medians and averages
    "G34": "...SAL.4",       # motor vehicles per dwelling
    "G36": ".D..SAL.4",      # dwelling structure (dwellings)
    "G37": "...SAL.4",       # tenure and landlord type by structure
    "G43": ".3..SAL.4",      # labour force, persons
}
# Rental report quarters: the last 4 (current rents) and the same 4 quarters five years earlier.
RENT_QUARTERS = ["2025-09", "2025-12", "2026-03", "2026-06", "2020-09", "2020-12", "2021-03", "2021-06"]


def get(url: str, dest: Path, tries: int = 4) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            tmp = dest.with_suffix(dest.suffix + ".part")
            tmp.write_bytes(data)
            tmp.rename(dest)
            print(f"  {dest.name}: {len(data) / 1e6:.1f} MB", flush=True)
            return dest
        except Exception as e:  # transient 5xx are common on data.api.abs.gov.au
            if i == tries - 1:
                raise
            print(f"  retry {dest.name} ({e})", flush=True)
            time.sleep(5 * (i + 1))
    return dest


def get_sdmx(flow: str, key: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    req = urllib.request.Request(f"{ABS_API}/ABS,{flow}/{key}", headers={**UA, "Accept": "application/vnd.sdmx.data+csv"})
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = r.read()
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            print(f"  {dest.name}: {len(data) / 1e6:.1f} MB", flush=True)
            return dest
        except Exception as e:
            if i == 3:
                raise
            print(f"  retry {flow} ({e})", flush=True)
            time.sleep(10 * (i + 1))
    return dest


def arcgis(service: str, where: str, fields: str, dest: Path, offset: float = 0.00005, page: int = 200) -> Path:
    """All features of an ABS ArcGIS layer as GeoJSON (WGS84, generalised to ~5 m)."""
    if dest.exists():
        return dest
    feats, start = [], 0
    while True:
        q = urllib.parse.urlencode({"where": where, "outFields": fields, "outSR": 4326, "f": "geojson",
                                    "maxAllowableOffset": offset, "resultOffset": start, "resultRecordCount": page,
                                    "orderByFields": "objectid"})
        req = urllib.request.Request(f"{ARCGIS}/{service}/MapServer/0/query?{q}", headers=UA)
        with urllib.request.urlopen(req, timeout=180) as r:
            got = json.loads(r.read())["features"]
        feats += got
        if len(got) < page:
            break
        start += page
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    print(f"  {dest.name}: {len(feats)} features", flush=True)
    return dest


def ckan_resources(dataset: str) -> list[dict]:
    req = urllib.request.Request(CKAN + dataset, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["result"]["resources"]


def fetch_all(raw: Path) -> None:
    abs_ = raw / "abs"
    print("boundaries", flush=True)
    arcgis("ASGS2021/SAL", "state_code_2021='4'", "sal_code_2021,sal_name_2021,area_albers_sqkm", abs_ / "sal-sa.geojson")
    arcgis("ASGS2021/GCCSA", "gccsa_code_2021='4GADE'", "gccsa_code_2021", abs_ / "gccsa-adelaide.geojson")
    arcgis("ASGS2021/SA2", "gccsa_code_2021='4GADE'", "sa2_code_2021,sa2_name_2021", abs_ / "sa2-adelaide.geojson")
    arcgis("ASGS2025/LGA", "state_code_2021='4'", "*", abs_ / "lga-sa.geojson")

    print("census, SEIFA, ERP", flush=True)
    for t, key in CENSUS.items():
        get_sdmx(f"C21_{t}_SAL", key, abs_ / "census" / f"{t}.csv")
    get_sdmx("ABS_SEIFA2021_SAL", ".IRSAD+IRSD.SCORE+RWAD+RWSD", abs_ / "seifa2021-sal.csv")
    get_sdmx("ABS_ANNUAL_ERP_ASGS2021", "ERP.SA2..A?startPeriod=2016", abs_ / "erp-sa2.csv")

    print("data.sa.gov.au", flush=True)
    sa = raw / "sa"
    for r in ckan_resources(HOUSE_DATASET):
        name = r["name"].split("Sales ")[-1].replace(" ", "-").lower()  # "q3-2026"
        ext = ".csv" if r["url"].endswith(".csv") else ".xlsx"
        get(r["url"], sa / "house" / f"{name}{ext}")
    rents = {r["name"].split()[-1]: r["url"] for r in ckan_resources(RENT_DATASET)}
    for q in RENT_QUARTERS:
        if q in rents:
            get(rents[q], sa / "rent" / f"{q}.xlsx")
        else:
            print(f"  ! rent report {q} not found", flush=True)
    get(CRIME_2025, sa / "crime-2025-26.csv")
    get(BUSHFIRE, sa / "bushfire-protection-areas.zip")

    print("DEM", flush=True)
    for t in DEM_TILES:
        get(DEM.format(t=t), raw / "dem" / f"{t}.tif")
