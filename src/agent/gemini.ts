/**
 * Gemini reasoner (Google Generative Language API, free tier friendly).
 *
 * Two things this does that the free tier makes necessary:
 *
 *  1. **Structured output.** `responseMimeType: application/json` plus a
 *     `responseSchema` means the model returns parseable JSON instead of prose
 *     wrapped in a code fence. Fewer retries matters when you get ~10 requests
 *     per minute.
 *
 *  2. **429 backoff.** The free tier rate-limits aggressively. A rate-limited
 *     planner must degrade to the heuristic reasoner, never to "spend blindly"
 *     — see the fallback wiring in Planner.
 *
 * The planner is called once per plan, not once per request, so a handful of
 * calls per minute is comfortably enough for a demo.
 */

import {
  applyScores,
  buildCatalogue,
  buildRankingPrompt,
  extractScores,
  type RankedOption,
  type Reasoner,
  type ToolOption,
} from './planner.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/** Matches the shape `applyScores` expects, enforced by the API rather than hoped for. */
const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      providerId: { type: 'STRING' },
      value: { type: 'NUMBER' },
      rationale: { type: 'STRING' },
    },
    required: ['providerId', 'value', 'rationale'],
  },
} as const;

export interface GeminiReasonerOptions {
  readonly apiKey: string;
  /**
   * Model id. Free-tier availability changes; run `npm run check:gemini` to
   * list what this key can actually reach rather than guessing.
   */
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export class GeminiReasoner implements Reasoner {
  readonly name = 'gemini';
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GeminiReasonerOptions) {
    // An alias, not a pinned version. Google retires specific versions for new
    // keys while still listing them in ListModels, so a pinned default rots
    // silently; `-latest` tracks whatever is current. Pin via GEMINI_MODEL once
    // `npm run check:gemini` has confirmed a working id.
    this.model = opts.model ?? process.env['GEMINI_MODEL'] ?? 'gemini-flash-latest';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async rank(task: string, options: readonly ToolOption[]): Promise<RankedOption[]> {
    const prompt = buildRankingPrompt(task, buildCatalogue(options));

    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0, // reproducible plans matter more than variety here
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const json = await this.callWithBackoff(body);
    const text =
      json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '[]';

    // Structured output should give clean JSON; extractScores is the safety net
    // for the case where it comes back fenced or with a leading sentence.
    let scored = extractScores(text);
    if (scored.length === 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) scored = parsed;
      } catch {
        /* fall through to an all-zero ranking rather than throwing */
      }
    }

    return applyScores(options, scored);
  }

  /** List models this key can reach. Used by the preflight script. */
  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(`${API_ROOT}/models`, {
      headers: { 'x-goog-api-key': this.opts.apiKey },
    });
    if (!res.ok) {
      throw new Error(`Gemini ListModels returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  private async callWithBackoff(body: unknown): Promise<GeminiResponse> {
    let lastError = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(
          `${API_ROOT}/models/${this.model}:generateContent`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': this.opts.apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );

        if (res.ok) return (await res.json()) as GeminiResponse;

        const text = (await res.text()).slice(0, 300);
        lastError = `${res.status}: ${text}`;

        // 429 = free-tier rate limit, 5xx = transient. Both are worth retrying.
        if (res.status === 429 || res.status >= 500) {
          if (attempt < this.maxRetries) {
            await sleep(2 ** attempt * 1_000 + Math.random() * 500);
            continue;
          }
        }

        if (res.status === 404) {
          throw new Error(
            `Gemini model "${this.model}" not found for this key (${lastError}). ` +
              `Run \`npm run check:gemini\` to list available models, then set GEMINI_MODEL.`,
          );
        }
        throw new Error(`Gemini API returned ${lastError}`);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          lastError = `timed out after ${this.timeoutMs}ms`;
          if (attempt < this.maxRetries) continue;
        }
        throw e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`Gemini API failed after ${this.maxRetries + 1} attempts — ${lastError}`);
  }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
