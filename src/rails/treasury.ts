/**
 * The treasury: the only component allowed to move real money.
 *
 * It does two jobs, and the split between them is the answer to "you cannot run
 * a ₹0.40 bank transaction":
 *
 *   ensureFunded()  Real money IN. One mandate debit, rarely, for a few hundred
 *                   rupees, under a bank-enforced ceiling.
 *
 *   settleBatch()   Real money OUT. Accumulated micro-charges per provider,
 *                   summed and paid once, when the total is worth moving.
 *
 * Between those two, thousands of ₹0.004 charges happen entirely inside the
 * ledger, at zero marginal cost. That is not a workaround for INR rails — it is
 * how every micropayment system that has ever worked is built, x402
 * facilitators included. The honest claim is "sub-paisa accounting with
 * aggregated settlement", not "sub-paisa bank transactions".
 *
 * Sub-paisa remainders are never rounded away. They carry forward, because
 * rounding a remainder in our favour on every batch is a slow theft from the
 * provider, and rounding against us is a slow leak.
 */

import type { Clock } from '../core/clock.js';
import { InsufficientFundsError } from '../core/errors.js';
import type { Ledger } from '../core/ledger.js';
import { MICROS_PER_PAISA, type Micros, ZERO, add, micros, sub } from '../core/money.js';
import type { FundingEvent, ProviderId, Receipt } from '../core/types.js';
import type { RailPayout, SettlementRail } from './rail.js';

export interface TreasuryOptions {
  readonly ledger: Ledger;
  readonly rail: SettlementRail;
  readonly clock: Clock;
  /** How much a single mandate debit brings in. */
  readonly topUpAmount: Micros;
  /** Top up when available funds drop below this. */
  readonly lowWaterMark: Micros;
  /** Do not bother the rail for less than this. RazorpayX has minimums. */
  readonly minPayout?: Micros;
}

export interface BatchResult {
  readonly payouts: readonly RailPayout[];
  /** Provider -> sub-paisa remainder carried into the next batch. */
  readonly carried: Readonly<Record<string, number>>;
  readonly receiptsSettled: number;
  readonly skipped: readonly { provider: string; total: Micros; reason: string }[];
}

export class Treasury {
  private readonly ledger: Ledger;
  private readonly rail: SettlementRail;
  private readonly clock: Clock;
  private readonly topUpAmount: Micros;
  private readonly lowWaterMark: Micros;
  private readonly minPayout: Micros;

  /** Sub-paisa dust owed per provider, waiting for a batch it can round into. */
  private readonly carry = new Map<ProviderId, Micros>();
  private topUpCount = 0;

  constructor(opts: TreasuryOptions) {
    this.ledger = opts.ledger;
    this.rail = opts.rail;
    this.clock = opts.clock;
    this.topUpAmount = opts.topUpAmount;
    this.lowWaterMark = opts.lowWaterMark;
    this.minPayout = opts.minPayout ?? micros(100 * MICROS_PER_PAISA); // ₹1
  }

  /**
   * Top up if we are running low.
   *
   * Credits the ledger only after the rail confirms the debit. The idempotency
   * key is derived from the top-up sequence, so a retried call after a timeout
   * cannot debit the customer twice.
   */
  async ensureFunded(): Promise<FundingEvent | undefined> {
    if (this.ledger.available() > this.lowWaterMark) return undefined;

    const sequence = this.topUpCount + 1;
    const idempotencyKey = `${this.ledger.agentId}:topup:${sequence}`;

    // Throws MandateViolationError if the bank-enforced ceiling refuses.
    const credit = await this.rail.debit({
      amount: this.topUpAmount,
      idempotencyKey,
      note: 'Agent budget top-up',
    });
    this.topUpCount = sequence;

    return this.ledger.credit({
      kind: 'topup',
      amount: credit.amount,
      railRef: credit.railRef,
      eventId: idempotencyKey,
      note: `${this.rail.name} mandate debit`,
    });
  }

  /** Available funds, and whether a top-up is due. */
  status() {
    return {
      available: this.ledger.available(),
      lowWaterMark: this.lowWaterMark,
      topUpDue: this.ledger.available() <= this.lowWaterMark,
      topUps: this.topUpCount,
      unsettled: this.unsettledByProvider(),
      carry: Object.fromEntries(this.carry),
    };
  }

  /**
   * Pay providers what they are owed.
   *
   * A payout covers a whole number of paise; the sub-paisa remainder stays on
   * the books as carry. Receipts are stamped with the payout reference, which
   * is what closes the loop between the internal audit chain and money that
   * actually moved.
   */
  async settleBatch(): Promise<BatchResult> {
    const groups = this.unsettledReceiptsByProvider();
    const payouts: RailPayout[] = [];
    const skipped: { provider: string; total: Micros; reason: string }[] = [];
    let receiptsSettled = 0;

    for (const [provider, receipts] of groups) {
      const earned = receipts.reduce((acc, r) => add(acc, r.settledAmount), ZERO);
      const total = add(earned, this.carry.get(provider) ?? ZERO);

      // Split into whole paise (payable) and dust (carried).
      const payable = micros(Math.floor(total / MICROS_PER_PAISA) * MICROS_PER_PAISA);
      const remainder = sub(total, payable);

      if (payable < this.minPayout) {
        this.carry.set(provider, total);
        skipped.push({
          provider,
          total,
          reason: `below minimum payout of ${this.minPayout} µINR — accumulating`,
        });
        continue;
      }

      const payout = await this.rail.payout({
        provider,
        amount: payable,
        idempotencyKey: `${provider}:${receipts[0]!.seq}-${receipts.at(-1)!.seq}`,
        destination: `fa_${provider}`,
        note: `${receipts.length} calls`,
      });

      // Stamp the receipts. railRef is outside the hash, so this does not
      // invalidate the chain — see hashReceipt in ledger.ts.
      for (const r of receipts) r.railRef = payout.railRef;

      this.carry.set(provider, remainder);
      payouts.push(payout);
      receiptsSettled += receipts.length;
    }

    return {
      payouts,
      carried: Object.fromEntries(this.carry),
      receiptsSettled,
      skipped,
    };
  }

  private unsettledReceiptsByProvider(): Map<ProviderId, Receipt[]> {
    const groups = new Map<ProviderId, Receipt[]>();
    for (const r of this.ledger.receipts()) {
      if (r.railRef) continue; // already paid out
      const list = groups.get(r.provider);
      if (list) list.push(r);
      else groups.set(r.provider, [r]);
    }
    return groups;
  }

  private unsettledByProvider(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [provider, receipts] of this.unsettledReceiptsByProvider()) {
      out[provider] = receipts.reduce((acc, r) => acc + r.settledAmount, 0);
    }
    return out;
  }
}

export { InsufficientFundsError };
