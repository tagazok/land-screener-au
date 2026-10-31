import type { Value } from './engine';
import { COLUMNS } from './strategies';

const aud0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('en-AU', { style: 'percent', maximumFractionDigits: 1 });
// Small rates (population growth) need more digits, or -0.04 % reads as "-0 %".
const pctSmall = new Intl.NumberFormat('en-AU', { style: 'percent', maximumFractionDigits: 2 });

export function fmt(column: string, v: Value | undefined): string {
  if (v === null || v === undefined) return '—';
  const unit = COLUMNS[column]?.unit ?? 'num';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  switch (unit) {
    case 'aud':
      return aud0.format(v);
    case 'aud_week':
      return `${aud0.format(v)}/wk`;
    case 'pct':
      return v !== 0 && Math.abs(v) < 0.01 ? pctSmall.format(v) : pct.format(v);
    case 'km':
      return `${one.format(v)} km`;
    case 'm':
      return `${int.format(v)} m`;
    case 'years':
      return `${int.format(v)} yrs`;
    case 'density':
    case 'count':
      return int.format(v);
    default:
      return one.format(v);
  }
}

/** CSV value: ',' field separator, '.' decimal, booleans as yes/no. Numbers keep full precision. */
export const CSV_SEP = ',';

export function csvValue(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
