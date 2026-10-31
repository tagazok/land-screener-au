// Strategy fit for every suburb, computed with the app's own engine so the
// AI summaries explain exactly what the screener shows.
//
//   npx vite-node scripts/strategy-fit.ts
//
// For each suburb and each strategy (default filters): pass, or the filters that
// remove it, with the suburb's value and the threshold. Pass/fail does not depend
// on the councils selected (thresholds are absolute).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { passes, type Row } from '../src/engine';
import { fmt } from '../src/format';
import { COLUMNS, FILTERS, STRATEGIES, derive } from '../src/strategies';

const root = resolve(import.meta.dirname, '..');
const data = JSON.parse(readFileSync(resolve(root, 'public/data/communes.json'), 'utf8')) as {
  n: number;
  cols: Record<string, Row[string][]>;
};
const names = Object.keys(data.cols);
const raw: Row[] = Array.from({ length: data.n }, (_, i) => {
  const r: Record<string, Row[string]> = {};
  for (const c of names) r[c] = data.cols[c][i];
  return r as Row;
});

type Fit = { pass: boolean; why: string[] };
const out: Record<string, Record<string, Fit>> = {};
const counts: Record<string, number> = {};
const rows = derive(raw);

for (const st of STRATEGIES) {
  const active = st.filters.filter((f) => f.enabled);
  let n = 0;
  for (const r of rows) {
    const why: string[] = [];
    for (const f of active) {
      if (passes(r, f)) continue;
      const label = FILTERS[f.id]?.label ?? f.id;
      const v = r[f.column];
      if (f.op === 'min' || f.op === 'max') {
        const uncovered = r.n_sales_house === null || r.n_sales_house === undefined;
        const shown = v !== null && v !== undefined ? fmt(f.column, v)
          : uncovered ? 'no data, the Valuer-General publishes no house prices for this council' : 'no data';
        why.push(`${label}: ${shown} (threshold ${f.op === 'min' ? '≥' : '≤'} ${fmt(f.column, f.value ?? null)})`);
      } else {
        why.push(`${label} (${COLUMNS[f.column]?.label ?? f.column}: yes)`);
      }
    }
    (out[r.code] ??= {})[st.id] = { pass: why.length === 0, why };
    if (!why.length) n++;
  }
  counts[st.id] = n;
}

const target = resolve(root, '../raw/ai/strategy-fit.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify({ strategies: STRATEGIES.map((s) => ({ id: s.id, label: s.label })), fit: out }));
console.log(`wrote ${Object.keys(out).length} suburbs -> ${target}`);
console.log('suburbs passing each strategy:', counts);
