/**
 * The policy engine.
 *
 * This is the part of the system that decides whether money may move. It is
 * pure arithmetic over the ledger and the clock. It contains no model calls, no
 * network, no randomness beyond ID generation, and — critically — no way for
 * the agent to argue with it.
 *
 * The LLM decides whether a purchase is *worth it*. This decides whether it is
 * *allowed*. The separation is the entire safety argument: a prompt injection,
 * a hallucinated justification, or a runaway loop cannot widen a cap, because
 * the cap is never in the model's context in the first place.
 *
 * Check order is deliberate: definite structural refusals first (expired,
 * not allowed, too big), then budget arithmetic, then funds. That way the error
 * an agent gets back names the most fundamental reason it was refused, not
 * whichever check happened to run first.
 */

import type { Clock } from './clock.js';
import { DAY, HOUR, MINUTE } from './clock.js';
import type { Ledger } from './ledger.js';
import {
  AuthorizationExpiredError,
  BudgetExhaustedError,
  InsufficientFundsError,
  PaiseError,
  PerCallLimitError,
  ProtocolViolationError,
  ProviderLimitError,
  ProviderNotAllowedError,
  QuoteExceededError,
  QuoteExpiredError,
  ReplayDetectedError,
  UnquotedChargeError,
} from './errors.js';
import {
  type Micros,
  ZERO,
  add,
  clampAtZero,
  format,
  gt,
  sub,
  withToleranceBps,
} from './money.js';
import { HmacSigner, type Signer, canonicalAuthorization, newId } from './signer.js';
import type {
  Authorization,
  BudgetPolicy,
  BudgetStatus,
  CapStatus,
  Charge,
  ProviderId,
  Quote,
  Receipt,
  SpendCap,
  Verdict,
  WindowKind,
} from './types.js';

export const SCHEME = 'paise-ledger-v1';

/** Rolling window lengths. `lifetime` reaches back to the beginning of time. */
export function windowMs(window: WindowKind): number {
  switch (window) {
    case 'minute':
      return MINUTE;
    case 'hour':
      return HOUR;
    case 'day':
      return DAY;
    case 'lifetime':
      return Number.POSITIVE_INFINITY;
  }
}

export interface PolicyEngineOptions {
  readonly policy: BudgetPolicy;
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly signer?: Signer;
  /** Fires on every decision — the dashboard and benchmark subscribe to this. */
  readonly onEvent?: (event: PolicyEvent) => void;
}

export type PolicyEvent =
  | { kind: 'authorized'; authorization: Authorization; at: number }
  | { kind: 'refused'; error: PaiseError; quote?: Quote; charge?: Charge; at: number }
  | { kind: 'settled'; receipt: Receipt; at: number }
  | { kind: 'released'; authId: string; reason: string; at: number };

export class PolicyEngine {
  readonly policy: BudgetPolicy;
  readonly ledger: Ledger;
  private readonly clock: Clock;
  private readonly signer: Signer;
  private readonly onEvent: (event: PolicyEvent) => void;

  constructor(opts: PolicyEngineOptions) {
    this.policy = opts.policy;
    this.ledger = opts.ledger;
    this.clock = opts.clock;
    this.signer = opts.signer ?? new HmacSigner('paise-dev-signing-key-change-me');
    this.onEvent = opts.onEvent ?? (() => {});
  }

  // -------------------------------------------------------------------------
  // Phase 1 — authorize
  // -------------------------------------------------------------------------

  /**
   * Would this quote be approved? No side effects, no hold, no nonce burned.
   *
   * The planner calls this to price out a plan before committing to any of it,
   * so the agent can say "I can afford three of these five calls" rather than
   * discovering it halfway through.
   */
  evaluate(quote: Quote): Verdict {
    this.ledger.expireStaleHolds();
    const reserve = this.reserveFor(quote.amount);
    try {
      this.check(quote, reserve);
      return { ok: true, amount: reserve };
    } catch (e) {
      if (e instanceof PaiseError) {
        return { ok: false, code: e.code, reason: e.message };
      }
      throw e;
    }
  }

  /**
   * Approve a quote and reserve the funds.
   *
   * Throws a typed {@link PaiseError} on refusal. It never partially commits:
   * either an authorization comes back and a hold exists, or nothing changed.
   */
  authorize(quote: Quote): Authorization {
    this.ledger.expireStaleHolds();
    const now = this.clock.now();
    const reserve = this.reserveFor(quote.amount);

    try {
      this.check(quote, reserve);
    } catch (e) {
      if (e instanceof PaiseError) {
        this.onEvent({ kind: 'refused', error: e, quote, at: now });
      }
      throw e;
    }

    const authId = newId('auth');
    const expiresAt = Math.min(quote.expiresAt, now + this.policy.authorizationTtlMs);

    this.ledger.placeHold({
      authId,
      provider: quote.provider,
      quoteId: quote.quoteId,
      resource: quote.resource,
      quotedAmount: quote.amount,
      amount: reserve,
      expiresAt,
    });

    const unsigned = {
      authId,
      quoteId: quote.quoteId,
      agentId: this.policy.agentId,
      provider: quote.provider,
      resource: quote.resource,
      maxAmount: reserve,
      nonce: quote.nonce,
      issuedAt: now,
      expiresAt,
      scheme: SCHEME,
    };

    const authorization: Authorization = {
      ...unsigned,
      signature: this.signer.sign(canonicalAuthorization(unsigned)),
    };

    this.onEvent({ kind: 'authorized', authorization, at: now });
    return authorization;
  }

  // -------------------------------------------------------------------------
  // Phase 2 — settle
  // -------------------------------------------------------------------------

  /**
   * Accept what the provider says it charged, and turn the hold into a spend.
   *
   * This is where hostile counterparties are stopped. Every refusal path
   * releases the hold, so a misbehaving provider costs us nothing but latency.
   */
  settle(charge: Charge): Receipt {
    const now = this.clock.now();
    const hold = this.ledger.getHold(charge.authId);

    // A charge against an authorization we never issued.
    if (!hold) {
      const already = this.ledger.receiptForAuth(charge.authId);
      const error = already
        ? new ReplayDetectedError(charge.authId, already.receiptId, already.settledAt)
        : new UnquotedChargeError('unknown', charge.authId, charge.amount);
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    // The same authorization presented twice.
    if (hold.state === 'settled') {
      const original = this.ledger.receiptForAuth(charge.authId)!;
      const error = new ReplayDetectedError(charge.authId, original.receiptId, original.settledAt);
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    // The hold was already given up — expired, or explicitly abandoned.
    if (hold.state === 'released') {
      const error = new AuthorizationExpiredError(charge.authId, hold.expiresAt, now);
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    // Late settlement. Release and refuse rather than pay against a stale hold.
    if (hold.expiresAt <= now) {
      this.ledger.releaseHold(charge.authId);
      const error = new AuthorizationExpiredError(charge.authId, hold.expiresAt, now);
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    // The charge must reference the quote we actually authorized.
    if (charge.quoteId !== hold.quoteId) {
      this.ledger.releaseHold(charge.authId);
      const error = new ProtocolViolationError(
        'quote-mismatch',
        `charge cites quote ${charge.quoteId}, authorization was for ${hold.quoteId}`,
      );
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    if (charge.amount < 0) {
      this.ledger.releaseHold(charge.authId);
      const error = new ProtocolViolationError(
        'negative-charge',
        `charge amount ${charge.amount} is negative`,
      );
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    // The overcharge check. This is the hostile-API defence.
    if (gt(charge.amount, hold.amount)) {
      this.ledger.releaseHold(charge.authId);
      const error = new QuoteExceededError(
        hold.provider,
        hold.quotedAmount,
        charge.amount,
        hold.amount,
      );
      this.onEvent({ kind: 'refused', error, charge, at: now });
      throw error;
    }

    const receipt = this.ledger.settleHold(
      charge.authId,
      charge.amount,
      hold.resource,
      charge.providerRef,
    );
    this.onEvent({ kind: 'settled', receipt, at: now });
    return receipt;
  }

  /** Give up an authorization without paying — the request failed, timed out, etc. */
  release(authId: string, reason = 'abandoned'): void {
    const hold = this.ledger.getHold(authId);
    if (!hold || hold.state !== 'held') return;
    this.ledger.releaseHold(authId);
    this.onEvent({ kind: 'released', authId, reason, at: this.clock.now() });
  }

  // -------------------------------------------------------------------------
  // Checks
  // -------------------------------------------------------------------------

  /**
   * Funds to reserve for a given quote.
   *
   * We hold the *tolerated maximum*, not the quoted amount. If the policy
   * allows a 5% overage at settlement, then 5% overage must already have been
   * counted against every cap at authorization time — otherwise a run of
   * within-tolerance overcharges walks the agent straight past its daily limit
   * while every individual check passed.
   */
  private reserveFor(quoted: Micros): Micros {
    return withToleranceBps(quoted, this.policy.quoteToleranceBps);
  }

  /** Throws the first applicable typed refusal, or returns cleanly. */
  private check(quote: Quote, reserve: Micros): void {
    const now = this.clock.now();

    if (quote.expiresAt <= now) {
      throw new QuoteExpiredError(quote.quoteId, quote.expiresAt, now);
    }

    if (quote.currency !== 'INR') {
      throw new ProtocolViolationError('currency', `unsupported currency ${quote.currency}`);
    }

    if (quote.amount < 0) {
      throw new ProtocolViolationError('negative-quote', `quote amount ${quote.amount} is negative`);
    }

    const allowlist = this.policy.allowlist;
    if (allowlist && !allowlist.includes(quote.provider)) {
      throw new ProviderNotAllowedError(quote.provider, allowlist);
    }

    if (gt(reserve, this.policy.perCallLimit)) {
      throw new PerCallLimitError(this.policy.perCallLimit, reserve);
    }

    this.checkProviderLimit(quote.provider, reserve, now);
    this.checkCaps(reserve, now);

    if (gt(reserve, this.ledger.available())) {
      throw new InsufficientFundsError(this.ledger.available(), reserve);
    }
  }

  private checkProviderLimit(provider: ProviderId, reserve: Micros, now: number): void {
    const limit = this.policy.perProviderDailyLimit?.[provider];
    if (limit === undefined) return;

    const since = now - DAY;
    const committed = add(this.ledger.spentSince(since, provider), this.ledger.heldNow(provider));
    if (gt(add(committed, reserve), limit)) {
      const earliest = this.ledger.earliestSettlementSince(since);
      throw new ProviderLimitError(
        provider,
        limit,
        committed,
        reserve,
        earliest !== undefined ? earliest + DAY : now,
      );
    }
  }

  private checkCaps(reserve: Micros, now: number): void {
    for (const cap of this.policy.caps) {
      const committed = this.committedIn(cap, now);
      if (gt(add(committed, reserve), cap.limit)) {
        throw new BudgetExhaustedError(
          cap.window,
          cap.limit,
          committed,
          reserve,
          this.resetsAt(cap, now),
        );
      }
    }
  }

  /**
   * Spend counted against a cap: settled receipts inside the window, plus every
   * live hold. Holds are counted in full regardless of when they were placed —
   * they represent money that may still leave.
   */
  private committedIn(cap: SpendCap, now: number): Micros {
    const span = windowMs(cap.window);
    const since = span === Number.POSITIVE_INFINITY ? 0 : now - span;
    return add(this.ledger.spentSince(since), this.ledger.heldNow());
  }

  /** When enough spend ages out of the window for the cap to have room again. */
  private resetsAt(cap: SpendCap, now: number): number {
    const span = windowMs(cap.window);
    if (span === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
    const earliest = this.ledger.earliestSettlementSince(now - span);
    return earliest !== undefined ? earliest + span : now;
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  status(): BudgetStatus {
    const now = this.clock.now();
    const caps: CapStatus[] = this.policy.caps.map((cap) => {
      const span = windowMs(cap.window);
      const since = span === Number.POSITIVE_INFINITY ? 0 : now - span;
      const spent = this.ledger.spentSince(since);
      const held = this.ledger.heldNow();
      return {
        window: cap.window,
        limit: cap.limit,
        spent,
        held,
        remaining: clampAtZero(sub(cap.limit, add(spent, held))),
        resetsAt: this.resetsAt(cap, now),
      };
    });

    return {
      agentId: this.policy.agentId,
      balance: this.ledger.balance(),
      available: this.ledger.available(),
      caps,
      perCallLimit: this.policy.perCallLimit,
      totalSpent: this.ledger.totalSpent(),
      totalHeld: this.ledger.held(),
      liveHolds: this.ledger.liveHoldCount(),
      receiptCount: this.ledger.receipts().length,
    };
  }

  /** One-line summary for logs and the CLI. */
  summary(): string {
    const s = this.status();
    const caps = s.caps
      .map((c) => `${c.window}: ${format(c.remaining)}/${format(c.limit)} left`)
      .join(', ');
    return `balance ${format(s.balance)} (${format(s.available)} available) — ${caps}`;
  }
}

export { ZERO };
