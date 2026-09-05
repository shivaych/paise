import { describe, expect, it } from 'vitest';
import { TestClock } from '../src/core/clock.js';
import { MandateViolationError } from '../src/core/errors.js';
import { Ledger } from '../src/core/ledger.js';
import { MICROS_PER_PAISA, micros, paise, rupees } from '../src/core/money.js';
import { MockRail } from '../src/rails/mock.js';
import { Treasury } from '../src/rails/treasury.js';
import {
  microsToPaise,
  paiseToMicros,
  verifyWebhookSignature,
} from '../src/rails/razorpay.js';
import { createHmac } from 'node:crypto';

function fixture(railOpts = {}) {
  const clock = new TestClock(new Date('2026-01-01T00:00:00Z'));
  const ledger = new Ledger('agent-1', clock);
  const rail = new MockRail({ clock, maxAmountPerDebit: rupees(500), ...railOpts });
  const treasury = new Treasury({
    ledger,
    rail,
    clock,
    topUpAmount: rupees(100),
    lowWaterMark: rupees(20),
    minPayout: rupees(1),
  });
  return { clock, ledger, rail, treasury };
}

/** Settle a payment straight into the ledger, bypassing the policy engine. */
function recordSpend(ledger: Ledger, provider: string, amount: number, seq: number) {
  ledger.placeHold({
    authId: `a${seq}`,
    provider,
    quoteId: `q${seq}`,
    resource: '/data',
    quotedAmount: amount as never,
    amount: amount as never,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  return ledger.settleHold(`a${seq}`, amount as never, '/data');
}

describe('mock rail — the bank-enforced ceiling', () => {
  it('permits a debit within the mandate ceiling', async () => {
    const { rail } = fixture();
    const credit = await rail.debit({ amount: rupees(100), idempotencyKey: 'k1' });
    expect(credit.amount).toBe(rupees(100));
    expect(credit.railRef).toMatch(/^pay_/);
  });

  it('refuses a debit above the ceiling, however it was requested', async () => {
    const { rail } = fixture({ maxAmountPerDebit: rupees(500) });
    // This is the backstop: even if every check in the policy engine were
    // removed, the mandate still refuses.
    await expect(rail.debit({ amount: rupees(50_000), idempotencyKey: 'k1' })).rejects.toThrow(
      MandateViolationError,
    );
  });

  it('refuses debits once the mandate is revoked', async () => {
    const { rail } = fixture();
    rail.revoke();
    await expect(rail.debit({ amount: rupees(10), idempotencyKey: 'k1' })).rejects.toThrow(
      /revoked/,
    );
  });

  it('is idempotent — a retried debit does not charge twice', async () => {
    const { rail } = fixture();
    const a = await rail.debit({ amount: rupees(100), idempotencyKey: 'same-key' });
    const b = await rail.debit({ amount: rupees(100), idempotencyKey: 'same-key' });
    expect(b.railRef).toBe(a.railRef);
  });
});

describe('treasury — funding', () => {
  it('tops up only when below the low-water mark', async () => {
    const { ledger, treasury } = fixture();

    const first = await treasury.ensureFunded();
    expect(first?.amount).toBe(rupees(100));
    expect(ledger.available()).toBe(rupees(100));

    // Still well funded — no second debit.
    const second = await treasury.ensureFunded();
    expect(second).toBeUndefined();
    expect(ledger.available()).toBe(rupees(100));
  });

  it('credits the ledger only with what the rail confirmed', async () => {
    const { ledger, treasury } = fixture();
    await treasury.ensureFunded();
    const [event] = ledger.funding();
    expect(event?.railRef).toMatch(/^pay_/);
    expect(ledger.verifyIntegrity().ok).toBe(true);
  });

  it('does not double-credit when a top-up is retried', async () => {
    const { ledger, treasury } = fixture();
    await treasury.ensureFunded();
    // Same sequence number => same idempotency key => same ledger event.
    await treasury.ensureFunded();
    await treasury.ensureFunded();
    expect(ledger.funding()).toHaveLength(1);
    expect(ledger.balance()).toBe(rupees(100));
  });

  it('propagates a mandate refusal instead of crediting anything', async () => {
    const clock = new TestClock(0);
    const ledger = new Ledger('agent-1', clock);
    const rail = new MockRail({ clock, maxAmountPerDebit: rupees(50) });
    const treasury = new Treasury({
      ledger,
      rail,
      clock,
      topUpAmount: rupees(500), // more than the mandate allows
      lowWaterMark: rupees(20),
    });

    await expect(treasury.ensureFunded()).rejects.toThrow(MandateViolationError);
    expect(ledger.balance()).toBe(0);
  });
});

describe('treasury — aggregated settlement', () => {
  it('batches many micro-charges into one payout per provider', async () => {
    const { ledger, treasury } = fixture();
    await treasury.ensureFunded();

    // 300 calls at ₹0.02 to one provider, 100 at ₹0.05 to another.
    let seq = 0;
    for (let i = 0; i < 300; i++) recordSpend(ledger, 'solarindex', paise(2), seq++);
    for (let i = 0; i < 100; i++) recordSpend(ledger, 'subsidydb', paise(5), seq++);

    const result = await treasury.settleBatch();

    expect(result.payouts).toHaveLength(2); // 400 calls -> 2 bank transactions
    expect(result.receiptsSettled).toBe(400);

    const solar = result.payouts.find((p) => p.provider === 'solarindex');
    const subsidy = result.payouts.find((p) => p.provider === 'subsidydb');
    expect(solar?.amount).toBe(rupees(6)); // 300 x ₹0.02
    expect(subsidy?.amount).toBe(rupees(5)); // 100 x ₹0.05
  });

  it('stamps receipts with the payout reference without breaking the hash chain', async () => {
    const { ledger, treasury } = fixture();
    await treasury.ensureFunded();
    for (let i = 0; i < 60; i++) recordSpend(ledger, 'solarindex', paise(5), i);

    await treasury.settleBatch();

    expect(ledger.receipts().every((r) => r.railRef?.startsWith('pout_'))).toBe(true);
    expect(ledger.verifyChain().ok).toBe(true);
  });

  it('carries sub-paisa dust forward instead of rounding it away', async () => {
    const { ledger, treasury } = fixture();
    ledger.credit({ kind: 'topup', amount: rupees(1_000) }); // 200 rounds needs headroom

    let totalEarned = 0;
    let totalPaid = 0;
    let seq = 0;

    // Each round earns ₹1.00005 — a payable rupee plus 50 µINR of dust that no
    // bank rail can represent.
    for (let round = 0; round < 200; round++) {
      for (let i = 0; i < 3; i++) {
        recordSpend(ledger, 'dusty', micros(333_350), seq++);
        totalEarned += 333_350;
      }
      const result = await treasury.settleBatch();
      totalPaid += result.payouts.reduce((acc, p) => acc + p.amount, 0);

      // The invariant: nothing is ever rounded away in either direction.
      // What we have paid plus what we still owe is exactly what was earned.
      expect(totalPaid + (result.carried['dusty'] ?? 0)).toBe(totalEarned);
    }

    // 200 rounds of 50 µINR of dust accumulates to a whole paisa, and that
    // paisa gets paid rather than quietly kept.
    expect(totalPaid).toBeGreaterThan(200 * 1_000_000);
    expect(totalPaid).toBe(totalEarned);
  });

  it('holds back a provider whose balance is below the payout minimum', async () => {
    const { ledger, treasury } = fixture();
    await treasury.ensureFunded();
    recordSpend(ledger, 'tiny', paise(3), 0); // ₹0.03, under the ₹1 minimum

    const result = await treasury.settleBatch();
    expect(result.payouts).toHaveLength(0);
    expect(result.skipped[0]?.provider).toBe('tiny');
    expect(result.carried['tiny']).toBe(paise(3));
  });

  it('does not pay the same receipt twice across batches', async () => {
    const { ledger, treasury } = fixture();
    await treasury.ensureFunded();
    for (let i = 0; i < 40; i++) recordSpend(ledger, 'solarindex', paise(10), i);

    const first = await treasury.settleBatch();
    const second = await treasury.settleBatch();

    expect(first.payouts).toHaveLength(1);
    expect(second.payouts).toHaveLength(0);
    expect(second.receiptsSettled).toBe(0);
  });
});

describe('razorpay rail — unit-testable parts', () => {
  it('converts µINR to paise and refuses sub-paisa amounts', () => {
    expect(microsToPaise(rupees(1))).toBe(100);
    expect(microsToPaise(paise(40))).toBe(40);
    expect(paiseToMicros(40)).toBe(paise(40));
    // A factor-of-100 slip here would be a hundredfold overcharge, so it throws
    // rather than rounding.
    expect(() => microsToPaise(micros(4_500))).toThrow(RangeError);
    expect(MICROS_PER_PAISA).toBe(10_000);
  });

  it('verifies a webhook signature over the raw body', () => {
    const secret = 'whsec_test_1234567890';
    const body = JSON.stringify({ event: 'payment.captured', id: 'pay_123' });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(body, signature, 'wrong_secret')).toBe(false);
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'deadbeef', secret)).toBe(false);
  });
});
