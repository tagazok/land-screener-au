// Two interchangeable model backends:
// - "nano": Chrome's built-in Gemini Nano (Prompt API). Runs on the device, no key, no network.
// - "bedrock": Amazon Bedrock Converse API, called straight from the browser with the
//   user's own Bedrock API key (kept in this browser's localStorage only).

import { ANSWER_SYSTEM, WEB_SYSTEM, parsePlan, planSchema, systemPrompt, type Plan } from './plan';

export type ProviderId = 'nano' | 'bedrock';

export interface AiSettings {
  provider: ProviderId;
  bedrockKey: string;
  bedrockRegion: string;
  bedrockModel: string;
  /** Answer with an Amazon Nova model and Bedrock Web Grounding when the question needs the web. */
  webSearch: boolean;
  webModel: string;
}

const KEY = 'lsau-ai';
export const DEFAULT_SETTINGS: AiSettings = {
  provider: 'nano', bedrockKey: '', bedrockRegion: 'us-east-1', bedrockModel: 'us.anthropic.claude-haiku-5-5',
  webSearch: true, webModel: 'us.amazon.nova-2-lite-v1:0',
};

export interface WebAnswer {
  text: string;
  sources: { url: string; domain: string }[];
}

export function loadSettings(): AiSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AiSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

// ------------------------------------------------------------------ Chrome built-in model
/* eslint-disable @typescript-eslint/no-explicit-any */
const LM = () => (globalThis as any).LanguageModel as any | undefined;
const NANO_LANG = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

export type NanoState = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

export async function nanoAvailability(): Promise<NanoState> {
  const lm = LM();
  if (!lm) return 'unsupported';
  try {
    return (await lm.availability(NANO_LANG)) as NanoState;
  } catch {
    return 'unavailable';
  }
}

async function nanoSession(system: string, onProgress?: (p: number) => void): Promise<any> {
  return LM().create({
    ...NANO_LANG,
    initialPrompts: [{ role: 'system', content: system }],
    monitor(m: any) { m.addEventListener('downloadprogress', (e: any) => onProgress?.(e.loaded)); },
  });
}

// ------------------------------------------------------------------ Bedrock
async function converse(s: AiSettings, body: object, signal?: AbortSignal, model = s.bedrockModel): Promise<any> {
  const url = `https://bedrock-runtime.${s.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.bedrockKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = r.headers.get('x-amzn-ErrorMessage') ?? (await r.text()).slice(0, 300);
    throw new Error(`Bedrock ${r.status} : ${msg}`);
  }
  return r.json();
}

// ------------------------------------------------------------------ public API
export interface Assistant {
  /** Turn a request into a Plan. */
  plan(question: string, signal?: AbortSignal): Promise<Plan>;
  /** Write a short answer from the question and the facts of the top communes. */
  answer(question: string, facts: string, signal?: AbortSignal): Promise<string>;
  /** Same, searching the web (Bedrock + Amazon Nova Web Grounding only); null when unavailable. */
  webAnswer: ((question: string, facts: string, signal?: AbortSignal) => Promise<WebAnswer>) | null;
}

/** Bedrock Web Grounding: Nova runs the searches itself and returns citations next to the text. */
async function novaWeb(s: AiSettings, question: string, facts: string, signal?: AbortSignal): Promise<WebAnswer> {
  const res = await converse(s, {
    system: [{ text: WEB_SYSTEM }],
    messages: [{ role: 'user', content: [{ text: `Request: ${question}\n\nApp data:\n${facts}` }] }],
    inferenceConfig: { maxTokens: 1500 },
    toolConfig: { tools: [{ systemTool: { name: 'nova_grounding' } }] },
  }, signal, s.webModel);
  const content: any[] = res.output?.message?.content ?? [];
  const sources = new Map<string, string>();
  for (const c of content) {
    for (const cit of c.citationsContent?.citations ?? []) {
      const w = cit.location?.web;
      if (typeof w?.url === 'string' && /^https:\/\//.test(w.url)) sources.set(w.url, w.domain ?? new URL(w.url).hostname);
    }
  }
  return {
    text: content.map((c) => c.text ?? '').join('').trim(),
    sources: [...sources].map(([url, domain]) => ({ url, domain })),
  };
}

export function assistant(s: AiSettings, onProgress?: (p: number) => void): Assistant {
  if (s.provider === 'bedrock') {
    return {
      async plan(question, signal) {
        const { text, columns } = systemPrompt(question, true);
        const call = (toolChoice: object) => converse(s, {
          system: [{ text: `${text}\nAlways answer by calling the apply_plan tool.` }],
          messages: [{ role: 'user', content: [{ text: question }] }],
          inferenceConfig: { maxTokens: 4000 },
          toolConfig: {
            tools: [{ toolSpec: { name: 'apply_plan', description: 'Applies the criteria to the map and the list of suburbs.', inputSchema: { json: planSchema(columns) } } }],
            toolChoice,
          },
        }, signal);
        // Forcing the tool is the most reliable, but models that reason first (e.g. Sonnet 5.5)
        // refuse it: fall back to letting the model choose, with the instruction above.
        let res;
        try {
          res = await call({ tool: { name: 'apply_plan' } });
        } catch (e) {
          if (!/tool_choice/.test((e as Error).message)) throw e;
          res = await call({ auto: {} });
        }
        const content = res.output?.message?.content ?? [];
        const use = content.find((c: any) => c.toolUse)?.toolUse;
        if (use) return parsePlan(JSON.stringify(use.input));
        const txt = content.map((c: any) => c.text ?? '').join('');
        if (/\{[\s\S]*\}/.test(txt)) return parsePlan(txt);
        throw new Error('Bedrock returned no criteria');
      },
      async answer(question, facts, signal) {
        const res = await converse(s, {
          system: [{ text: ANSWER_SYSTEM }],
          messages: [{ role: 'user', content: [{ text: `Request: ${question}\n\nPassing suburbs (best first):\n${facts}` }] }],
          inferenceConfig: { maxTokens: 3000 },
        }, signal);
        // Reasoning models also return a reasoningContent block: keep only the text.
        return res.output?.message?.content?.map((c: any) => c.text ?? '').join('').trim() ?? '';
      },
      webAnswer: s.webSearch ? (question, facts, signal) => novaWeb(s, question, facts, signal) : null,
    };
  }
  return {
    async plan(question, signal) {
      const { text, columns } = systemPrompt(question, false);
      const session = await nanoSession(text, onProgress);
      try {
        const out = await session.prompt(question, { responseConstraint: planSchema(columns), signal });
        return parsePlan(out);
      } finally {
        session.destroy();
      }
    },
    async answer(question, facts, signal) {
      const session = await nanoSession(ANSWER_SYSTEM, onProgress);
      try {
        return await session.prompt(`Request: ${question}\n\nPassing suburbs (best first):\n${facts}`, { signal });
      } finally {
        session.destroy();
      }
    },
    // Gemini Nano has no web access; web questions fall back to the data-only answer.
    webAnswer: null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
