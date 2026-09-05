import { describe, expect, it } from 'vitest';
import { HOUR } from '../src/core/clock.js';
import {
  AuthorizationExpiredError,
  BudgetExhaustedError,
  InsufficientFundsError,
  PerCallLimitError,
  ProviderLimitError,
  ProviderNotAllowedError,
  QuoteExceededError,
  QuoteExpiredError,
  ReplayDetectedError,
  UnquotedChargeError,
  isPaiseError,
} from '../src/core/errors.js';
import { paise, rupees, scale } from '../src/core/money.js';
import { fund, lcg, quoteFor, setup } from './helpers.js';

describe('policy engine — the happy path', () => {
  it('authorizes, settles, and records a receipt', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(40));
    const auth = engine.authorize(quote);

    expect(ledger.held()).toBe(paise(40));
    expect(ledger.available()).toBe(rupees(50) - paise(40));

    const receipt = engine.settle({
      authId: auth.authId,
      quoteId: quote.quoteId,
      amount: paise(40),
    });

    expect(receipt.settledAmount).toBe(paise(40));
    expect(ledger.totalSpent()).toBe(paise(40));
    expect(ledger.held()).toBe(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it('evaluates without committing anything', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const verdict = engine.evaluate(quoteFor(clock, paise(40)));

    expect(verdict.ok).toBe(true);
    expect(ledger.held()).toBe(0); // no hold placed
    expect(ledger.available()).toBe(rupees(50));
  });

  it('releases an abandoned authorization', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const auth = engine.authorize(quoteFor(clock, paise(40)));
    engine.release(auth.authId, 'request timed out');

    expect(ledger.available()).toBe(rupees(50));
    expect(ledger.totalSpent()).toBe(0);
  });
});

describe('policy engine — budget refusals', () => {
  it('refuses a single call above the per-call ceiling', () => {
    const { clock, ledger, engine } = setup({ perCallLimit: rupees(1) });
    fund(ledger, rupees(500));

    expect(() => engine.authorize(quoteFor(clock, rupees(2)))).toThrow(PerCallLimitError);
    expect(ledger.held()).toBe(0);
  });

  it('refuses once the hourly cap is committed', () => {
    const { clock, ledger, engine } = setup({
      caps: [{ window: 'hour', limit: rupees(2) }],
      perCallLimit: rupees(1),
    });
    fund(ledger, rupees(500)); // money is not the constraint — the cap is

    for (let i = 0; i < 4; i++) {
      const q = quoteFor(clock, paise(50));
      const a = engine.authorize(q);
      engine.settle({ authId: a.authId, quoteId: q.quoteId, amount: paise(50) });
    }
    expect(ledger.totalSpent()).toBe(rupees(2));

    let caught: unknown;
    try {
      engine.authorize(quoteFor(clock, paise(1)));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    expect((caught as BudgetExhaustedError).window).toBe('hour');
    expect(ledger.totalSpent()).toBe(rupees(2)); // not one µINR more
  });

  it('lets the rolling window free up capacity as spend ages out', () => {
    const { clock, ledger, engine } = setup({
      caps: [{ window: 'hour', limit: rupees(2) }],
      perCallLimit: rupees(2),
    });
    fund(ledger, rupees(500));

    const q1 = quoteFor(clock, rupees(2));
    const a1 = engine.authorize(q1);
    engine.settle({ authId: a1.authId, quoteId: q1.quoteId, amount: rupees(2) });

    expect(() => engine.authorize(quoteFor(clock, paise(1)))).toThrow(BudgetExhaustedError);

    clock.advance(HOUR + 1);

    const q2 = quoteFor(clock, rupees(2));
    expect(() => engine.authorize(q2)).not.toThrow();
    expect(ledger.spentSince(clock.now() - HOUR)).toBe(0);
  });

  it('counts live holds against the cap, so a concurrent burst cannot slip through', () => {
    const { clock, ledger, engine } = setup({
      caps: [{ window: 'hour', limit: rupees(2) }],
      perCallLimit: rupees(1),
    });
    fund(ledger, rupees(500));

    // Four ₹0.50 requests authorized before any of them settle.
    const auths = [];
    for (let i = 0; i < 4; i++) auths.push(engine.authorize(quoteFor(clock, paise(50))));
    expect(ledger.held()).toBe(rupees(2));

    // The fifth must be refused even though nothing has settled yet.
    expect(() => engine.authorize(quoteFor(clock, paise(1)))).toThrow(BudgetExhaustedError);
    expect(auths).toHaveLength(4);
  });

  it('distinguishes "no budget" from "no money"', () => {
    const { clock, ledger, engine } = setup({
      caps: [{ window: 'day', limit: rupees(100) }],
      perCallLimit: rupees(10),
    });
    fund(ledger, rupees(1)); // plenty of budget, almost no funds

    let caught: unknown;
    try {
      engine.authorize(quoteFor(clock, rupees(5)));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsufficientFundsError);
    expect((caught as InsufficientFundsError).available).toBe(rupees(1));
  });

  it('enforces the allowlist', () => {
    const { clock, ledger, engine } = setup({ allowlist: ['provider-a'] });
    fund(ledger, rupees(50));

    expect(() =>
      engine.authorize(quoteFor(clock, paise(10), { provider: 'sketchy-api' })),
    ).toThrow(ProviderNotAllowedError);
  });

  it('enforces a per-provider daily ceiling', () => {
    const { clock, ledger, engine } = setup({
      caps: [{ window: 'day', limit: rupees(100) }],
      perCallLimit: rupees(10),
      perProviderDailyLimit: { greedy: rupees(1) },
    });
    fund(ledger, rupees(500));

    const q = quoteFor(clock, rupees(1), { provider: 'greedy' });
    const a = engine.authorize(q);
    engine.settle({ authId: a.authId, quoteId: q.quoteId, amount: rupees(1) });

    expect(() => engine.authorize(quoteFor(clock, paise(1), { provider: 'greedy' }))).toThrow(
      ProviderLimitError,
    );
    // A different provider is unaffected.
    expect(() =>
      engine.authorize(quoteFor(clock, paise(1), { provider: 'polite' })),
    ).not.toThrow();
  });
});

describe('policy engine — hostile counterparties', () => {
  it('refuses an overcharge, releases the hold, and records no spend', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(50));
    const auth = engine.authorize(quote);

    let caught: unknown;
    try {
      engine.settle({
        authId: auth.authId,
        quoteId: quote.quoteId,
        amount: rupees(50), // quoted ₹0.50, charging ₹50
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(QuoteExceededError);
    const err = caught as QuoteExceededError;
    expect(err.quoted).toBe(paise(50));
    expect(err.charged).toBe(rupees(50));

    expect(ledger.totalSpent()).toBe(0);
    expect(ledger.available()).toBe(rupees(50)); // every rupee still ours
    expect(ledger.held()).toBe(0);
    expect(ledger.receipts()).toHaveLength(0);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it('accepts an overcharge inside an explicitly configured tolerance', () => {
    // perCallLimit is raised above ₹1.05 here: the ceiling applies to the
    // reserved (tolerated) amount, not the quote, which the default fixture trips.
    const { clock, ledger, engine } = setup({
      quoteToleranceBps: 500, // 5%
      perCallLimit: rupees(2),
      caps: [{ window: 'hour', limit: rupees(10) }],
    });
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, rupees(1));
    const auth = engine.authorize(quote);

    // The hold reserved the tolerated maximum, not the quote.
    expect(ledger.held()).toBe(rupees(1.05));

    const receipt = engine.settle({
      authId: auth.authId,
      quoteId: quote.quoteId,
      amount: rupees(1.04),
    });
    expect(receipt.settledAmount).toBe(rupees(1.04));

    // ...but a rupee past the tolerance is still refused.
    const q2 = quoteFor(clock, rupees(1));
    const a2 = engine.authorize(q2);
    expect(() =>
      engine.settle({ authId: a2.authId, quoteId: q2.quoteId, amount: rupees(1.06) }),
    ).toThrow(QuoteExceededError);
  });

  it('refuses a replayed settlement', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(40));
    const auth = engine.authorize(quote);
    const charge = { authId: auth.authId, quoteId: quote.quoteId, amount: paise(40) };

    engine.settle(charge);
    expect(() => engine.settle(charge)).toThrow(ReplayDetectedError);
    expect(ledger.totalSpent()).toBe(paise(40)); // charged exactly once
  });

  it('refuses a charge against an authorization we never issued', () => {
    const { ledger, engine } = setup();
    fund(ledger, rupees(50));

    expect(() =>
      engine.settle({ authId: 'auth_fabricated', quoteId: 'quote_x', amount: rupees(5) }),
    ).toThrow(UnquotedChargeError);
    expect(ledger.totalSpent()).toBe(0);
  });

  it('refuses a charge citing a different quote than was authorized', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(40));
    const auth = engine.authorize(quote);

    expect(() =>
      engine.settle({ authId: auth.authId, quoteId: 'quote_someone_elses', amount: paise(40) }),
    ).toThrow(/quote-mismatch/);
    expect(ledger.totalSpent()).toBe(0);
    expect(ledger.available()).toBe(rupees(50));
  });

  it('refuses an expired quote', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(40), { ttlMs: 5_000 });
    clock.advance(5_001);

    expect(() => engine.authorize(quote)).toThrow(QuoteExpiredError);
  });

  it('refuses a late settlement and releases the hold', () => {
    const { clock, ledger, engine } = setup({ authorizationTtlMs: 10_000 });
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(40));
    const auth = engine.authorize(quote);
    clock.advance(10_001);

    expect(() =>
      engine.settle({ authId: auth.authId, quoteId: quote.quoteId, amount: paise(40) }),
    ).toThrow(AuthorizationExpiredError);

    expect(ledger.available()).toBe(rupees(50));
    expect(ledger.totalSpent()).toBe(0);
  });

  it('refuses a negative charge', () => {
    const { clock, ledger, engine } = setup();
    fund(ledger, rupees(50));

    const quote = quoteFor(clock, paise(40));
    const auth = engine.authorize(quote);

    expect(() =>
      engine.settle({ authId: auth.authId, quoteId: quote.quoteId, amount: -100 as never }),
    ).toThrow(/negative-charge/);
  });
});

describe('policy engine — the overspend invariant', () => {
  /**
   * The claim on the pitch slide is "0% overspend". This is the test that has
   * to be true for that claim to be honest: a long, adversarial, randomised
   * workload where a sixth of all providers try to overcharge tenfold, some
   * abandon the request, and some replay. After every single operation, the
   * hourly cap must hold and the books must balance.
   */
  it('never exceeds the hourly cap under a hostile randomised workload', () => {
    const HOURLY = rupees(2);
    const { clock, ledger, engine } = setup({
      caps: [{ window: 'hour', limit: HOURLY }],
      perCallLimit: paise(60),
      quoteToleranceBps: 0,
      authorizationTtlMs: 30_000,
    });
    fund(ledger, rupees(10_000)); // deliberately far more money than the cap allows

    const rng = lcg(20260905);
    const stats = { authorized: 0, refused: 0, settled: 0, overchargesBlocked: 0, replays: 0 };

    for (let i = 0; i < 3_000; i++) {
      // Averages ~150s between requests, so the run covers a few simulated days.
      // The window has to roll many times for the cap logic to be under real load.
      clock.advance(Math.floor(rng() * 300_000));

      const amount = paise(1 + Math.floor(rng() * 59));
      const provider = `provider-${Math.floor(rng() * 4)}`;
      const quote = quoteFor(clock, amount, { provider });

      let auth;
      try {
        auth = engine.authorize(quote);
        stats.authorized++;
      } catch (e) {
        expect(isPaiseError(e)).toBe(true);
        stats.refused++;
        continue;
      }

      const charge = { authId: auth.authId, quoteId: quote.quoteId, amount };
      const roll = rng();
      try {
        if (roll < 0.16) {
          // hostile: quote small, charge ten times more
          engine.settle({ ...charge, amount: scale(amount, 10) });
          throw new Error('an overcharge was accepted — invariant broken');
        } else if (roll < 0.26) {
          engine.release(auth.authId, 'simulated timeout');
        } else if (roll < 0.31) {
          engine.settle(charge);
          engine.settle(charge); // replay attempt
          throw new Error('a replay was accepted — invariant broken');
        } else {
          engine.settle(charge);
          stats.settled++;
        }
      } catch (e) {
        expect(isPaiseError(e)).toBe(true);
        if (e instanceof QuoteExceededError) stats.overchargesBlocked++;
        if (e instanceof ReplayDetectedError) stats.replays++;
      }

      // The invariants, checked after every operation rather than at the end.
      expect(ledger.verifyIntegrity().ok).toBe(true);
      expect(ledger.spentSince(clock.now() - HOUR)).toBeLessThanOrEqual(HOURLY);
      expect(ledger.available()).toBeGreaterThanOrEqual(0);
      expect(ledger.held()).toBeGreaterThanOrEqual(0);
    }

    // The workload has to have actually exercised things, or the test is vacuous.
    expect(stats.settled).toBeGreaterThan(100);
    expect(stats.refused).toBeGreaterThan(100);
    expect(stats.overchargesBlocked).toBeGreaterThan(100);
    expect(stats.replays).toBeGreaterThan(20);
    expect(ledger.verifyChain().ok).toBe(true);
  });
});
