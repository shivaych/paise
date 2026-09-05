/**
 * Razorpay settlement rail.
 *
 * ┌─ Verification status ─────────────────────────────────────────────────────┐
 * │                                                                           │
 * │  VERIFIED against a live Razorpay test account (2026-09-05):              │
 * │    createTopUpLink()       created plink_TYPQHBDUJ52i8q end to end.        │
 * │    HTTP auth + error path  GET /payments returned 200 with these keys.     │
 * │    verifyWebhookSignature()  a real payment.captured for pay_TYPexHVrGuvCyz│
 * │                            reached the app over a public tunnel, verified, │
 * │                            and credited Rs.500 to the ledger. A forged     │
 * │                            message on the same endpoint got a 400.         │
 * │                            Plus 13 tests in tests/webhook.test.ts.         │
 * │                                                                           │
 * │  NOT YET RUN — blocked on access, not on code:                            │
 * │    debit()    needs an authorised UPI Autopay mandate token.               │
 * │    payout()   needs a RazorpayX account, provisioned separately from a     │
 * │               standard test key.                                           │
 * │                                                                           │
 * │  Settlement still defaults to MockRail. Do not describe payouts as         │
 * │  working until this note says they are.                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Design point worth keeping regardless of credential status: the ledger is
 * credited from the *webhook*, never from the API response to our own debit
 * call. An API response says "accepted"; a webhook says "settled". Crediting on
 * the former is how you end up spending money that never arrived.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MandateViolationError, SettlementFailedError } from '../core/errors.js';
import { type Micros, MICROS_PER_PAISA, micros } from '../core/money.js';
import type {
  DebitInput,
  MandateInfo,
  PayoutInput,
  RailCredit,
  RailPayout,
  SettlementRail,
} from './rail.js';

const API_BASE = 'https://api.razorpay.com/v1';

/**
 * Razorpay denominates in paise. We denominate in µINR (1 paisa = 10,000 µINR).
 * Converting is the single most dangerous line in this file: a factor-of-100
 * slip here is a hundredfold overcharge, so it refuses to round.
 */
export function microsToPaise(amount: Micros): number {
  if (amount % MICROS_PER_PAISA !== 0) {
    throw new RangeError(
      `${amount} µINR is not a whole number of paise. Razorpay cannot represent sub-paisa ` +
        `amounts; aggregate before settling rather than rounding here.`,
    );
  }
  return amount / MICROS_PER_PAISA;
}

export function paiseToMicros(p: number): Micros {
  if (!Number.isSafeInteger(p)) throw new RangeError(`Paise must be an integer, got ${p}`);
  return micros(p * MICROS_PER_PAISA);
}

/**
 * Verify a Razorpay webhook.
 *
 * Must be given the RAW request body, byte for byte. Re-serialising parsed JSON
 * changes key order and whitespace and the signature will never match — mount
 * `express.raw({ type: 'application/json' })` on the webhook route, not
 * `express.json()`.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  webhookSecret: string,
): boolean {
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface RazorpayRailOptions {
  readonly keyId: string;
  readonly keySecret: string;
  /** Subscription / token id representing the authorised UPI Autopay mandate. */
  readonly mandateTokenId: string;
  readonly customerId: string;
  /** Bank-enforced per-debit ceiling agreed when the mandate was authorised. */
  readonly maxAmountPerDebit: Micros;
  readonly mandateValidUntil: number;
  /** RazorpayX account number, required for payouts. */
  readonly payoutAccountNumber?: string;
  readonly fetchImpl?: typeof fetch;
}

export class RazorpayRail implements SettlementRail {
  readonly name = 'razorpay';

  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RazorpayRailOptions) {
    this.auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async mandate(): Promise<MandateInfo> {
    return {
      mandateId: this.opts.mandateTokenId,
      maxAmountPerDebit: this.opts.maxAmountPerDebit,
      frequency: 'as_presented',
      validUntil: this.opts.mandateValidUntil,
      status: Date.now() > this.opts.mandateValidUntil ? 'expired' : 'active',
      rail: this.name,
    };
  }

  /**
   * Present the mandate for a debit.
   *
   * The local ceiling check below is belt-and-braces: the bank enforces the
   * same limit and its refusal is the one that counts. Checking here too just
   * turns a remote failure into a local one with a better message.
   */
  async debit(input: DebitInput): Promise<RailCredit> {
    if (input.amount > this.opts.maxAmountPerDebit) {
      throw new MandateViolationError(
        this.opts.mandateTokenId,
        'amount exceeds the per-debit ceiling authorised by the customer',
        input.amount,
        this.opts.maxAmountPerDebit,
      );
    }

    const body = {
      amount: microsToPaise(input.amount),
      currency: 'INR',
      customer_id: this.opts.customerId,
      token: this.opts.mandateTokenId,
      recurring: '1',
      description: input.note ?? 'Agent budget top-up',
      receipt: input.idempotencyKey,
    };

    const json = await this.call<{ id: string; status: string; amount: number }>(
      'POST',
      '/payments/create/recurring',
      body,
      input.idempotencyKey,
    );

    return {
      railRef: json.id,
      amount: paiseToMicros(json.amount),
      at: Date.now(),
    };
  }

  /**
   * Create a hosted payment link for a top-up.
   *
   * This is the demo-able funding path: a standard test key can create these,
   * whereas a recurring mandate debit needs an authorised UPI Autopay token
   * that test mode makes awkward to obtain. Paying the link in test mode fires
   * a real `payment.captured` webhook, which is what actually credits the
   * ledger — so the full money-in loop is exercised for real.
   *
   * `notes.agent_id` is what the webhook matches on, so a link created for one
   * agent cannot fund another.
   */
  async createTopUpLink(input: {
    amount: Micros;
    agentId: string;
    description?: string;
    callbackUrl?: string;
  }): Promise<{ id: string; shortUrl: string; amount: Micros; status: string }> {
    const body = {
      amount: microsToPaise(input.amount),
      currency: 'INR',
      accept_partial: false,
      description: input.description ?? `Budget top-up for ${input.agentId}`,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { agent_id: input.agentId, purpose: 'paise-topup' },
      ...(input.callbackUrl
        ? { callback_url: input.callbackUrl, callback_method: 'get' }
        : {}),
    };

    const json = await this.call<{
      id: string;
      short_url: string;
      amount: number;
      status: string;
    }>('POST', '/payment_links', body, `link:${input.agentId}:${Date.now()}`);

    return {
      id: json.id,
      shortUrl: json.short_url,
      amount: paiseToMicros(json.amount),
      status: json.status,
    };
  }

  /** Settle accumulated micro-charges to a provider via RazorpayX. */
  async payout(input: PayoutInput): Promise<RailPayout> {
    if (!this.opts.payoutAccountNumber) {
      throw new SettlementFailedError(
        this.name,
        'RazorpayX account number not configured; payouts unavailable',
      );
    }

    const body = {
      account_number: this.opts.payoutAccountNumber,
      amount: microsToPaise(input.amount),
      currency: 'INR',
      mode: 'UPI',
      purpose: 'payout',
      fund_account: { id: input.destination },
      queue_if_low_balance: true,
      reference_id: input.idempotencyKey,
      narration: input.note ?? `paise settlement: ${input.provider}`,
    };

    const json = await this.call<{ id: string; status: string; amount: number }>(
      'POST',
      '/payouts',
      body,
      input.idempotencyKey,
    );

    return {
      railRef: json.id,
      provider: input.provider,
      amount: paiseToMicros(json.amount),
      at: Date.now(),
      status: (json.status as RailPayout['status']) ?? 'queued',
    };
  }

  private async call<T>(
    method: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          'Content-Type': 'application/json',
          'X-Payout-Idempotency': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new SettlementFailedError(
        this.name,
        `network error calling ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new SettlementFailedError(this.name, `${path} returned ${res.status}: ${text}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SettlementFailedError(this.name, `${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}
