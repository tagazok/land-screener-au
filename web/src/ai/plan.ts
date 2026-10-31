// The assistant never touches the app directly. A model only produces a Plan
// (a small JSON object constrained by PLAN_SCHEMA); the app validates it and
// applies it with its own engine. Anything unknown is dropped, not guessed.

import { CATALOG_IDS, STRATEGY_IDS, STRATEGY_TEXT, describe, relevant, toStored } from './catalog';
import type { FilterDef } from '../engine';
import { COLUMNS, type StrategyId } from '../strategies';

export type PlanOp = 'min' | 'max' | 'is_true' | 'is_false';

export interface Plan {
  /** "answer": the user asked a question and wants a text answer; "action": just change the view. */
  mode: 'answer' | 'action';
  strategy: StrategyId | null;
  /** Council names or LGA codes to restrict to; null = keep; [] = all of Greater Adelaide. */
  councils: string[] | null;
  /** Remove the filters added earlier by the assistant before adding these. */
  reset_filters: boolean;
  filters: { column: string; op: PlanOp; value: number | null }[];
  /** Score groups to keep (A = best 20 %, E = worst 20 %); null = no change. */
  tiers: ('A' | 'B' | 'C' | 'D' | 'E')[] | null;
  color_by: string | null;
  bushfire_layer: boolean | null;
  relief_layer: boolean | null;
  /** One short sentence restating what was understood. */
  summary: string;
  /** The answer needs information that is not in the data (news, projects, local life…): search the web. */
  web_search: boolean;
}

export function planSchema(columns: string[] = CATALOG_IDS) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'strategy', 'councils', 'reset_filters', 'filters', 'tiers', 'color_by', 'bushfire_layer', 'relief_layer', 'summary', 'web_search'],
    properties: {
      mode: { type: 'string', enum: ['answer', 'action'] },
      strategy: { type: ['string', 'null'], enum: [...STRATEGY_IDS, null] },
      councils: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 20 },
      reset_filters: { type: 'boolean' },
      filters: {
        type: 'array', maxItems: 16,
        items: {
          type: 'object', additionalProperties: false, required: ['column', 'op', 'value'],
          properties: {
            column: { type: 'string', enum: columns },
            op: { type: 'string', enum: ['min', 'max', 'is_true', 'is_false'] },
            value: { type: ['number', 'null'] },
          },
        },
      },
      tiers: { type: ['array', 'null'], items: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] }, maxItems: 5 },
      color_by: { type: ['string', 'null'], enum: [...columns, null] },
      bushfire_layer: { type: ['boolean', 'null'] },
      relief_layer: { type: ['boolean', 'null'] },
      summary: { type: 'string', maxLength: 300 },
      web_search: { type: 'boolean' },
    },
  } as const;
}

export function systemPrompt(question: string, all: boolean): { text: string; columns: string[] } {
  const { entries, hints } = relevant(question, all);
  return {
    columns: entries.map((e) => e.id),
    text: `You drive an app that compares the 494 suburbs of Greater Adelaide, South Australia.
Turn the user's request into a JSON object that changes the view. Rules:
- filters: one condition per criterion. op "min" = at least, "max" = at most, "is_true"/"is_false" for yes/no (value null).
- Percentages are written as percentages: 5 means 5 %. Other values in the unit shown. Dollar amounts in Australian dollars (900000 = $900k).
- Use only the listed columns. Do not invent a criterion the user did not ask for.
- mode: "action" ONLY for a short command about the view (hide, show, keep, colour, exclude…). Otherwise "answer": a question, or a description of what the user is looking for ("I want", "I'm looking for", "a suburb…", "where…", "which…").
- strategy: ${STRATEGY_TEXT}. null if not mentioned; "live" for someone who wants to live there.
- councils: council names mentioned (e.g. "Unley", "Onkaparinga"), otherwise null.
- reset_filters: true if the request replaces the previous one, false if it adds to it.
- If the new request is a follow-up about the previous answer or about one suburb ("what is that risk?", "tell me about Stirling") with no new criterion: mode "answer", filters [], reset_filters false, everything else null.
- tiers: score groups to keep. Each passing suburb has an overall score and a group: A = best 20 %, then B, C, D, E = worst 20 %. "better than C" or "at least B" = ["A","B"]; "A or B" = ["A","B"]; "below C" = ["D","E"]. null if not mentioned.
- color_by: a column to colour the map if the user asks, otherwise null.
- bushfire_layer / relief_layer: true to show the bushfire areas / relief, false to hide them, otherwise null.
- summary: one sentence in English that restates what you understood.
- web_search: true ONLY if the answer needs information missing from the columns below: news, development projects, local life, events, schools by name, transport details, current listings or prices on websites, etc. (mode "answer"). false for everything the columns cover (prices, rents, risks, census, crime…).
Useful mappings:
${hints.map((h) => `- ${h}`).join('\n') || '- (none)'}
Available columns:
${describe(entries)}`,
  };
}

export interface Applied {
  filters: FilterDef[];
  dropped: string[];
}

/** Turn plan filters into engine filters; unknown columns or missing values are reported, not applied. */
export function planFilters(plan: Plan): Applied {
  const out: FilterDef[] = [];
  const dropped: string[] = [];
  for (const f of plan.filters ?? []) {
    const col = COLUMNS[f.column];
    if (!col) { dropped.push(f.column); continue; }
    const isBool = col.unit === 'bool';
    if (f.op === 'is_true' || f.op === 'is_false') {
      if (!isBool) { dropped.push(f.column); continue; }
      out.push({ id: `x:${f.column}:${f.op === 'is_true' ? 'isTrue' : 'isFalse'}`, column: f.column, op: f.op === 'is_true' ? 'isTrue' : 'isFalse', enabled: true });
      continue;
    }
    if (isBool || typeof f.value !== 'number' || !Number.isFinite(f.value)) { dropped.push(f.column); continue; }
    out.push({ id: `x:${f.column}:${f.op}`, column: f.column, op: f.op, value: toStored(f.column, f.value), enabled: true });
  }
  return { filters: out, dropped };
}

/** Parse a model's text output into a Plan (tolerates code fences). */
export function parsePlan(text: string): Plan {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('answer without JSON');
  const p = JSON.parse(m[0]) as Partial<Plan>;
  return {
    mode: p.mode === 'action' ? 'action' : 'answer',
    strategy: p.strategy && (STRATEGY_IDS as string[]).includes(p.strategy) ? p.strategy : null,
    councils: Array.isArray(p.councils) ? p.councils.map(String) : null,
    reset_filters: !!p.reset_filters,
    filters: Array.isArray(p.filters) ? p.filters : [],
    tiers: Array.isArray(p.tiers) ? p.tiers.filter((t) => ['A', 'B', 'C', 'D', 'E'].includes(t)) : null,
    color_by: p.color_by && p.color_by in COLUMNS ? p.color_by : null,
    bushfire_layer: typeof p.bushfire_layer === 'boolean' ? p.bushfire_layer : null,
    relief_layer: typeof p.relief_layer === 'boolean' ? p.relief_layer : null,
    summary: String(p.summary ?? ''),
    web_search: p.web_search === true,
  };
}

export const WEB_SYSTEM = `You are a property assistant for Adelaide. Answer in English, concisely (Markdown allowed: bold, lists, tables).
Search the web for the recent information you need. The app data below is reliable: use it first and do not contradict it.
Do not write web addresses in the text: sources are shown separately.`;

export const ANSWER_SYSTEM = `You are a property assistant for Adelaide. Answer in English, concisely.
You may use Markdown: **bold**, bulleted or numbered lists, and tables when comparing several suburbs or when the user asks for one. No level 1 or 2 headings.
Rely ONLY on the suburbs and figures provided: never invent a figure or a suburb.
Name 3 to 5 suburbs and explain why they fit, and mention one thing to watch if there is one.
If no suburb fits, say so and suggest which criterion to relax.
For a follow-up question about one suburb, answer precisely with its detail first (for example its list of risks), in 1 to 3 sentences.
Never write a web address yourself. If the user wants listings (houses for sale or rent) for a suburb, write exactly {{listings:CODE}} with its 5-digit suburb code: the app replaces it with the right links.`;
