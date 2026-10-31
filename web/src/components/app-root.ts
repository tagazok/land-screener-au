import { LitElement, css, html, nothing, svg } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { compareScore, evaluate, num, type FilterDef, type Row, type Scored, type SignalDef, type Tier } from '../engine';
import { CSV_SEP, csvValue, fmt } from '../format';
import { VERDICT_LABEL, judge, type Verdict } from '../judge';
import { DEFAULT_FINANCE, decodeFinance, encodeFinance, simulate, withFinance, type Finance } from '../finance';
import { makeScale, type Scale } from '../scale';
import {
  COLUMNS, DETAIL_GROUPS, FILTERS, HELP, SIGNALS, STRATEGIES, columnHelp, derive, missingDataNote, preset,
  type PropertyType, type StrategyId,
} from '../strategies';
import { customFilter, decode, encode } from '../url';
import { adLinks, firstPostcode } from '../links';
import { TIER_COLORS, type Bounds, type MapView, type Paint } from './map-view';
import './map-view';
import './info-tip';
import './ai-chat';
import type { ChatHost } from './ai-chat';
import { planFilters, type Plan } from '../ai/plan';

interface Meta {
  built: string;
  price_window: string;
  rent_window: string;
  sources: { key: string; producer: string; licence: string; vintage: string; url: string; credit: string | null }[];
}

type SortKey = { column: string; dir: 1 | -1 } | null;

const tip = (label: string, text: string) => html`<info-tip .label=${label} .text=${text}></info-tip>`;
const colTip = (c: string) => (columnHelp(c) ? tip(COLUMNS[c]?.label ?? c, columnHelp(c)) : nothing);

/** A value, coloured when it is good or bad news (see judge.ts). */
const val = (c: string, v: Row[string] | undefined) => {
  const j = judge(c, v);
  return j ? html`<span class="v ${j}" title=${VERDICT_LABEL[j]}>${fmt(c, v)}</span>` : html`${fmt(c, v)}`;
};

/** Every column the table can show, in side-panel order. */
const ALL_TABLE_COLUMNS = [...new Set(DETAIL_GROUPS.flatMap((g) => g.columns))].filter((c) => c in COLUMNS);

/** Extra columns shown by default after the strategy's own columns. */
const COMMON_COLUMNS = ['council', 'pop', 'pop_cagr', 'median_hh_income_week', 'price_trend_5y', 'seifa_decile_sa', 'risk_count',
  'crime_burglary', 'cbd_km'];

function defaultColumns(id: StrategyId): string[] {
  const st = STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
  return [...new Set([...st.table, ...COMMON_COLUMNS])].filter((c) => c in COLUMNS);
}

/** "Colour by" choices: the numeric indicators, grouped like the side panel. */
const COLOR_GROUPS = DETAIL_GROUPS.map((g) => ({
  title: g.title,
  columns: g.columns.filter((c) => COLUMNS[c] && !['bool', 'text'].includes(COLUMNS[c].unit)),
})).filter((g) => g.columns.length);

const TIER_TEXT: Record<string, string> = { A: '#fff', B: '#14361f', C: '#3b4a1a', D: '#5a4210', E: '#4a1606', fail: '#fff' };

/** Table rows rendered at a time; "Show more" adds another page. */
const PAGE = 200;

/** communes.json is columnar ({n, cols: {name: values[]}}): turn it into row objects once. */
function fromColumns(d: { n: number; cols: Record<string, Row[string][]> }): Row[] {
  const names = Object.keys(d.cols);
  const rows: Row[] = new Array(d.n);
  for (let i = 0; i < d.n; i++) {
    const r: Record<string, Row[string]> = {};
    for (const c of names) r[c] = d.cols[c][i];
    rows[i] = r as Row;
  }
  return rows;
}

/** Bounding box of one GeoJSON feature. */
function featureBounds(f: GeoJSON.Feature): Bounds {
  let w = 180, s = 90, e = -180, n = -90;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[];
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  if (f.geometry && 'coordinates' in f.geometry) visit(f.geometry.coordinates);
  return [[w, s], [e, n]];
}

/** Lower-case, accent-free text for search ("Port Noarlunga" → "port noarlunga"). */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-'’]/g, ' ');

@customElement('app-root')
export class AppRoot extends LitElement {
  @state() private raw: Row[] = [];
  @state() private departements: GeoJSON.FeatureCollection | null = null;
  @state() private depNames: Record<string, string> = {};
  @state() private meta: Meta | null = null;
  /** Council codes to show; empty = all of Greater Adelaide. */
  @state() private scopes: string[] = [];
  @state() private depQuery = '';
  @state() private search = '';
  @state() private shown = PAGE;
  @state() private strategy: StrategyId = 'long';
  @state() private type: PropertyType = 'house';
  @state() private filters: FilterDef[] = [];
  /** Free-form filters on any column, kept across strategy changes. */
  @state() private custom: FilterDef[] = [];
  /** Keep only these score groups (empty = all). Applied after scoring, so groups keep their meaning. */
  @state() private tiers: Tier[] = [];
  @state() private signals: SignalDef[] = [];
  @state() private selected: string | null = null;
  @state() private sort: SortKey = null;
  @state() private showFailing = false;
  @state() private settingsOpen = false;
  /** Map expanded to fill the window below the header (left of the side panel when open). */
  @state() private mapFull = false;
  @state() private finance: Finance = { ...DEFAULT_FINANCE };
  @state() private colorBy = 'score';
  /** Background map layers (bushfire protection areas, shaded relief). */
  @state() private overlays = { bushfire: false, relief: false };
  @state() private greyFailing = true;
  @state() private columns: string[] = [];
  @state() private theme: 'auto' | 'light' | 'dark' = 'auto';
  @state() private systemDark = false;
  /** Megabytes of suburb data received so far; null once the data is loaded. */
  @state() private loadingMb: number | null = 0;
  @state() private error: string | null = null;
  @state() private copied = false;
  @query('map-view') private mapView!: MapView;

  connectedCallback() {
    super.connectedCallback();
    const saved = localStorage.getItem('lsau-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'auto') this.theme = saved;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = mq.matches;
    mq.addEventListener('change', (e) => (this.systemDark = e.matches));
    this.applyUrl(location.hash);
    window.addEventListener('hashchange', () => this.applyUrl(location.hash));
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Close the innermost layer first: drawer, then side panel, then expanded map.
      if (this.settingsOpen) this.settingsOpen = false;
      else if (this.selected) this.select(null);
      else if (this.mapFull) this.setMapFull(false);
    });
    this.load();
    // Close open dropdowns (councils, columns) on a click outside them.
    window.addEventListener('click', (e) => {
      const path = e.composedPath();
      this.renderRoot.querySelectorAll('details.deppicker[open], details.colpicker[open]').forEach((d) => {
        if (!path.includes(d)) (d as HTMLDetailsElement).open = false;
      });
    });
  }

  private setMapFull(on: boolean) {
    this.mapFull = on;
    // The page behind the expanded map must not scroll under it.
    document.documentElement.style.overflow = on ? 'hidden' : '';
  }

  private async load() {
    try {
      const [data, dep, meta] = await Promise.all([
        this.fetchWithProgress('./data/communes.json'),
        fetch('./data/councils.geojson').then((r) => r.json()),
        fetch('./data/metadata.json').then((r) => r.json()),
      ]);
      this.raw = fromColumns(data);
      this.departements = dep;
      this.depNames = Object.fromEntries(
        (dep as GeoJSON.FeatureCollection).features.map((f) => [f.properties!.code, f.properties!.nom]),
      );
      this.meta = meta;
      this.loadingMb = null;
    } catch (e) {
      this.error = `Could not load the data: ${(e as Error).message}`;
    }
  }

  /** Fetch JSON while reporting the megabytes received, so a slow connection shows progress. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchWithProgress(url: string): Promise<any> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
    if (!r.body) return r.json();
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      this.loadingMb = got / 1e6;
    }
    const all = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }
    return JSON.parse(new TextDecoder().decode(all));
  }

  private applyUrl(hash: string) {
    const s = decode(hash);
    this.strategy = s.strategy;
    this.type = s.type;
    this.filters = s.filters;
    this.signals = s.signals;
    this.selected = s.selected;
    this.scopes = s.scopes ?? [];
    this.finance = decodeFinance(s.finance ?? null);
    this.custom = s.custom ?? [];
    this.tiers = s.tiers ?? [];
    this.columns = defaultColumns(s.strategy);
  }

  private pushUrl() {
    const h = encode({
      strategy: this.strategy, type: this.type, filters: this.filters, signals: this.signals, selected: this.selected, scopes: this.scopes, finance: encodeFinance(this.finance), custom: this.custom, tiers: this.tiers,
    });
    history.replaceState(null, '', `#${h}`);
  }

  private setStrategy(id: StrategyId) {
    const p = preset(id);
    this.strategy = id;
    this.type = p.type;
    this.filters = p.filters;
    this.signals = p.signals;
    this.sort = null;
    this.columns = defaultColumns(id);
    if (this.colorBy !== 'score' && !(this.colorBy in COLUMNS)) this.colorBy = 'score';
    this.pushUrl();
  }

  private get dark(): boolean {
    return this.theme === 'dark' || (this.theme === 'auto' && this.systemDark);
  }

  private setTheme(t: 'auto' | 'light' | 'dark') {
    this.theme = t;
    localStorage.setItem('lsau-theme', t);
  }

  private headerObs?: ResizeObserver;

  firstUpdated() {
    // The header wraps onto two lines on narrow windows: expose its real height
    // so the expanded map and the side panel start right below it.
    const h = this.renderRoot.querySelector('header');
    if (h) {
      this.headerObs = new ResizeObserver(() => this.style.setProperty('--header-h', `${h.getBoundingClientRect().height}px`));
      this.headerObs.observe(h);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.headerObs?.disconnect();
    document.documentElement.style.overflow = '';
  }

  updated() {
    const d = this.dark;
    this.dataset.theme = d ? 'dark' : 'light';
    document.documentElement.style.colorScheme = d ? 'dark' : 'light';
    document.documentElement.style.background = d ? '#0f1714' : '#f2f4f1';
  }

  /** Fill colour for every suburb, given the "Colour by" choice. Suburbs outside the chosen councils are hidden. */
  private mapPaint(results: Scored[]): { paint: Map<string, Paint>; scale: Scale | null } {
    const paint = new Map<string, Paint>();
    const grey = this.dark ? '#5b6862' : TIER_COLORS.fail;
    const hideOthers = this.scopes.length > 0;
    for (const r of this.raw) paint.set(r.code, { color: grey, strong: false, hidden: hideOthers });
    if (this.colorBy === 'score') {
      for (const r of results) {
        const on = r.pass && !!r.tier;
        paint.set(r.row.code, { color: on ? TIER_COLORS[r.tier!] : grey, strong: on });
      }
      return { paint, scale: null };
    }
    const c = this.colorBy;
    const pool = results.filter((r) => !this.greyFailing || r.pass);
    const scale = makeScale(c, pool.map((r) => num(r.row[c])).filter((x): x is number => x !== null));
    for (const r of results) {
      const v = num(r.row[c]);
      const shown = (!this.greyFailing || r.pass) && v !== null && scale;
      paint.set(r.row.code, { color: shown ? scale!.color(v!) : grey, strong: !!shown });
    }
    return { paint, scale };
  }

  private updateFilter(id: string, patch: Partial<FilterDef>) {
    this.filters = this.filters.map((f) => (f.id === id ? { ...f, ...patch } : f));
    this.pushUrl();
  }

  /** Add or replace a free-form filter (one per column and operator). */
  addCustom(column: string, op: FilterDef['op'], value?: number) {
    const f = customFilter(column, op, value);
    this.custom = [...this.custom.filter((x) => x.id !== f.id), f];
    this.shown = PAGE;
    this.pushUrl();
  }

  removeCustom(id: string) {
    this.custom = this.custom.filter((x) => x.id !== id);
    this.pushUrl();
  }

  /** Width of the assistant docked on the left (0 = floating or closed); the page shifts right by it. */
  @state() private chatWidth = 0;

  private setChatWidth(w: number) {
    this.chatWidth = w;
    this.style.setProperty('--chat-w', `${w}px`);
    // The map's canvas must follow the new size.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  /** Bridge for the assistant: it only ever goes through these functions. */
  private chatHost: ChatHost = {
    applyPlan: (plan: Plan) => this.applyPlan(plan),
    facts: (context: string) => this.chatFacts(context),
    openCommune: (code: string) => {
      // A suburb outside the chosen councils has no panel: widen to all of Greater Adelaide first.
      if (!this.results.some((r) => r.row.code === code)) this.setScopes([]);
      this.select(code, true);
    },
  };

  private applyPlan(plan: Plan): { applied: string[]; dropped: string[] } {
    const applied: string[] = [];
    if (plan.strategy && plan.strategy !== this.strategy) {
      this.setStrategy(plan.strategy);
      applied.push(STRATEGIES.find((s) => s.id === plan.strategy)!.label);
    }
    const dropped: string[] = [];
    if (plan.councils) {
      const codes: string[] = [];
      for (const d of plan.councils) {
        // "City of Unley", "Unley", "Port Adelaide Enfield" or the LGA code.
        const q = fold(d.trim()).replace(/^(city|town|district council|corporation) of (the )?/, '').replace(/ (city )?council$/, '');
        const code = /^\d{5}$/.test(q) ? q
          : Object.entries(this.depNames).find(([, n]) => fold(n) === q || fold(n).startsWith(q))?.[0];
        if (code && code in this.depNames) codes.push(code); else dropped.push(d);
      }
      if (codes.length || !plan.councils.length) {
        this.setScopes(codes);
        applied.push(codes.length ? this.scopeLabel : 'All of Greater Adelaide');
      }
    }
    if (plan.reset_filters) { this.custom = []; this.tiers = []; }
    if (plan.tiers?.length) {
      this.tiers = [...new Set(plan.tiers)].sort() as Tier[];
      applied.push(`Groups ${this.tiers.join(', ')}`);
    }
    const { filters, dropped: badCols } = planFilters(plan);
    dropped.push(...badCols);
    if (filters.length) {
      const ids = new Set(filters.map((f) => f.id));
      this.custom = [...this.custom.filter((x) => !ids.has(x.id)), ...filters];
      applied.push(...filters.map((f) => this.filterChip(f)));
    }
    if (plan.color_by && plan.color_by in COLUMNS && !['bool', 'text'].includes(COLUMNS[plan.color_by].unit)) {
      this.colorBy = plan.color_by;
      applied.push(`Map: ${COLUMNS[plan.color_by].label}`);
    }
    if (plan.bushfire_layer !== null || plan.relief_layer !== null) {
      this.overlays = { bushfire: plan.bushfire_layer ?? this.overlays.bushfire, relief: plan.relief_layer ?? this.overlays.relief };
      if (plan.bushfire_layer !== null) applied.push(plan.bushfire_layer ? 'Bushfire areas shown' : 'Bushfire areas hidden');
      if (plan.relief_layer !== null) applied.push(plan.relief_layer ? 'Relief shown' : 'Relief hidden');
    }
    this.showFailing = false;
    this.sort = null;
    this.shown = PAGE;
    this.pushUrl();
    return { applied, dropped };
  }

  /**
   * Facts for the model: the best suburbs now shown, plus any suburb named in the conversation
   * (so a follow-up like "what is Stirling's risk?" gets Stirling's data), with the values the user filtered on.
   */
  private chatFacts(context = ''): { count: number; text: string; communes: { code: string; nom: string; ads: { label: string; url: string }[] }[] } {
    const passing = this.results.filter((r) => r.pass).sort(compareScore);
    const cols = [...new Set([...this.custom.map((f) => f.column), 'pop', 'price', 'rent_week', 'gross_yield', 'cbd_km', 'risk_count', 'risk_list'])]
      .filter((c) => c in COLUMNS).slice(0, 14);
    const line = (row: Row, extra: string[] = []) => {
      const dep = this.depNames[row.dep as string] ?? row.dep;
      const vals = [...new Set([...cols, ...extra])].map((c) => `${COLUMNS[c]?.label ?? c} ${fmt(c, row[c])}`).join('; ');
      return `- ${row.nom} (council ${dep}, suburb code ${row.code}, postcode ${row.postcodes ?? '?'}): ${vals}`;
    };
    // Suburbs named in the question or the previous exchange (whole-word match, names of 4+ letters).
    const ctx = ` ${fold(context)} `;
    const named = context ? this.rows.filter((r) => r.nom.length >= 4 && ctx.includes(` ${fold(r.nom)} `)).slice(0, 5) : [];
    const detail = ['risk_list', 'bushfire_high_share', 'bushfire_med_high_share', 'low_lying_share', 'price_trend_5y', 'rent_trend_5y',
      'forest_around_share', 'relief_m', 'median_hh_income_week', 'seifa_decile_sa', 'tenant_share', 'unemployment_rate',
      'crime_burglary', 'crime_violence', 'pop_cagr'];
    const parts = [`${passing.length} suburbs pass the current criteria. The best ones:`, ...passing.slice(0, 8).map((r) => line(r.row))];
    if (named.length) parts.push('', 'Suburbs named in the conversation (detail):', ...named.map((r) => line(r, detail)));
    // Names the answer may cite: the suburbs listed for the model, plus the next best ones it may mention.
    const communes = [...passing.slice(0, 40).map((r) => r.row), ...named].map((r) => ({ code: r.code, nom: r.nom, ads: adLinks(r) }));
    return { count: passing.length + named.length, text: parts.join('\n'), communes };
  }

  private updateSignal(id: string, weight: number) {
    this.signals = this.signals.map((s) => (s.id === id ? { ...s, weight } : s));
    this.pushUrl();
  }

  private select(code: string | null, fly = false) {
    this.selected = code;
    this.pushUrl();
    if (fly && code) {
      const r = this.raw.find((x) => x.code === code);
      if (r) this.mapView?.flyTo(r.lon as number, r.lat as number);
    }
  }

  // ------------------------------------------------------------ derived
  // derive/evaluate are cached and only recomputed when their inputs change.
  private _rows?: { raw: Row[]; type: PropertyType; finance: Finance; out: Row[] };
  private _res?: { rows: Row[]; scope: string; filters: FilterDef[]; custom: FilterDef[]; tiers: Tier[]; signals: SignalDef[]; out: Scored[] };

  private get rows(): Row[] {
    const c = this._rows;
    if (c && c.raw === this.raw && c.type === this.type && c.finance === this.finance) return c.out;
    const out = withFinance(derive(this.raw, this.type), this.finance);
    this._rows = { raw: this.raw, type: this.type, finance: this.finance, out };
    return out;
  }

  /** Scores are computed among the suburbs of the chosen zone (all of Greater Adelaide or some councils). */
  private get results(): Scored[] {
    const rows = this.rows;
    const c = this._res;
    const key = this.scopes.join(',');
    if (c && c.rows === rows && c.scope === key && c.filters === this.filters && c.custom === this.custom && c.tiers === this.tiers && c.signals === this.signals) return c.out;
    const set = new Set(this.scopes);
    const inScope = set.size ? rows.filter((r) => set.has(r.dep as string)) : rows;
    let out = evaluate(inScope, [...this.filters, ...this.custom], this.signals);
    if (this.tiers.length) {
      const keep = new Set(this.tiers);
      out = out.map((r) => (r.pass && !keep.has(r.tier!) ? { ...r, pass: false, failed: ['tiers'] } : r));
    }
    this._res = { rows, scope: key, filters: this.filters, custom: this.custom, tiers: this.tiers, signals: this.signals, out };
    return out;
  }

  private setScopes(codes: string[]) {
    this.scopes = [...new Set(codes)].sort();
    this.shown = PAGE;
    const sel = this.selected ? this.raw.find((r) => r.code === this.selected) : undefined;
    if (sel && this.scopes.length && !this.scopes.includes(sel.dep as string)) this.selected = null;
    this.pushUrl();
  }

  private _zoom?: { scope: string; dep: unknown; out: Bounds | null };

  /** Bounds of the chosen councils (cached: a new array each render would re-zoom the map). */
  private get zoomTo(): Bounds | null {
    const key = this.scopes.join(',');
    if (this._zoom && this._zoom.scope === key && this._zoom.dep === this.departements) return this._zoom.out;
    const feats = this.departements?.features.filter((x) => this.scopes.includes(x.properties?.code)) ?? [];
    let out: Bounds | null = null;
    for (const f of feats) {
      const b = featureBounds(f);
      out = out ? [[Math.min(out[0][0], b[0][0]), Math.min(out[0][1], b[0][1])], [Math.max(out[1][0], b[1][0]), Math.max(out[1][1], b[1][1])]] : b;
    }
    this._zoom = { scope: key, dep: this.departements, out };
    return out;
  }

  /** "Unley", "Unley, Mitcham" or "4 councils" — for labels and the CSV. */
  private get scopeLabel(): string {
    const s = this.scopes;
    if (!s.length) return 'All of Greater Adelaide';
    if (s.length <= 3) return s.map((d) => this.depNames[d] ?? d).join(', ');
    return `${s.length} councils`;
  }

  private sorted(results: Scored[]): Scored[] {
    let list = this.showFailing ? [...results] : results.filter((r) => r.pass);
    if (this.search.trim()) {
      const q = fold(this.search.trim());
      // Name or postcode ("5045" finds Glenelg).
      list = list.filter((r) => fold(r.row.nom).includes(q)
        || (/^\d{2,4}$/.test(q) && typeof r.row.postcodes === 'string' && r.row.postcodes.split(' ').some((p) => p.startsWith(q))));
    }
    const s = this.sort;
    if (!s) {
      return list.sort((a, b) => (a.pass === b.pass ? compareScore(a, b) : a.pass ? -1 : 1));
    }
    return list.sort((a, b) => {
      const va = a.row[s.column];
      const vb = b.row[s.column];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * s.dir;
      return String(va).localeCompare(String(vb), 'en') * s.dir;
    });
  }

  private toggleSort(column: string) {
    const s = this.sort;
    this.sort = !s || s.column !== column ? { column, dir: -1 } : s.dir === -1 ? { column, dir: 1 } : null;
  }

  private exportCsv(list: Scored[]) {
    const cols = ['code', 'nom', ...this.tableColumns, 'score', 'tier'];
    const head = cols.map((c) => (c === 'code' ? 'ABS suburb code' : c === 'score' ? 'Score' : c === 'tier' ? 'Group' : COLUMNS[c]?.label ?? c));
    const lines = [head.map((h) => csvValue(h)).join(CSV_SEP)];
    for (const r of list) {
      lines.push(cols.map((c) => (c === 'score' ? csvValue(r.score) : c === 'tier' ? csvValue(r.tier) : csvValue(r.row[c]))).join(CSV_SEP));
    }
    const st = STRATEGIES.find((s) => s.id === this.strategy)!;
    const zone = this.scopes.length ? this.scopeLabel : 'Greater Adelaide';
    lines.push(`# Land Screener AU · ${zone} · ${st.label} · data of ${this.meta?.built ?? ''} · sources: SA Valuer-General, SA rental bonds (CBS / SA Housing Trust), SA Police, Plan SA, ABS Census 2021, SEIFA 2021, ABS ERP (CC BY 4.0)`);
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `land-screener-${this.scopes.join('-') || 'adelaide'}-${this.strategy}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async share() {
    this.pushUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1500);
    } catch {
      /* clipboard denied: the address bar still holds the link */
    }
  }

  private get tableColumns(): string[] {
    return this.columns.length ? this.columns : defaultColumns(this.strategy);
  }

  private toggleColumn(c: string, on: boolean) {
    const cur = this.tableColumns.filter((x) => x !== c);
    // Keep the order of the side-panel sections so the table stays readable.
    this.columns = on ? ALL_TABLE_COLUMNS.filter((x) => x === c || cur.includes(x)) : cur;
  }

  /** Short human text for an active filter, e.g. "Gross yield ≥ 3.5%". */
  private filterChip(f: FilterDef): string {
    const col = COLUMNS[f.column]?.label ?? f.column;
    if (f.op === 'isFalse') return `Not: ${col.toLowerCase()}`;
    if (f.op === 'isTrue') return col;
    return `${col} ${f.op === 'min' ? '≥' : '≤'} ${fmt(f.column, f.value ?? null)}`;
  }

  // ------------------------------------------------------------ render
  render() {
    if (this.error) return html`<p class="error" role="alert">${this.error}</p>`;
    const results = this.results;
    const passing = results.filter((r) => r.pass);
    const list = this.sorted(results);
    const st = STRATEGIES.find((s) => s.id === this.strategy)!;
    const sel = this.selected ? results.find((r) => r.row.code === this.selected) : undefined;
    const active = this.filters.filter((f) => f.enabled);

    return html`
      <header>
        <div class="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 25 L12 12 L17 19 L21 14 L29 25 Z" fill="#9be3b5"/><circle cx="23" cy="8" r="3" fill="#f4d35e"/></svg>
          <span><b>Land Screener</b><small>Greater Adelaide · open data</small></span>
        </div>
        <nav class="tabs" role="tablist" aria-label="Investment strategy">
          ${STRATEGIES.map((s) => html`
            <button role="tab" aria-selected=${s.id === this.strategy} class=${s.id === this.strategy ? 'on' : ''}
              title=${s.label} @click=${() => this.setStrategy(s.id)}>${s.label.replace(/ \(.*\)$/, "")}</button>`)}
        </nav>
        <span class="grow"></span>
        <div class="themes" role="radiogroup" aria-label="Theme">
          ${([['auto', 'Auto', 'Follow the system setting'], ['light', '☀', 'Light theme'], ['dark', '☾', 'Dark theme']] as const).map(([t, l, title]) => html`
            <button role="radio" aria-checked=${this.theme === t} class=${this.theme === t ? 'on' : ''} title=${title} aria-label=${title}
              @click=${() => this.setTheme(t)}>${l}</button>`)}
        </div>
      </header>

      <div class="layout ${sel ? 'has-detail' : ''} ${this.chatWidth ? 'chat-docked' : ''}">
        <main>
          <section class="summary" aria-label="Active settings">
            <div class="summary-text">
              <p>${st.blurb}</p>
              ${this.renderAssumptions()}
              <div class="chips">
                ${this.scopes.length ? html`<span class="chip strong">${this.scopeLabel}</span>` : nothing}
                <span class="chip strong" title="The SA Valuer-General publishes suburb medians for houses only">Houses</span>
                ${active.map((f) => html`<span class="chip">${this.filterChip(f)}</span>`)}
                ${this.custom.length + this.tiers.length > 1 ? html`<button class="chip clear" @click=${() => { this.custom = []; this.tiers = []; this.pushUrl(); }}
                  title="Remove all added filters (in green)">Clear added filters ×</button>` : nothing}
                ${this.tiers.length ? html`<span class="chip custom" title="Added filter">Groups ${this.tiers.join(', ')}<button aria-label="Remove the group filter" @click=${() => { this.tiers = []; this.pushUrl(); }}>×</button></span>` : nothing}
                ${this.custom.map((f) => html`<span class="chip custom" title="Added filter">${this.filterChip(f)}<button aria-label="Remove the filter ${this.filterChip(f)}" @click=${() => this.removeCustom(f.id)}>×</button></span>`)}
              </div>
            </div>
            <button class="btn primary" @click=${() => (this.settingsOpen = true)} aria-haspopup="dialog">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h9M16 5h1M3 10h2M9 10h8M3 15h7M14 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="5" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="10" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="15" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              Filters and weights
            </button>
          </section>

          ${this.renderStats(passing, results.length)}

          ${this.renderMap(results)}

          <div class="tablebar">
            <h2>Ranking</h2>
            <label class="switchlabel"><input class="switch" type="checkbox" .checked=${this.showFailing}
              @change=${(e: Event) => (this.showFailing = (e.target as HTMLInputElement).checked)}> Show removed suburbs</label>
            ${tip('Removed suburbs', HELP.failing)}
            <input class="search" type="search" placeholder="Search a suburb or postcode…" aria-label="Search a suburb"
              .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.shown = PAGE; }}
              @change=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.shown = PAGE; }}>
            <span class="grow"></span>
            <button class="btn" @click=${() => this.share()}>${this.copied ? 'Link copied ✓' : 'Copy link'}</button>
            ${this.renderColumnPicker()}
            <button class="btn" @click=${() => this.exportCsv(list)}>Export CSV · ${list.length}</button>
          </div>
          ${this.renderTable(list)}
          ${this.renderFooter()}
        </main>
        ${sel ? this.renderDetail(sel) : nothing}
      </div>

      ${this.settingsOpen ? this.renderSettings(results, st.label) : nothing}
      ${this.raw.length ? html`<ai-chat .host=${this.chatHost} @chat-dock=${(e: CustomEvent<{ width: number }>) => this.setChatWidth(e.detail.width)}></ai-chat>` : nothing}
      ${this.loadingMb !== null ? html`
        <div class="loading" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <b>Loading suburb data…</b>
            <small>${this.loadingMb > 0.01 ? `${this.loadingMb.toLocaleString('en-AU', { maximumFractionDigits: 1 })} MB of about 0.3 MB` : 'Connecting…'}</small>
            <progress max="0.3" value=${Math.min(0.3, this.loadingMb)}></progress>
          </div>
        </div>` : nothing}
    `;
  }

  private renderSettings(results: Scored[], label: string) {
    return html`
      <div class="backdrop" @click=${() => (this.settingsOpen = false)}></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="Filters and weights">
        <div class="drawer-head">
          <div><small>Settings</small><h2>${label}</h2></div>
          <button class="close" aria-label="Close the settings" @click=${() => (this.settingsOpen = false)}>×</button>
        </div>
        <div class="drawer-body">
          <h3>Filters <small>pass / removed</small> ${tip('Filters', HELP.filters)}</h3>
          ${this.filters.map((f) => this.renderFilter(f, results))}
          ${this.renderFinanceInputs()}
          <h3>Weights <small>ranking only</small> ${tip('Weights', HELP.weights)}</h3>
          ${this.signals.map((s) => {
            const info = SIGNALS[s.id] ?? { label: s.id, help: '' };
            return html`
              <div class="weight">
                <span>${info.label}${tip(info.label, `${info.help}\n\n${columnHelp(s.column)}`)}</span>
                <input type="range" min="0" max="5" step="1" .value=${String(s.weight)}
                  style="--p:${s.weight * 20}%" aria-label="Weight: ${info.label}"
                  @input=${(e: Event) => this.updateSignal(s.id, Number((e.target as HTMLInputElement).value))}>
                <output>${s.weight}</output>
              </div>`;
          })}
        </div>
        <div class="drawer-foot">
          <button class="btn" @click=${() => this.setStrategy(this.strategy)}>Default settings</button>
          <button class="btn primary" @click=${() => (this.settingsOpen = false)}>See the ${results.filter((r) => r.pass).length} suburbs</button>
        </div>
      </aside>`;
  }

  private renderFilter(f: FilterDef, results: Scored[]) {
    const failing = results.filter((r) => r.failed.includes(f.id)).length;
    const info = FILTERS[f.id] ?? { label: f.id, help: '' };
    const unit = COLUMNS[f.column]?.unit;
    const isPct = unit === 'pct';
    const shown = f.value === undefined ? undefined : isPct ? Math.round(f.value * 1000) / 10 : f.value;
    const help = [info.help, missingDataNote(f), columnHelp(f.column)].filter(Boolean).join('\n\n');
    return html`
      <div class="filter ${f.enabled ? '' : 'off'}">
        <label class="ftitle">
          <input class="switch" type="checkbox" .checked=${f.enabled} @change=${(e: Event) => this.updateFilter(f.id, { enabled: (e.target as HTMLInputElement).checked })}>
          <span>${info.label}</span>
        </label>
        ${tip(info.label, help)}
        ${f.op === 'min' || f.op === 'max' ? html`
          <span class="fval">
            <input type="number" step=${isPct ? '0.5' : 'any'} .value=${String(shown ?? '')} ?disabled=${!f.enabled}
              aria-label=${info.label}
              @change=${(e: Event) => {
                const v = Number((e.target as HTMLInputElement).value);
                if (Number.isFinite(v)) this.updateFilter(f.id, { value: isPct ? v / 100 : v });
              }}>${isPct ? html`<i>%</i>` : nothing}
          </span>` : html`<span></span>`}
        <span class="fcount" title="Suburbs removed by this filter">${f.enabled && failing ? `−${failing}` : ''}</span>
      </div>`;
  }

  private renderStats(passing: Scored[], total: number) {
    const med = (col: string) => {
      const v = passing.map((r) => num(r.row[col])).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const card = (value: unknown, label: string, help: string) => html`
      <div class="stat"><span class="label">${label}${tip(label, help)}</span><b>${value}</b></div>`;
    const extra = this.strategy === 'live'
      ? card(val('crime_burglary', med('crime_burglary')), 'median break-ins / 1,000 dwellings', `${HELP.median}\n\n${columnHelp('crime_burglary')}`)
      : this.strategy === 'growth'
        ? card(val('price_trend_5y', med('price_trend_5y')), 'median price change, 5 years', `${HELP.median}\n\n${columnHelp('price_trend_5y')}`)
        : card(val('gross_yield', med('gross_yield')), 'median gross yield', `${HELP.median}\n\n${columnHelp('gross_yield')}`);
    return html`
      <section class="stats" aria-label="Summary">
        ${card(html`${passing.length}<small> / ${total}</small>`, 'suburbs pass', HELP.passing)}
        ${card(fmt('price', med('price')), 'median house price', `${HELP.median}\n\n${columnHelp('price')}`)}
        ${extra}
        ${card(val('pop_cagr', med('pop_cagr')), 'median population growth / yr', `${HELP.median}\n\n${columnHelp('pop_cagr')}`)}
      </section>`;
  }

  private renderMap(results: Scored[]) {
    const { paint, scale } = this.mapPaint(results);
    const label = this.colorBy === 'score' ? 'Overall score' : COLUMNS[this.colorBy]?.label ?? this.colorBy;
    return html`
      <div class="card mapcard ${this.mapFull ? 'full' : ''}" role=${this.mapFull ? 'region' : nothing} aria-label=${this.mapFull ? 'Full-size map' : nothing}>
        <div class="maptools">
          ${this.renderDepPicker()}
          <label class="select">
            <span>Colour by</span>
            <select aria-label="Colour the map by" @change=${(e: Event) => (this.colorBy = (e.target as HTMLSelectElement).value)}>
              <option value="score" ?selected=${this.colorBy === 'score'}>Overall score (groups A to E)</option>
              ${COLOR_GROUPS.map((g) => html`<optgroup label=${g.title}>
                ${g.columns.map((c) => html`<option value=${c} ?selected=${this.colorBy === c}>${COLUMNS[c].label}</option>`)}
              </optgroup>`)}
            </select>
          </label>
          ${this.colorBy !== 'score' ? html`${colTip(this.colorBy)}
            <label class="switchlabel"><input class="switch" type="checkbox" .checked=${this.greyFailing}
              @change=${(e: Event) => (this.greyFailing = (e.target as HTMLInputElement).checked)}> Grey out removed suburbs</label>` : nothing}
          <div class="seg" role="group" aria-label="Map layers">
            ${([['bushfire', 'Bushfire', 'Show the bushfire protection areas (Plan SA): High, Medium, General'],
                ['relief', 'Relief', 'Show shaded relief (Esri World Hillshade)']] as const).map(([k, l, title]) => html`
              <button aria-pressed=${this.overlays[k] ? 'true' : 'false'} class=${this.overlays[k] ? 'on' : ''} title=${title}
                @click=${() => (this.overlays = { ...this.overlays, [k]: !this.overlays[k] })}>${l}</button>`)}
          </div>${tip('Bushfire and relief', HELP.overlays)}
          <span class="grow"></span>
          <span class="hint">Click a suburb for its detail</span>
          <button class="btn icon" @click=${() => this.setMapFull(!this.mapFull)}
            aria-pressed=${this.mapFull ? 'true' : 'false'} title=${this.mapFull ? 'Shrink the map (Esc)' : 'Expand the map'}>
            ${this.mapFull
              ? html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Shrink`
              : html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Expand`}
          </button>
        </div>
        <div class="mapwrap">
          <map-view .tiles=${'./data/communes.pmtiles'} .bushfire=${'./data/bushfire.geojson'} .departements=${this.departements} .zoomTo=${this.zoomTo}
            .paint=${paint} .selected=${this.selected} .dark=${this.dark} .overlays=${this.overlays}
            @select=${(e: CustomEvent<string>) => this.select(e.detail)}></map-view>
          ${this.renderScale(label, scale)}
        </div>
      </div>`;
  }

  /** Multi-select of councils: map, table, scores and medians are restricted to them. */
  private renderDepPicker() {
    const q = fold(this.depQuery.trim());
    const all = Object.entries(this.depNames).sort(([, a], [, b]) => a.localeCompare(b));
    const shown = q ? all.filter(([, n]) => fold(n).includes(q)) : all;
    const sel = new Set(this.scopes);
    const toggle = (c: string, on: boolean) => this.setScopes(on ? [...this.scopes, c] : this.scopes.filter((x) => x !== c));
    return html`
      <details class="deppicker">
        <summary class="btn ${sel.size ? 'active' : ''}" aria-label="Filter by council">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18s6-5.2 6-10A6 6 0 0 0 4 8c0 4.8 6 10 6 10z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="8" r="2" fill="currentColor"/></svg>
          ${this.scopeLabel}
          ${sel.size ? html`<span class="count">${sel.size}</span>` : nothing}
        </summary>
        <div class="depmenu" role="group" aria-label="Councils">
          <div class="depmenu-head">
            <input class="search" type="search" placeholder="Council name…" aria-label="Search a council"
              .value=${this.depQuery} @input=${(e: Event) => (this.depQuery = (e.target as HTMLInputElement).value)}>
            <button class="link" ?disabled=${!sel.size} @click=${() => this.setScopes([])}>All of Greater Adelaide</button>
            ${tip('Councils', HELP.scope)}
          </div>
          ${sel.size ? html`<div class="depchips">${this.scopes.map((c) => html`
            <button class="chip removable" @click=${() => toggle(c, false)} aria-label="Remove ${this.depNames[c] ?? c}">${this.depNames[c] ?? c} ×</button>`)}</div>` : nothing}
          <div class="deplist">
            ${shown.map(([c, n]) => html`
              <label><input type="checkbox" .checked=${sel.has(c)} @change=${(e: Event) => toggle(c, (e.target as HTMLInputElement).checked)}>
                ${n}</label>`)}
            ${shown.length ? nothing : html`<p class="empty">No council matches.</p>`}
          </div>
        </div>
      </details>`;
  }

  /** Colour key on the right of the map. */
  private renderScale(label: string, scale: Scale | null) {
    if (this.colorBy === 'score') {
      return html`
        <div class="key" aria-label="Legend: ${label}">
          <b>${label}${tip('Groups A to E', HELP.tier)}</b>
          ${(['A', 'B', 'C', 'D', 'E'] as const).map((t, i) => html`
            <div class="tierrow"><span style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}">${t}</span>
              <small>${['best 20 %', '', 'average', '', 'last 20 %'][i]}</small></div>`)}
          <div class="tierrow"><span class="na"></span><small>removed</small></div>
        </div>`;
    }
    if (!scale) return html`<div class="key"><b>${label}</b><small>no data</small></div>`;
    const c = this.colorBy;
    const mid = (scale.min + scale.max) / 2;
    return html`
      <div class="key" aria-label="Legend: ${label}">
        <b>${label}</b>
        <div class="gradient">
          <div class="bar" style="background:linear-gradient(to top, ${scale.stops.join(', ')})"></div>
          <div class="ticks">
            <span>${fmt(c, scale.max)}${scale.neutral ? '' : scale.lowIsGood ? html` <em class="bad">worse</em>` : html` <em class="good">better</em>`}</span>
            <span>${fmt(c, mid)}</span>
            <span>${fmt(c, scale.min)}${scale.neutral ? '' : scale.lowIsGood ? html` <em class="good">better</em>` : html` <em class="bad">worse</em>`}</span>
          </div>
        </div>
        <div class="tierrow"><span class="na"></span><small>${this.greyFailing ? 'removed or n/a' : 'n/a'}</small></div>
        <small class="keynote">Scale from the 5th to the 95th percentile${this.greyFailing ? ' of passing suburbs' : ''}</small>
      </div>`;
  }

  private renderColumnPicker() {
    const cols = this.tableColumns;
    return html`
      <details class="colpicker">
        <summary class="btn">Columns · ${cols.length}</summary>
        <div class="colmenu" role="group" aria-label="Table columns">
          <div class="colmenu-head">
            <b>Columns shown</b>
            <button class="link" @click=${() => (this.columns = defaultColumns(this.strategy))}>Default</button>
          </div>
          ${DETAIL_GROUPS.map((g) => html`
            <fieldset><legend>${g.title}</legend>
              ${g.columns.filter((c) => c in COLUMNS).map((c) => html`
                <label><input type="checkbox" .checked=${cols.includes(c)}
                  @change=${(e: Event) => this.toggleColumn(c, (e.target as HTMLInputElement).checked)}> ${COLUMNS[c].label}</label>`)}
            </fieldset>`)}
        </div>
      </details>`;
  }

  private tierBadge(r: Scored) {
    const t = r.pass && r.tier ? r.tier : 'fail';
    return html`<span class="tier" style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}">${r.pass ? r.tier : '–'}</span>`;
  }

  private renderTable(list: Scored[]) {
    const cols = this.tableColumns;
    const arrow = (c: string) => (this.sort?.column === c ? (this.sort.dir === -1 ? ' ↓' : ' ↑') : '');
    const header = (c: string, label: string) => html`
      <th scope="col" aria-sort=${this.sort?.column === c ? (this.sort.dir === -1 ? 'descending' : 'ascending') : 'none'}>
        <span class="th"><button @click=${() => this.toggleSort(c)}>${label}${arrow(c)}</button>${colTip(c)}</span>
      </th>`;
    const rank = this.ranks;
    const page = list.slice(0, this.shown);
    return html`
      <div class="card tablewrap">
        <table>
          <thead><tr>
            <th scope="col" class="num"><span class="th">#</span></th>
            ${header('nom', 'Suburb')}
            <th scope="col"><span class="th"><button @click=${() => (this.sort = null)}>Score${this.sort ? '' : ' ↓'}</button>${tip('Score', HELP.score)}</span></th>
            ${cols.map((c) => header(c, COLUMNS[c]?.label ?? c))}
          </tr></thead>
          <tbody>
            ${page.map((r) => html`
              <tr class=${`${r.pass ? '' : 'failrow'} ${r.row.code === this.selected ? 'sel' : ''}`}
                @click=${() => this.select(r.row.code, true)}>
                <td class="num">${r.pass ? rank.get(r.row.code) : ''}</td>
                <td class="name">${this.tierBadge(r)}<span>${r.row.nom}${r.row.postcodes ? html` <small class="dep">${r.row.postcodes}</small>` : nothing}</span></td>
                <td>${r.pass
                  ? html`<span class="score"><span class="bar"><i style="width:${r.score}%"></i></span><b>${fmt('score', r.score)}</b></span>`
                  : html`<span class="out" title=${`Fails: ${r.failed.map((f) => FILTERS[f]?.label ?? f).join(', ')}`}>removed</span>`}</td>
                ${cols.map((c) => html`<td>${val(c, r.row[c])}</td>`)}
              </tr>`)}
          </tbody>
        </table>
        ${list.length > page.length ? html`
          <div class="more">
            <span>${page.length} of ${fmt('pop', list.length)} suburbs shown</span>
            <button class="btn" @click=${() => (this.shown += PAGE)}>Show ${Math.min(PAGE, list.length - page.length)} more</button>
            <button class="link" @click=${() => (this.shown = list.length)}>Show all</button>
          </div>` : nothing}
      </div>`;
  }

  private _ranks?: { res: Scored[]; out: Map<string, number> };

  /** Rank (1 = best score) of each passing commune, independent of table sort and search. */
  private get ranks(): Map<string, number> {
    const res = this.results;
    if (this._ranks?.res === res) return this._ranks.out;
    const out = new Map<string, number>();
    res.filter((r) => r.pass).sort(compareScore).forEach((r, i) => out.set(r.row.code, i + 1));
    this._ranks = { res, out };
    return out;
  }

  /** Strongest good and bad signals of a commune, across all panel columns. */
  private highlights(row: Row): { good: string[]; bad: string[] } {
    const good: string[] = [];
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const g of DETAIL_GROUPS) {
      for (const c of g.columns) {
        if (seen.has(c) || !(c in COLUMNS)) continue;
        seen.add(c);
        const j: Verdict | null = judge(c, row[c]);
        // Strengths: keep the summary line, not each nearby service or each variant of an indicator.
        const detailOnly = c === 'n_sales' || c === 'n_bonds_house' || c === 'seifa_decile_sa' || c.startsWith('bushfire_');
        if (j === 'good' && !detailOnly) good.push(c);
        else if (j === 'bad' || j === 'warn') bad.push(c);
      }
    }
    return { good, bad };
  }

  private renderDetail(r: Scored) {
    const row = r.row;
    const hl = this.highlights(row);
    const t = r.pass && r.tier ? r.tier : 'fail';
    return html`
      <aside class="sidenav" aria-label="Detail: ${row.nom}">
        <div class="sn-head">
          <div class="sn-title">
            <span class="tier big" style="background:${TIER_COLORS[t]};color:${TIER_TEXT[t]}">${r.pass ? r.tier : '–'}</span>
            <div>
              <h3>${row.nom}</h3>
              <small>${fmt('pop', row.pop)} residents · ${row.council ?? ''} council</small>
              ${row.postcodes ? html`<small class="cp" title="Postcode">SA ${row.postcodes}</small>` : nothing}
            </div>
          </div>
          <button class="close" aria-label="Close the panel" title="Close (Esc)" @click=${() => this.select(null)}>×</button>
        </div>
        <div class="sn-body">
          ${r.pass
            ? html`<div class="sn-score">
                <div><span class="label">Score ${tip('Score', HELP.score)}</span><b>${fmt('score', r.score)}</b><small>/100</small></div>
                <div><span class="label">Group ${tip('Group', HELP.tier)}</span><b>${r.tier}</b></div>
              </div>`
            : html`<p class="failbox">Removed by: ${r.failed.map((f) => f === 'tiers' ? `group ${r.tier ?? ''} outside groups ${this.tiers.join(', ')}` : FILTERS[f]?.label ?? this.filterChip([...this.custom].find((c) => c.id === f) ?? { id: f, column: f, op: 'min', enabled: true })).join(', ')}</p>`}

          ${hl.good.length || hl.bad.length ? html`
            <div class="hl">
              ${hl.good.length ? html`<div class="hl-col good"><h4>Strengths</h4>
                <ul>${hl.good.map((c) => html`<li><span>${COLUMNS[c].label}</span><b>${fmt(c, row[c])}</b></li>`)}</ul></div>` : nothing}
              ${hl.bad.length ? html`<div class="hl-col bad"><h4>Weaknesses</h4>
                <ul>${hl.bad.map((c) => html`<li class=${judge(c, row[c]) ?? ''}><span>${COLUMNS[c].label}</span><b>${fmt(c, row[c])}</b></li>`)}</ul></div>` : nothing}
            </div>` : nothing}

          ${r.pass ? html`
            <details open class="grp">
              <summary>Rank by criterion ${tip('Rank by criterion', HELP.parts)}</summary>
              <div class="parts">${this.signals.filter((s) => s.weight > 0).map((s) => {
                const p = r.parts[s.id];
                const pct = p === null || p === undefined ? null : Math.round(p * 100);
                const cls = pct === null ? '' : pct >= 66 ? 'good' : pct < 34 ? 'bad' : '';
                return html`<div><span>${SIGNALS[s.id]?.label ?? s.id}</span>
                  <span class="bar ${cls}"><i style="width:${pct ?? 0}%"></i></span>
                  <b>${pct === null ? 'n/a' : pct}</b></div>`;
              })}</div>
            </details>` : nothing}

          ${adLinks(row).length ? html`
            <div class="ads">
              <span class="label">Listings${tip('Listings', 'Links to a search of houses in this suburb (postcode ' + (firstPostcode(row) ?? '') + ') on realestate.com.au and Domain, opened in a new tab. The links are built by the app; the sites can change their address format.')}</span>
              ${adLinks(row).map((l) => html`<a href=${l.url} target="_blank" rel="noopener noreferrer">${l.label} ↗</a>`)}
            </div>` : nothing}
          ${this.detailWarnings(row)}
          ${this.renderSimulation(row)}
          ${this.renderHistory(row)}

          ${DETAIL_GROUPS.map((g) => html`
            <details open class="grp">
              <summary>${g.title}${g.help ? tip(g.title, g.help) : nothing}</summary>
              <dl>${g.columns.filter((c) => c in COLUMNS).map((c) => html`
                <dt>${COLUMNS[c].label}${colTip(c)}</dt><dd>${val(c, row[c])}</dd>`)}</dl>
            </details>`)}
          <p class="code">ABS suburb code (SAL 2021) ${row.code}</p>
        </div>
      </aside>`;
  }

  /** Open the drawer on the purchase assumptions. */
  private editAssumptions() {
    this.settingsOpen = true;
    this.updateComplete.then(() => this.renderRoot.querySelector('#assumptions')?.scrollIntoView({ block: 'start' }));
  }

  /** One line under the strategy blurb: the assumptions the yields on screen rely on, with an "Edit" link. */
  private renderAssumptions() {
    if (this.strategy !== 'long') return nothing;
    const f = this.finance;
    const p = (v: number) => fmt('net_yield', v);
    const a = (v: number) => fmt('purchase_price', v);
    return html`
      <p class="assume">Net yield and cash flow use: median house · <b>${p(f.deposit)}</b> deposit · loan <b>${p(f.rate)}</b> over ${f.years} years
        · SA stamp duty + ${a(f.otherCosts)} costs · management ${p(f.charges)} · ${f.vacancy} weeks vacant · ${a(f.holding)}/yr rates and insurance
        · <button class="link" @click=${() => this.editAssumptions()}>Edit</button></p>`;
  }

  private setFinance(patch: Partial<Finance>) {
    this.finance = { ...this.finance, ...patch };
    this.pushUrl();
  }

  /** Purchase assumptions used for net yield and cash flow (drawer section). */
  private renderFinanceInputs() {
    const f = this.finance;
    const field = (label: string, value: number, unit: string, step: string, set: (v: number) => void, help: string) => html`
      <label class="fin">
        <span>${label}${tip(label, help)}</span>
        <span class="fval"><input type="number" step=${step} min="0" .value=${String(value)}
          aria-label=${label} @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v >= 0) set(v);
          }}><i>${unit}</i></span>
      </label>`;
    const pct = (v: number) => Math.round(v * 1000) / 10;
    return html`
      <h3 id="assumptions">Purchase assumptions <small>net yield and cash flow</small> ${tip('Purchase assumptions', HELP.finance)}</h3>
      <div class="fingrid">
        ${field('Deposit', pct(f.deposit), '%', '1', (v) => this.setFinance({ deposit: v / 100 }), 'Share of the total cost (price + stamp duty + other costs) paid without borrowing. Under 20 %, lenders usually add mortgage insurance (not counted).')}
        ${field('Interest rate', pct(f.rate), '%', '0.05', (v) => this.setFinance({ rate: v / 100 }), 'Yearly rate of an investor loan, principal and interest.')}
        ${field('Loan term', f.years, 'years', '1', (v) => this.setFinance({ years: Math.max(1, v) }), 'Length of the loan.')}
        ${field('Other purchase costs', f.otherCosts, '$', '500', (v) => this.setFinance({ otherCosts: v }),
          'Added to stamp duty: transfer and mortgage registration fees (Land Services SA), conveyancing, building and pest inspection. Stamp duty itself is computed from the price with the SA general rates.')}
        ${field('Management and maintenance', pct(f.charges), '% of rent', '1', (v) => this.setFinance({ charges: v / 100 }),
          'Property manager fee, letting fee, repairs and upkeep. Adelaide managers often charge 6 to 9 % plus letting fees; 10 to 15 % covers repairs too.')}
        ${field('Vacancy', f.vacancy, 'weeks/yr', '1', (v) => this.setFinance({ vacancy: Math.min(52, v) }), 'Average weeks per year without a tenant.')}
        ${field('Holding costs', f.holding, '$/yr', '250', (v) => this.setFinance({ holding: v }),
          'Council rates, emergency services levy, SA Water supply charge, land tax and landlord insurance, per year. They depend on the property and the council: check the council rates notice and RevenueSA for land tax.')}
      </div>
      <button class="link" @click=${() => this.setFinance({ ...DEFAULT_FINANCE })}>Default assumptions</button>`;
  }

  /** Step-by-step purchase simulation for the selected suburb. */
  private renderSimulation(row: Row) {
    const sim = simulate(row, this.finance);
    if (!sim) {
      return html`<details class="grp"><summary>Purchase simulation</summary>
        <p class="muted">Not enough house sales or new leases to simulate a purchase here.</p></details>`;
    }
    const e = (v: number) => fmt('purchase_price', Math.round(v));
    const f = this.finance;
    return html`
      <details open class="grp sim">
        <summary>Purchase simulation${tip('Purchase simulation', HELP.finance)}</summary>
        <p class="muted">The median house of the suburb, rented at the median weekly rent of new house leases.
          <button class="link" @click=${() => this.editAssumptions()}>Edit the assumptions</button></p>
        <dl>
          <dt>Median price (${row.n_sales} sales)</dt><dd>${e(sim.price)}</dd>
          <dt>+ Stamp duty (SA general rates)</dt><dd>${e(sim.stampDuty)}</dd>
          <dt>+ Other purchase costs</dt><dd>${e(sim.otherCosts)}</dd>
          <dt><b>= Total cost</b></dt><dd><b>${e(sim.totalCost)}</b></dd>
          <dt>Yearly rent (${fmt('rent_week', row.rent_week)} × 52)</dt><dd>${e(sim.rentYear)}</dd>
          <dt>− Vacancy (${f.vacancy} weeks)</dt><dd>${e(-sim.vacancyLoss)}</dd>
          <dt>− Management and maintenance (${fmt('net_yield', f.charges)})</dt><dd>${e(-sim.charges)}</dd>
          <dt>− Holding costs</dt><dd>${e(-sim.holding)}</dd>
          <dt><b>= Net yearly income</b></dt><dd><b>${e(sim.netIncome)}</b></dd>
          <dt><b>Net yield</b>${colTip('net_yield')}</dt><dd>${val('net_yield', sim.netYield)}</dd>
          <dt>Loan (deposit ${fmt('net_yield', f.deposit)})</dt><dd>${e(sim.loan)}</dd>
          <dt>Repayment (${fmt('net_yield', f.rate)}, ${f.years} years)</dt><dd>${e(-sim.monthlyPayment)}</dd>
          <dt><b>Monthly cash flow</b>${colTip('cashflow_month')}</dt><dd>${val('cashflow_month', Math.round(sim.cashflowMonth))}</dd>
        </dl>
        <p class="muted small">Before income tax, negative gearing and depreciation. Rents of new leases are usually above the rent a sitting tenant pays.</p>
      </details>`;
  }

  /** Median house price and number of sales per year (SA Valuer-General 2015–2025), as a small SVG chart. */
  private renderHistory(row: Row) {
    const years = Array.from({ length: 11 }, (_, i) => String(2015 + i));
    const price = years.map((y) => num(row[`hist_house_${y}`]));
    const n = years.map((y) => num(row[`nhist_house_${y}`]) ?? 0);
    if (!price.some((p) => p !== null)) return nothing;
    const W = 300, H = 120, padL = 44, padB = 18, padT = 8;
    const prices = price.filter((p): p is number => p !== null);
    const maxN = Math.max(1, ...n);
    const lo = Math.min(...prices) * 0.9;
    const hi = Math.max(...prices) * 1.05;
    const x = (i: number) => padL + (i + 0.5) * ((W - padL) / years.length);
    const y = (p: number) => padT + (H - padT - padB) * (1 - (p - lo) / (hi - lo || 1));
    const bw = (W - padL) / years.length * 0.6;
    const k = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`);
    const pts = price.map((p, i) => (p === null ? null : `${x(i)},${y(p)}`)).filter(Boolean).join(' ');
    return html`
      <details open class="grp">
        <summary>Price and sales per year${tip('Price and sales per year', HELP.history)}</summary>
        <svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="Median house price and number of sales per year">
          ${[lo, (lo + hi) / 2, hi].map((v) => svg`<text x=${padL - 4} y=${y(v) + 3} text-anchor="end" class="ax">${k(v)}</text>
            <line x1=${padL} x2=${W} y1=${y(v)} y2=${y(v)} class="grid"></line>`)}
          ${n.map((c, i) => svg`<rect x=${x(i) - bw / 2} width=${bw}
            y=${H - padB - (c / maxN) * (H - padT - padB) * 0.45} height=${(c / maxN) * (H - padT - padB) * 0.45}
            fill="var(--brand-2)" opacity="0.22"><title>${years[i]}: ${c} sales</title></rect>`)}
          <polyline points=${pts} fill="none" stroke="var(--brand-2)" stroke-width="2"></polyline>
          ${price.map((p, i) => (p === null ? nothing : svg`<circle cx=${x(i)} cy=${y(p)} r="3" fill="var(--brand-2)">
            <title>${years[i]}: ${fmt('price', p)} (${n[i]} sales)</title></circle>`))}
          ${years.map((yy, i) => (i % 2 === 0 ? svg`<text x=${x(i)} y=${H - 4} text-anchor="middle" class="ax">${yy.slice(2)}</text>` : nothing))}
        </svg>
        <div class="legendrow"><span><i style="background:var(--brand-2)"></i>Houses (median price, line; sales, bars)</span></div>
        <p class="muted small">A point is missing when the year had fewer than 5 sales.</p>
      </details>`;
  }

  private detailWarnings(row: Row) {
    const w: string[] = [];
    if ((num(row.bushfire_med_high_share) ?? 0) > 0) w.push('Part of this suburb is in a Medium or High bushfire protection area: new homes and extensions must meet bushfire construction standards, and insurance can cost more. Check the address on the SA Property and Planning Atlas (sappa.plan.sa.gov.au).');
    if ((num(row.low_lying_share) ?? 0) > 0.05) w.push('Part of this suburb is below 5 m: check coastal flooding and sea-level rise maps for the exact address with the council.');
    if (typeof row.price_median_house !== 'number') w.push('No house price here: the Valuer-General covers the 19 metropolitan councils only, and a suburb needs at least 5 sales over the last four quarters.');
    if (this.strategy === 'live') w.push('Before buying a given house: read the Form 1 (vendor statement) and check the zoning and overlays of the address on the SA Property and Planning Atlas. The data here is suburb-wide.');
    return w.map((t) => html`<p class="note">${t}</p>`);
  }

  private renderFooter() {
    const d = (s: string | undefined) => (s ? new Date(s).toLocaleDateString('en-AU') : '—');
    return html`
      <footer class="card">
        <p><b>Read this before trusting a number.</b> House prices are suburb medians from the SA Valuer-General over the last four quarters (${this.meta?.price_window ?? '—'}); small suburbs have few sales, and units are not covered. Rents are medians of new house leases from rental bonds (${this.meta?.rent_window ?? '—'}). Census figures date from 2021 and crime figures from 2025-26. Gross yield ignores stamp duty, rates, land tax, insurance, management, vacancy and repairs. A risk flag means a hazard is mapped over a large part of the suburb, not that a given house is exposed. Green / orange / red follow fixed thresholds, the same for every suburb. Hover the "?" for how each value is computed.</p>
        <details><summary>Sources and licences</summary>
          <ul>${this.meta?.sources.map((s) => html`<li><a href=${s.url} rel="noopener" target="_blank">${s.producer}</a> — ${s.vintage} — ${s.licence}${s.credit ? html` — <i>${s.credit}</i>` : nothing}</li>`)}</ul>
        </details>
        <p class="small">Data built on ${d(this.meta?.built)}. This is not financial advice.</p>
      </footer>`;
  }

  static styles = css`
    :host {
      --bg: #f2f4f1; --surface: #ffffff; --ink: #14201b; --muted: #5d6b64; --faint: #8b9791; --line: #e3e7e2;
      --brand: #134e33; --brand-2: #1f7a4c; --brand-soft: #e6f3ec;
      --good: #137a3d; --good-bg: #dcf5e5; --bad: #b42318; --bad-bg: #fde4e1; --warn: #a15c07; --warn-bg: #fdf0d5;
      --radius: 14px; --shadow: 0 1px 2px rgba(16, 32, 24, .05), 0 6px 20px rgba(16, 32, 24, .06);
      --surface-2: #f6f8f6; --surface-3: #eceeec; --ink-2: #33423b; --hover: #f4f8f5; --th-bg: #f7f9f7; --row-line: #eef1ee;
      --track: #e1e7e2; --input-bg: #fbfcfb; --input-line: #d6ddd8; --switch-off: #cfd7d2; --seg-bg: #e4e9e5;
      --note-fg: #6b4106; --glass: rgba(255,255,255,.94); --tip-btn: #e3e9e5; --tip-btn-fg: #4f5f57;
      display: block; min-height: 100vh; background: var(--bg); color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
      -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
    }
    :host([data-theme='dark']) {
      --bg: #0f1714; --surface: #16211c; --ink: #e4ece7; --muted: #9db0a6; --faint: #74867c; --line: #25342d;
      --brand: #2a8f5a; --brand-2: #3fb877; --brand-soft: #1b3729;
      --good: #6fd597; --good-bg: #163525; --bad: #ff8f80; --bad-bg: #3c1f1b; --warn: #f2b860; --warn-bg: #3a2b14;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.25);
      --surface-2: #1b2822; --surface-3: #23322b; --ink-2: #c9d6cf; --hover: #1c2b24; --th-bg: #19251f; --row-line: #1f2c26;
      --track: #2b3a33; --input-bg: #111b17; --input-line: #33453c; --switch-off: #3a4a42; --seg-bg: #22302a;
      --note-fg: #f5d9a8; --glass: rgba(22,33,28,.94); --tip-btn: #2a3a33; --tip-btn-fg: #c3d1ca;
    }
    button { font: inherit; color: inherit; }
    .card { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); border: 1px solid var(--line); }

    /* ---- header ---- */
    header { position: sticky; top: 0; z-index: 30; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px;
      padding: 10px 20px; background: linear-gradient(115deg, #0d3a26, #175c3c 60%, #1f7a4c); color: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand svg { width: 30px; height: 30px; background: rgba(255,255,255,.1); border-radius: 9px; padding: 3px; }
    .brand span { display: flex; flex-direction: column; line-height: 1.15; }
    .brand b { font-size: 16px; letter-spacing: -.01em; } .brand small { font-size: 11.5px; opacity: .7; }
    .tabs { display: flex; gap: 2px; flex-wrap: wrap; background: rgba(0,0,0,.18); padding: 4px; border-radius: 12px; }
    .tabs button { border: 0; background: transparent; color: rgba(255,255,255,.82); padding: 7px 12px; border-radius: 9px; cursor: pointer; font-weight: 500; white-space: nowrap; transition: background .15s, color .15s; }
    .tabs button:hover { background: rgba(255,255,255,.1); color: #fff; }
    .tabs button.on { background: #fff; color: var(--brand); font-weight: 650; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    .tabs button:focus-visible, .btn:focus-visible, .seg button:focus-visible { outline: 2px solid #9be3b5; outline-offset: 2px; }

    /* ---- layout ---- */
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); }
    .layout.has-detail { grid-template-columns: minmax(0, 1fr) 400px; }
    /* Docked assistant: the page (and the expanded map) start right of it. */
    .layout.chat-docked { margin-left: var(--chat-w, 0px); }
    .layout.chat-docked .mapcard.full { left: var(--chat-w, 0px); }
    main { padding: 18px 22px 30px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }

    /* ---- summary of active settings ---- */
    .summary { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; }
    .summary-text p { margin: 0 0 10px; color: var(--muted); max-width: 820px; font-size: 14.5px; }
    .localrent { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 6px 0 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
    .localrent label { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; flex-wrap: wrap; }
    .localrent .tag { font-size: 11px; font-weight: 700; color: var(--brand-2); background: var(--brand-soft); border-radius: 999px; padding: 1px 8px; }
    .summary-text p.assume { font-size: 12.5px; margin-top: -4px; }
    .summary-text p.assume b { color: var(--ink-2); font-weight: 650; }
    .summary-text p.assume b.warn { color: var(--warn); }
    .summary-text p.assume .link { font-size: 12.5px; font-weight: 650; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .chip { background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px; font-size: 12.5px; color: var(--ink-2); }
    .chip.custom { border-color: var(--brand-2); background: var(--brand-soft); display: inline-flex; align-items: center; gap: 4px; padding-right: 4px; }
    .chip.custom button { border: 0; background: transparent; color: var(--brand-2); font-size: 15px; line-height: 1; cursor: pointer; padding: 0 5px; border-radius: 999px; }
    .chip.custom button:hover { background: var(--surface); }
    .chip.clear { cursor: pointer; font: inherit; font-size: 12.5px; color: var(--brand-2); border-style: dashed; }
    .chip.clear:hover { background: var(--brand-soft); }
    .seg { display: inline-flex; background: var(--seg-bg); border-radius: 999px; padding: 3px; margin-right: 2px; }
    .seg button { border: 0; background: transparent; border-radius: 999px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: var(--muted); font-weight: 500; }
    .seg button.on { background: var(--surface); color: var(--brand); font-weight: 650; box-shadow: 0 1px 2px rgba(0,0,0,.12); }

    .btn { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: var(--surface); padding: 8px 14px; border-radius: 10px; cursor: pointer; font-weight: 550; white-space: nowrap; transition: background .15s, border-color .15s; }
    .btn:hover { border-color: var(--input-line); background: var(--hover); }
    .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
    .btn.primary:hover { background: var(--brand-2); }
    .btn svg { width: 17px; height: 17px; }

    /* ---- stats ---- */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
    .stat .label { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; }
    .stat b { font-size: 26px; font-weight: 700; letter-spacing: -.02em; }
    .stat b small { font-size: 14px; color: var(--faint); font-weight: 500; }
    .stat b .v { font-size: inherit; padding: 0 8px; border-radius: 8px; }

    /* ---- map ---- */
    .mapcard { overflow: visible; }
    .maptools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .select { display: inline-flex; align-items: stretch; border: 1px solid var(--input-line); border-radius: 10px; background: var(--input-bg); overflow: hidden; }
    .select span { padding: 0 10px; color: var(--muted); font-size: 12.5px; border-right: 1px solid var(--line); display: flex; align-items: center; background: var(--surface-2); }
    .select select { font: inherit; border: 0; background: transparent; color: var(--ink); padding: 7px 10px; min-width: 260px; cursor: pointer; }
    .select select:focus-visible { outline: 2px solid var(--brand-2); }
    .select option, .select optgroup { background: var(--surface); color: var(--ink); }
    .hint { color: var(--faint); font-size: 12.5px; }
    .mapwrap { position: relative; height: 56vh; min-height: 380px; border-radius: 0 0 var(--radius) var(--radius); overflow: hidden; }
    /* Expanded map: fixed between the header and the bottom of the window, left of the side panel. */
    .mapcard.full { position: fixed; top: var(--header-h, 56px); left: 0; right: 0; bottom: 0; z-index: 25;
      display: flex; flex-direction: column; border-radius: 0; border: 0; box-shadow: none; }
    .layout.has-detail .mapcard.full { right: 400px; }
    .mapcard.full .mapwrap { flex: 1; height: auto; min-height: 0; border-radius: 0; }
    .btn.icon { padding: 6px 10px; gap: 6px; font-size: 13px; }
    .btn.icon svg { width: 16px; height: 16px; }
    map-view { position: absolute; inset: 0; }
    .key { position: absolute; right: 12px; top: 12px; width: 160px; background: var(--glass); backdrop-filter: blur(6px); border-radius: 12px; box-shadow: var(--shadow); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .key b { font-size: 12.5px; display: flex; align-items: center; line-height: 1.25; }
    .tierrow { display: flex; align-items: center; gap: 8px; }
    .tierrow span { width: 24px; height: 18px; border-radius: 5px; display: grid; place-items: center; font-weight: 750; font-size: 11px; flex: none; }
    .tierrow span.na { background: repeating-linear-gradient(45deg, var(--surface-3), var(--surface-3) 3px, var(--track) 3px, var(--track) 6px); }
    .tierrow small, .keynote { color: var(--muted); }
    .keynote { font-size: 11px; line-height: 1.3; }
    .gradient { display: flex; gap: 8px; height: 170px; }
    .gradient .bar { width: 14px; height: 100%; border-radius: 7px; }
    .gradient .ticks { display: flex; flex-direction: column; justify-content: space-between; font-weight: 600; }
    .gradient em { font-style: normal; font-weight: 500; font-size: 10.5px; }
    .gradient em.good { color: var(--good); } .gradient em.bad { color: var(--bad); }

    /* ---- header extras ---- */
    header .grow { flex: 1; }
    .themes { display: flex; gap: 2px; background: rgba(0,0,0,.18); padding: 3px; border-radius: 10px; }
    .themes button { border: 0; background: transparent; color: rgba(255,255,255,.8); min-width: 32px; padding: 5px 9px; border-radius: 8px; cursor: pointer; font-size: 12.5px; }
    .themes button.on { background: rgba(255,255,255,.92); color: #134e33; font-weight: 650; }
    .themes button:focus-visible { outline: 2px solid #9be3b5; outline-offset: 1px; }

    /* ---- table extras ---- */
    th:nth-child(2), td.name { position: sticky; left: 0; background: var(--surface); z-index: 1; box-shadow: 1px 0 0 var(--row-line); }
    th:nth-child(2) { z-index: 2; background: var(--th-bg); }
    tbody tr:hover td.name { background: var(--hover); }
    tr.sel td.name { background: var(--brand-soft); }
    .more { display: flex; align-items: center; gap: 14px; justify-content: center; padding: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; position: sticky; left: 0; }
    td.name small.dep { color: var(--faint); font-weight: 500; font-size: 11.5px; margin-left: 4px; }
    .search { font: inherit; border: 1px solid var(--input-line); background: var(--input-bg); color: var(--ink); border-radius: 10px; padding: 7px 12px; min-width: 220px; }
    .search:focus-visible { outline: 2px solid var(--brand-2); border-color: transparent; }
    .select.small select { min-width: 210px; padding: 5px 8px; font-size: 13px; }
    .colpicker { position: relative; }
    .deppicker { position: relative; }
    .deppicker summary { list-style: none; max-width: 340px; overflow: hidden; text-overflow: ellipsis; }
    .deppicker summary::-webkit-details-marker { display: none; }
    .deppicker summary svg { width: 16px; height: 16px; flex: none; }
    .deppicker summary.active { border-color: var(--brand-2); color: var(--brand-2); background: var(--brand-soft); }
    .deppicker .count { background: var(--brand-2); color: #fff; border-radius: 99px; font-size: 11px; padding: 0 7px; line-height: 18px; }
    .depmenu { position: absolute; left: 0; top: calc(100% + 6px); z-index: 30; width: min(420px, 90vw); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .depmenu-head { display: flex; align-items: center; gap: 10px; }
    .depmenu-head .search { flex: 1; min-width: 0; }
    .depchips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip.removable { cursor: pointer; font: inherit; font-size: 12.5px; background: var(--brand-soft); border-color: transparent; color: var(--ink); }
    .chip.removable:hover { background: var(--bad-bg); }
    .deplist { max-height: 320px; overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; }
    .deplist label { display: flex; align-items: center; gap: 6px; font-size: 13px; padding: 3px 2px; cursor: pointer; border-radius: 6px; }
    .deplist label:hover { background: var(--hover); }
    .deplist input { accent-color: var(--brand-2); }
    .deplist .code { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 22px; }
    .deplist .empty { grid-column: 1 / -1; color: var(--muted); margin: 6px 0; }
    .link:disabled { color: var(--faint); cursor: default; }
    .chip.strong { background: var(--brand-soft); border-color: transparent; font-weight: 600; }
    .colpicker summary { list-style: none; } .colpicker summary::-webkit-details-marker { display: none; }
    .colmenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: min(560px, 90vw); max-height: 60vh; overflow-y: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 12px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px; }
    .colmenu-head { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; }
    .colmenu fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
    .colmenu legend { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 650; padding: 0 0 4px; }
    .colmenu label { display: flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; }
    .colmenu input { accent-color: var(--brand-2); }
    .link { border: 0; background: none; color: var(--brand-2); cursor: pointer; font-weight: 600; padding: 0; }

    /* ---- AI summary ---- */
    .ai { background: linear-gradient(135deg, var(--brand-soft), var(--surface-2)); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
    .ai-head { display: flex; align-items: center; }
    .ai-badge { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--brand-2); }
    .ai p { margin: 6px 0 0; font-size: 13.5px; line-height: 1.55; }
    .ai p.muted { color: var(--muted); display: flex; align-items: center; gap: 8px; }

    /* ---- loading ---- */
    .loading { position: fixed; left: 50%; top: 45%; transform: translate(-50%, -50%); z-index: 60; display: flex; gap: 14px; align-items: center;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; box-shadow: 0 12px 40px rgba(0, 0, 0, .18); min-width: 320px; }
    .loading div { display: flex; flex-direction: column; gap: 4px; }
    .loading small { color: var(--muted); font-size: 12.5px; }
    .loading progress { width: 100%; height: 6px; accent-color: var(--brand-2); }
    .spinner { width: 26px; height: 26px; flex: none; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--brand-2); animation: spin .9s linear infinite; }
    .spinner.small { width: 14px; height: 14px; border-width: 2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

    /* ---- table ---- */
    .tablebar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
    .tablebar h2 { margin: 0 8px 0 0; font-size: 18px; letter-spacing: -.01em; }
    .grow { flex: 1; }
    .tablewrap { overflow: auto; max-height: 70vh; }
    table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13.5px; }
    /* Sticky headers each form a layer: lift the one whose tooltip is open above its neighbours. */
    th:hover, th:focus-within { z-index: 4; }
    th { position: sticky; top: 0; z-index: 1; background: var(--th-bg); text-align: left; vertical-align: bottom; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .th { display: inline-flex; align-items: flex-end; gap: 4px; padding: 9px 10px; }
    th button { border: 0; background: none; padding: 0; cursor: pointer; font-weight: 650; text-align: left; color: inherit; font-size: 12px; line-height: 1.25; min-width: 88px; max-width: 150px; }
    th button:hover { color: var(--ink); }
    td { padding: 8px 10px; border-bottom: 1px solid var(--row-line); white-space: nowrap; }
    td.num, th.num { color: var(--faint); width: 32px; text-align: right; }
    td.name { display: flex; align-items: center; gap: 10px; font-weight: 600; }
    tbody tr { cursor: pointer; transition: background .1s; }
    tbody tr:hover { background: var(--hover); }
    tr.sel { background: var(--brand-soft) !important; box-shadow: inset 3px 0 0 var(--brand); }
    tr.failrow td { color: var(--faint); } tr.failrow td.name { font-weight: 500; }
    .tier { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 7px; font-size: 11.5px; font-weight: 750; flex: none; }
    .tier.big { width: 40px; height: 40px; border-radius: 12px; font-size: 19px; }
    .score { display: inline-flex; align-items: center; gap: 8px; }
    .bar { display: inline-block; width: 54px; height: 6px; border-radius: 99px; background: var(--track); overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6cc48d, var(--brand-2)); }
    .bar.good i { background: var(--good); } .bar.bad i { background: #e2775f; }
    .score b { font-weight: 700; min-width: 30px; }
    .out { font-size: 12px; background: var(--surface-3); color: var(--muted); border-radius: 6px; padding: 2px 7px; }

    /* ---- good / bad values ---- */
    .v { display: inline-block; padding: 1px 7px; border-radius: 6px; font-weight: 600; }
    .v.good { background: var(--good-bg); color: var(--good); }
    .v.bad { background: var(--bad-bg); color: var(--bad); }
    .v.warn { background: var(--warn-bg); color: var(--warn); }
    /* In the table, good values stay quiet (green text) so problems stand out. */
    td .v.good { background: none; padding: 0; font-weight: 650; }

    /* ---- side panel ---- */
    .sidenav { position: sticky; top: var(--header-h, 56px); align-self: start; height: calc(100vh - var(--header-h, 56px)); display: flex; flex-direction: column; background: var(--surface); border-left: 1px solid var(--line); box-shadow: -8px 0 24px rgba(16,32,24,.06); z-index: 26; }
    .sn-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; padding: 16px 18px 14px; border-bottom: 1px solid var(--line); }
    .sn-title { display: flex; align-items: center; gap: 12px; }
    .sn-head h3 { margin: 0; font-size: 20px; letter-spacing: -.02em; } .sn-head small { color: var(--muted); }
    .sn-head small.cp { display: block; margin-top: 2px; }
    .ads { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); font-size: 12.5px; }
    .ads .label { display: inline-flex; align-items: center; font-weight: 650; color: var(--ink-2); width: 100%; }
    .ads a { color: var(--brand-2); text-decoration: none; font-weight: 600; }
    .ads a:hover { text-decoration: underline; }
    .sn-body { overflow-y: auto; padding: 14px 18px 30px; display: flex; flex-direction: column; gap: 12px; }
    .sn-score { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .sn-score > div { background: var(--surface-2); border-radius: 12px; padding: 10px 12px; }
    .sn-score .label { display: flex; align-items: center; font-size: 12px; color: var(--muted); }
    .sn-score b { font-size: 24px; font-weight: 750; letter-spacing: -.02em; } .sn-score small { color: var(--faint); margin-left: 2px; }
    .failbox { margin: 0; background: var(--surface-2); border-radius: 12px; padding: 10px 12px; color: var(--muted); }
    .hl { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .hl-col { border-radius: 12px; padding: 10px 12px; }
    .hl-col.good { background: var(--good-bg); } .hl-col.bad { background: var(--bad-bg); }
    .hl-col h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
    .hl-col.good h4 { color: var(--good); } .hl-col.bad h4 { color: var(--bad); }
    .hl-col ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 3px; }
    .hl-col li { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
    .hl-col li b { white-space: nowrap; }
    .hl-col li.warn { color: var(--warn); }
    .grp { border: 1px solid var(--line); border-radius: 12px; padding: 4px 12px 8px; }
    .grp summary { cursor: pointer; list-style: none; padding: 8px 0 4px; font-weight: 650; font-size: 12.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-2); display: flex; align-items: center; }
    .grp summary::-webkit-details-marker { display: none; }
    .grp summary::before { content: '▸'; margin-right: 6px; color: var(--faint); transition: transform .15s; }
    .grp[open] summary::before { transform: rotate(90deg); }
    .grp dl { display: grid; grid-template-columns: 1fr auto; margin: 4px 0 0; gap: 5px 12px; font-size: 13px; }
    .muted { color: var(--muted); font-size: 12.5px; margin: 4px 0; }
    .muted.small { font-size: 11.5px; }
    .sim dd { font-variant-numeric: tabular-nums; }
    svg.hist { width: 100%; height: auto; margin-top: 6px; }
    svg.hist .ax { font-size: 9px; fill: var(--muted); }
    svg.hist .grid { stroke: var(--line); stroke-width: 1; }
    .legendrow { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11.5px; color: var(--muted); }
    .legendrow i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
    .fingrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
    .fin { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
    .fin > span:first-child { display: flex; align-items: center; color: var(--ink-2); }
    .grp dt { color: var(--ink-2); } .grp dd { margin: 0; text-align: right; white-space: nowrap; }
    .parts { display: grid; gap: 6px; padding-top: 4px; }
    .parts div { display: grid; grid-template-columns: 1fr 90px 28px; gap: 8px; align-items: center; font-size: 12.5px; }
    .parts .bar { width: 100%; } .parts b { text-align: right; }
    .note { margin: 0; background: var(--warn-bg); color: var(--note-fg); border-radius: 12px; padding: 9px 12px; font-size: 12.5px; }
    .code { margin: 0; font-size: 12px; color: var(--faint); }
    .close { border: 0; background: var(--surface-3); width: 32px; height: 32px; border-radius: 10px; font-size: 20px; line-height: 1; cursor: pointer; color: var(--ink-2); flex: none; }
    .close:hover { background: var(--track); } .close:focus-visible { outline: 2px solid var(--brand-2); }

    /* ---- settings drawer ---- */
    .backdrop { position: fixed; inset: 0; background: rgba(10, 25, 18, .35); z-index: 40; animation: fade .15s ease-out; }
    .drawer { position: fixed; top: 0; left: 0; bottom: 0; width: min(420px, 100vw); z-index: 41; background: var(--surface); display: flex; flex-direction: column; box-shadow: 12px 0 40px rgba(0,0,0,.2); animation: slide .2s ease-out; }
    @keyframes slide { from { transform: translateX(-24px); opacity: 0; } }
    @keyframes fade { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .drawer, .backdrop { animation: none; } }
    .drawer-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 18px 20px 12px; border-bottom: 1px solid var(--line); }
    .drawer-head small { color: var(--muted); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
    .drawer-head h2 { margin: 2px 0 0; font-size: 19px; }
    .drawer-body { overflow-y: auto; padding: 6px 20px 20px; flex: 1; }
    .drawer-body h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 18px 0 8px; display: flex; align-items: center; gap: 4px; color: var(--ink-2); }
    .drawer-body h3 small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--faint); }
    .drawer-foot { display: flex; justify-content: space-between; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--line); }
    .filter { display: grid; grid-template-columns: 1fr auto auto 38px; align-items: center; gap: 6px 8px; padding: 9px 0; border-bottom: 1px solid var(--row-line); }
    .filter.off .ftitle span { color: var(--faint); }
    .ftitle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .fval { display: inline-flex; align-items: center; gap: 4px; }
    .fval i { font-style: normal; color: var(--muted); }
    .fval input { width: 84px; font: inherit; padding: 5px 8px; border: 1px solid var(--input-line); border-radius: 8px; box-sizing: border-box; text-align: right; background: var(--input-bg); color: var(--ink); }
    .fval input:focus { outline: 2px solid var(--brand-2); outline-offset: 0; border-color: transparent; }
    .fval input:disabled { opacity: .45; }
    .fcount { color: var(--bad); font-size: 12px; font-weight: 600; text-align: right; }
    .weight { display: grid; grid-template-columns: 1fr 120px 18px; align-items: center; gap: 10px; padding: 6px 0; }
    .weight span { display: flex; align-items: center; }
    .weight output { text-align: right; font-weight: 650; color: var(--brand); }
    input[type='range'] { -webkit-appearance: none; appearance: none; height: 6px; border-radius: 99px; background: linear-gradient(90deg, var(--brand-2) var(--p), var(--track) var(--p)); cursor: pointer; }
    input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 2px solid var(--brand-2); box-shadow: 0 1px 3px rgba(0,0,0,.2); }
    input[type='range']::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 2px solid var(--brand-2); }
    input[type='range']:focus-visible { outline: 2px solid var(--brand-2); outline-offset: 4px; }

    /* toggle switch (still a native checkbox for keyboard and screen readers) */
    .switch { -webkit-appearance: none; appearance: none; flex: none; width: 34px; height: 20px; margin: 0; border-radius: 99px; background: var(--switch-off); position: relative; cursor: pointer; transition: background .15s; }
    .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s; }
    .switch:checked { background: var(--brand-2); }
    .switch:checked::after { transform: translateX(14px); }
    .switch:focus-visible { outline: 2px solid var(--brand-2); outline-offset: 2px; }
    .switchlabel { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--muted); }

    /* ---- footer ---- */
    footer { padding: 14px 18px; color: var(--muted); font-size: 12.5px; }
    footer p { margin: 0 0 8px; } footer .small { color: var(--faint); margin: 8px 0 0; }
    footer summary { cursor: pointer; font-weight: 600; color: var(--ink-2); }
    footer a { color: var(--brand-2); }
    .error { padding: 20px; color: var(--bad); }

    @media (max-width: 1150px) {
      .layout.has-detail .mapcard.full { right: 0; }
      .layout.has-detail { grid-template-columns: minmax(0, 1fr); }
      .sidenav { position: fixed; right: 0; top: 0; height: 100vh; width: min(400px, 100vw); z-index: 35; }
    }
    @media (max-width: 720px) {
      main { padding: 12px; }
      .summary { flex-direction: column; }
      header { padding: 10px 12px; }
    }
  `;
}
