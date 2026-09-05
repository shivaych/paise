/**
 * Razorpay webhook receiver.
 *
 * This is the *only* thing allowed to credit the ledger with real money.
 *
 * The temptation is to credit as soon as our own `debit()` call returns 200.
 * Don't. An API response says "accepted"; a webhook says "settled". Crediting
 * the former is how an agent ends up confidently spending money that never
 * arrived. `Treasury.ensureFunded()` calls the API; this credits the ledger.
 *
 * Three properties this must have, all of which have bitten real integrations:
 *
 *   1. **Raw body.** The signature is HMAC-SHA256 over the exact bytes sent.
 *      Re-serialising parsed JSON reorders keys and changes whitespace, and the
 *      signature will never match. Mount `express.raw`, never `express.json`.
 *
 *   2. **Idempotency.** Razorpay retries webhooks — on timeout, on 5xx, and
 *      sometimes just because. The Razorpay payment id is used as the ledger
 *      event id, so a redelivery is a no-op rather than free money.
 *
 *   3. **Correct status codes.** 400 on a bad signature (do not retry, it will
 *      never succeed). 500 on a transient internal failure (please retry).
 *      200 on anything understood, including events we deliberately ignore —
 *      a non-2xx makes Razorpay retry an event we already handled.
 */

import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { Ledger } from '../core/ledger.js';
import type { Micros } from '../core/money.js';
import { format } from '../core/money.js';
import { paiseToMicros, verifyWebhookSignature } from './razorpay.js';

export const SIGNATURE_HEADER = 'x-razorpay-signature';

/** Events that mean "money arrived". */
const CREDIT_EVENTS = new Set(['payment.captured', 'subscription.charged', 'order.paid']);

/** Events that update the state of money we sent out. */
const PAYOUT_EVENTS = new Set([
  'payout.processed',
  'payout.failed',
  'payout.reversed',
  'payout.rejected',
]);

export type WebhookOutcome =
  | { kind: 'credited'; eventId: string; amount: Micros; railRef: string; duplicate: boolean }
  | { kind: 'payout-update'; railRef: string; status: string; amount: Micros }
  | { kind: 'ignored'; event: string; reason: string };

export interface RazorpayWebhookOptions {
  readonly ledger: Ledger;
  readonly webhookSecret: string;
  /**
   * Only credit payments whose `notes.agent_id` matches, when the note is
   * present. Stops one agent's top-up landing in another's budget.
   */
  readonly agentId?: string;
  readonly onOutcome?: (outcome: WebhookOutcome) => void;
  readonly onPayout?: (railRef: string, status: string, amount: Micros) => void;
}

interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayEntity };
    payout?: { entity?: RazorpayEntity };
    order?: { entity?: RazorpayEntity };
    subscription?: { entity?: RazorpayEntity };
  };
}

interface RazorpayEntity {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  notes?: Record<string, unknown>;
}

/**
 * Decide what an event means. Pure — no ledger writes, no I/O — so the
 * interesting branches are testable without an HTTP server or a Razorpay account.
 */
export function interpretEvent(parsed: RazorpayEvent, agentId?: string): WebhookOutcome {
  const event = parsed.event ?? 'unknown';

  if (CREDIT_EVENTS.has(event)) {
    const entity =
      parsed.payload?.payment?.entity ?? parsed.payload?.order?.entity ?? undefined;

    if (!entity?.id || typeof entity.amount !== 'number') {
      return { kind: 'ignored', event, reason: 'missing payment id or amount' };
    }
    if (entity.currency && entity.currency !== 'INR') {
      return { kind: 'ignored', event, reason: `unsupported currency ${entity.currency}` };
    }

    const noteAgent = entity.notes?.['agent_id'];
    if (agentId && typeof noteAgent === 'string' && noteAgent !== agentId) {
      return { kind: 'ignored', event, reason: `payment is for agent ${noteAgent}, not ${agentId}` };
    }

    return {
      kind: 'credited',
      eventId: entity.id,
      amount: paiseToMicros(entity.amount),
      railRef: entity.id,
      duplicate: false,
    };
  }

  if (PAYOUT_EVENTS.has(event)) {
    const entity = parsed.payload?.payout?.entity;
    if (!entity?.id || typeof entity.amount !== 'number') {
      return { kind: 'ignored', event, reason: 'missing payout id or amount' };
    }
    return {
      kind: 'payout-update',
      railRef: entity.id,
      status: entity.status ?? event.split('.')[1] ?? 'unknown',
      amount: paiseToMicros(entity.amount),
    };
  }

  return { kind: 'ignored', event, reason: 'event not relevant to the budget ledger' };
}

export function razorpayWebhookHandler(opts: RazorpayWebhookOptions): RequestHandler {
  return function handler(req: Request, res: Response) {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) {
      // Almost always means express.json() is mounted ahead of this route.
      res.status(500).json({
        error: 'webhook route did not receive a raw body',
        hint: 'mount express.raw({ type: "*/*" }) on this route, before express.json()',
      });
      return;
    }

    const signature = req.header(SIGNATURE_HEADER);
    if (!signature) {
      res.status(400).json({ error: `missing ${SIGNATURE_HEADER}` });
      return;
    }
    // A bad signature will never become good: 400, so Razorpay stops retrying.
    if (!verifyWebhookSignature(raw, signature, opts.webhookSecret)) {
      res.status(400).json({ error: 'signature verification failed' });
      return;
    }

    let parsed: RazorpayEvent;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'body is not valid JSON' });
      return;
    }

    let outcome: WebhookOutcome;
    try {
      outcome = interpretEvent(parsed, opts.agentId);

      if (outcome.kind === 'credited') {
        const before = opts.ledger.funding().length;
        opts.ledger.credit({
          kind: 'topup',
          amount: outcome.amount,
          railRef: outcome.railRef,
          eventId: outcome.eventId, // idempotency: a redelivery is a no-op
          note: `razorpay ${parsed.event}`,
        });
        const duplicate = opts.ledger.funding().length === before;
        outcome = { ...outcome, duplicate };
      }

      if (outcome.kind === 'payout-update') {
        opts.onPayout?.(outcome.railRef, outcome.status, outcome.amount);
      }
    } catch (e) {
      // Transient or unexpected: 500 asks Razorpay to try again.
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }

    opts.onOutcome?.(outcome);
    res.status(200).json({ ok: true, outcome: describe(outcome) });
  };
}

function describe(outcome: WebhookOutcome): string {
  switch (outcome.kind) {
    case 'credited':
      return outcome.duplicate
        ? `duplicate delivery of ${outcome.eventId} — ignored`
        : `credited ${format(outcome.amount)} (${outcome.railRef})`;
    case 'payout-update':
      return `payout ${outcome.railRef} is ${outcome.status}`;
    case 'ignored':
      return `ignored ${outcome.event}: ${outcome.reason}`;
  }
}

/** Mount at a path with the correct body parser already applied. */
export function mountRazorpayWebhook(
  app: Express,
  opts: RazorpayWebhookOptions & { path?: string },
): void {
  app.post(
    opts.path ?? '/webhooks/razorpay',
    express.raw({ type: '*/*' }),
    razorpayWebhookHandler(opts),
  );
}
