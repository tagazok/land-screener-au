import { LitElement, css, html, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import mlcss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import { Protocol } from 'pmtiles';
import type { Tier } from '../engine';

export const TIER_COLORS: Record<Tier | 'fail', string> = {
  A: '#1a9850',
  B: '#91cf60',
  C: '#d9ef8b',
  D: '#fee08b',
  E: '#fc8d59',
  fail: '#9e9e9e',
};

/** What to draw for one commune: its fill colour and whether it is emphasised. */
export interface Paint {
  color: string;
  strong: boolean;
  /** Outside the chosen councils: not drawn and not clickable. */
  hidden?: boolean;
}

export type Bounds = [[number, number], [number, number]];

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const ADELAIDE: Bounds = [[138.43, -35.36], [139.05, -34.49]];
const SRC = 'communes';
const LAYER = 'communes'; // tippecanoe layer name

/** Shaded relief tiles (Esri World Hillshade, no key), drawn under the suburbs. */
const HILLSHADE = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Hillshade © <a href="https://www.esri.com/" target="_blank">Esri</a>',
};
/** Bushfire protection areas (Plan SA), drawn over the suburb colours. */
const BUSHFIRE_COLORS = ['match', ['get', 'level'], 'High', '#d7301f', 'Medium', '#fc8d59', '#fdcc8a'] as maplibregl.ExpressionSpecification;

// pmtiles:// URLs are read with HTTP range requests: only visible tiles are fetched.
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

@customElement('map-view')
export class MapView extends LitElement {
  static styles = [
    unsafeCSS(mlcss),
    css`
      :host { display: block; position: relative; }
      #map { position: absolute; inset: 0; }
      #map.dark .maplibregl-ctrl-attrib { background: rgba(22, 33, 28, .85); color: #9db0a6; }
      #map.dark .maplibregl-ctrl-attrib a { color: #c9d6cf; }
      #map.dark .maplibregl-ctrl-group { background: #16211c; box-shadow: 0 0 0 1px #25342d; }
      #map.dark .maplibregl-ctrl-group button + button { border-top-color: #25342d; }
      #map.dark .maplibregl-ctrl-group button span { filter: invert(1); }
    `,
  ];

  /** URL of the suburbs PMTiles file. */
  @property() tiles = '';
  /** URL of the bushfire protection areas GeoJSON. */
  @property() bushfire = '';
  @property({ attribute: false }) departements: GeoJSON.FeatureCollection | null = null;
  @property({ attribute: false }) paint: Map<string, Paint> = new Map();
  @property() selected: string | null = null;
  @property({ type: Boolean }) dark = false;
  /** When set, the map zooms to these bounds (e.g. the chosen councils). */
  @property({ attribute: false }) zoomTo: Bounds | null = null;
  /** Optional layers: bushfire areas (over the suburbs) and shaded relief (under them). */
  @property({ attribute: false }) overlays: { bushfire: boolean; relief: boolean } = { bushfire: false, relief: false };

  private map?: MlMap;
  private styleReady = false;
  private hovered: string | null = null;
  private resizeObs?: ResizeObserver;
  private lastSelected: string | null = null;
  /** Feature states already sent, so a repaint only touches communes whose colour changed. */
  private sent = new Map<string, string>();

  render() {
    return html`<div id="map" class=${this.dark ? 'dark' : ''} role="region" aria-label="Map of suburbs"></div>`;
  }

  firstUpdated() {
    const el = this.renderRoot.querySelector('#map') as HTMLElement;
    this.map = new maplibregl.Map({ container: el, style: this.dark ? STYLE_DARK : STYLE_LIGHT, bounds: this.zoomTo ?? ADELAIDE, fitBoundsOptions: { padding: 16 } });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    // Re-add our layers whenever the basemap style (light/dark) is (re)loaded.
    this.map.on('style.load', () => {
      this.styleReady = true;
      this.sent.clear();
      this.addData();
    });
    // The container can still be sizing itself on the first frame: fit again once the map is ready.
    this.map.once('load', () => this.map!.fitBounds(this.zoomTo ?? ADELAIDE, { padding: 16, animate: false }));
    this.map.on('mousemove', 'fill', (e) => {
      const f = e.features?.[0];
      const code = (f && !this.paint.get(f.properties?.code)?.hidden ? f.properties?.code : undefined) as string | undefined;
      if (code === this.hovered) return;
      this.setState(this.hovered, { hover: false });
      this.hovered = code ?? null;
      this.setState(code ?? null, { hover: true });
      this.map!.getCanvas().style.cursor = code ? 'pointer' : '';
    });
    this.map.on('mouseleave', 'fill', () => {
      this.setState(this.hovered, { hover: false });
      this.hovered = null;
      this.map!.getCanvas().style.cursor = '';
    });
    this.map.on('click', 'fill', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined;
      if (code && !this.paint.get(code)?.hidden) this.dispatchEvent(new CustomEvent('select', { detail: code, bubbles: true, composed: true }));
    });
    this.resizeObs = new ResizeObserver(() => this.map?.resize());
    this.resizeObs.observe(el);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObs?.disconnect();
  }

  private setState(code: string | null, state: Record<string, unknown>) {
    if (code && this.map?.getSource(SRC)) this.map.setFeatureState({ source: SRC, sourceLayer: LAYER, id: code }, state);
  }

  private addData() {
    const m = this.map;
    if (!m || !this.styleReady || !this.tiles || m.getSource(SRC)) return;
    const abs = new URL(this.tiles, location.href).href;
    m.addSource('relief', { type: 'raster', tiles: [HILLSHADE.url], tileSize: 256, maxzoom: 16, attribution: HILLSHADE.attribution });
    m.addLayer({ id: 'relief', type: 'raster', source: 'relief', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.5 } });
    m.addSource(SRC, { type: 'vector', url: `pmtiles://${abs}`, promoteId: { [LAYER]: 'code' } });
    m.addLayer({
      id: 'fill', type: 'fill', source: SRC, 'source-layer': LAYER,
      paint: {
        'fill-color': ['coalesce', ['feature-state', 'color'], TIER_COLORS.fail],
        'fill-opacity': this.fillOpacity(),
      },
    });
    m.addLayer({
      id: 'line', type: 'line', source: SRC, 'source-layer': LAYER, minzoom: 9,
      paint: { 'line-color': this.dark ? '#0b1410' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.2, 11, 0.8],
        'line-opacity': ['case', ['boolean', ['feature-state', 'hidden'], false], 0, 0.7] },
    });
    if (this.bushfire) {
      m.addSource('bushfire', { type: 'geojson', data: new URL(this.bushfire, location.href).href, attribution: 'Bushfire areas: Plan SA' });
      m.addLayer({ id: 'bushfire', type: 'fill', source: 'bushfire', layout: { visibility: 'none' },
        paint: { 'fill-color': BUSHFIRE_COLORS, 'fill-opacity': 0.5, 'fill-outline-color': BUSHFIRE_COLORS } });
    }
    if (this.departements) {
      m.addSource('dep', { type: 'geojson', data: this.departements });
      m.addLayer({
        id: 'dep-line', type: 'line', source: 'dep',
        paint: { 'line-color': this.dark ? '#c9d6cf' : '#2c3e36', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.6], 'line-opacity': 0.55 },
      });
    }
    m.addLayer({
      id: 'highlight', type: 'line', source: SRC, 'source-layer': LAYER,
      paint: {
        'line-color': this.dark ? '#ffffff' : '#0d2a1d',
        'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3,
          ['boolean', ['feature-state', 'hover'], false], 1.5, 0],
      },
    });
    this.applyOverlays();
    this.repaint();
  }

  /** Lighter suburb colours while a layer is shown, so it stays readable. */
  private fillOpacity(): maplibregl.ExpressionSpecification {
    const on = this.overlays.bushfire || this.overlays.relief;
    return ['case', ['boolean', ['feature-state', 'hidden'], false], 0,
      ['boolean', ['feature-state', 'strong'], false], on ? 0.45 : 0.82, on ? 0.08 : 0.25];
  }

  private applyOverlays() {
    const m = this.map;
    if (!m || !m.getLayer('fill')) return;
    for (const id of ['bushfire', 'relief'] as const) {
      if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', this.overlays[id] ? 'visible' : 'none');
    }
    m.setPaintProperty('fill', 'fill-opacity', this.fillOpacity());
  }

  private repaint() {
    const m = this.map;
    if (!m || !m.getSource(SRC)) return;
    for (const [code, p] of this.paint) {
      const key = `${p.color}${p.strong ? 1 : 0}${p.hidden ? 1 : 0}`;
      if (this.sent.get(code) === key) continue;
      this.sent.set(code, key);
      m.setFeatureState({ source: SRC, sourceLayer: LAYER, id: code }, { color: p.color, strong: p.strong, hidden: !!p.hidden });
    }
    if (this.lastSelected && this.lastSelected !== this.selected) this.setState(this.lastSelected, { selected: false });
    this.lastSelected = this.selected;
    if (this.selected) this.setState(this.selected, { selected: true });
  }

  flyTo(lon: number, lat: number) {
    this.map?.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 12) });
  }

  updated(changed: Map<string, unknown>) {
    if (!this.map) return;
    if (changed.has('dark') && changed.get('dark') !== undefined) {
      this.styleReady = false;
      // diff:false forces a full reload so 'style.load' fires and re-adds the suburbs.
      this.map.setStyle(this.dark ? STYLE_DARK : STYLE_LIGHT, { diff: false });
      return;
    }
    if (changed.has('tiles') || changed.has('departements')) this.addData();
    if (changed.has('paint') || changed.has('selected')) this.repaint();
    if (changed.has('overlays')) this.applyOverlays();
    if (changed.has('zoomTo') && changed.get('zoomTo') !== undefined) {
      this.map.fitBounds(this.zoomTo ?? ADELAIDE, { padding: 20, duration: 600 });
    }
  }
}
