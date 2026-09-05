/**
 * The settlement rail interface.
 *
 * Everything above this line — the policy engine, the ledger, the x402
 * protocol — is rail-agnostic. This is the seam where actual money moves, and
 * it is deliberately narrow: pull funds in through a mandate, push funds out
 * through a payout, and describe the bank-enforced limits.
 *
 * Two implementations ship:
 *   MockRail      — enforces a mandate ceiling in-process, no credentials
 *   RazorpayRail  — UPI Autopay mandate debits + RazorpayX payouts
 *
 * A Base/USDC adapter would be a third file implementing the same three
 * methods. That is the argument for the abstraction: the safety properties
 * belong to the policy engine, not to any particular way of moving rupees.
 */

import type { Micros } from '../core/money.js';

export type MandateStatus = 'active' | 'paused' | 'revoked' | 'expired';

/**
 * The bank-enforced allowance.
 *
 * This is the part that makes the whole design defensible: `maxAmountPerDebit`
 * is not enforced by our code. It is enforced by NPCI and the customer's bank
 * at the moment of debit. A bug anywhere in this repository cannot cause a
 * debit above it.
 */
export interface MandateInfo {
  readonly mandateId: string;
  readonly maxAmountPerDebit: Micros;
  readonly frequency: 'as_presented' | 'daily' | 'weekly' | 'monthly';
  readonly validUntil: number;
  readonly status: MandateStatus;
  /** Which rail issued it, for display. */
  readonly rail: string;
}

export interface RailCredit {
  /** The rail's own reference — a Razorpay `payment_id` for a mandate debit. */
  readonly railRef: string;
  readonly amount: Micros;
  readonly at: number;
}

export interface RailPayout {
  /** RazorpayX `payout_id`, or the mock equivalent. */
  readonly railRef: string;
  readonly provider: string;
  readonly amount: Micros;
  readonly at: number;
  readonly status: 'queued' | 'processing' | 'processed' | 'failed';
}

export interface DebitInput {
  readonly amount: Micros;
  /** Required. A retried top-up must not debit the customer twice. */
  readonly idempotencyKey: string;
  readonly note?: string;
}

export interface PayoutInput {
  readonly provider: string;
  readonly amount: Micros;
  readonly idempotencyKey: string;
  /** Where the provider gets paid — a UPI VPA or fund account id. */
  readonly destination?: string;
  readonly note?: string;
}

export interface SettlementRail {
  readonly name: string;

  /** Current mandate and its bank-enforced ceiling. */
  mandate(): Promise<MandateInfo>;

  /**
   * Pull funds from the customer under the mandate.
   * Throws {@link MandateViolationError} if the rail or the bank refuses.
   */
  debit(input: DebitInput): Promise<RailCredit>;

  /** Push accumulated earnings to a provider. */
  payout(input: PayoutInput): Promise<RailPayout>;
}
