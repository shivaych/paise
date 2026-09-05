/**
 * Authorization signing.
 *
 * An authorization is a bearer instrument: whoever holds it can claim up to
 * `maxAmount` from us. So it is signed, and the signature covers every field
 * that constrains the payment — amount, provider, quote, nonce and expiry.
 * Change any of them and the signature no longer verifies.
 *
 * HMAC-SHA256, not ECDSA. The crypto-rail version of this design signs with a
 * session key because the *verifier is a stranger* (a smart contract). Here the
 * issuer and the verifier are both us, so a symmetric MAC is the correct
 * primitive: same integrity guarantee, no key management, no chain.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Authorization, Quote } from './types.js';

export interface Signer {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

export class HmacSigner implements Signer {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) {
      throw new Error('Signing secret must be at least 16 characters');
    }
    this.key = Buffer.from(secret, 'utf8');
  }

  sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload, 'utf8').digest('hex');
  }

  /** Constant-time comparison — signature checks must not leak timing. */
  verify(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload), 'hex');
    let given: Buffer;
    try {
      given = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    if (given.length !== expected.length) return false;
    return timingSafeEqual(expected, given);
  }
}

/**
 * Deterministic serialisation of everything an authorization promises.
 * Field order is fixed and must never change without a scheme version bump.
 */
export function canonicalAuthorization(auth: Omit<Authorization, 'signature'>): string {
  return [
    'paise-auth-v1',
    auth.authId,
    auth.quoteId,
    auth.agentId,
    auth.provider,
    auth.resource,
    String(auth.maxAmount),
    auth.nonce,
    String(auth.issuedAt),
    String(auth.expiresAt),
    auth.scheme,
  ].join('\n');
}

/** Deterministic serialisation of a quote, so a provider can prove what it offered. */
export function canonicalQuote(quote: Quote): string {
  return [
    'paise-quote-v1',
    quote.quoteId,
    quote.provider,
    quote.resource,
    String(quote.amount),
    quote.currency,
    String(quote.issuedAt),
    String(quote.expiresAt),
    quote.nonce,
    quote.scheme,
    quote.payTo,
  ].join('\n');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function newNonce(): string {
  return randomBytes(12).toString('base64url');
}
