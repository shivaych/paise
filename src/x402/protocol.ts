/**
 * The x402 wire format.
 *
 * The exchange, end to end:
 *
 *   1. GET /report                       -> 402 + PaymentRequiredBody (the quote)
 *   2. agent authorizes locally          -> Authorization (a hold now exists)
 *   3. GET /report  X-Payment: <auth>    -> 200 + X-Payment-Receipt (the charge)
 *   4. agent settles locally             -> Receipt (hold becomes spend)
 *
 * Step 4 is the one most implementations skip, and it is the one that makes
 * overcharging detectable: the provider states its charge in a header we
 * check against the hold *before* recording any spend.
 *
 * Deviation from Coinbase's x402, stated plainly: that spec settles on-chain
 * against an EVM scheme (`exact` / USDC on Base). This is the same envelope
 * with an INR scheme (`paise-ledger-v1`) that settles against a pre-funded
 * ledger backed by a UPI Autopay mandate. It is a proposed scheme, not a
 * conformant implementation, and it should not claim otherwise.
 */

import { ProtocolViolationError } from '../core/errors.js';
import type { Micros } from '../core/money.js';
import { micros } from '../core/money.js';
import { newId, newNonce } from '../core/signer.js';
import type { Authorization, Charge, Quote } from '../core/types.js';

export const PAYMENT_HEADER = 'x-payment';
export const RECEIPT_HEADER = 'x-payment-receipt';
export const X402_VERSION = 1;
export const DEFAULT_QUOTE_TTL_MS = 60_000;

/** The JSON body served alongside an HTTP 402. */
export interface PaymentRequiredBody {
  readonly x402Version: number;
  readonly scheme: string;
  readonly message: string;
  readonly quote: Quote;
}

/** The JSON carried in `X-Payment-Receipt` on a successful 200. */
export interface ChargeReceiptBody {
  readonly authId: string;
  readonly quoteId: string;
  /** Integer µINR actually charged. */
  readonly amount: number;
  readonly providerRef?: string;
}

export interface CreateQuoteInput {
  readonly provider: string;
  readonly resource: string;
  readonly amount: Micros;
  readonly now: number;
  readonly ttlMs?: number;
  readonly payTo?: string;
  readonly scheme?: string;
}

export function createQuote(input: CreateQuoteInput): Quote {
  const ttl = input.ttlMs ?? DEFAULT_QUOTE_TTL_MS;
  return {
    quoteId: newId('quote'),
    provider: input.provider,
    resource: input.resource,
    amount: input.amount,
    currency: 'INR',
    issuedAt: input.now,
    expiresAt: input.now + ttl,
    nonce: newNonce(),
    scheme: input.scheme ?? 'paise-ledger-v1',
    payTo: input.payTo ?? `upi://${input.provider}`,
  };
}

export function paymentRequiredBody(quote: Quote, message?: string): PaymentRequiredBody {
  return {
    x402Version: X402_VERSION,
    scheme: quote.scheme,
    message: message ?? `Payment required: ${quote.amount} µINR for ${quote.resource}`,
    quote,
  };
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(header: string, what: string): unknown {
  let text: string;
  try {
    text = Buffer.from(header, 'base64url').toString('utf8');
  } catch {
    throw new ProtocolViolationError(what, 'header is not valid base64url');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolViolationError(what, 'header does not contain valid JSON');
  }
}

export function encodeAuthorization(auth: Authorization): string {
  return encode(auth);
}

/** Structural validation only. Signature verification is the server's job. */
export function decodeAuthorization(header: string): Authorization {
  const raw = decode(header, 'authorization');
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolViolationError('authorization', 'expected a JSON object');
  }
  const a = raw as Record<string, unknown>;
  const required = [
    'authId',
    'quoteId',
    'agentId',
    'provider',
    'resource',
    'nonce',
    'scheme',
    'signature',
  ] as const;
  for (const field of required) {
    if (typeof a[field] !== 'string') {
      throw new ProtocolViolationError('authorization', `missing or non-string field "${field}"`);
    }
  }
  for (const field of ['maxAmount', 'issuedAt', 'expiresAt'] as const) {
    if (typeof a[field] !== 'number' || !Number.isSafeInteger(a[field])) {
      throw new ProtocolViolationError('authorization', `field "${field}" must be a safe integer`);
    }
  }
  if ((a['maxAmount'] as number) < 0) {
    throw new ProtocolViolationError('authorization', 'maxAmount must not be negative');
  }
  return {
    authId: a['authId'] as string,
    quoteId: a['quoteId'] as string,
    agentId: a['agentId'] as string,
    provider: a['provider'] as string,
    resource: a['resource'] as string,
    maxAmount: micros(a['maxAmount'] as number),
    nonce: a['nonce'] as string,
    issuedAt: a['issuedAt'] as number,
    expiresAt: a['expiresAt'] as number,
    scheme: a['scheme'] as string,
    signature: a['signature'] as string,
  };
}

export function encodeChargeReceipt(body: ChargeReceiptBody): string {
  return encode(body);
}

export function decodeChargeReceipt(header: string): Charge {
  const raw = decode(header, 'charge-receipt');
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolViolationError('charge-receipt', 'expected a JSON object');
  }
  const c = raw as Record<string, unknown>;
  if (typeof c['authId'] !== 'string' || typeof c['quoteId'] !== 'string') {
    throw new ProtocolViolationError('charge-receipt', 'authId and quoteId must be strings');
  }
  if (typeof c['amount'] !== 'number' || !Number.isSafeInteger(c['amount'])) {
    throw new ProtocolViolationError('charge-receipt', 'amount must be an integer count of µINR');
  }
  return {
    authId: c['authId'],
    quoteId: c['quoteId'],
    amount: micros(c['amount']),
    ...(typeof c['providerRef'] === 'string' ? { providerRef: c['providerRef'] } : {}),
  };
}
