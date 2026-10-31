// Shareable URL state: strategy, property type and any filter/weight that
// differs from the strategy preset. Version prefix lets old links degrade.

import type { FilterDef, SignalDef, Tier } from './engine';
import { COLUMNS, preset, type PropertyType, type StrategyId, type Strategy } from './strategies';

export interface UrlState {
  strategy: StrategyId;
  type: PropertyType;
  filters: FilterDef[];
  signals: SignalDef[];
  selected: string | null;
  /** Council (LGA 2025) codes to show; empty = all of Greater Adelaide. */
  scopes?: string[];
  /** Financing assumptions that differ from the defaults, encoded by finance.ts. */
  finance?: string;
  /** Free-form filters on any column (added by the assistant or by hand). */
  custom?: FilterDef[];
  /** Score groups to keep (A-E); empty = all. */
  tiers?: Tier[];
}

const OPS = ['min', 'max', 'isTrue', 'isFalse'] as const;

/** A free-form filter: id "x:<column>:<op>" so it never collides with a preset filter. */
export function customFilter(column: string, op: FilterDef['op'], value?: number): FilterDef {
  return { id: `x:${column}:${op}`, column, op, value, enabled: true, requireData: false };
}

export const isCustom = (f: FilterDef) => f.id.startsWith('x:');

function encodeCustom(list: FilterDef[]): string {
  return list.map((f) => `${f.column}~${f.op}${f.value !== undefined ? `~${f.value}` : ''}`).join(',');
}

function decodeCustom(s: string | null, known: (c: string) => boolean): FilterDef[] {
  if (!s) return [];
  const out: FilterDef[] = [];
  for (const part of s.split(',')) {
    const [column, op, v] = part.split('~');
    if (!column || !known(column) || !(OPS as readonly string[]).includes(op)) continue;
    const value = v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
    if ((op === 'min' || op === 'max') && value === undefined) continue;
    out.push(customFilter(column, op as FilterDef['op'], value));
  }
  return out;
}

export function encode(st: UrlState): string {
  const base = preset(st.strategy);
  const p = new URLSearchParams();
  p.set('v', '1');
  p.set('s', st.strategy);
  for (const f of st.filters) {
    const b = base.filters.find((x) => x.id === f.id);
    if (!b || b.enabled !== f.enabled || b.value !== f.value) {
      p.set(`f.${f.id}`, `${f.enabled ? 1 : 0}${f.value !== undefined ? `:${f.value}` : ''}`);
    }
  }
  for (const s of st.signals) {
    const b = base.signals.find((x) => x.id === s.id);
    if (!b || b.weight !== s.weight) p.set(`w.${s.id}`, String(s.weight));
  }
  if (st.selected) p.set('c', st.selected);
  // Commas stay readable in the hash: #…&z=40070,47140
  if (st.scopes?.length) p.set('z', [...st.scopes].sort().join(','));
  if (st.finance) p.set('fi', st.finance);
  if (st.custom?.length) p.set('x', encodeCustom(st.custom));
  if (st.tiers?.length) p.set('g', st.tiers.join(''));
  return p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%7E/g, '~');
}

export function decode(hash: string): UrlState {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const sid = (p.get('s') as StrategyId) || 'long';
  const st: Strategy = preset(sid);
  const state: UrlState = {
    strategy: st.id,
    type: st.type,
    filters: st.filters,
    signals: st.signals,
    selected: p.get('c'),
    scopes: [...new Set((p.get('z') ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d{5}$/.test(s)))].sort(),
    finance: p.get('fi') ?? undefined,
    custom: decodeCustom(p.get('x'), (c) => c in COLUMNS),
    tiers: [...new Set((p.get('g') ?? '').toUpperCase().split('').filter((t) => 'ABCDE'.includes(t)))].sort() as Tier[],
  };
  if (p.get('v') !== '1') return state;
  for (const f of state.filters) {
    const raw = p.get(`f.${f.id}`);
    if (!raw) continue;
    const [en, val] = raw.split(':');
    f.enabled = en === '1';
    if (val !== undefined && Number.isFinite(Number(val))) f.value = Number(val);
  }
  for (const s of state.signals) {
    const raw = p.get(`w.${s.id}`);
    if (raw !== null && Number.isFinite(Number(raw))) s.weight = Math.max(0, Math.min(5, Number(raw)));
  }
  return state;
}
