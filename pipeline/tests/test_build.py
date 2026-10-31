import polars as pl

from lsau.build import house_metrics, norm


def test_norm_matches_sources():
    # ABS adds "(SA)" to names shared with other states; SA sources write names in upper case.
    assert norm("Richmond (SA)") == norm("RICHMOND")
    assert norm("Mt Barker") == norm("Mount Barker")
    assert norm("  Port  Adelaide ") == "PORT ADELAIDE"


def test_house_metrics_weights_quarters_by_sales():
    rows = [{"key": "X", "year": y, "q": q, "n": 10.0, "median": 500_000.0} for y, q in [(2020, 4), (2021, 1), (2021, 2), (2021, 3)]]
    rows += [{"key": "X", "year": 2025, "q": 4, "n": 30.0, "median": 900_000.0},
             {"key": "X", "year": 2026, "q": 1, "n": 10.0, "median": 700_000.0}]
    out = house_metrics(pl.DataFrame(rows)).row(0, named=True)
    assert out["n_sales_house"] == 40
    assert out["price_median_house"] == 850_000  # (30 × 900k + 10 × 700k) / 40
    assert abs(out["price_trend_5y"] - 0.7) < 1e-9
