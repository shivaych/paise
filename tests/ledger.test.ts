import { describe, expect, it } from 'vitest';
import { TestClock } from '../src/core/clock.js';
import { Ledger } from '../src/core/ledger.js';
import { rupees } from '../src/core/money.js';
import type { Receipt } from '../src/core/types.js';

function ledger() {
  const clock = new TestClock(new Date('2026-01-01T00:00:00Z'));
  return { clock, l: new Ledger('agent-1', clock) };
}

function hold(l: Ledger, authId: string, amount: number, expiresAt: number) {
  return l.placeHold({
    authId,
    provider: 'p1',
    quoteId: `q-${authId}`,
    resource: '/data',
    quotedAmount: amount as never,
    amount: amount as never,
    expiresAt,
  });
}

describe('ledger', () => {
  it('starts empty and balanced', () => {
    const { l } = ledger();
    expect(l.balance()).toBe(0);
    expect(l.available()).toBe(0);
    expect(l.verifyIntegrity().ok).toBe(true);
  });

  it('credits funds and stays zero-sum', () => {
    const { l } = ledger();
    l.credit({ kind: 'topup', amount: rupees(100), railRef: 'pay_test123' });
    expect(l.available()).toBe(rupees(100));
    expect(l.balance()).toBe(rupees(100));
    expect(l.verifyIntegrity().ok).toBe(true);
  });

  it('treats repeated funding events as idempotent', () => {
    const { l } = ledger();
    // Razorpay webhooks retry. A double-credit is free money we do not have.
    l.credit({ kind: 'topup', amount: rupees(100), eventId: 'evt_1' });
    l.credit({ kind: 'topup', amount: rupees(100), eventId: 'evt_1' });
    expect(l.balance()).toBe(rupees(100));
    expect(l.funding()).toHaveLength(1);
  });

  it('moves funds available -> held -> spent', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(10) });

    hold(l, 'a1', rupees(3), clock.now() + 30_000);
    expect(l.available()).toBe(rupees(7));
    expect(l.held()).toBe(rupees(3));
    expect(l.balance()).toBe(rupees(10));

    l.settleHold('a1', rupees(3) as never, '/data');
    expect(l.available()).toBe(rupees(7));
    expect(l.held()).toBe(0);
    expect(l.totalSpent()).toBe(rupees(3));
    expect(l.balance()).toBe(rupees(7));
    expect(l.verifyIntegrity().ok).toBe(true);
  });

  it('returns the unused remainder of a hold when settling for less', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(10) });
    hold(l, 'a1', rupees(3), clock.now() + 30_000);

    l.settleHold('a1', rupees(1) as never, '/data');
    expect(l.totalSpent()).toBe(rupees(1));
    expect(l.available()).toBe(rupees(9));
    expect(l.verifyIntegrity().ok).toBe(true);
  });

  it('refuses to reserve more than is available', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(5) });
    expect(() => hold(l, 'a1', rupees(6), clock.now() + 30_000)).toThrow(RangeError);
    expect(l.verifyIntegrity().ok).toBe(true);
  });

  it('refuses to settle more than the hold', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(10) });
    hold(l, 'a1', rupees(2), clock.now() + 30_000);
    expect(() => l.settleHold('a1', rupees(5) as never, '/data')).toThrow(RangeError);
    expect(l.totalSpent()).toBe(0);
  });

  it('releases expired holds and returns the funds', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(10) });
    hold(l, 'a1', rupees(4), clock.now() + 30_000);
    expect(l.available()).toBe(rupees(6));

    clock.advance(30_001);
    const expired = l.expireStaleHolds();

    expect(expired).toHaveLength(1);
    expect(l.available()).toBe(rupees(10));
    expect(l.held()).toBe(0);
    expect(l.verifyIntegrity().ok).toBe(true);
  });

  it('will not settle a hold twice', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(10) });
    hold(l, 'a1', rupees(2), clock.now() + 30_000);
    l.settleHold('a1', rupees(2) as never, '/data');
    expect(() => l.settleHold('a1', rupees(2) as never, '/data')).toThrow(/already settled/);
    expect(l.totalSpent()).toBe(rupees(2));
  });

  it('scopes window queries to the requested period', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(100) });

    hold(l, 'a1', rupees(1), clock.now() + 1000);
    l.settleHold('a1', rupees(1) as never, '/data');

    clock.advanceHours(2);
    hold(l, 'a2', rupees(1), clock.now() + 1000);
    l.settleHold('a2', rupees(1) as never, '/data');

    expect(l.spentSince(0)).toBe(rupees(2));
    expect(l.spentSince(clock.now() - 3_600_000)).toBe(rupees(1)); // last hour only
  });

  it('hash-chains receipts and detects tampering', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(100) });
    for (let i = 0; i < 5; i++) {
      hold(l, `a${i}`, rupees(1), clock.now() + 1000);
      l.settleHold(`a${i}`, rupees(1) as never, '/data');
      clock.advance(1000);
    }

    expect(l.verifyChain().ok).toBe(true);
    expect(l.receipts()).toHaveLength(5);

    // Someone edits the log to hide an expensive call.
    const forged = l.receipts()[2] as unknown as { settledAmount: number };
    forged.settledAmount = rupees(0.01);

    const result = l.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.brokenAt).toBe(3);
  });

  it('keeps railRef out of the hash so back-filling does not break the chain', () => {
    const { l, clock } = ledger();
    l.credit({ kind: 'topup', amount: rupees(10) });
    hold(l, 'a1', rupees(1), clock.now() + 1000);
    const receipt: Receipt = l.settleHold('a1', rupees(1) as never, '/data');

    receipt.railRef = 'pout_ABC123'; // attached later by the settlement batch
    expect(l.verifyChain().ok).toBe(true);
  });
});
