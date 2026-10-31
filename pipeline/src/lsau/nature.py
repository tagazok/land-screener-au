"""Relief and tree cover per suburb.

- Relief: Copernicus DEM GLO-90 (WGS84 GeoTIFF tiles in raw/dem/). It is a surface model, so
  buildings and trees can add a few metres. Per suburb: mean, min, max elevation, relief =
  95th - 5th percentile, and the share of area below 5 m (low-lying coastal land).
- Trees: ESA WorldCover 2021 (10 m, class 10 = tree cover) read remotely at ~40 m through the
  cloud-optimised GeoTIFF overviews (no full download). Share inside the suburb and within ~5 km.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import polars as pl

WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{}_Map.tif"
WC_TILES = ["S36E138"]  # covers 36°S-33°S, 138°E-141°E: all of Greater Adelaide
WC_DECIMATE = 4         # 10 m -> ~40 m (suburbs are small)
AROUND_KM = 5
LOW_M = 5


def _shapes(feats):
    from shapely.geometry import shape

    return [f["properties"]["code"] for f in feats], [shape(f["geometry"]) for f in feats]


def relief(tifs: list[Path], feats: list[dict]) -> pl.DataFrame:
    import rasterio
    import rasterio.features

    codes, shp = _shapes(feats)
    bounds = np.array([g.bounds for g in shp])
    ids, alts = [], []
    for tif in tifs:
        with rasterio.open(tif) as src:
            b = src.bounds
            hit = np.where((bounds[:, 0] < b.right) & (bounds[:, 2] > b.left) & (bounds[:, 1] < b.top) & (bounds[:, 3] > b.bottom))[0]
            if not len(hit):
                continue
            z = src.read(1).astype(np.float32)
            nd = src.nodata
            grid = rasterio.features.rasterize(((shp[i], int(i) + 1) for i in hit), out_shape=z.shape,
                                               transform=src.transform, fill=0, dtype="int32", all_touched=False)
        ok = (grid > 0) & np.isfinite(z) & ((z != nd) if nd is not None else True)
        ids.append(grid[ok] - 1)
        alts.append(z[ok])
    d = pl.DataFrame({"i": np.concatenate(ids), "alt": np.concatenate(alts)})
    out = d.group_by("i").agg(
        pl.col("alt").mean().alias("alt_mean"), pl.col("alt").min().alias("alt_min"), pl.col("alt").max().alias("alt_max"),
        (pl.col("alt").quantile(0.95) - pl.col("alt").quantile(0.05)).alias("relief_m"),
        (pl.col("alt") < LOW_M).mean().alias("low_lying_share"),
    )
    return out.with_columns(pl.col("i").map_elements(lambda i: codes[i], return_dtype=pl.Utf8).alias("code")).drop("i")


def forest(feats: list[dict]) -> pl.DataFrame:
    import rasterio
    import rasterio.features
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds
    from scipy.ndimage import uniform_filter

    codes, shp = _shapes(feats)
    n = len(codes)
    land, trees, around = np.zeros(n), np.zeros(n), np.zeros(n)
    minx, miny = min(g.bounds[0] for g in shp), min(g.bounds[1] for g in shp)
    maxx, maxy = max(g.bounds[2] for g in shp), max(g.bounds[3] for g in shp)
    pad = 0.07  # ~6 km, so the "around" window is full at the edges
    for tile in WC_TILES:
        with rasterio.open("/vsicurl/" + WORLDCOVER.format(tile)) as src:
            win = from_bounds(minx - pad, miny - pad, maxx + pad, maxy + pad, src.transform).round_offsets().round_lengths()
            h, w = int(win.height) // WC_DECIMATE, int(win.width) // WC_DECIMATE
            v = src.read(1, window=win, out_shape=(h, w), resampling=Resampling.nearest)
            tr = src.window_transform(win) * rasterio.Affine.scale(win.width / w, win.height / h)
        grid = rasterio.features.rasterize(((g, i + 1) for i, g in enumerate(shp)), out_shape=v.shape, transform=tr,
                                           fill=0, dtype="int32")
        valid = (v != 0) & (v != 80)  # no data, permanent water
        is_tree = (v == 10).astype(np.float32)
        px_km = abs(tr.a) * 111.32 * np.cos(np.radians((miny + maxy) / 2))
        size = max(3, int(round(2 * AROUND_KM / px_km)))
        num = uniform_filter(is_tree * valid, size=size, mode="constant")
        den = uniform_filter(valid.astype(np.float32), size=size, mode="constant")
        ring = np.divide(num, den, out=np.zeros_like(num), where=den > 0)
        sel = (grid > 0) & valid
        idx = grid[sel] - 1
        land += np.bincount(idx, minlength=n)
        trees += np.bincount(idx, weights=is_tree[sel], minlength=n)
        around += np.bincount(idx, weights=ring[sel], minlength=n)
    keep = land > 0
    return pl.DataFrame({"code": [c for c, k in zip(codes, keep) if k],
                         "forest_share": trees[keep] / land[keep], "forest_around_share": around[keep] / land[keep]})
