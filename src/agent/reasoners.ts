/**
 * Reasoner selection.
 *
 * Kept separate from planner.ts so the concrete reasoners can import shared
 * helpers from it without a cycle.
 */

import { ClaudeReasoner, HeuristicReasoner, type Reasoner } from './planner.js';
import { GeminiReasoner } from './gemini.js';

/**
 * Pick a reasoner from the environment.
 *
 * Order: Gemini, then Claude, then the deterministic heuristic. The heuristic
 * is not a degraded mode — it is what keeps `npm run bench` reproducible and
 * runnable with no credentials at all.
 */
export function defaultReasoner(): Reasoner {
  const gemini = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (gemini) {
    const model = process.env['GEMINI_MODEL'];
    return new GeminiReasoner({ apiKey: gemini, ...(model ? { model } : {}) });
  }

  const anthropic = process.env['ANTHROPIC_API_KEY'];
  if (anthropic) return new ClaudeReasoner({ apiKey: anthropic });

  return new HeuristicReasoner();
}

/**
 * The reasoner used when the primary one errors or is rate-limited.
 * Always deterministic and always available — a rate limit must never turn into
 * an unbudgeted decision.
 */
export function fallbackReasoner(): Reasoner {
  return new HeuristicReasoner();
}

export { GeminiReasoner, ClaudeReasoner, HeuristicReasoner };
export type { Reasoner };
