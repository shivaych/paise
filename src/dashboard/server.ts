/**
 * The demo dashboard.
 *
 * Runs the whole stack in one process — provider fleet, policy engine, ledger,
 * treasury — and exposes it as a page you can watch while an agent spends.
 *
 * Built for the moment in a demo where you point at the screen and say "that
 * API just tried to charge fifty rupees against a fifty-paisa quote, and the
 * budget bar did not move."
 */

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DASHBOARD_PORT, DEMO_POLICY, DEMO_TOPUP, SIGNING_SECRET } from '../config.js';
import { systemClock } from '../core/clock.js';
import { isPaiseError } from '../core/errors.js';
import { Ledger } from '../core/ledger.js';
import { isMainModule } from '../core/main.js';
import { type Micros, ZERO, format, rupees } from '../core/money.js';
import { PolicyEngine, type PolicyEvent } from '../core/policy.js';
import { HmacSigner } from '../core/signer.js';
import { MockRail } from '../rails/mock.js';
import { Treasury } from '../rails/treasury.js';
import { FLEET } from '../providers/fleet.js';
import { startProviders } from '../providers/server.js';
import { PaidClient } from '../x402/client.js';
import { Planner, type ToolOption } from '../agent/planner.js';
import { defaultReasoner, fallbackReasoner } from '../agent/reasoners.js';
import { mountRazorpayWebhook } from '../rails/webhook.js';

const MAX_EVENTS = 200;

interface FeedEntry {
  readonly at: number;
  readonly kind: string;
  readonly provider?: string;
  readonly amount?: Micros;
  readonly code?: string;
  readonly message: string;
  readonly severity: 'ok' | 'refused' | 'attack' | 'info';
}

const ATTACK_CODES = new Set([
  'QUOTE_EXCEEDED',
  'UNQUOTED_CHARGE',
  'REPLAY_DETECTED',
  'PROTOCOL_VIOLATION',
  'AUTHORIZATION_EXPIRED',
]);

export async function startDashboard(port = DASHBOARD_PORT) {
  const feed: FeedEntry[] = [];
  const push = (entry: FeedEntry) => {
    feed.unshift(entry);
    if (feed.length > MAX_EVENTS) feed.pop();
  };

  const ledger = new Ledger(DEMO_POLICY.agentId, systemClock);
  const engine = new PolicyEngine({
    policy: DEMO_POLICY,
    ledger,
    clock: systemClock,
    signer: new HmacSigner(SIGNING_SECRET),
    onEvent: (e: PolicyEvent) => push(toFeedEntry(e)),
  });

  const rail = new MockRail({ clock: systemClock, maxAmountPerDebit: DEMO_TOPUP });
  const treasury = new Treasury({
    ledger,
    rail,
    clock: systemClock,
    topUpAmount: DEMO_TOPUP,
    lowWaterMark: rupees(50),
    minPayout: rupees(1),
  });

  const { port: providerPort } = await startProviders(0);
  const base = `http://127.0.0.1:${providerPort}`;
  const client = new PaidClient({ engine, timeoutMs: 8_000 });
  const reasoner = defaultReasoner();
  const planner = new Planner({ engine, reasoner, fallback: fallbackReasoner() });
  console.log(`  planner reasoner: ${reasoner.name}`);

  await treasury.ensureFunded();
  push({
    at: Date.now(),
    kind: 'topup',
    amount: DEMO_TOPUP,
    message: `Mandate debit of ${format(DEMO_TOPUP)} cleared — agent funded`,
    severity: 'info',
  });

  const app = express();

  // Mounted BEFORE express.json(): the webhook signature is computed over the
  // raw bytes, and a JSON round-trip changes them. Order is load-bearing.
  const webhookSecret = process.env['RAZORPAY_WEBHOOK_SECRET'];
  if (webhookSecret) {
    mountRazorpayWebhook(app, {
      ledger,
      webhookSecret,
      agentId: DEMO_POLICY.agentId,
      onOutcome: (outcome) =>
        push({
          at: Date.now(),
          kind: `webhook:${outcome.kind}`,
          ...(outcome.kind === 'credited' ? { amount: outcome.amount } : {}),
          message:
            outcome.kind === 'credited'
              ? `Razorpay webhook credited ${format(outcome.amount)} (${outcome.railRef})`
              : outcome.kind === 'payout-update'
                ? `Payout ${outcome.railRef} is ${outcome.status}`
                : `Webhook ignored: ${outcome.reason}`,
          severity: 'info',
        }),
    });
    console.log('  razorpay webhook: POST /webhooks/razorpay');
  } else {
    console.log('  razorpay webhook: disabled (RAZORPAY_WEBHOOK_SECRET not set)');
  }

  app.use(express.json());
  app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')));

  app.get('/api/state', async (_req, res) => {
    res.json({
      status: engine.status(),
      mandate: await rail.mandate(),
      treasury: treasury.status(),
      feed: feed.slice(0, 60),
      receipts: ledger
        .receipts()
        .slice(-25)
        .reverse()
        .map((r) => ({
          seq: r.seq,
          provider: r.provider,
          resource: r.resource,
          quoted: r.quotedAmount,
          settled: r.settledAmount,
          at: r.settledAt,
          hash: r.hash.slice(0, 12),
          railRef: r.railRef ?? null,
        })),
      audit: {
        chain: ledger.verifyChain(),
        doubleEntry: ledger.verifyIntegrity(),
        receipts: ledger.receipts().length,
      },
      fleet: FLEET.map((p) => ({
        id: p.id,
        path: p.path,
        price: p.price,
        label: p.label,
        hostile: p.hostile,
      })),
    });
  });

  /** Fire a batch of agent requests at the fleet. */
  app.post('/api/run', async (req, res) => {
    const count = Math.min(Number(req.body?.count ?? 10), 200);
    const only = typeof req.body?.provider === 'string' ? req.body.provider : undefined;
    const pool = only ? FLEET.filter((p) => p.id === only) : FLEET;
    if (pool.length === 0) {
      res.status(400).json({ error: `unknown provider ${only}` });
      return;
    }

    let paid = 0;
    let refused = 0;
    await Promise.all(
      Array.from({ length: count }, async (_v, i) => {
        const spec = pool[i % pool.length]!;
        try {
          const result = await client.get(`${base}${spec.path}`);
          if (result.paid) paid++;
        } catch (e) {
          refused++;
          if (!isPaiseError(e)) {
            push({
              at: Date.now(),
              kind: 'error',
              provider: spec.id,
              message: e instanceof Error ? e.message : String(e),
              severity: 'refused',
            });
          }
        }
      }),
    );

    res.json({ requested: count, paid, refused, status: engine.status() });
  });

  app.post('/api/topup', async (_req, res) => {
    try {
      const event = await treasury.ensureFunded();
      if (event) {
        push({
          at: Date.now(),
          kind: 'topup',
          amount: event.amount,
          message: `Mandate debit of ${format(event.amount)} cleared (${event.railRef})`,
          severity: 'info',
        });
      }
      res.json({ topped: Boolean(event), status: engine.status() });
    } catch (e) {
      push({
        at: Date.now(),
        kind: 'mandate-refused',
        message: e instanceof Error ? e.message : String(e),
        severity: 'attack',
      });
      res.status(402).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/settle', async (_req, res) => {
    const result = await treasury.settleBatch();
    for (const payout of result.payouts) {
      push({
        at: Date.now(),
        kind: 'payout',
        provider: payout.provider,
        amount: payout.amount,
        message: `Paid ${format(payout.amount)} to ${payout.provider} (${payout.railRef})`,
        severity: 'info',
      });
    }
    res.json(result);
  });

  app.post('/api/plan', async (req, res) => {
    const task = typeof req.body?.task === 'string' ? req.body.task : 'Research rooftop solar in India';
    const options: ToolOption[] = FLEET.map((p) => ({
      providerId: p.id,
      path: p.path,
      price: p.price,
      label: p.label,
      topics: p.label.toLowerCase().split(/\s+/),
    }));
    res.json(await planner.plan(task, options));
  });

  return new Promise<{ port: number }>((resolve) => {
    app.listen(port, '127.0.0.1', () => resolve({ port }));
  });
}

function toFeedEntry(e: PolicyEvent): FeedEntry {
  switch (e.kind) {
    case 'authorized':
      return {
        at: e.at,
        kind: 'authorized',
        provider: e.authorization.provider,
        amount: e.authorization.maxAmount,
        message: `Authorized up to ${format(e.authorization.maxAmount)} for ${e.authorization.resource}`,
        severity: 'info',
      };
    case 'settled':
      return {
        at: e.at,
        kind: 'settled',
        provider: e.receipt.provider,
        amount: e.receipt.settledAmount,
        message: `Paid ${format(e.receipt.settledAmount)} to ${e.receipt.provider}`,
        severity: 'ok',
      };
    case 'released':
      return {
        at: e.at,
        kind: 'released',
        message: `Hold released (${e.reason})`,
        severity: 'info',
      };
    case 'refused':
      return {
        at: e.at,
        kind: 'refused',
        provider: e.quote?.provider,
        code: e.error.code,
        message: e.error.message,
        severity: ATTACK_CODES.has(e.error.code) ? 'attack' : 'refused',
      };
  }
}

if (isMainModule(import.meta.url)) {
  startDashboard().then(({ port }) => {
    console.log(`\n  paise dashboard → http://127.0.0.1:${port}\n`);
  });
}

export { ZERO };
