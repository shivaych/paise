/**
 * Client side of x402: an HTTP client that can pay for what it fetches.
 *
 * Every exit path is accounted for. If the request is free we never touch the
 * ledger; if we authorize and anything subsequently goes wrong — network error,
 * 5xx, overcharge, replay, malformed receipt — the hold is released before the
 * error propagates. A hold that leaks is budget the agent can never spend
 * again, so "release in `finally`" is not tidiness, it is correctness.
 *
 * Refusals surface as typed PaiseErrors. The caller can tell "I could not
 * afford this" apart from "this API tried to rob me" without parsing strings.
 */

import type { PolicyEngine } from '../core/policy.js';
import {
  PaiseError,
  ProtocolViolationError,
  SettlementFailedError,
} from '../core/errors.js';
import { type Micros, ZERO, micros } from '../core/money.js';
import type { Quote, Receipt } from '../core/types.js';
import {
  PAYMENT_HEADER,
  RECEIPT_HEADER,
  decodeChargeReceipt,
  encodeAuthorization,
} from './protocol.js';

export interface PaidResult<T = unknown> {
  readonly ok: boolean;
  readonly status: number;
  readonly body: T;
  /** What this call actually cost. Zero for free endpoints. */
  readonly cost: Micros;
  readonly paid: boolean;
  readonly receipt?: Receipt;
  readonly quote?: Quote;
  /** Wall-clock milliseconds, for the throughput number. */
  readonly durationMs: number;
}

export interface PaidClientOptions {
  readonly engine: PolicyEngine;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class PaidClient {
  private readonly engine: PolicyEngine;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: PaidClientOptions) {
    this.engine = opts.engine;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * Fetch a resource, paying for it if asked.
   *
   * Throws a {@link PaiseError} when payment is refused by our own policy or by
   * a counterparty's misbehaviour. Ordinary HTTP failures come back as a result
   * with `ok: false` — they are not budget events.
   */
  async get<T = unknown>(url: string, init: RequestInit = {}): Promise<PaidResult<T>> {
    const startedAt = Date.now();

    // ---- Attempt 1: maybe it is free. ------------------------------------
    const first = await this.request(url, init);

    if (first.status !== 402) {
      return {
        ok: first.ok,
        status: first.status,
        body: (await this.readBody(first)) as T,
        cost: ZERO,
        paid: false,
        durationMs: Date.now() - startedAt,
      };
    }

    // ---- It costs money. Parse the quote. --------------------------------
    const quote = await this.parseQuote(first);

    // Throws a typed refusal if we cannot or may not pay. Nothing is held.
    const authorization = this.engine.authorize(quote);

    let settled = false;
    try {
      const second = await this.request(url, {
        ...init,
        headers: { ...(init.headers ?? {}), [PAYMENT_HEADER]: encodeAuthorization(authorization) },
      });

      if (second.status === 402 || second.status >= 400) {
        // Paid nothing, got nothing. Release and report as a plain HTTP failure.
        return {
          ok: false,
          status: second.status,
          body: (await this.readBody(second)) as T,
          cost: ZERO,
          paid: false,
          quote,
          durationMs: Date.now() - startedAt,
        };
      }

      const receiptHeader = second.headers.get(RECEIPT_HEADER);
      if (!receiptHeader) {
        throw new ProtocolViolationError(
          'missing-receipt',
          `${quote.provider} served a paid resource without an ${RECEIPT_HEADER} header`,
        );
      }

      // Throws QuoteExceededError / ReplayDetectedError / etc. on misbehaviour.
      const charge = decodeChargeReceipt(receiptHeader);
      const receipt = this.engine.settle(charge);
      settled = true;

      return {
        ok: true,
        status: second.status,
        body: (await this.readBody(second)) as T,
        cost: receipt.settledAmount,
        paid: true,
        receipt,
        quote,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      // Covers every path that did not reach a successful settlement:
      // network error, 5xx, refused overcharge, thrown protocol violation.
      if (!settled) this.engine.release(authorization.authId, 'request did not settle');
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async parseQuote(res: Response): Promise<Quote> {
    const body = (await this.readBody(res)) as { quote?: unknown };
    const raw = body?.quote;
    if (typeof raw !== 'object' || raw === null) {
      throw new ProtocolViolationError('payment-required', '402 body did not contain a quote');
    }
    const q = raw as Record<string, unknown>;
    for (const field of ['quoteId', 'provider', 'resource', 'nonce', 'scheme'] as const) {
      if (typeof q[field] !== 'string') {
        throw new ProtocolViolationError('quote', `missing or non-string "${field}"`);
      }
    }
    if (typeof q['amount'] !== 'number' || !Number.isSafeInteger(q['amount'])) {
      throw new ProtocolViolationError('quote', 'amount must be an integer count of µINR');
    }
    if (q['currency'] !== 'INR') {
      throw new ProtocolViolationError('quote', `unsupported currency ${String(q['currency'])}`);
    }
    for (const field of ['issuedAt', 'expiresAt'] as const) {
      if (typeof q[field] !== 'number') {
        throw new ProtocolViolationError('quote', `"${field}" must be a number`);
      }
    }

    return {
      quoteId: q['quoteId'] as string,
      provider: q['provider'] as string,
      resource: q['resource'] as string,
      amount: micros(q['amount'] as number),
      currency: 'INR',
      issuedAt: q['issuedAt'] as number,
      expiresAt: q['expiresAt'] as number,
      nonce: q['nonce'] as string,
      scheme: q['scheme'] as string,
      payTo: typeof q['payTo'] === 'string' ? q['payTo'] : '',
    };
  }
}

export { PaiseError, SettlementFailedError };
