import { LitElement, css, html, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Plan } from '../ai/plan';
import {
  DEFAULT_SETTINGS, assistant, loadSettings, nanoAvailability, saveSettings, type AiSettings, type NanoState,
} from '../ai/providers';

/** What the chat needs from the app: apply a plan, then describe the communes it now shows. */
export interface ChatHost {
  applyPlan(plan: Plan): { applied: string[]; dropped: string[] };
  facts(context: string): { count: number; text: string; communes: Commune[] };
  /** Open a commune's side panel and fly the map to it. */
  openCommune(code: string): void;
}

export interface Commune {
  code: string;
  nom: string;
  /** Listing-site links built by the app (see links.ts). */
  ads?: { label: string; url: string }[];
}

interface Msg {
  role: 'user' | 'assistant' | 'error';
  text: string;
  chips?: string[];
  /** Communes the model was told about: their names in the answer become links. */
  communes?: Commune[];
  /** Web pages a web-search answer is based on. */
  sources?: { url: string; domain: string }[];
}

const EXAMPLES = [
  'Hide suburbs with more than 1 risk flag',
  'Where can I buy a house under $800k within 15 km of the CBD?',
  'I want a green, hilly suburb with low crime and no bushfire risk',
];

/**
 * Model output is untrusted: Markdown -> HTML, then sanitized. Only formatting tags survive
 * (no scripts, styles, images, iframes or forms); links open in a new tab.
 */
function renderMarkdown(text: string, communes: Commune[] = []) {
  // The model writes {{listings:CODE}}; the app swaps in links it builds itself, only for suburbs it sent.
  const byCode = new Map(communes.map((c) => [c.code, c]));
  const withAds = text.replace(/\{\{\s*(?:listings|annonces)\s*:\s*(\d{5})\s*\}\}/gi, (_, code: string) => {
    const c = byCode.get(code.toUpperCase());
    return c?.ads?.length ? `leboncoin : ${c.ads.map((a) => `[${a.label}](${a.url})`).join(' · ')}` : '';
  });
  const raw = marked.parse(withAds, { async: false, gfm: true, breaks: true }) as string;
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'h3', 'h4', 'h5', 'blockquote', 'code', 'pre', 'hr', 'a', 'del'],
    ALLOWED_ATTR: ['href', 'align'],
    ALLOWED_URI_REGEXP: /^https:\/\//i,
  });
  const box = document.createElement('div');
  box.innerHTML = clean;
  box.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  linkCommunes(box, communes);
  // h1/h2 are not in the allowed list: their text is kept as plain paragraphs, too big for a chat bubble otherwise.
  return unsafeHTML(box.innerHTML);
}

/**
 * Turn each name of a commune the model was given into a link that opens its panel. Works on
 * text nodes of the already-sanitized answer, so no model text ever becomes markup. Longest
 * names first, so "Port Noarlunga South" is not split by "Port Noarlunga".
 */
function linkCommunes(root: HTMLElement, communes: Commune[]) {
  if (!communes.length) return;
  const byName = new Map<string, string>();
  for (const c of communes) if (c.nom.length >= 3 && !byName.has(c.nom)) byName.set(c.nom, c.code);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}-])(${names.map(esc).join('|')})(?![\\p{L}\\p{N}-])`, 'gu');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest('a, code, pre'))) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const s = node.data;
    re.lastIndex = 0;
    if (!re.test(s)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of s.matchAll(re)) {
      frag.append(s.slice(last, m.index));
      const a = document.createElement('a');
      a.className = 'commune';
      a.href = '#';
      a.dataset.code = byName.get(m[1])!;
      a.title = 'Open the suburb panel';
      a.textContent = m[1];
      frag.append(a);
      last = m.index! + m[1].length;
    }
    frag.append(s.slice(last));
    node.replaceWith(frag);
  }
}

@customElement('ai-chat')
export class AiChat extends LitElement {
  @property({ attribute: false }) host!: ChatHost;
  @state() private open = false;
  @state() private settingsOpen = false;
  @state() private settings: AiSettings = loadSettings();
  @state() private nano: NanoState | null = null;
  @state() private busy = '';
  @state() private progress: number | null = null;
  @state() private msgs: Msg[] = [];
  @state() private draft = '';
  /** Docked as a full-height panel on the left of the page (remembered in this browser). */
  @property({ type: Boolean, reflect: true }) docked = false;
  @state() private width = 380;
  private abort?: AbortController;

  connectedCallback() {
    super.connectedCallback();
    nanoAvailability().then((s) => (this.nano = s));
    try {
      const d = JSON.parse(localStorage.getItem('lsau-chat-dock') ?? '{}');
      if (typeof d.width === 'number') this.width = d.width;
      if (d.docked) { this.open = true; this.setDocked(true); }
    } catch { /* ignore */ }
  }

  updated() {
    // Docked layout only while the panel is open: closed, the button returns to the bottom left.
    this.toggleAttribute('dock-open', this.open && this.docked);
  }

  private onAnswerClick(e: Event) {
    const a = (e.target as HTMLElement).closest('a.commune') as HTMLElement | null;
    if (!a?.dataset.code) return;
    e.preventDefault();
    this.host.openCommune(a.dataset.code);
  }

  /** Tell the app how much room the docked panel takes, so the page moves right. */
  private emitDock() {
    this.dispatchEvent(new CustomEvent('chat-dock', { detail: { width: this.open && this.docked ? this.width : 0 }, bubbles: true, composed: true }));
    localStorage.setItem('lsau-chat-dock', JSON.stringify({ docked: this.docked, width: this.width }));
  }

  private setDocked(on: boolean) {
    this.docked = on;
    this.style.setProperty('--chat-w', `${this.width}px`);
    this.emitDock();
  }

  private setOpen(on: boolean) {
    this.open = on;
    this.emitDock();
  }

  private startResize(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      this.width = Math.round(Math.min(Math.max(ev.clientX, 300), Math.min(900, window.innerWidth - 420)));
      this.style.setProperty('--chat-w', `${this.width}px`);
      this.emitDock();
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  private get ready(): boolean {
    if (this.settings.provider === 'bedrock') return !!this.settings.bedrockKey;
    return this.nano === 'available' || this.nano === 'downloadable' || this.nano === 'downloading';
  }

  private async send(text = this.draft.trim()) {
    if (!text || this.busy) return;
    this.draft = '';
    this.msgs = [...this.msgs, { role: 'user', text }];
    this.abort = new AbortController();
    const a = assistant(this.settings, (p) => (this.progress = p));
    const t0 = performance.now();
    try {
      this.busy = 'Je comprends la demande…';
      const before = this.history();
      const plan = await a.plan(before ? `Previous exchange:\n${before}\n\nNew request: ${text}` : text, this.abort.signal);
      const { applied, dropped } = this.host.applyPlan(plan);
      const chips = [...applied, ...dropped.map((d) => `ignored: ${d}`)];
      if (plan.mode === 'answer') {
        this.busy = 'Writing the answer…';
        const prev = this.history();
        const { count, text: facts, communes } = this.host.facts(`${text} ${prev}`);
        const question = prev ? `Previous exchange:\n${prev}\n\nNew question: ${text}` : text;
        // Route: questions the data cannot answer (news, local life…) go to the web-search model.
        if (plan.web_search && a.webAnswer) {
          this.busy = 'Je cherche sur le web…';
          const web = await a.webAnswer(question, facts, this.abort.signal);
          this.msgs = [...this.msgs, { role: 'assistant', text: web.text, chips: [...chips, '🌐 web search'], communes, sources: web.sources }];
        } else {
          const answer = count ? await a.answer(question, facts, this.abort.signal) : 'No suburb passes all these criteria. Remove a filter (the × on the labels at the top) to widen the search.';
          const note = plan.web_search ? '\n\n_This question needs a web search: turn it on in the settings ⚙ (Amazon Bedrock)._' : '';
          this.msgs = [...this.msgs, { role: 'assistant', text: `${answer}\n\n${count} suburbs pass.${note}`, chips, communes }];
        }
      } else {
        this.msgs = [...this.msgs, { role: 'assistant', text: plan.summary || 'Done.', chips }];
      }
      console.info(`[ai] ${this.settings.provider} ${(performance.now() - t0).toFixed(0)} ms`, plan);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.msgs = [...this.msgs, { role: 'error', text: (e as Error).message }];
    } finally {
      this.busy = '';
      this.progress = null;
    }
  }

  /** The previous question and answer, so a follow-up ("what is that risk?") keeps its context. */
  private history(): string {
    const done = this.msgs.slice(0, -1).filter((m) => m.role !== 'error');
    return done.slice(-2).map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.text}`).join('\n');
  }

  private saveSettings(e: Event) {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    this.settings = {
      provider: f.get('provider') === 'bedrock' ? 'bedrock' : 'nano',
      bedrockKey: String(f.get('key') ?? '').trim(),
      bedrockRegion: String(f.get('region') ?? '').trim() || DEFAULT_SETTINGS.bedrockRegion,
      bedrockModel: String(f.get('model') ?? '').trim() || DEFAULT_SETTINGS.bedrockModel,
      webSearch: f.get('web') === 'on',
      webModel: String(f.get('webmodel') ?? '').trim() || DEFAULT_SETTINGS.webModel,
    };
    saveSettings(this.settings);
    this.settingsOpen = false;
    this.draftProvider = this.draftWeb = null;
  }

  private nanoText(): string {
    switch (this.nano) {
      case 'available': return 'Gemini Nano is ready, on your device.';
      case 'downloadable': return 'Chrome will download Gemini Nano at the first question (several GB, once).';
      case 'downloading': return 'Chrome is downloading Gemini Nano…';
      case 'unavailable': return 'Gemini Nano is not available on this device (memory, disk space or language).';
      case 'unsupported': return 'This browser has no built-in model: it needs desktop Chrome (version 148 or later). You can use an Amazon Bedrock key in the settings.';
      default: return 'Checking the model…';
    }
  }

  render() {
    if (!this.open) {
      return html`<button class="fab" @click=${() => this.setOpen(true)} aria-label="Open the assistant">✦ Assistant</button>`;
    }
    const s = this.settings;
    return html`
      <section class="panel" role="dialog" aria-label="Assistant">
        <header>
          <b>✦ Assistant</b>
          <small title=${s.provider === 'bedrock' ? s.bedrockModel : ''}>${s.provider === 'bedrock' ? `Bedrock · ${s.bedrockModel.replace(/^(us|eu|apac|global)\./, '').replace(/^anthropic\./, '')}` : 'Gemini Nano (local)'}</small>
          <span class="grow"></span>
          <button class="icon dock" title=${this.docked ? 'Undock (floating window)' : 'Dock to the left of the page'}
            aria-pressed=${this.docked ? 'true' : 'false'} aria-label=${this.docked ? 'Undock the assistant' : 'Dock the assistant to the left'}
            @click=${() => this.setDocked(!this.docked)}>
            <svg viewBox="0 0 20 20" aria-hidden="true">${this.docked
              ? svg`<rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="9" y="9" width="6" height="5" rx="1" fill="currentColor"/>`
              : svg`<rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="5" width="5" height="10" fill="currentColor"/>`}</svg>
          </button>
          <button class="icon" title="Settings" aria-label="Assistant settings" @click=${() => (this.settingsOpen = !this.settingsOpen)}>⚙</button>
          <button class="icon" title="Close" aria-label="Close the assistant" @click=${() => this.setOpen(false)}>×</button>
        </header>
        ${this.docked ? html`<div class="resize" role="separator" aria-orientation="vertical" aria-label="Resize the assistant"
          title="Drag to change the width" @pointerdown=${(e: PointerEvent) => this.startResize(e)}></div>` : nothing}
        ${this.settingsOpen ? this.renderSettings() : nothing}
        <div class="log" aria-live="polite" ?hidden=${this.settingsOpen}>
          ${this.msgs.length ? nothing : html`
            <p class="muted">${s.provider === 'nano' ? this.nanoText() : 'Questions are sent to Amazon Bedrock with your key.'}</p>
            <p class="muted">Describe what you are looking for, or ask for a change to the map. Examples:</p>
            ${EXAMPLES.map((e) => html`<button class="ex" @click=${() => this.send(e)} ?disabled=${!this.ready}>${e}</button>`)}`}
          ${this.msgs.map((m) => html`
            <div class="msg ${m.role}">
              ${m.role === 'assistant' ? html`<div class="md" @click=${(e: Event) => this.onAnswerClick(e)}>${renderMarkdown(m.text, m.communes)}</div>` : html`<p>${m.text}</p>`}
              ${m.sources?.length ? html`<div class="sources">Sources: ${m.sources.map((s, i) => html`${i ? ' · ' : ''}<a href=${s.url} target="_blank" rel="noopener noreferrer" title=${s.url}>${s.domain}</a>`)}</div>` : nothing}
              ${m.chips?.length ? html`<div class="chips">${m.chips.map((c) => html`<span>${c}</span>`)}</div>` : nothing}
            </div>`)}
          ${this.busy ? html`<div class="msg assistant busy"><span class="spinner"></span> ${this.busy}
            ${this.progress !== null && this.progress < 1 ? html` (downloading the model ${Math.round(this.progress * 100)} %)` : nothing}
            <button class="link" @click=${() => this.abort?.abort()}>Stop</button></div>` : nothing}
        </div>
        <form class="ask" ?hidden=${this.settingsOpen} @submit=${(e: Event) => { e.preventDefault(); this.send(); }}>
          <textarea rows="2" placeholder=${this.ready ? 'Your request…' : 'Assistant unavailable: see the settings ⚙'}
            .value=${this.draft} ?disabled=${!this.ready || !!this.busy}
            @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }}></textarea>
          <button class="send" type="submit" ?disabled=${!this.ready || !!this.busy || !this.draft.trim()}>Send</button>
        </form>
      </section>`;
  }

  /** Choices being edited in the settings form, so the form shows only what applies. */
  @state() private draftProvider: AiSettings['provider'] | null = null;
  @state() private draftWeb: boolean | null = null;

  private renderSettings() {
    const s = this.settings;
    const provider = this.draftProvider ?? s.provider;
    const web = this.draftWeb ?? s.webSearch;
    const bedrock = provider === 'bedrock';
    return html`
      <form class="settings" @submit=${(e: Event) => this.saveSettings(e)}>
        <section>
          <h4>Assistant model</h4>
          <div class="choices" role="radiogroup">
            <label class="choice ${!bedrock ? 'on' : ''}">
              <input type="radio" name="provider" value="nano" ?checked=${!bedrock} @change=${() => (this.draftProvider = 'nano')}>
              <span><b>Gemini Nano, in Chrome</b><small>Local and free: nothing leaves the computer. Short requests.</small></span>
            </label>
            <label class="choice ${bedrock ? 'on' : ''}">
              <input type="radio" name="provider" value="bedrock" ?checked=${bedrock} @change=${() => (this.draftProvider = 'bedrock')}>
              <span><b>Amazon Bedrock</b><small>With your API key. Better for long requests, and can search the web.</small></span>
            </label>
          </div>
        </section>

        <section ?hidden=${!bedrock}>
          <h4>Bedrock connection</h4>
          <label class="field">API key<input name="key" type="password" autocomplete="off" .value=${s.bedrockKey} placeholder="ABSK…"></label>
          <div class="row">
            <label class="field narrow">Region<input name="region" .value=${s.bedrockRegion}></label>
            <label class="field">Model (criteria and answers)<input name="model" .value=${s.bedrockModel} placeholder=${DEFAULT_SETTINGS.bedrockModel}></label>
          </div>
          <p class="hint">The key stays in this browser, is only sent to Amazon Bedrock and never appears in the share link. Prefer a short-term key limited to Bedrock.</p>
        </section>

        <section ?hidden=${!bedrock}>
          <h4>Recherche web</h4>
          <label class="toggle">
            <input type="checkbox" name="web" ?checked=${web} @change=${(e: Event) => (this.draftWeb = (e.target as HTMLInputElement).checked)}>
            <span>Search the web when the data is not enough <small>(news, projects, schools, local life…)</small></span>
          </label>
          <label class="field" ?hidden=${!web}>Search model (Amazon Nova, US regions only)
            <input name="webmodel" .value=${s.webModel} placeholder=${DEFAULT_SETTINGS.webModel}></label>
        </section>

        <div class="row end">
          ${s.bedrockKey && bedrock ? html`<button type="button" class="link" @click=${() => { this.settings = { ...s, bedrockKey: '', provider: 'nano' }; this.draftProvider = null; saveSettings(this.settings); }}>Clear the key</button>` : nothing}
          <button type="button" class="link" @click=${() => { this.settingsOpen = false; this.draftProvider = this.draftWeb = null; }}>Cancel</button>
          <button type="submit" class="send">Save</button>
        </div>
      </form>`;
  }

  static styles = css`
    :host { position: fixed; left: 18px; bottom: 18px; z-index: 55; font: inherit; color: var(--ink); }
    :host([dock-open]) { left: 0; top: var(--header-h, 56px); bottom: 0; width: var(--chat-w, 380px); z-index: 27; }
    :host([dock-open]) .panel { width: 100%; height: 100%; border-radius: 0; border-width: 0 1px 0 0; box-shadow: 8px 0 24px rgba(16,32,24,.06); position: relative; }
    .resize { position: absolute; top: 0; right: -4px; width: 8px; height: 100%; cursor: col-resize; z-index: 2; touch-action: none; }
    .resize:hover, .resize:active { background: linear-gradient(90deg, transparent 3px, var(--brand-2) 3px, var(--brand-2) 5px, transparent 5px); }
    .icon svg { width: 17px; height: 17px; vertical-align: -3px; }
    .icon[aria-pressed='true'] { color: var(--brand-2); }
    @media (max-width: 900px) { .dock { display: none; } :host([dock-open]) { width: 100vw; } }
    .fab { border: 0; border-radius: 999px; padding: 11px 18px; font: inherit; font-weight: 650; cursor: pointer;
      background: var(--brand); color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.22); }
    .panel { width: min(420px, calc(100vw - 36px)); height: min(620px, calc(100vh - 110px)); display: flex; flex-direction: column;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.25); overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    header b { white-space: nowrap; }
    header small { color: var(--muted); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow { flex: 1; }
    .icon { border: 0; background: transparent; color: var(--muted); font-size: 18px; cursor: pointer; width: 30px; height: 30px; border-radius: 8px; }
    .icon:hover { background: var(--surface-2); color: var(--ink); }
    .log { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .muted { color: var(--muted); font-size: 13px; margin: 0; }
    .small { font-size: 12px; }
    .ex { text-align: left; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; cursor: pointer; }
    .ex:disabled { opacity: .5; cursor: default; }
    .msg { border-radius: 12px; padding: 9px 11px; font-size: 13.5px; line-height: 1.5; max-width: 92%; }
    .msg p { margin: 0; white-space: pre-wrap; }
    .md { overflow-x: auto; }
    .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
    .md p { white-space: normal; margin: 0 0 8px; }
    .md ul, .md ol { margin: 4px 0 8px; padding-left: 20px; } .md li { margin: 2px 0; }
    .md h3, .md h4, .md h5 { font-size: 13.5px; margin: 10px 0 4px; }
    .md table { border-collapse: collapse; font-size: 12.5px; margin: 6px 0 8px; width: 100%; }
    .md th, .md td { border-bottom: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
    .md th { color: var(--muted); font-weight: 650; }
    .md code { font-size: 12px; background: var(--surface); padding: 1px 4px; border-radius: 4px; }
    .md blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
    .md a { color: var(--brand-2); }
    .md a.commune { font-weight: 600; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; cursor: pointer; }
    .md a.commune:hover { text-decoration-style: solid; }
    .msg.user { align-self: flex-end; background: var(--brand); color: #fff; }
    .msg.assistant { align-self: flex-start; background: var(--surface-2); }
    .msg.error { align-self: flex-start; background: var(--bad-bg); color: var(--bad); }
    .msg.busy { display: flex; align-items: center; gap: 8px; color: var(--muted); flex-wrap: wrap; }
    .sources { margin-top: 7px; font-size: 12px; color: var(--muted); }
    .sources a { color: var(--brand-2); }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
    .chips span { font-size: 11.5px; background: var(--brand-soft); color: var(--brand-2); border-radius: 999px; padding: 2px 8px; }
    .ask { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
    textarea { flex: 1; resize: none; font: inherit; font-size: 13.5px; border: 1px solid var(--input-line, var(--line)); border-radius: 10px; padding: 8px; background: var(--input-bg, var(--surface)); color: var(--ink); box-sizing: border-box; }
    .send { border: 0; border-radius: 10px; padding: 0 14px; font: inherit; font-weight: 650; background: var(--brand); color: #fff; cursor: pointer; min-height: 36px; }
    .send:disabled { opacity: .45; cursor: default; }
    .link { border: 0; background: transparent; color: var(--brand-2); font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: underline; }
    [hidden] { display: none !important; }
    /* Settings replace the conversation while open; the buttons stay visible at the bottom. */
    .settings { flex: 1; min-height: 0; overflow: auto; padding: 12px 12px 0; display: flex; flex-direction: column; gap: 12px; background: var(--surface-2); font-size: 13px; }
    .settings > .row.end { position: sticky; bottom: 0; margin: auto -12px 0; padding: 10px 12px; background: var(--surface-2); border-top: 1px solid var(--line); }
    .settings section { display: flex; flex-direction: column; gap: 8px; }
    .settings section + section { border-top: 1px solid var(--line); padding-top: 12px; }
    .settings [hidden] { display: none !important; }
    .settings h4 { margin: 0; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-2); }
    .choices { display: flex; flex-direction: column; gap: 6px; }
    .choice { display: flex; gap: 9px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); cursor: pointer; }
    .choice.on { border-color: var(--brand-2); background: var(--brand-soft); }
    .choice input { margin: 2px 0 0; accent-color: var(--brand-2); flex: none; }
    .choice span, .toggle span { display: flex; flex-direction: column; gap: 1px; line-height: 1.35; }
    .choice small, .toggle small { color: var(--muted); font-size: 12px; }
    .toggle { display: flex; gap: 9px; align-items: flex-start; cursor: pointer; }
    .toggle input { margin: 2px 0 0; accent-color: var(--brand-2); flex: none; width: 15px; height: 15px; }
    .toggle span { display: block; }
    .field { display: flex; flex-direction: column; gap: 4px; color: var(--ink-2); font-size: 12.5px; font-weight: 600; min-width: 0; }
    .field input { font: inherit; font-weight: 400; font-size: 13px; padding: 6px 8px; border: 1px solid var(--input-line, var(--line)); border-radius: 8px; background: var(--input-bg, var(--surface)); color: var(--ink); width: 100%; box-sizing: border-box; }
    .hint { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
    .row { display: flex; gap: 8px; } .row > * { flex: 1; } .row > .narrow { flex: 0 0 34%; }
    .row.end { justify-content: flex-end; align-items: center; gap: 12px; } .row.end > * { flex: none; }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--brand-2); animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
}
