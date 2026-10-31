// What the assistant knows about the data: the indicators it may filter on, and
// everyday words mapped to them. Kept compact: Chrome's on-device model has a
// small context window, so only the indicators relevant to a question are sent.

import { COLUMNS, STRATEGIES } from '../strategies';

export interface CatalogEntry {
  id: string;
  label: string;
  /** What the model must write as a value: "%" means a percentage (5 = 5 %). */
  unit: string;
  kind: 'number' | 'bool';
  hint: string;
}

const UNIT: Record<string, string> = {
  pct: '%', aud: 'A$', aud_week: 'A$/week', count: 'number', km: 'km', density: 'people/km²', num: '', m: 'm', years: 'years',
};

/** Columns the assistant must not touch (identifiers, text, per-year raw series). */
const SKIP = /^(code|nom|dep|lon|lat|council|postcodes|hist_|nhist_)/;

function firstSentence(s = ''): string {
  const i = s.search(/[.:](\s|$)/);
  return (i > 0 ? s.slice(0, i) : s).slice(0, 140);
}

export const CATALOG: CatalogEntry[] = Object.entries(COLUMNS)
  .filter(([id, c]) => !SKIP.test(id) && c.unit !== 'text')
  .map(([id, c]) => ({
    id,
    label: c.label,
    unit: c.unit === 'bool' ? 'yes/no' : UNIT[c.unit] ?? '',
    kind: c.unit === 'bool' ? 'bool' : 'number',
    hint: firstSentence(c.def),
  }));

export const CATALOG_IDS = CATALOG.map((c) => c.id);
const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

/** Values the model writes as percentages are stored as ratios (0.05). */
export function toStored(column: string, value: number): number {
  return COLUMNS[column]?.unit === 'pct' ? value / 100 : value;
}

/**
 * Everyday concepts -> indicators, with a suggested rule. Sent to the model as guidance,
 * and used to pick which indicators to show it.
 */
export const CONCEPTS: { words: RegExp; text: string; columns: string[] }[] = [
  { words: /fire|bushfire|bush/i, columns: ['bushfire_high_share', 'bushfire_med_high_share', 'bushfire_medium_share'],
    text: 'no bushfire risk = bushfire_med_high_share max 0; little = bushfire_med_high_share max 10' },
  { words: /flood|sea|coast|surge|low.?lying|beach/i, columns: ['low_lying_share'], text: 'no coastal flooding = low_lying_share max 5' },
  { words: /tree|forest|green|bush|park|nature/i, columns: ['forest_around_share', 'forest_share'], text: 'green surroundings = forest_around_share min 30' },
  { words: /hill|flat|relief|elevation|view/i, columns: ['relief_m', 'alt_mean'], text: 'hilly = relief_m min 80; flat = relief_m max 20' },
  { words: /cbd|city|commute|close|far|distance|centre|center/i, columns: ['cbd_km'], text: 'close to the city = cbd_km max 10' },
  { words: /grow|population|people|resident|density|size/i, columns: ['pop', 'pop_cagr', 'density'], text: 'growing = pop_cagr min 1' },
  { words: /risk/i, columns: ['risk_count'], text: 'risk flags = risk_count (0 to 3)' },
  { words: /price|cheap|afford|budget|expensive|cost|rise|grow|capital|boom/i, columns: ['price', 'price_trend_5y'],
    text: 'under a budget = price max 800000 (A$); prices up strongly = price_trend_5y min 80' },
  { words: /yield|rent|invest|cash|tenant|landlord/i, columns: ['gross_yield', 'net_yield', 'cashflow_month', 'rent_week', 'rent_trend_5y', 'tenant_share'],
    text: 'yield in %; rents rising = rent_trend_5y min 50' },
  { words: /crime|safe|burglar|break|theft|violen/i, columns: ['crime_burglary', 'crime_violence', 'crime_theft'],
    text: 'safe = crime_burglary max 5 (per 1,000 dwellings), crime_violence max 8 (per 1,000 residents)' },
  { words: /income|wealth|rich|poor|advantag|socio|seifa|family|school/i, columns: ['seifa_irsad', 'seifa_decile_sa', 'median_hh_income_week', 'degree_share'],
    text: 'well-off area = seifa_decile_sa min 8; schools are not in the data: use web_search' },
  { words: /unemploy|job|work/i, columns: ['unemployment_rate'], text: 'low unemployment = unemployment_rate max 4' },
];

const ALWAYS = ['pop', 'risk_count', 'price', 'pop_cagr'];

/** Indicators relevant to a question (all of them when `all` is set, for large models). */
export function relevant(question: string, all = false): { entries: CatalogEntry[]; hints: string[] } {
  if (all) return { entries: CATALOG, hints: CONCEPTS.map((c) => c.text) };
  const hit = CONCEPTS.filter((c) => c.words.test(question));
  const ids = new Set([...ALWAYS, ...hit.flatMap((c) => c.columns)]);
  // Also any indicator whose label words appear in the question.
  const q = question.toLowerCase();
  for (const c of CATALOG) if (c.label.length > 4 && q.includes(c.label.toLowerCase())) ids.add(c.id);
  return { entries: [...ids].map((i) => BY_ID.get(i)).filter((x): x is CatalogEntry => !!x), hints: hit.map((c) => c.text) };
}

export function describe(entries: CatalogEntry[]): string {
  return entries.map((c) => `- ${c.id} (${c.label}${c.unit ? `, ${c.unit}` : ''}${c.hint ? `: ${c.hint}` : ''})`).join('\n');
}

export const STRATEGY_IDS = STRATEGIES.map((s) => s.id);
export const STRATEGY_TEXT = STRATEGIES.map((s) => `${s.id} = ${s.label}`).join('; ');
