# Land Screener AU · Greater Adelaide

Static screener of the 494 suburbs of Greater Adelaide (ABS Greater Capital City Statistical Area 4GADE), built from open data. A fork of Land Screener FR.

- `pipeline/`: Python (uv). `uv run lsau fetch` downloads the sources into `raw/` (about 60 MB), `uv run lsau build` writes `web/public/data/`.
- `web/`: Lit + Vite + MapLibre. `npm run dev` (port 5182), `npm run preview` (port 5183), `npm test`.

## Data

| Theme | Source | Vintage |
|---|---|---|
| Suburb, SA2, Greater Adelaide boundaries; councils | ABS ASGS Edition 3 (SAL 2021), LGA 2025 | 2021 / 2025 |
| House prices (median, sales, 5-year change, yearly history) | SA Valuer-General, metropolitan median house sales | Q1 2015 – Q3 2026 |
| Rents of new leases (houses, units, 5-year change) | SA private rental report (rental bonds) | Jul 2020 – Jun 2021, Jul 2025 – Jun 2026 |
| Population, income, tenure, dwellings, cars, unemployment | ABS Census 2021 (Data API) | 2021 |
| Socio-economic index | ABS SEIFA 2021 (IRSAD) | 2021 |
| Population growth | ABS ERP by SA2 | 2016 – latest |
| Crime | SA Police, by suburb | 2025-26 |
| Bushfire protection areas | Plan SA | 2008-2013 mapping |
| Relief, low-lying land | Copernicus DEM GLO-90 | 2021 |
| Tree cover | ESA WorldCover 2021 | 2021 |

Not covered: unit prices (the Valuer-General publishes houses only), house prices in Mount Barker, Light, Adelaide Plains and Barossa councils, schools, flood maps, council rates and land tax per suburb.

Strategies: long-term rental (with an SA stamp duty and cash-flow simulation), capital growth, live there.
