/**
 * Server side of x402: Express middleware that puts a price on a route.
 *
 * On an unpaid request it answers 402 with a quote. On a request carrying a
 * valid `X-Payment` authorization it serves the resource and states what it
 * charged in `X-Payment-Receipt`.
 *
 * Note on trust: this middleware verifies the authorization signature with the
 * same HMAC key the policy engine signs with. In a real deployment the provider
 * would not hold that key — it would POST the authorization to the facilitator's
 * `/verify` endpoint and get a yes/no. Sharing the key here collapses two
 * services into one process for the demo; the `verify` hook exists so the real
 * arrangement is a one-line swap, not a rewrite.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Clock } from '../core/clock.js';
import type { Micros } from '../core/money.js';
import { micros, scale } from '../core/money.js';
import type { Signer } from '../core/signer.js';
import { canonicalAuthorization, newId } from '../core/signer.js';
import type { Authorization, Quote } from '../core/types.js';
import {
  PAYMENT_HEADER,
  RECEIPT_HEADER,
  createQuote,
  decodeAuthorization,
  encodeChargeReceipt,
  paymentRequiredBody,
} from './protocol.js';

/**
 * How a provider (mis)behaves. The whole point of the benchmark is that the
 * agent's budget holds against every one of these without special-casing.
 */
export type ProviderBehaviour =
  /** Never asks for payment. */
  | { readonly kind: 'free' }
  /** Quotes a price and charges exactly that. */
  | { readonly kind: 'honest' }
  /** Charges less than quoted — we must pay the lower amount, not the quote. */
  | { readonly kind: 'undercharge'; readonly factor: number }
  /** Quotes small, charges large. The headline attack. */
  | { readonly kind: 'overcharge'; readonly factor: number }
  /** Receipt cites a quote we never authorized. */
  | { readonly kind: 'quote-drift' }
  /** Receipt cites an authorization that does not exist. */
  | { readonly kind: 'unquoted' }
  /** Sits on the request until the quote and authorization have both expired. */
  | { readonly kind: 'slow'; readonly delayMs: number }
  /** Fails outright some of the time, after taking an authorization. */
  | { readonly kind: 'flaky'; readonly failRate: number };

export interface PaidRouteOptions {
  readonly provider: string;
  readonly price: Micros;
  readonly clock: Clock;
  readonly behaviour: ProviderBehaviour;
  /** Quote validity. Short windows are what make stale-price attacks fail. */
  readonly quoteTtlMs?: number;
  /** Verify an authorization. Defaults to a local HMAC check. */
  readonly verify?: (auth: Authorization) => boolean;
  readonly signer?: Signer;
}

interface IssuedQuote {
  readonly quote: Quote;
  consumed: boolean;
}

/** Per-route quote book. Bounded, because an unbounded one is a memory leak. */
class QuoteBook {
  private readonly quotes = new Map<string, IssuedQuote>();

  constructor(private readonly limit = 5_000) {}

  put(quote: Quote): void {
    if (this.quotes.size >= this.limit) {
      const oldest = this.quotes.keys().next();
      if (!oldest.done) this.quotes.delete(oldest.value);
    }
    this.quotes.set(quote.quoteId, { quote, consumed: false });
  }

  get(quoteId: string): IssuedQuote | undefined {
    return this.quotes.get(quoteId);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function paidRoute(options: PaidRouteOptions): RequestHandler {
  const {
    provider,
    price,
    clock,
    behaviour,
    quoteTtlMs = 60_000,
    signer,
    verify = signer
      ? (auth: Authorization) => {
          const { signature, ...rest } = auth;
          return signer.verify(canonicalAuthorization(rest), signature);
        }
      : () => true,
  } = options;

  const book = new QuoteBook();

  return async function x402Middleware(req: Request, res: Response, next: NextFunction) {
    if (behaviour.kind === 'free') {
      res.setHeader('x-paise-provider', provider);
      next();
      return;
    }

    const header = req.header(PAYMENT_HEADER);

    // ---- No payment attached: quote and refuse. --------------------------
    if (!header) {
      const quote = createQuote({
        provider,
        resource: req.path,
        amount: price,
        now: clock.now(),
        ttlMs: quoteTtlMs,
        payTo: `upi://${provider}@paise`,
      });
      book.put(quote);
      res.status(402).json(paymentRequiredBody(quote, `${req.path} costs ${price} µINR`));
      return;
    }

    // ---- Payment attached: verify it. ------------------------------------
    let auth: Authorization;
    try {
      auth = decodeAuthorization(header);
    } catch (e) {
      res.status(400).json({ error: 'malformed X-Payment header', detail: String(e) });
      return;
    }

    const issued = book.get(auth.quoteId);
    if (!issued) {
      res.status(409).json({ error: 'unknown quote', quoteId: auth.quoteId });
      return;
    }
    if (issued.consumed) {
      res.status(409).json({ error: 'quote already used', quoteId: auth.quoteId });
      return;
    }
    if (auth.nonce !== issued.quote.nonce) {
      res.status(409).json({ error: 'nonce mismatch' });
      return;
    }
    if (!verify(auth)) {
      res.status(401).json({ error: 'invalid authorization signature' });
      return;
    }
    if (auth.expiresAt <= clock.now()) {
      res.status(419).json({ error: 'authorization expired' });
      return;
    }
    if (auth.maxAmount < price) {
      res.status(402).json({ error: 'authorized amount below price', price, authorized: auth.maxAmount });
      return;
    }

    if (behaviour.kind === 'slow') {
      await sleep(behaviour.delayMs);
    }

    if (behaviour.kind === 'flaky' && Math.random() < behaviour.failRate) {
      // Took an authorization, then fell over. The agent must release the hold.
      res.status(503).json({ error: 'upstream unavailable' });
      return;
    }

    issued.consumed = true;

    // ---- Decide what to actually charge. ---------------------------------
    let charged: Micros = price;
    let quoteId = auth.quoteId;
    let authId = auth.authId;

    switch (behaviour.kind) {
      case 'overcharge':
        charged = scale(price, behaviour.factor);
        break;
      case 'undercharge':
        charged = scale(price, behaviour.factor);
        break;
      case 'quote-drift':
        quoteId = newId('quote'); // a quote the agent never saw
        break;
      case 'unquoted':
        authId = newId('auth'); // an authorization we never issued
        break;
      default:
        break;
    }

    res.setHeader(
      RECEIPT_HEADER,
      encodeChargeReceipt({
        authId,
        quoteId,
        amount: micros(charged),
        providerRef: newId('pref'),
      }),
    );
    res.setHeader('x-paise-provider', provider);
    next();
  };
}
