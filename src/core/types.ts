/**
 * Core domain types.
 *
 * The payment lifecycle is two-phase, and that is the load-bearing design
 * decision in this whole system:
 *
 *   1. AUTHORIZE — the agent asks the policy engine for permission to spend up
 *      to a quoted amount. The engine checks caps, funds and allowlists, then
 *      places a *hold*. The money is not spent yet, but it is no longer
 *      available to any other concurrent request.
 *
 *   2. SETTLE — the provider states what it actually charged. If that exceeds
 *      the hold, settlement is refused, the hold is released, and no spend is
 *      recorded. Otherwise the hold converts to a spend and a receipt is
 *      written.
 *
 * One-phase "just pay it" would make both concurrent overspend and hostile
 * overcharge unpreventable. Holds are what make the 0%-overspend claim true
 * rather than aspirational.
 */

import type { Micros } from './money.js';

export type AgentId = string;
export type ProviderId = string;
export type QuoteId = string;
export type AuthorizationId = string;
export type ReceiptId = string;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** The period a rolling spend cap is measured over. */
export type WindowKind = 'minute' | 'hour' | 'day' | 'lifetime';

export interface SpendCap {
  readonly window: WindowKind;
  readonly limit: Micros;
}

export interface BudgetPolicy {
  readonly agentId: AgentId;

  /** Rolling-window caps. Every one of them must pass. */
  readonly caps: readonly SpendCap[];

  /** Hardest ceiling on any single call, independent of remaining budget. */
  readonly perCallLimit: Micros;

  /** Counterparties the agent may pay. `undefined` means any. */
  readonly allowlist?: readonly ProviderId[];

  /** Optional per-provider daily ceilings, so one API cannot eat the whole budget. */
  readonly perProviderDailyLimit?: Readonly<Record<ProviderId, Micros>>;

  /**
   * How much above the quote we tolerate at settlement, in basis points.
   * 0 means the charge must not exceed the quote by even one µINR.
   */
  readonly quoteToleranceBps: number;

  /** How long an issued authorization stays valid, in ms. */
  readonly authorizationTtlMs: number;
}

// ---------------------------------------------------------------------------
// The x402 exchange
// ---------------------------------------------------------------------------

/** What a server sends back with an HTTP 402, telling the agent the price. */
export interface Quote {
  readonly quoteId: QuoteId;
  readonly provider: ProviderId;
  readonly resource: string;
  readonly amount: Micros;
  readonly currency: 'INR';
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Single-use, echoed back in the authorization to bind the two together. */
  readonly nonce: string;
  /** Settlement scheme identifier, e.g. `paise-ledger-v1`. */
  readonly scheme: string;
  /** Where the provider wants to be paid — a rail-specific handle. */
  readonly payTo: string;
}

/**
 * The agent's signed promise to pay up to `maxAmount` for exactly this quote.
 * Travels in the `X-Payment` header on the retried request.
 */
export interface Authorization {
  readonly authId: AuthorizationId;
  readonly quoteId: QuoteId;
  readonly agentId: AgentId;
  readonly provider: ProviderId;
  readonly resource: string;
  /** The ceiling. A charge above this is refused. */
  readonly maxAmount: Micros;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly scheme: string;
  /** HMAC over the canonical serialisation. Proves the engine issued this. */
  readonly signature: string;
}

/** What the provider claims it actually charged, presented for settlement. */
export interface Charge {
  readonly authId: AuthorizationId;
  readonly quoteId: QuoteId;
  readonly amount: Micros;
  /** Provider's own reference, echoed into the receipt for reconciliation. */
  readonly providerRef?: string;
}

/** The state of a placed hold. */
export type HoldState = 'held' | 'settled' | 'released';

export interface Hold {
  readonly authId: AuthorizationId;
  readonly agentId: AgentId;
  readonly provider: ProviderId;
  readonly quoteId: QuoteId;
  readonly resource: string;
  readonly quotedAmount: Micros;
  /** Funds reserved. Equals the quote plus any configured tolerance. */
  readonly amount: Micros;
  readonly placedAt: number;
  readonly expiresAt: number;
  state: HoldState;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * An immutable record of one settled payment.
 *
 * Receipts are hash-chained: each carries the hash of its predecessor, so the
 * log is tamper-evident. Deleting or editing any entry breaks every hash after
 * it. This is the audit-trail property we wanted from a blockchain, without
 * needing one — and it reconciles against real Razorpay `payout_id`s once a
 * settlement batch lands.
 */
export interface Receipt {
  readonly receiptId: ReceiptId;
  /** Monotonic position in the chain, starting at 1. */
  readonly seq: number;
  readonly authId: AuthorizationId;
  readonly quoteId: QuoteId;
  readonly agentId: AgentId;
  readonly provider: ProviderId;
  readonly resource: string;
  readonly quotedAmount: Micros;
  readonly settledAmount: Micros;
  readonly settledAt: number;
  readonly providerRef?: string;
  /** Rail reference once a settlement batch has actually moved the money. */
  railRef?: string;
  readonly prevHash: string;
  readonly hash: string;
}

/** Non-payment ledger movements, so the balance is always explainable. */
export type FundingKind = 'topup' | 'refund' | 'adjustment';

export interface FundingEvent {
  readonly eventId: string;
  readonly kind: FundingKind;
  readonly agentId: AgentId;
  readonly amount: Micros;
  readonly at: number;
  /** Rail reference — a Razorpay `payment_id` for a mandate debit, say. */
  readonly railRef?: string;
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface CapStatus {
  readonly window: WindowKind;
  readonly limit: Micros;
  /** Already settled inside the window. */
  readonly spent: Micros;
  /** Reserved by live holds. */
  readonly held: Micros;
  /** `limit - spent - held`, floored at zero. */
  readonly remaining: Micros;
  readonly resetsAt: number;
}

export interface BudgetStatus {
  readonly agentId: AgentId;
  readonly balance: Micros;
  readonly available: Micros;
  readonly caps: readonly CapStatus[];
  readonly perCallLimit: Micros;
  readonly totalSpent: Micros;
  readonly totalHeld: Micros;
  readonly liveHolds: number;
  readonly receiptCount: number;
}

/**
 * A non-committing verdict. `authorize()` throws on refusal; `evaluate()`
 * returns this, so the planner can ask "would this be allowed?" without
 * placing a hold or burning a nonce.
 */
export type Verdict =
  | { readonly ok: true; readonly amount: Micros }
  | { readonly ok: false; readonly code: string; readonly reason: string };
