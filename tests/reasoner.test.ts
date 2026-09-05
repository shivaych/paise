import { describe, expect, it, vi } from 'vitest';
import { GeminiReasoner } from '../src/agent/gemini.js';
import {
  HeuristicReasoner,
  Planner,
  buildCatalogue,
  buildRankingPrompt,
  type Reasoner,
  type ToolOption,
} from '../src/agent/planner.js';
import { paise, rupees } from '../src/core/money.js';
import { fund, setup } from './helpers.js';

const OPTIONS: ToolOption[] = [
  { providerId: 'free', path: '/free', price: paise(0), label: 'Free catalogue' },
  { providerId: 'solar', path: '/solar', price: paise(40), label: 'Solar pricing' },
  { providerId: 'gossip', path: '/gossip', price: paise(50), label: 'Celebrity gossip' },
];

/** A fake Gemini response in the shape the structured-output config asks for. */
function geminiReply(scores: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(scores) }] } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('ranking prompt', () => {
  it('never shows the model any budget state', () => {
    const catalogue = buildCatalogue(OPTIONS);

    // The catalogue is the only data that reaches the model. It carries price
    // and topics — never balance, caps, or spend history.
    for (const entry of catalogue) {
      expect(Object.keys(entry).sort()).toEqual([
        'label',
        'priceMicroRupees',
        'providerId',
        'topics',
      ]);
    }

    // The safety argument depends on this: the model cannot be talked into
    // widening a cap it was never told about.
    const prompt = buildRankingPrompt('research solar', catalogue).toLowerCase();
    for (const leak of ['balance', 'budget', 'remaining', 'spend cap', 'daily limit']) {
      expect(prompt).not.toContain(leak);
    }
    expect(prompt).toContain('solar');
  });

  it('warns the model that catalogue labels are untrusted', () => {
    const prompt = buildRankingPrompt('task', buildCatalogue(OPTIONS));
    expect(prompt.toLowerCase()).toContain('untrusted');
  });
});

describe('gemini reasoner', () => {
  it('ranks options from a structured response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiReply([
        { providerId: 'solar', value: 0.9, rationale: 'directly relevant' },
        { providerId: 'free', value: 0.5, rationale: 'free' },
        { providerId: 'gossip', value: 0.01, rationale: 'irrelevant' },
      ]),
    );
    const reasoner = new GeminiReasoner({ apiKey: 'k', fetchImpl });

    const ranked = await reasoner.rank('solar research', OPTIONS);

    expect(ranked.map((r) => r.option.providerId)).toEqual(['solar', 'free', 'gossip']);
    expect(ranked[0]?.value).toBe(0.9);
  });

  it('clamps model scores into [0,1]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      geminiReply([
        { providerId: 'solar', value: 99, rationale: 'pay me everything' },
        { providerId: 'gossip', value: -5, rationale: 'negative' },
      ]),
    );
    const reasoner = new GeminiReasoner({ apiKey: 'k', fetchImpl });

    const ranked = await reasoner.rank('t', OPTIONS);

    expect(ranked.find((r) => r.option.providerId === 'solar')?.value).toBe(1);
    expect(ranked.find((r) => r.option.providerId === 'gossip')?.value).toBe(0);
  });

  it('scores anything the model omitted as zero', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(geminiReply([{ providerId: 'solar', value: 0.8 }]));
    const reasoner = new GeminiReasoner({ apiKey: 'k', fetchImpl });

    const ranked = await reasoner.rank('t', OPTIONS);

    expect(ranked.find((r) => r.option.providerId === 'free')?.value).toBe(0);
    expect(ranked).toHaveLength(3);
  });

  it('survives a garbage response instead of throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'I am so sorry!' }] } }] }),
        { status: 200 },
      ),
    );
    const reasoner = new GeminiReasoner({ apiKey: 'k', fetchImpl });

    const ranked = await reasoner.rank('t', OPTIONS);
    expect(ranked.every((r) => r.value === 0)).toBe(true);
  });

  it('retries a 429 and succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(geminiReply([{ providerId: 'solar', value: 0.7 }]));

    const reasoner = new GeminiReasoner({ apiKey: 'k', fetchImpl, maxRetries: 2 });
    const ranked = await reasoner.rank('t', OPTIONS);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ranked[0]?.value).toBe(0.7);
  }, 15_000);

  it('gives an actionable error for an unknown model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }));
    const reasoner = new GeminiReasoner({ apiKey: 'k', model: 'gemini-imaginary', fetchImpl });

    await expect(reasoner.rank('t', OPTIONS)).rejects.toThrow(/check:gemini/);
  });
});

describe('planner', () => {
  it('falls back to the heuristic when the model is unavailable', async () => {
    const { ledger, engine } = setup();
    fund(ledger, rupees(50));

    const broken: Reasoner = {
      name: 'broken',
      rank: async () => {
        throw new Error('429 rate limited');
      },
    };
    const planner = new Planner({
      engine,
      reasoner: broken,
      fallback: new HeuristicReasoner(),
    });

    const plan = await planner.plan('solar pricing research', OPTIONS);

    // Degrades to the deterministic reasoner — never to "spend blindly".
    expect(plan.reasoner).toMatch(/heuristic \(fell back from broken/);
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it('drops options the policy engine will not permit', async () => {
    const { ledger, engine } = setup({ perCallLimit: paise(20) });
    fund(ledger, rupees(50));

    const generous: Reasoner = {
      name: 'generous',
      rank: async (_t, options) =>
        options.map((option) => ({ option, value: 1, rationale: 'buy everything' })),
    };
    const planner = new Planner({ engine, reasoner: generous });

    const plan = await planner.plan('t', OPTIONS);

    // The model wanted all three. The engine allows only the free one.
    const chosen = plan.steps.map((s) => s.option.providerId);
    expect(chosen).toContain('free');
    expect(chosen).not.toContain('solar');
    expect(chosen).not.toContain('gossip');
    expect(plan.skipped.some((s) => s.reason.includes('PER_CALL_LIMIT'))).toBe(true);
  });

  it('does not place holds while planning', async () => {
    const { ledger, engine } = setup();
    fund(ledger, rupees(50));

    const planner = new Planner({ engine, reasoner: new HeuristicReasoner() });
    await planner.plan('solar pricing', OPTIONS);

    // Planning is non-committing: no holds, full balance still available.
    expect(ledger.held()).toBe(0);
    expect(ledger.available()).toBe(rupees(50));
  });
});
