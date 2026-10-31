import { describe, expect, it } from 'vitest';
import { evaluate, passes, percentiles, type FilterDef, type Row, type SignalDef } from './engine';
import { csvValue, fmt } from './format';
import { judge } from './judge';
import { COLUMNS, FILTERS, SIGNALS, STRATEGIES, columnHelp, derive, preset } from './strategies';
import { decode, encode } from './url';

describe('good / bad verdicts', () => {
  it('higher-is-better thresholds', () => {
    expect(judge('gross_yield', 0.045)).toBe('good');
    expect(judge('gross_yield', 0.035)).toBe(null);
    expect(judge('gross_yield', 0.028)).toBe('warn');
    expect(judge('gross_yield', 0.02)).toBe('bad');
    expect(judge('pop_cagr', -0.001)).toBe('bad');
  });
  it('lower-is-better thresholds', () => {
    expect(judge('risk_count', 0)).toBe('good');
    expect(judge('risk_count', 1)).toBe('warn');
    expect(judge('risk_count', 2)).toBe('bad');
    expect(judge('crime_burglary', 2)).toBe('good');
    expect(judge('crime_burglary', 20)).toBe('bad');
  });
  it('missing values', () => {
    expect(judge('seifa_irsad', null)).toBe(null);
    expect(judge('council', 'Adelaide')).toBe(null);
  });
});

describe('formatting and help coverage', () => {
  it('formats numbers the Australian way', () => {
    expect(fmt('price', 912500)).toBe('$912,500');
    expect(fmt('rent_week', 650)).toBe('$650/wk');
    expect(fmt('gross_yield', 0.0372)).toBe('3.7%');
  });
  it('writes CSV values', () => {
    expect(csvValue(0.0592)).toBe('0.0592');
    expect(csvValue('a,b')).toBe('"a,b"');
  });
  it('every shown column, filter and weight has an explanation', () => {
    for (const st of STRATEGIES) {
      for (const c of st.table) expect(columnHelp(c), c).not.toBe('');
      for (const f of st.filters) expect(FILTERS[f.id]?.help, f.id).toBeTruthy();
      for (const s of st.signals) expect(SIGNALS[s.id]?.help, s.id).toBeTruthy();
      for (const f of st.filters) expect(COLUMNS[f.column], f.column).toBeDefined();
    }
  });
});

const row = (code: string, extra: Record<string, number | boolean | null>): Row => ({ code, nom: code, ...extra });

describe('filters', () => {
  const f: FilterDef = { id: 'y', column: 'y', op: 'min', value: 0.05, enabled: true };
  it('min / max thresholds', () => {
    expect(passes(row('a', { y: 0.06 }), f)).toBe(true);
    expect(passes(row('a', { y: 0.04 }), f)).toBe(false);
    expect(passes(row('a', { y: 0.04 }), { ...f, op: 'max' })).toBe(true);
  });
  it('missing data passes unless requireData', () => {
    expect(passes(row('a', { y: null }), f)).toBe(true);
    expect(passes(row('a', { y: null }), { ...f, requireData: true })).toBe(false);
  });
  it('boolean ops', () => {
    const b: FilterDef = { id: 'b', column: 'b', op: 'isFalse', enabled: true };
    expect(passes(row('a', { b: true }), b)).toBe(false);
    expect(passes(row('a', { b: false }), b)).toBe(true);
  });
});

describe('percentiles', () => {
  it('ranks with ties and nulls', () => {
    expect(percentiles([10, null, 30, 20])).toEqual([0, null, 1, 0.5]);
    expect(percentiles([5, 5, 10])).toEqual([0.25, 0.25, 1]);
  });
});

describe('evaluate', () => {
  const rows = [row('a', { y: 0.08, g: 0 }), row('b', { y: 0.06, g: 1 }), row('c', { y: 0.02, g: 1 })];
  const filters: FilterDef[] = [{ id: 'y', column: 'y', op: 'min', value: 0.05, enabled: true }];
  const signals: SignalDef[] = [
    { id: 'y', column: 'y', dir: 1, weight: 1 },
    { id: 'g', column: 'g', dir: 1, weight: 0 },
  ];
  it('filters exclude, weights only order', () => {
    const r = evaluate(rows, filters, signals);
    expect(r.map((x) => x.pass)).toEqual([true, true, false]);
    expect(r[0].score).toBe(100);
    expect(r[1].score).toBe(0);
    expect(r[2].score).toBeNull();
    // zero-weight signal is still computed for display but does not move the score
    expect(r[1].parts.g).toBe(1);
  });
  it('lower-is-better signals invert', () => {
    const r = evaluate(rows, [], [{ id: 'y', column: 'y', dir: -1, weight: 1 }]);
    expect(r[2].score).toBe(100);
  });
  it('disabled filters do nothing', () => {
    const r = evaluate(rows, [{ ...filters[0], enabled: false }], signals);
    expect(r.every((x) => x.pass)).toBe(true);
  });
  it('tiers are assigned to passing rows only', () => {
    const r = evaluate(rows, filters, signals);
    expect(r[0].tier).toBe('A');
    expect(r[2].tier).toBeNull();
  });
});

describe('derive', () => {
  it('maps house columns and counts risks', () => {
    const [d] = derive([row('a', { price_median_house: 800000, gross_yield_house: 0.04, bushfire_high_share: 0.6, bushfire_med_high_share: 0.9, low_lying_share: 0 })]);
    expect(d.price).toBe(800000);
    expect(d.gross_yield).toBe(0.04);
    expect(d.risk_count).toBe(2);
  });
});

describe('url', () => {
  it('round-trips changed filters and weights', () => {
    const p = preset('growth');
    p.filters[0].value = 2500;
    p.filters[1].enabled = true;
    p.signals[0].weight = 5;
    const h = encode({ strategy: 'growth', type: 'house', filters: p.filters, signals: p.signals, selected: '40001' });
    const back = decode(h);
    expect(back.strategy).toBe('growth');
    expect(back.filters[0].value).toBe(2500);
    expect(back.filters[1].enabled).toBe(true);
    expect(back.signals[0].weight).toBe(5);
    expect(back.selected).toBe('40001');
  });
  it('falls back to the preset on unknown input', () => {
    expect(decode('#garbage').strategy).toBe('long');
  });
  it('round-trips several councils and ignores invalid codes', () => {
    const p = preset('live');
    const h = encode({ strategy: 'live', type: 'house', filters: p.filters, signals: p.signals, selected: null, scopes: ['47140', '40070'] });
    expect(h).toContain('z=40070,47140');
    expect(decode(h).scopes).toEqual(['40070', '47140']);
    expect(decode('#v=1&s=live&z=40070,zz,999').scopes).toEqual(['40070']);
    expect(decode('#v=1&s=live').scopes).toEqual([]);
  });
});
