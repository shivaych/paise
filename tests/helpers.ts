import { TestClock } from '../src/core/clock.js';
import { Ledger } from '../src/core/ledger.js';
import { PolicyEngine } from '../src/core/policy.js';
import { type Micros, rupees } from '../src/core/money.js';
import { createQuote } from '../src/x402/protocol.js';
import type { BudgetPolicy, Quote } from '../src/core/types.js';

export const AGENT = 'agent-under-test';

export function setup(overrides: Partial<BudgetPolicy> = {}) {
  const clock = new TestClock(new Date('2026-01-01T00:00:00Z'));
  const ledger = new Ledger(AGENT, clock);

  const policy: BudgetPolicy = {
    agentId: AGENT,
    caps: [
      { window: 'hour', limit: rupees(2) },
      { window: 'day', limit: rupees(20) },
    ],
    perCallLimit: rupees(1),
    quoteToleranceBps: 0,
    authorizationTtlMs: 30_000,
    ...overrides,
  };

  const engine = new PolicyEngine({ policy, ledger, clock });
  return { clock, ledger, engine, policy };
}

export function fund(ledger: Ledger, amount: Micros) {
  return ledger.credit({ kind: 'topup', amount, note: 'test fixture' });
}

export function quoteFor(
  clock: TestClock,
  amount: Micros,
  opts: { provider?: string; resource?: string; ttlMs?: number } = {},
): Quote {
  return createQuote({
    provider: opts.provider ?? 'provider-a',
    resource: opts.resource ?? '/data',
    amount,
    now: clock.now(),
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
}

/** Deterministic PRNG, so a failing fuzz run reproduces exactly. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
