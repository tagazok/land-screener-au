// "Is this value good or bad news?" — absolute thresholds per column, so the
// colour means the same thing whatever the filters. Thresholds are written for
// someone buying in Greater Adelaide, to live or to rent (2026 levels).

import type { Value } from './engine';

export type Verdict = 'good' | 'bad' | 'warn';

interface Rule {
  /** +1: higher is better, -1: lower is better. */
  dir: 1 | -1;
  /** Good when at or beyond this value (in the good direction). */
  good?: number;
  /** Bad when beyond this value (in the bad direction). */
  bad?: number;
  /** Worth a look when beyond this value, but not yet bad. */
  warn?: number;
}

const RULES: Record<string, Rule> = {
  gross_yield: { dir: 1, good: 0.04, warn: 0.03, bad: 0.025 },
  net_yield: { dir: 1, good: 0.025, warn: 0.015, bad: 0.01 },
  cashflow_month: { dir: 1, good: 0, warn: -1000, bad: -2000 },
  price_trend_5y: { dir: 1, good: 0.6, bad: 0.2 },
  rent_trend_5y: { dir: 1, good: 0.5, bad: 0.2 },
  pop_cagr: { dir: 1, good: 0.015, bad: 0 },
  unoccupied_share: { dir: -1, good: 0.05, bad: 0.12 },
  unemployment_rate: { dir: -1, good: 0.04, warn: 0.07, bad: 0.1 },
  seifa_irsad: { dir: 1, good: 1050, warn: 950, bad: 900 },
  seifa_decile_sa: { dir: 1, good: 8, warn: 4, bad: 2 },
  risk_count: { dir: -1, good: 0, warn: 1, bad: 2 },
  bushfire_high_share: { dir: -1, good: 0, warn: 0.1, bad: 0.25 },
  bushfire_med_high_share: { dir: -1, good: 0, warn: 0.2, bad: 0.5 },
  low_lying_share: { dir: -1, good: 0, warn: 0.05, bad: 0.25 },
  crime_burglary: { dir: -1, good: 3, warn: 8, bad: 14 },
  crime_violence: { dir: -1, good: 4, warn: 12, bad: 25 },
  crime_damage: { dir: -1, good: 4, warn: 12, bad: 25 },
  crime_theft: { dir: -1, good: 5, warn: 15, bad: 30 },
  forest_around_share: { dir: 1, good: 0.35 },
  n_sales: { dir: 1, good: 30, bad: 10 },
  n_bonds_house: { dir: 1, good: 30, bad: 10 },
};

/** Booleans where `true` is bad news (none yet in this dataset). */
const BAD_IF_TRUE = new Set<string>();

/** Direction of a column (+1 higher is better, -1 lower is better), if it has a rule. */
export function direction(column: string): 1 | -1 | null {
  return RULES[column]?.dir ?? null;
}

export function judge(column: string, v: Value | undefined): Verdict | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v && BAD_IF_TRUE.has(column) ? 'bad' : null;
  if (typeof v !== 'number') return null;
  const r = RULES[column];
  if (!r) return null;
  if (r.dir === 1) {
    if (r.bad !== undefined && v < r.bad) return 'bad';
    if (r.good !== undefined && v >= r.good) return 'good';
    if (r.warn !== undefined && v < r.warn) return 'warn';
  } else {
    if (r.bad !== undefined && v >= r.bad) return 'bad';
    if (r.good !== undefined && v <= r.good) return 'good';
    if (r.warn !== undefined && v >= r.warn) return 'warn';
  }
  return null;
}

/** Human sentence for a verdict, used in the side panel's strengths/weaknesses lists. */
export const VERDICT_LABEL: Record<Verdict, string> = { good: 'Strength', bad: 'Weakness', warn: 'Watch' };
