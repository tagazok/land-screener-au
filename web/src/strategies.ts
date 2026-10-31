// Strategy presets, column dictionary and all explanatory texts (English).
// Presets are data: filters decide pass/fail, weights only order the survivors.

import type { FilterDef, Row, SignalDef } from './engine';

export type StrategyId = 'long' | 'growth' | 'live';
/** Only houses: the SA Valuer-General publishes suburb medians for houses, not units. */
export type PropertyType = 'house';

export interface ColumnInfo {
  label: string;
  unit: 'aud' | 'aud_week' | 'pct' | 'count' | 'bool' | 'text' | 'num' | 'density' | 'km' | 'm' | 'years';
  /** What the value means. */
  def?: string;
  /** How it is calculated, and from which source. */
  calc?: string;
}

/** Tooltip text for a column: meaning, then "How: ..." when there is one. */
export function columnHelp(column: string): string {
  const c = COLUMNS[column];
  if (!c) return '';
  return [c.def, c.calc ? `How: ${c.calc}` : ''].filter(Boolean).join('\n\n');
}

const CENSUS = 'ABS Census 2021 (General Community Profile, by suburb).';

export const COLUMNS: Record<string, ColumnInfo> = {
  nom: { label: 'Suburb', unit: 'text' },
  council: { label: 'Council', unit: 'text' },
  postcodes: { label: 'Postcode', unit: 'text' },
  pop: { label: 'Population', unit: 'count', def: 'Usual residents at the 2021 Census.' },
  price: {
    label: 'Median house price', unit: 'aud',
    def: 'Median sale price of houses over the last four quarters (Q4 2025 to Q3 2026). The median is the middle sale: half sold for more, half for less.',
    calc: 'SA Valuer-General, metropolitan median house sales by suburb, one file per quarter. The four quarterly medians are averaged, weighted by their number of sales (the individual sales are not published). Empty with fewer than 5 sales. Only the 19 metropolitan councils are covered: Mount Barker, Light, Adelaide Plains and Barossa suburbs have no price.',
  },
  n_sales: { label: 'House sales (12 m)', unit: 'count', def: 'House sales used for the median, last four quarters. Under 10, treat the price as a rough guide.' },
  price_trend_5y: {
    label: 'Price, 5 years', unit: 'pct',
    def: 'Change in the median house price over five years.',
    calc: 'last four quarters vs the same four quarters five years earlier (Q4 2020 to Q3 2021). Empty with fewer than 10 sales in either window.',
  },
  rent_week: {
    label: 'Weekly rent', unit: 'aud_week',
    def: 'Median weekly rent of new house leases signed over the last four quarters (July 2025 to June 2026).',
    calc: 'SA private rental report: bonds lodged with Consumer and Business Services, by suburb. Quarterly medians averaged, weighted by the number of bonds. Bands of 1 to 5 bonds ("*") count as 3. Empty with fewer than 10 bonds. These are rents of new leases, usually higher than the rents of sitting tenants.',
  },
  n_bonds_house: { label: 'House leases (12 m)', unit: 'count', def: 'New house leases (bonds lodged) in the last four quarters.' },
  rent_week_flat: { label: 'Weekly rent, units', unit: 'aud_week', def: 'Median weekly rent of new flat or unit leases, last four quarters.', calc: 'same source and method as the house rent.' },
  n_bonds_flat: { label: 'Unit leases (12 m)', unit: 'count', def: 'New flat or unit leases in the last four quarters.' },
  rent_trend_5y: {
    label: 'Rent, 5 years', unit: 'pct',
    def: 'Change in the median weekly house rent over five years.',
    calc: 'July 2025 - June 2026 vs July 2020 - June 2021. Empty with fewer than 10 bonds in either year.',
  },
  gross_yield: {
    label: 'Gross yield', unit: 'pct',
    def: 'Yearly rent as a share of the purchase price, before any cost.',
    calc: 'weekly rent × 52 ÷ median house price. Example: $600 a week and $900,000 → 31,200 ÷ 900,000 = 3.5 %. Ignores stamp duty, council rates, land tax, insurance, management fees, vacancy and repairs. Both medians are suburb-wide, so a given house can differ a lot.',
  },
  net_yield: {
    label: 'Net yield', unit: 'pct',
    def: 'Yield after vacancy, management and maintenance, and yearly holding costs, with stamp duty and purchase costs added to the price.',
    calc: '(rent × 52 − vacancy − management and maintenance − holding costs) ÷ (price + stamp duty + other purchase costs). Assumptions under "Edit".',
  },
  cashflow_month: { label: 'Cash flow / month', unit: 'aud', def: 'Net monthly rent minus the monthly loan repayment (principal and interest).', calc: 'with the deposit, rate and term of the purchase assumptions. Before income tax and negative gearing.' },
  purchase_price: { label: 'Total purchase cost', unit: 'aud', def: 'Median house price plus stamp duty and other purchase costs.' },
  pop_cagr: {
    label: 'Population growth / yr', unit: 'pct',
    def: 'Average yearly population growth since 2016 of the ABS statistical area (SA2) that contains the suburb. SA2 areas group a few suburbs: neighbours share the same value.',
    calc: 'ABS estimated resident population by SA2, (latest ÷ 2016) to the power 1/years, minus 1. Empty when the area had fewer than 500 residents in 2016.',
  },
  density: { label: 'Density', unit: 'density', def: 'Residents per km² (2021).', calc: 'Census population ÷ suburb area.' },
  median_age: { label: 'Median age', unit: 'years', calc: CENSUS },
  median_hh_income_week: { label: 'Household income / week', unit: 'aud_week', def: 'Median total household income per week, before tax.', calc: CENSUS },
  census_rent_week: { label: 'Rent paid (2021)', unit: 'aud_week', def: 'Median weekly rent paid by all renting households in 2021, including long-standing leases and public housing.', calc: CENSUS },
  household_size: { label: 'Household size', unit: 'num', def: 'Average number of people per household.', calc: CENSUS },
  cars_per_household: { label: 'Cars / dwelling', unit: 'num', def: 'Motor vehicles per occupied dwelling.', calc: `${CENSUS} 4 or more counted as 4.` },
  no_car_share: { label: 'Dwellings without a car', unit: 'pct', calc: CENSUS },
  dwellings: { label: 'Dwellings', unit: 'count', def: 'Private dwellings, occupied or not.', calc: CENSUS },
  unoccupied_share: {
    label: 'Unoccupied dwellings', unit: 'pct',
    def: 'Private dwellings empty on census night: for sale or rent, holiday homes, owners away. Low values point to a tight market.',
    calc: CENSUS,
  },
  house_share: { label: 'Separate houses', unit: 'pct', def: 'Share of occupied dwellings that are separate houses.', calc: CENSUS },
  flat_share: { label: 'Flats and apartments', unit: 'pct', def: 'Share of occupied dwellings that are flats or apartments.', calc: CENSUS },
  tenant_share: { label: 'Renters', unit: 'pct', def: 'Share of households renting. A deep rental market means more applicants and more investor buyers on resale.', calc: CENSUS },
  social_share: { label: 'Social housing', unit: 'pct', def: 'Share of households renting from the SA Housing Trust or a community housing provider.', calc: CENSUS },
  owner_share: { label: 'Owner-occupiers', unit: 'pct', def: 'Share of households owning outright or with a mortgage.', calc: CENSUS },
  unemployment_rate: { label: 'Unemployment', unit: 'pct', calc: `${CENSUS} Unemployed ÷ labour force.` },
  degree_share: { label: 'University degree', unit: 'pct', def: 'Residents aged 15+ with a bachelor degree or higher.', calc: CENSUS },
  seifa_irsad: {
    label: 'SEIFA advantage score', unit: 'num',
    def: 'ABS Index of Relative Socio-economic Advantage and Disadvantage (IRSAD) 2021. 1000 is the Australian average; higher means more advantaged (income, education, jobs, housing).',
    calc: 'ABS SEIFA 2021 by suburb.',
  },
  seifa_decile_sa: { label: 'SEIFA decile (SA)', unit: 'num', def: 'IRSAD decile within South Australia: 1 = most disadvantaged 10 % of SA suburbs, 10 = most advantaged.', calc: 'ABS SEIFA 2021.' },
  crime_burglary: {
    label: 'Break-ins', unit: 'num',
    def: 'Residential break-ins (serious criminal trespass, residence) per 1,000 dwellings, July 2025 to June 2026.',
    calc: 'SA Police crime statistics by suburb of the incident ÷ occupied dwellings 2021 × 1,000. Empty under 200 residents.',
  },
  crime_violence: {
    label: 'Violence', unit: 'num',
    def: 'Assault, robbery and homicide offences per 1,000 residents, 2025-26. Includes family violence.',
    calc: 'SA Police ÷ population 2021 × 1,000. Suburbs with a shopping centre, nightlife or the CBD count offences against visitors, who are not residents: their rate is inflated.',
  },
  crime_damage: { label: 'Property damage', unit: 'num', def: 'Property damage and arson offences per 1,000 residents, 2025-26.', calc: 'SA Police ÷ population 2021 × 1,000.' },
  crime_theft: {
    label: 'Theft', unit: 'num',
    def: 'Motor vehicle theft, theft from a person and other theft per 1,000 residents, 2025-26. Shoplifting is excluded (it follows shops, not homes).',
    calc: 'SA Police ÷ population 2021 × 1,000.',
  },
  risk_count: {
    label: 'Risk flags', unit: 'count',
    def: 'Number of risk flags, out of 3, to compare suburbs quickly. A flag means a hazard is mapped over a large part of the suburb, not that a given house is exposed.',
    calc: '+1 for each: more than 25 % of the area in a High bushfire protection area; more than 50 % in a High or Medium area; more than 25 % of the area below 5 m elevation (coastal flooding and sea-level rise).',
  },
  risk_list: { label: 'Which', unit: 'text', def: 'The flags counted in "Risk flags".' },
  bushfire_high_share: {
    label: 'High bushfire area', unit: 'pct',
    def: 'Share of the suburb in a High bushfire protection area. New homes there must meet bushfire construction standards (BAL) and keep defendable space; insurance can cost more.',
    calc: 'Plan SA bushfire protection areas (mapping from 2008-2013, still published in 2026), intersected with the suburb boundary. The Planning and Design Code hazard overlays may differ: check the address on the SA Property and Planning Atlas.',
  },
  bushfire_medium_share: { label: 'Medium bushfire area', unit: 'pct', def: 'Share of the suburb in a Medium bushfire protection area.', calc: 'Plan SA bushfire protection areas.' },
  bushfire_general_share: { label: 'General bushfire area', unit: 'pct', def: 'Share of the suburb in a General bushfire protection area (lowest mapped level).', calc: 'Plan SA bushfire protection areas.' },
  bushfire_med_high_share: { label: 'Medium or High bushfire', unit: 'pct', def: 'Share of the suburb in a High or Medium bushfire protection area.', calc: 'Plan SA bushfire protection areas.' },
  low_lying_share: {
    label: 'Land below 5 m', unit: 'pct',
    def: 'Share of the suburb below 5 m elevation: a simple sign of exposure to coastal flooding, storm surge and sea-level rise (Port Adelaide, the LeFevre Peninsula, the coast).',
    calc: 'Copernicus DEM 90 m. It is a surface model: roofs and trees add height, so low land can be under-counted in built-up areas. Not a flood map: check the council and the SA Property and Planning Atlas.',
  },
  relief_m: {
    label: 'Relief', unit: 'm',
    def: 'Height difference between the high and low parts of the suburb. Under 20 m = flat plains; 80 m or more = Adelaide Hills and foothills.',
    calc: '95th minus 5th percentile of elevation (Copernicus DEM 90 m), so one peak or gully does not distort it.',
  },
  alt_mean: { label: 'Mean elevation', unit: 'm', calc: 'Copernicus DEM 90 m, averaged over the suburb.' },
  alt_min: { label: 'Lowest point', unit: 'm', calc: 'Copernicus DEM 90 m.' },
  alt_max: { label: 'Highest point', unit: 'm', calc: 'Copernicus DEM 90 m.' },
  forest_share: { label: 'Tree cover', unit: 'pct', def: 'Share of the suburb under tree cover (parks, bushland, large street trees).', calc: 'ESA WorldCover 2021 (Sentinel satellites, 10 m), class "tree cover", read at about 40 m.' },
  forest_around_share: { label: 'Trees within 5 km', unit: 'pct', def: 'Share of tree cover within about 5 km: the bushland and parks within reach, even outside the suburb.', calc: 'ESA WorldCover 2021: for each point of the suburb, tree share in a 10 km square around it, then averaged. Water is ignored.' },
  cbd_km: { label: 'Distance to CBD', unit: 'km', def: 'Straight-line distance to the Adelaide GPO (King William Street). By road, count about 1.3 times more.' },
  area_km2: { label: 'Area', unit: 'num', def: 'Suburb area, km².' },
};

/** Adds the house aliases (price, rent_week, gross_yield, ...) and the risk flags. */
export function derive(raw: Row[], _type: PropertyType = 'house'): Row[] {
  return raw.map((r) => {
    const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
    const pct = (k: string) => Math.round((n(k) ?? 0) * 100);
    const signals: [boolean, string][] = [
      [(n('bushfire_high_share') ?? 0) > 0.25, `High bushfire area (${pct('bushfire_high_share')} % of the suburb)`],
      [(n('bushfire_med_high_share') ?? 0) > 0.5, `Medium or High bushfire area (${pct('bushfire_med_high_share')} %)`],
      [(n('low_lying_share') ?? 0) > 0.25, `low-lying land (${pct('low_lying_share')} % below 5 m)`],
    ];
    const hit = signals.filter(([on]) => on).map(([, l]) => l);
    return {
      ...r,
      price: r.price_median_house ?? null,
      n_sales: r.n_sales_house ?? 0,
      rent_week: r.rent_week_house ?? null,
      gross_yield: r.gross_yield_house ?? null,
      risk_count: hit.length,
      risk_list: hit.length ? hit.join('; ') : 'none',
    };
  });
}

export interface Strategy {
  id: StrategyId;
  label: string;
  blurb: string;
  type: PropertyType;
  filters: FilterDef[];
  signals: SignalDef[];
  /** Columns shown in the table, after the suburb name. */
  table: string[];
}

const f = (id: string, column: string, op: FilterDef['op'], value?: number, enabled = true, requireData = false): FilterDef => ({
  id, column, op, value, enabled, requireData,
});
const s = (id: string, column: string, dir: 1 | -1, weight: number): SignalDef => ({ id, column, dir, weight });

/** Extra filters available in every strategy, off by default. */
const COMMON_FILTERS = () => [
  f('pricemax', 'price', 'max', 900000, false),
  f('cbd', 'cbd_km', 'max', 20, false),
  f('bushfire', 'bushfire_med_high_share', 'max', 0.1, false),
  f('lowlying', 'low_lying_share', 'max', 0.05, false),
  f('forestaround', 'forest_around_share', 'min', 0.3, false),
  f('relief', 'relief_m', 'min', 50, false),
];

export const STRATEGIES: Strategy[] = [
  {
    id: 'long',
    label: 'Long-term rental',
    blurb: 'Buy a house to rent it out on a standard lease. Favours yield, rents that keep rising, a growing population and a tight rental market.',
    type: 'house',
    filters: [
      f('yield', 'gross_yield', 'min', 0.035, true, true),
      f('sales', 'n_sales', 'min', 10),
      f('risks', 'risk_count', 'max', 1),
      f('growth', 'pop_cagr', 'min', 0, false),
      f('netyield', 'net_yield', 'min', 0.02, false, true),
      f('cashflow', 'cashflow_month', 'min', -1500, false, true),
      f('unemp', 'unemployment_rate', 'max', 0.08, false),
      f('burglary', 'crime_burglary', 'max', 10, false),
    ],
    signals: [
      s('net', 'net_yield', 1, 3),
      s('yield', 'gross_yield', 1, 1),
      s('renttrend', 'rent_trend_5y', 1, 2),
      s('growth', 'pop_cagr', 1, 2),
      s('vacancy', 'unoccupied_share', -1, 1),
      s('tenants', 'tenant_share', 1, 1),
      s('unemp', 'unemployment_rate', -1, 1),
      s('burglary', 'crime_burglary', -1, 1),
      s('risk', 'risk_count', -1, 1),
      s('price', 'price', -1, 0),
    ],
    table: ['price', 'rent_week', 'gross_yield', 'net_yield', 'cashflow_month', 'rent_trend_5y', 'pop_cagr', 'tenant_share', 'unemployment_rate', 'crime_burglary', 'risk_count', 'n_sales'],
  },
  {
    id: 'growth',
    label: 'Capital growth',
    blurb: 'Buy for the price gain over 10 years or more. Favours suburbs where prices and rents have risen, the population grows and the CBD is close, while staying affordable.',
    type: 'house',
    filters: [
      f('sales', 'n_sales', 'min', 10),
      f('risks', 'risk_count', 'max', 1),
      f('trend', 'price_trend_5y', 'min', 0, false),
      f('growth', 'pop_cagr', 'min', 0, false),
    ],
    signals: [
      s('trend', 'price_trend_5y', 1, 2),
      s('renttrend', 'rent_trend_5y', 1, 2),
      s('growth', 'pop_cagr', 1, 2),
      s('cbd', 'cbd_km', -1, 2),
      s('price', 'price', -1, 1),
      s('seifa', 'seifa_irsad', 1, 1),
      s('yield', 'gross_yield', 1, 1),
      s('risk', 'risk_count', -1, 1),
    ],
    table: ['price', 'price_trend_5y', 'rent_trend_5y', 'pop_cagr', 'cbd_km', 'gross_yield', 'seifa_decile_sa', 'risk_count', 'n_sales'],
  },
  {
    id: 'live',
    label: 'Live there',
    blurb: 'Buy a home to live in for 15 to 30 years. Favours safety from bushfire and coastal flooding, low crime, an advantaged area, greenery and a reasonable distance to the CBD.',
    type: 'house',
    filters: [
      f('risks', 'risk_count', 'max', 1),
      f('burglary', 'crime_burglary', 'max', 15),
      f('violence', 'crime_violence', 'max', 25, false),
      f('seifa', 'seifa_decile_sa', 'min', 5, false),
    ],
    signals: [
      s('risk', 'risk_count', -1, 2),
      s('burglary', 'crime_burglary', -1, 2),
      s('violence', 'crime_violence', -1, 2),
      s('seifa', 'seifa_irsad', 1, 2),
      s('trees', 'forest_around_share', 1, 1),
      s('cbd', 'cbd_km', -1, 1),
      s('trend', 'price_trend_5y', 1, 1),
      s('price', 'price', -1, 1),
    ],
    table: ['price', 'risk_count', 'bushfire_med_high_share', 'low_lying_share', 'crime_burglary', 'crime_violence', 'seifa_decile_sa', 'forest_around_share', 'cbd_km', 'price_trend_5y'],
  },
];

// Every strategy gets a population range at the top of its filters, and the common filters at the end.
for (const st of STRATEGIES) {
  st.filters = [f('pop', 'pop', 'min', 1000, false), f('popmax', 'pop', 'max', 10000, false), ...st.filters, ...COMMON_FILTERS()];
}

export const FILTERS: Record<string, { label: string; help: string }> = {
  pop: { label: 'Population at least', help: 'Removes suburbs with fewer residents (Census 2021).' },
  popmax: { label: 'Population at most', help: 'Removes suburbs with more residents (Census 2021).' },
  yield: { label: 'Gross yield at least', help: 'Removes suburbs where a year of rent is less than this share of the median price. Suburbs without a price or a rent are removed.' },
  sales: { label: 'House sales at least (12 m)', help: 'Removes suburbs with too few sales: with 3 or 4 sales, one unusual sale can move the median a lot. More sales also means an easier resale.' },
  risks: { label: 'Risk flags at most', help: 'Removes suburbs with more risk flags than this (bushfire areas, low-lying land).' },
  growth: { label: 'Population growth / yr at least', help: 'Removes suburbs in SA2 areas whose population grows slower than this (0 % = keeps only growing areas).' },
  netyield: { label: 'Net yield at least', help: 'Removes suburbs whose net yield, with your assumptions, is under this value.' },
  cashflow: { label: 'Monthly cash flow at least', help: 'Removes suburbs where rent minus costs and loan repayments falls below this amount per month (negative = you top up).' },
  unemp: { label: 'Unemployment at most', help: 'Removes suburbs with a higher unemployment rate (Census 2021).' },
  burglary: { label: 'Break-ins at most', help: 'Removes suburbs with more residential break-ins per 1,000 dwellings (2025-26). Suburbs under 200 residents have no rate and pass.' },
  violence: { label: 'Violence at most', help: 'Removes suburbs with more assault, robbery and homicide offences per 1,000 residents (2025-26).' },
  seifa: { label: 'SEIFA decile at least', help: 'Removes suburbs below this socio-economic decile within South Australia (1 to 10).' },
  trend: { label: 'Price change 5 y at least', help: 'Removes suburbs where the median house price rose less than this over five years.' },
  pricemax: { label: 'Median price at most', help: 'Removes suburbs whose median house price is above your budget. Suburbs without a price pass.' },
  cbd: { label: 'Distance to CBD at most', help: 'Removes suburbs further than this from the Adelaide GPO (straight line).' },
  bushfire: { label: 'Medium/High bushfire area at most', help: 'Removes suburbs with more than this share of their area in a High or Medium bushfire protection area.' },
  lowlying: { label: 'Land below 5 m at most', help: 'Removes suburbs with more than this share of their area below 5 m elevation (coastal flooding).' },
  forestaround: { label: 'Trees within 5 km at least', help: 'Removes suburbs with less tree cover within about 5 km.' },
  relief: { label: 'Relief at least', help: 'Keeps hilly suburbs: removes those whose relief is under this height.' },
};

export const SIGNALS: Record<string, { label: string; help: string }> = {
  net: { label: 'Net yield', help: 'The higher the estimated net yield, the better the score.' },
  yield: { label: 'Gross yield', help: 'The higher the gross yield, the better the score.' },
  renttrend: { label: 'Rising rents', help: 'The more rents rose over five years, the better the score.' },
  trend: { label: 'Rising prices', help: 'The more prices rose over five years, the better the score: the suburb is in demand. It also means paying more today.' },
  growth: { label: 'Population growth', help: 'The faster the population grows, the better the score.' },
  vacancy: { label: 'Few empty dwellings', help: 'The fewer dwellings were empty on census night, the better the score: tenants are easier to find.' },
  tenants: { label: 'Deep rental market', help: 'The higher the share of renters, the better the score.' },
  unemp: { label: 'Low unemployment', help: 'The lower the unemployment, the better the score.' },
  burglary: { label: 'Few break-ins', help: 'The fewer residential break-ins per dwelling, the better the score.' },
  violence: { label: 'Little violence', help: 'The fewer violent offences per resident, the better the score.' },
  risk: { label: 'Few risks', help: 'The fewer risk flags, the better the score.' },
  price: { label: 'Low price', help: 'The lower the median house price, the better the score: a smaller entry ticket.' },
  cbd: { label: 'Close to the CBD', help: 'The closer to the Adelaide GPO, the better the score.' },
  seifa: { label: 'Advantaged area', help: 'The higher the SEIFA advantage score, the better the score.' },
  trees: { label: 'Green surroundings', help: 'The more tree cover within 5 km, the better the score.' },
};

/** Sections of the side panel. Columns missing from COLUMNS are skipped. */
export const DETAIL_GROUPS: { title: string; help?: string; columns: string[] }[] = [
  { title: 'Market', columns: ['price', 'n_sales', 'price_trend_5y', 'rent_week', 'n_bonds_house', 'rent_trend_5y', 'gross_yield', 'net_yield', 'cashflow_month', 'rent_week_flat', 'n_bonds_flat'] },
  { title: 'Rental demand', columns: ['tenant_share', 'social_share', 'owner_share', 'unoccupied_share', 'census_rent_week', 'unemployment_rate'] },
  { title: 'Residents', columns: ['pop', 'pop_cagr', 'density', 'median_age', 'household_size', 'median_hh_income_week', 'degree_share', 'seifa_irsad', 'seifa_decile_sa'] },
  { title: 'Housing', columns: ['dwellings', 'house_share', 'flat_share', 'cars_per_household', 'no_car_share'] },
  { title: 'Safety', help: 'Offences recorded by SA Police in 2025-26, by suburb of the incident. Suburbs with shops, nightlife or the CBD have more offences per resident because visitors are not counted in the population.', columns: ['crime_burglary', 'crime_violence', 'crime_damage', 'crime_theft'] },
  { title: 'Bushfire, coast and risks', columns: ['risk_count', 'risk_list', 'bushfire_high_share', 'bushfire_medium_share', 'bushfire_general_share', 'low_lying_share'] },
  { title: 'Nature and relief', help: 'Trees: ESA WorldCover 2021. Elevation: Copernicus DEM 90 m. Show bushfire areas and shaded relief on the map with the buttons above it.', columns: ['forest_around_share', 'forest_share', 'relief_m', 'alt_mean', 'alt_min', 'alt_max', 'cbd_km', 'area_km2'] },
];

export const HELP = {
  finance: 'Net yield and cash flow are computed for every suburb with these assumptions, from the median house price (SA Valuer-General) and the median weekly rent of new leases (rental bonds).\n\nStamp duty uses the South Australian general rates (no first-home concession, no foreign-buyer surcharge). It is an estimate to compare suburbs, not a loan quote: income tax, negative gearing, depreciation, lenders mortgage insurance and renovation are not counted. The assumptions are saved in the share link.',
  overlays: 'Layers drawn under the suburbs (whose colours become lighter so both stay readable).\n\nBushfire: Plan SA bushfire protection areas, High in red, Medium in orange, General in light orange.\nRelief: shaded relief from Esri World Hillshade.\n\nTo filter, use "Medium/High bushfire area" and "Relief" in the filters.',
  history: 'Median house price per year (sales-weighted mean of the four quarterly medians of the SA Valuer-General) and the number of sales. Years with fewer than 5 sales have no price.',
  scope: 'With no selection: all of Greater Adelaide; suburbs are compared with each other across the metro area.\n\nWith one or more councils: the map and the table only show their suburbs, and the score, groups A to E and medians are recomputed among those suburbs only. The selection is saved in the share link.',
  filters: 'A filter removes the suburbs that fail its condition. Untick it to turn it off.\n\nThe red number shows how many suburbs the filter removes (one suburb can be removed by several filters).',
  weights: 'Weights never remove a suburb: they only change the ranking.\n\n0 = ignored, 5 = very important. Only the ratio between weights matters: all at 1 or all at 5 give the same ranking.',
  score: 'Score from 0 to 100, among the suburbs that pass the filters.\n\nHow: for each weighted criterion, the passing suburbs are ranked from worst (0) to best (100). The score is the weighted average of these ranks. When a suburb has no value for a criterion, that criterion is ignored for it.\n\nThe score is relative: it changes when you change the filters.',
  tier: 'Passing suburbs are split into 5 equal groups by score: A = best 20 %, then B, C, D and E. In grey: suburbs removed by at least one filter.',
  parts: 'Rank of the suburb on each criterion, from 0 (worst of the passing suburbs) to 100 (best). The score is the weighted average of these ranks.',
  passing: 'Number of suburbs that pass every active filter.',
  median: 'Median among the passing suburbs: half are above, half below.',
  failing: 'Also shows, in grey at the bottom of the table, the suburbs removed by the filters. Hover "removed" to see which filters they fail.',
};

export const missingDataNote = (fd: FilterDef): string =>
  fd.op === 'min' || fd.op === 'max'
    ? fd.requireData
      ? 'Suburbs without data are removed.'
      : 'Suburbs without data pass this filter.'
    : '';

export function preset(id: StrategyId): Strategy {
  const st = STRATEGIES.find((x) => x.id === id) ?? STRATEGIES[0];
  return structuredClone(st);
}
