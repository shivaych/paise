/**
 * In-process settlement rail.
 *
 * Models the one property that actually matters about a UPI Autopay mandate:
 * a ceiling the payer's own software cannot raise. Everything runs with no
 * credentials, which is what makes the benchmark reproducible on any machine.
 *
 * The refusal here is a stand-in for a refusal from the customer's bank. Its
 * job is to be the last line of defence: if every check in the policy engine
 * were deleted, this would still stop an oversized debit.
 */

import { MandateViolationError, SettlementFailedError } from '../core/errors.js';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import { type Micros, rupees } from '../core/money.js';
import { newId } from '../core/signer.js';
import type {
  DebitInput,
  MandateInfo,
  MandateStatus,
  PayoutInput,
  RailCredit,
  RailPayout,
  SettlementRail,
} from './rail.js';

export interface MockRailOptions {
  readonly maxAmountPerDebit?: Micros;
  readonly validUntil?: number;
  readonly status?: MandateStatus;
  readonly clock?: Clock;
  /** Fraction of payouts that fail, for exercising the retry path. */
  readonly payoutFailureRate?: number;
}

export class MockRail implements SettlementRail {
  readonly name = 'mock';

  private readonly clock: Clock;
  private readonly ceiling: Micros;
  private readonly validUntil: number;
  private readonly payoutFailureRate: number;
  private status: MandateStatus;
  private readonly mandateId = newId('mandate');

  /** idempotencyKey -> result, so retries are free. */
  private readonly debits = new Map<string, RailCredit>();
  private readonly payouts = new Map<string, RailPayout>();

  constructor(opts: MockRailOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.ceiling = opts.maxAmountPerDebit ?? rupees(500);
    this.validUntil = opts.validUntil ?? this.clock.now() + 365 * 24 * 3_600_000;
    this.status = opts.status ?? 'active';
    this.payoutFailureRate = opts.payoutFailureRate ?? 0;
  }

  async mandate(): Promise<MandateInfo> {
    return {
      mandateId: this.mandateId,
      maxAmountPerDebit: this.ceiling,
      frequency: 'as_presented',
      validUntil: this.validUntil,
      status: this.effectiveStatus(),
      rail: this.name,
    };
  }

  async debit(input: DebitInput): Promise<RailCredit> {
    const cached = this.debits.get(input.idempotencyKey);
    if (cached) return cached;

    const status = this.effectiveStatus();
    if (status !== 'active') {
      throw new MandateViolationError(
        this.mandateId,
        `mandate is ${status}`,
        input.amount,
        this.ceiling,
      );
    }
    if (input.amount <= 0) {
      throw new MandateViolationError(
        this.mandateId,
        'debit amount must be positive',
        input.amount,
        this.ceiling,
      );
    }
    // The ceiling. Not ours to raise.
    if (input.amount > this.ceiling) {
      throw new MandateViolationError(
        this.mandateId,
        'amount exceeds the per-debit ceiling authorised by the customer',
        input.amount,
        this.ceiling,
      );
    }

    const credit: RailCredit = {
      railRef: newId('pay'),
      amount: input.amount,
      at: this.clock.now(),
    };
    this.debits.set(input.idempotencyKey, credit);
    return credit;
  }

  async payout(input: PayoutInput): Promise<RailPayout> {
    const cached = this.payouts.get(input.idempotencyKey);
    if (cached) return cached;

    if (this.payoutFailureRate > 0 && Math.random() < this.payoutFailureRate) {
      throw new SettlementFailedError(this.name, 'simulated payout failure');
    }
    if (input.amount <= 0) {
      throw new SettlementFailedError(this.name, `payout amount must be positive`);
    }

    const payout: RailPayout = {
      railRef: newId('pout'),
      provider: input.provider,
      amount: input.amount,
      at: this.clock.now(),
      status: 'processed',
    };
    this.payouts.set(input.idempotencyKey, payout);
    return payout;
  }

  // -- test controls --------------------------------------------------------

  pause(): void {
    this.status = 'paused';
  }

  revoke(): void {
    this.status = 'revoked';
  }

  private effectiveStatus(): MandateStatus {
    if (this.status !== 'active') return this.status;
    return this.clock.now() > this.validUntil ? 'expired' : 'active';
  }
}
