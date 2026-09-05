/**
 * The ledger.
 *
 * Double-entry, in-memory, append-only. Every movement of money is recorded as
 * a set of postings that sum to exactly zero, across four account families:
 *
 *   external          money outside the system (the funding source)
 *   available         funds the agent may commit
 *   held              funds reserved by a live authorization
 *   spent:<provider>  funds irrevocably owed to a counterparty
 *
 * The zero-sum invariant is checkable at any instant (`verifyIntegrity`), which
 * makes "we did not lose track of a single µINR" a property we can demonstrate
 * rather than assert.
 *
 * Why double-entry for a hackathon project: because the single most likely way
 * to accidentally overspend is for a hold to be released *and* settled, or
 * settled twice, leaving the balance quietly wrong. In a double-entry system
 * that shows up immediately as a non-zero sum instead of silently drifting.
 */

import { createHash } from 'node:crypto';
import type { Clock } from './clock.js';
import type {
  AgentId,
  AuthorizationId,
  FundingEvent,
  FundingKind,
  Hold,
  ProviderId,
  Receipt,
} from './types.js';
import { type Micros, add, micros, sub } from './money.js';
import { newId } from './signer.js';

const GENESIS_HASH = '0'.repeat(64);

const ACCOUNT_EXTERNAL = 'external';
const ACCOUNT_AVAILABLE = 'available';
const ACCOUNT_HELD = 'held';
const spentAccount = (p: ProviderId) => `spent:${p}`;

export interface Posting {
  readonly account: string;
  readonly amount: number;
}

export interface JournalEntry {
  readonly seq: number;
  readonly at: number;
  readonly kind: 'topup' | 'hold' | 'release' | 'settle' | 'adjustment';
  readonly ref: string;
  readonly postings: readonly Posting[];
}

export interface PlaceHoldInput {
  readonly authId: AuthorizationId;
  readonly provider: ProviderId;
  readonly quoteId: string;
  readonly resource: string;
  readonly quotedAmount: Micros;
  /** Funds to reserve — the quote plus any tolerance the policy allows. */
  readonly amount: Micros;
  readonly expiresAt: number;
}

export interface CreditInput {
  readonly kind: FundingKind;
  readonly amount: Micros;
  readonly railRef?: string;
  readonly note?: string;
  /** Supply to make the credit idempotent — a repeated eventId is a no-op. */
  readonly eventId?: string;
}

export class Ledger {
  private readonly accounts = new Map<string, number>();
  private readonly journal: JournalEntry[] = [];
  private readonly holds = new Map<AuthorizationId, Hold>();
  private readonly receiptList: Receipt[] = [];
  private readonly fundingEvents: FundingEvent[] = [];
  private readonly seenFundingIds = new Set<string>();
  /** authId -> receiptId, so a replayed settlement can name the original. */
  private readonly settledAuths = new Map<AuthorizationId, Receipt>();
  private journalSeq = 0;

  constructor(
    readonly agentId: AgentId,
    private readonly clock: Clock,
  ) {}

  // -------------------------------------------------------------------------
  // Funding
  // -------------------------------------------------------------------------

  /**
   * Bring money into the system. In production this is driven by a Razorpay
   * webhook confirming a mandate debit actually cleared — never by the agent
   * asking nicely.
   */
  credit(input: CreditInput): FundingEvent {
    if (input.amount <= 0) {
      throw new RangeError(`Credit must be positive, got ${input.amount}`);
    }
    const eventId = input.eventId ?? newId('fund');

    const existing = this.fundingEvents.find((e) => e.eventId === eventId);
    if (existing) return existing; // idempotent: webhooks retry

    this.seenFundingIds.add(eventId);
    const at = this.clock.now();

    this.post(input.kind === 'topup' ? 'topup' : 'adjustment', eventId, at, [
      { account: ACCOUNT_EXTERNAL, amount: -input.amount },
      { account: ACCOUNT_AVAILABLE, amount: input.amount },
    ]);

    const event: FundingEvent = {
      eventId,
      kind: input.kind,
      agentId: this.agentId,
      amount: input.amount,
      at,
      ...(input.railRef !== undefined ? { railRef: input.railRef } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    this.fundingEvents.push(event);
    return event;
  }

  // -------------------------------------------------------------------------
  // Holds
  // -------------------------------------------------------------------------

  /**
   * Reserve funds against a live authorization.
   *
   * The caller (the policy engine) has already checked caps. The ledger's own
   * job is narrower and absolute: never reserve more than is actually there.
   */
  placeHold(input: PlaceHoldInput): Hold {
    if (this.holds.has(input.authId)) {
      throw new Error(`Duplicate hold for authorization ${input.authId}`);
    }
    if (input.amount < 0) {
      throw new RangeError(`Hold amount must be non-negative, got ${input.amount}`);
    }
    if (input.amount > this.available()) {
      throw new RangeError(
        `Ledger refuses to over-reserve: hold ${input.amount} exceeds available ${this.available()}`,
      );
    }

    const at = this.clock.now();
    const hold: Hold = {
      authId: input.authId,
      agentId: this.agentId,
      provider: input.provider,
      quoteId: input.quoteId,
      resource: input.resource,
      quotedAmount: input.quotedAmount,
      amount: input.amount,
      placedAt: at,
      expiresAt: input.expiresAt,
      state: 'held',
    };

    this.post('hold', input.authId, at, [
      { account: ACCOUNT_AVAILABLE, amount: -input.amount },
      { account: ACCOUNT_HELD, amount: input.amount },
    ]);

    this.holds.set(input.authId, hold);
    return hold;
  }

  /** Return a hold's funds to available. Idempotent for already-released holds. */
  releaseHold(authId: AuthorizationId): Hold | undefined {
    const hold = this.holds.get(authId);
    if (!hold || hold.state !== 'held') return hold;

    this.post('release', authId, this.clock.now(), [
      { account: ACCOUNT_HELD, amount: -hold.amount },
      { account: ACCOUNT_AVAILABLE, amount: hold.amount },
    ]);
    hold.state = 'released';
    return hold;
  }

  /**
   * Convert a hold into a spend and write a receipt.
   *
   * `settledAmount` must not exceed the hold — the policy engine enforces the
   * business rule and this is the structural backstop. Any unused remainder of
   * the hold flows back to available, which is why the postings are three-sided.
   */
  settleHold(
    authId: AuthorizationId,
    settledAmount: Micros,
    resource: string,
    providerRef?: string,
  ): Receipt {
    const hold = this.holds.get(authId);
    if (!hold) throw new Error(`No such hold: ${authId}`);
    if (hold.state !== 'held') throw new Error(`Hold ${authId} is already ${hold.state}`);
    if (settledAmount < 0) throw new RangeError('Settled amount must be non-negative');
    if (settledAmount > hold.amount) {
      throw new RangeError(
        `Ledger refuses to settle ${settledAmount} against a hold of ${hold.amount}`,
      );
    }

    const at = this.clock.now();
    const remainder = sub(hold.amount, settledAmount);

    this.post('settle', authId, at, [
      { account: ACCOUNT_HELD, amount: -hold.amount },
      { account: ACCOUNT_AVAILABLE, amount: remainder },
      { account: spentAccount(hold.provider), amount: settledAmount },
    ]);
    hold.state = 'settled';

    const receipt = this.appendReceipt({
      authId,
      quoteId: hold.quoteId,
      provider: hold.provider,
      resource,
      quotedAmount: hold.quotedAmount,
      settledAmount,
      settledAt: at,
      providerRef,
    });
    this.settledAuths.set(authId, receipt);
    return receipt;
  }

  /**
   * Release every hold whose validity window has closed.
   *
   * Called at the top of each policy decision. Without this, an abandoned
   * request would pin funds forever and the agent would starve itself.
   */
  expireStaleHolds(): Hold[] {
    const now = this.clock.now();
    const expired: Hold[] = [];
    for (const hold of this.holds.values()) {
      if (hold.state === 'held' && hold.expiresAt <= now) {
        this.releaseHold(hold.authId);
        expired.push(hold);
      }
    }
    return expired;
  }

  getHold(authId: AuthorizationId): Hold | undefined {
    return this.holds.get(authId);
  }

  receiptForAuth(authId: AuthorizationId): Receipt | undefined {
    return this.settledAuths.get(authId);
  }

  // -------------------------------------------------------------------------
  // Balances
  // -------------------------------------------------------------------------

  private balanceOf(account: string): Micros {
    return micros(this.accounts.get(account) ?? 0);
  }

  /** Funds free to commit right now. */
  available(): Micros {
    return this.balanceOf(ACCOUNT_AVAILABLE);
  }

  /** Funds reserved by live holds. */
  held(): Micros {
    return this.balanceOf(ACCOUNT_HELD);
  }

  /** Everything we still control: available + held. */
  balance(): Micros {
    return add(this.available(), this.held());
  }

  /** Total irrevocably committed to counterparties, all time. */
  totalSpent(): Micros {
    let total = 0;
    for (const [account, amount] of this.accounts) {
      if (account.startsWith('spent:')) total += amount;
    }
    return micros(total);
  }

  spentForProvider(provider: ProviderId): Micros {
    return this.balanceOf(spentAccount(provider));
  }

  // -------------------------------------------------------------------------
  // Window queries — what the rolling caps are measured against
  // -------------------------------------------------------------------------

  /**
   * Settled spend at or after `since`. Receipts are append-only in time order,
   * so we walk backwards and stop as soon as we leave the window.
   */
  spentSince(since: number, provider?: ProviderId): Micros {
    let total = 0;
    for (let i = this.receiptList.length - 1; i >= 0; i--) {
      const r = this.receiptList[i]!;
      if (r.settledAt < since) break;
      if (provider === undefined || r.provider === provider) total += r.settledAmount;
    }
    return micros(total);
  }

  /**
   * Funds currently held by live authorizations.
   *
   * Caps must count holds as well as settled spend, otherwise a burst of
   * concurrent requests could each pass the check and collectively blow the
   * cap once they all settle.
   */
  heldNow(provider?: ProviderId): Micros {
    let total = 0;
    for (const hold of this.holds.values()) {
      if (hold.state !== 'held') continue;
      if (provider === undefined || hold.provider === provider) total += hold.amount;
    }
    return micros(total);
  }

  /** Timestamp of the earliest settled receipt inside the window, if any. */
  earliestSettlementSince(since: number): number | undefined {
    let earliest: number | undefined;
    for (let i = this.receiptList.length - 1; i >= 0; i--) {
      const r = this.receiptList[i]!;
      if (r.settledAt < since) break;
      earliest = r.settledAt;
    }
    return earliest;
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  receipts(): readonly Receipt[] {
    return this.receiptList;
  }

  funding(): readonly FundingEvent[] {
    return this.fundingEvents;
  }

  entries(): readonly JournalEntry[] {
    return this.journal;
  }

  liveHoldCount(): number {
    let n = 0;
    for (const h of this.holds.values()) if (h.state === 'held') n++;
    return n;
  }

  /**
   * Recompute the receipt hash chain from genesis.
   *
   * If anyone edits, reorders or deletes a receipt, this reports the first
   * position that no longer matches. Tamper-evidence without a blockchain.
   */
  verifyChain(): { ok: true } | { ok: false; brokenAt: number; reason: string } {
    let prevHash = GENESIS_HASH;
    for (const receipt of this.receiptList) {
      if (receipt.prevHash !== prevHash) {
        return { ok: false, brokenAt: receipt.seq, reason: 'prevHash does not match predecessor' };
      }
      const expected = hashReceipt(receipt, prevHash);
      if (expected !== receipt.hash) {
        return { ok: false, brokenAt: receipt.seq, reason: 'receipt contents do not match hash' };
      }
      prevHash = receipt.hash;
    }
    return { ok: true };
  }

  /**
   * The zero-sum check. Every posting set balances, so the total across all
   * accounts must be exactly zero at all times.
   */
  verifyIntegrity(): { ok: true } | { ok: false; drift: number } {
    let total = 0;
    for (const amount of this.accounts.values()) total += amount;
    return total === 0 ? { ok: true } : { ok: false, drift: total };
  }

  /** Human-readable account balances, for the dashboard. */
  accountBalances(): Record<string, number> {
    return Object.fromEntries(this.accounts);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private post(
    kind: JournalEntry['kind'],
    ref: string,
    at: number,
    postings: readonly Posting[],
  ): void {
    const sum = postings.reduce((acc, p) => acc + p.amount, 0);
    if (sum !== 0) {
      throw new Error(`Unbalanced posting set for ${kind}/${ref}: sums to ${sum}, must be 0`);
    }
    for (const p of postings) {
      this.accounts.set(p.account, (this.accounts.get(p.account) ?? 0) + p.amount);
    }
    this.journal.push({ seq: ++this.journalSeq, at, kind, ref, postings });
  }

  private appendReceipt(body: {
    authId: string;
    quoteId: string;
    provider: string;
    resource: string;
    quotedAmount: Micros;
    settledAmount: Micros;
    settledAt: number;
    providerRef?: string;
  }): Receipt {
    const prev = this.receiptList.at(-1);
    const prevHash = prev?.hash ?? GENESIS_HASH;
    const seq = this.receiptList.length + 1;

    const draft = {
      receiptId: newId('rcpt'),
      seq,
      authId: body.authId,
      quoteId: body.quoteId,
      agentId: this.agentId,
      provider: body.provider,
      resource: body.resource,
      quotedAmount: body.quotedAmount,
      settledAmount: body.settledAmount,
      settledAt: body.settledAt,
      ...(body.providerRef !== undefined ? { providerRef: body.providerRef } : {}),
      prevHash,
    };

    const receipt: Receipt = { ...draft, hash: hashReceipt(draft, prevHash) };
    this.receiptList.push(receipt);
    return receipt;
  }
}

/**
 * Hash covers every immutable field plus the predecessor's hash.
 *
 * `railRef` is deliberately excluded: it is attached later, when a settlement
 * batch actually moves money, and back-filling it must not invalidate the
 * chain. It is an annotation on a receipt, not part of what the receipt asserts.
 */
function hashReceipt(
  r: Omit<Receipt, 'hash' | 'railRef'> & { railRef?: string },
  prevHash: string,
): string {
  const canonical = [
    'paise-receipt-v1',
    r.receiptId,
    String(r.seq),
    r.authId,
    r.quoteId,
    r.agentId,
    r.provider,
    r.resource,
    String(r.quotedAmount),
    String(r.settledAmount),
    String(r.settledAt),
    r.providerRef ?? '',
  ].join('\n');

  return createHash('sha256').update(prevHash).update('\n').update(canonical).digest('hex');
}

export { GENESIS_HASH };
