/**
 * Typed refusals.
 *
 * The headline property of this system is that when money runs out or a
 * counterparty misbehaves, the agent gets a *specific, structured error* — not
 * a partial charge, not a retry storm, and not a drained wallet.
 *
 * Every error carries enough structured detail for the dashboard to render it
 * and for the benchmark to assert on it. `retryable` says whether some later or
 * smaller request could plausibly succeed; it never means "retry this one".
 */

import type { Micros } from './money.js';
import { format } from './money.js';
import type { WindowKind } from './types.js';

export type ErrorCode =
  | 'BUDGET_EXHAUSTED'
  | 'PER_CALL_LIMIT'
  | 'PROVIDER_LIMIT'
  | 'INSUFFICIENT_FUNDS'
  | 'PROVIDER_NOT_ALLOWED'
  | 'QUOTE_EXCEEDED'
  | 'QUOTE_EXPIRED'
  | 'UNQUOTED_CHARGE'
  | 'REPLAY_DETECTED'
  | 'AUTHORIZATION_EXPIRED'
  | 'MANDATE_VIOLATION'
  | 'SETTLEMENT_FAILED'
  | 'PROTOCOL_VIOLATION';

export abstract class PaiseError extends Error {
  abstract readonly code: ErrorCode;

  /** True when a smaller, later, or different request could succeed. */
  readonly retryable: boolean = false;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Structured payload — safe to log, serialise, and render. */
  abstract details(): Record<string, unknown>;

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      name: this.name,
      message: this.message,
      retryable: this.retryable,
      ...this.details(),
    };
  }
}

// ---------------------------------------------------------------------------
// Budget refusals — our own policy said no.
// ---------------------------------------------------------------------------

/** A rolling-window cap (per minute/hour/day/lifetime) would be breached. */
export class BudgetExhaustedError extends PaiseError {
  readonly code = 'BUDGET_EXHAUSTED' as const;
  override readonly retryable = true; // the window eventually rolls

  constructor(
    readonly window: WindowKind,
    readonly limit: Micros,
    readonly committed: Micros,
    readonly requested: Micros,
    readonly resetsAt: number,
  ) {
    super(
      `${window} budget exhausted: ${format(committed)} of ${format(limit)} already committed, ` +
        `cannot add ${format(requested)}. Window resets at ${new Date(resetsAt).toISOString()}.`,
    );
  }

  details() {
    return {
      window: this.window,
      limit: this.limit,
      committed: this.committed,
      requested: this.requested,
      resetsAt: this.resetsAt,
    };
  }
}

/** A single call costs more than the per-call ceiling, regardless of budget left. */
export class PerCallLimitError extends PaiseError {
  readonly code = 'PER_CALL_LIMIT' as const;

  constructor(
    readonly limit: Micros,
    readonly requested: Micros,
  ) {
    super(
      `Single-call limit exceeded: ${format(requested)} requested, ceiling is ${format(limit)}.`,
    );
  }

  details() {
    return { limit: this.limit, requested: this.requested };
  }
}

/** A per-provider ceiling would be breached. Stops one bad API monopolising the budget. */
export class ProviderLimitError extends PaiseError {
  readonly code = 'PROVIDER_LIMIT' as const;
  override readonly retryable = true;

  constructor(
    readonly provider: string,
    readonly limit: Micros,
    readonly committed: Micros,
    readonly requested: Micros,
    readonly resetsAt: number,
  ) {
    super(
      `Daily limit for provider "${provider}" exhausted: ${format(committed)} of ${format(limit)} ` +
        `committed, cannot add ${format(requested)}.`,
    );
  }

  details() {
    return {
      provider: this.provider,
      limit: this.limit,
      committed: this.committed,
      requested: this.requested,
      resetsAt: this.resetsAt,
    };
  }
}

/** The agent is not permitted to pay this counterparty at all. */
export class ProviderNotAllowedError extends PaiseError {
  readonly code = 'PROVIDER_NOT_ALLOWED' as const;

  constructor(
    readonly provider: string,
    readonly allowlist: readonly string[],
  ) {
    super(`Provider "${provider}" is not on the allowlist.`);
  }

  details() {
    return { provider: this.provider, allowlist: this.allowlist };
  }
}

/**
 * The policy would allow it, but there is not enough money in the account.
 *
 * Deliberately distinct from BudgetExhaustedError: same stop, different fix.
 * "Budget exhausted" means wait or raise the cap; "insufficient funds" means
 * top up. The agent's planner treats them differently.
 */
export class InsufficientFundsError extends PaiseError {
  readonly code = 'INSUFFICIENT_FUNDS' as const;
  override readonly retryable = true; // a top-up can land

  constructor(
    readonly available: Micros,
    readonly requested: Micros,
  ) {
    super(
      `Insufficient funds: ${format(available)} available, ${format(requested)} required. ` +
        `Top up to continue.`,
    );
  }

  details() {
    return { available: this.available, requested: this.requested };
  }
}

// ---------------------------------------------------------------------------
// Counterparty refusals — the other side misbehaved.
// ---------------------------------------------------------------------------

/**
 * The provider quoted one price and charged another.
 *
 * This is the hostile-API case. The hold is released, no spend is recorded, and
 * the agent is told exactly what happened.
 */
export class QuoteExceededError extends PaiseError {
  readonly code = 'QUOTE_EXCEEDED' as const;

  constructor(
    readonly provider: string,
    readonly quoted: Micros,
    readonly charged: Micros,
    readonly tolerated: Micros,
  ) {
    super(
      `Provider "${provider}" quoted ${format(quoted)} but charged ${format(charged)} ` +
        `(tolerance allows up to ${format(tolerated)}). Payment refused.`,
    );
  }

  details() {
    return {
      provider: this.provider,
      quoted: this.quoted,
      charged: this.charged,
      tolerated: this.tolerated,
      overchargeBy: this.charged - this.quoted,
    };
  }
}

/** The quote's validity window closed before we paid. Prevents stale-price attacks. */
export class QuoteExpiredError extends PaiseError {
  readonly code = 'QUOTE_EXPIRED' as const;
  override readonly retryable = true; // ask for a fresh quote

  constructor(
    readonly quoteId: string,
    readonly expiredAt: number,
    readonly now: number,
  ) {
    super(
      `Quote ${quoteId} expired at ${new Date(expiredAt).toISOString()} ` +
        `(now ${new Date(now).toISOString()}). Request a fresh quote.`,
    );
  }

  details() {
    return { quoteId: this.quoteId, expiredAt: this.expiredAt, now: this.now };
  }
}

/** A charge arrived that references no authorization we ever issued. */
export class UnquotedChargeError extends PaiseError {
  readonly code = 'UNQUOTED_CHARGE' as const;

  constructor(
    readonly provider: string,
    readonly authId: string,
    readonly amount: Micros,
  ) {
    super(
      `Provider "${provider}" attempted to charge ${format(amount)} against unknown ` +
        `authorization "${authId}". No such authorization was issued.`,
    );
  }

  details() {
    return { provider: this.provider, authId: this.authId, amount: this.amount };
  }
}

/** The same authorization was presented for settlement twice. */
export class ReplayDetectedError extends PaiseError {
  readonly code = 'REPLAY_DETECTED' as const;

  constructor(
    readonly authId: string,
    readonly originalReceiptId: string,
    readonly settledAt: number,
  ) {
    super(
      `Authorization "${authId}" was already settled at ` +
        `${new Date(settledAt).toISOString()} (receipt ${originalReceiptId}). ` +
        `Replay refused.`,
    );
  }

  details() {
    return {
      authId: this.authId,
      originalReceiptId: this.originalReceiptId,
      settledAt: this.settledAt,
    };
  }
}

/** The authorization's own validity window closed before the provider settled it. */
export class AuthorizationExpiredError extends PaiseError {
  readonly code = 'AUTHORIZATION_EXPIRED' as const;
  override readonly retryable = true;

  constructor(
    readonly authId: string,
    readonly expiredAt: number,
    readonly now: number,
  ) {
    super(
      `Authorization "${authId}" expired at ${new Date(expiredAt).toISOString()}; ` +
        `hold released. Charge refused.`,
    );
  }

  details() {
    return { authId: this.authId, expiredAt: this.expiredAt, now: this.now };
  }
}

// ---------------------------------------------------------------------------
// Rail refusals — the money layer said no.
// ---------------------------------------------------------------------------

/**
 * The settlement rail rejected the movement — e.g. a UPI Autopay mandate's
 * bank-enforced ceiling. This is the backstop: it fires even if every check
 * above was buggy or bypassed.
 */
export class MandateViolationError extends PaiseError {
  readonly code = 'MANDATE_VIOLATION' as const;

  constructor(
    readonly mandateId: string,
    readonly reason: string,
    readonly requested: Micros,
    readonly mandateCeiling: Micros,
  ) {
    super(
      `Mandate ${mandateId} refused ${format(requested)}: ${reason} ` +
        `(bank-enforced ceiling ${format(mandateCeiling)}).`,
    );
  }

  details() {
    return {
      mandateId: this.mandateId,
      reason: this.reason,
      requested: this.requested,
      mandateCeiling: this.mandateCeiling,
    };
  }
}

/** Money movement failed at the rail. The ledger is rolled back to before the attempt. */
export class SettlementFailedError extends PaiseError {
  readonly code = 'SETTLEMENT_FAILED' as const;
  override readonly retryable = true;

  constructor(
    readonly rail: string,
    readonly reason: string,
    readonly railRef?: string,
  ) {
    super(`Settlement failed on rail "${rail}": ${reason}`);
  }

  details() {
    return { rail: this.rail, reason: this.reason, railRef: this.railRef };
  }
}

/** The counterparty broke the x402 wire contract — malformed header, bad signature, etc. */
export class ProtocolViolationError extends PaiseError {
  readonly code = 'PROTOCOL_VIOLATION' as const;

  constructor(
    readonly what: string,
    readonly detail: string,
  ) {
    super(`x402 protocol violation (${what}): ${detail}`);
  }

  details() {
    return { what: this.what, detail: this.detail };
  }
}

/** Narrowing helper for catch blocks and the benchmark harness. */
export function isPaiseError(e: unknown): e is PaiseError {
  return e instanceof PaiseError;
}
