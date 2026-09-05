import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TestClock } from '../src/core/clock.js';
import { Ledger } from '../src/core/ledger.js';
import { type Micros, rupees } from '../src/core/money.js';
import { interpretEvent, mountRazorpayWebhook } from '../src/rails/webhook.js';

const SECRET = 'whsec_test_abcdef123456';
const AGENT = 'agent-1';

const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

const paymentEvent = (id: string, amountPaise: number, notes?: Record<string, unknown>) =>
  JSON.stringify({
    entity: 'event',
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id, amount: amountPaise, currency: 'INR', status: 'captured', notes },
      },
    },
  });

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

interface Harness {
  url: string;
  ledger: Ledger;
  payouts: { railRef: string; status: string; amount: Micros }[];
}

async function serve(): Promise<Harness> {
  const ledger = new Ledger(AGENT, new TestClock(new Date('2026-01-01T00:00:00Z')));
  const payouts: Harness['payouts'] = [];
  const app = express();

  // Mounted BEFORE express.json(), which is the whole trick.
  mountRazorpayWebhook(app, {
    ledger,
    webhookSecret: SECRET,
    agentId: AGENT,
    onPayout: (railRef, status, amount) => payouts.push({ railRef, status, amount }),
  });
  app.use(express.json());

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/webhooks/razorpay`, ledger, payouts };
}

function post(url: string, body: string, signature?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-razorpay-signature': signature } : {}),
    },
    body,
  });
}

describe('razorpay webhook — signature', () => {
  it('credits the ledger for a correctly signed payment', async () => {
    const { url, ledger } = await serve();
    const body = paymentEvent('pay_ABC123', 50_000); // ₹500 in paise

    const res = await post(url, body, sign(body));

    expect(res.status).toBe(200);
    expect(ledger.balance()).toBe(rupees(500));
    expect(ledger.funding()[0]?.railRef).toBe('pay_ABC123');
  });

  it('rejects a bad signature with 400 and credits nothing', async () => {
    const { url, ledger } = await serve();
    const body = paymentEvent('pay_FORGED', 10_000_000);

    const res = await post(url, body, 'deadbeef'.repeat(8));

    // 400, not 500: this will never succeed, so Razorpay must stop retrying.
    expect(res.status).toBe(400);
    expect(ledger.balance()).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const { url, ledger } = await serve();
    const body = paymentEvent('pay_NOSIG', 10_000);

    expect((await post(url, body)).status).toBe(400);
    expect(ledger.balance()).toBe(0);
  });

  it('rejects a body altered after signing', async () => {
    const { url, ledger } = await serve();
    const original = paymentEvent('pay_ABC123', 100);
    const signature = sign(original);
    const tampered = paymentEvent('pay_ABC123', 10_000_000); // 100x the amount

    expect((await post(url, tampered, signature)).status).toBe(400);
    expect(ledger.balance()).toBe(0);
  });
});

describe('razorpay webhook — idempotency', () => {
  it('credits only once when Razorpay redelivers the same event', async () => {
    const { url, ledger } = await serve();
    const body = paymentEvent('pay_RETRY', 50_000);
    const signature = sign(body);

    for (let i = 0; i < 5; i++) {
      expect((await post(url, body, signature)).status).toBe(200);
    }

    expect(ledger.balance()).toBe(rupees(500));
    expect(ledger.funding()).toHaveLength(1);
  });

  it('reports a redelivery as a duplicate rather than silently succeeding', async () => {
    const { url } = await serve();
    const body = paymentEvent('pay_DUP', 10_000);
    const signature = sign(body);

    await post(url, body, signature);
    const second = await post(url, body, signature);
    const json = (await second.json()) as { outcome: string };

    expect(json.outcome).toMatch(/duplicate/i);
  });
});

describe('razorpay webhook — event routing', () => {
  it('ignores a payment addressed to a different agent', async () => {
    const { url, ledger } = await serve();
    const body = paymentEvent('pay_OTHER', 50_000, { agent_id: 'someone-else' });

    const res = await post(url, body, sign(body));

    expect(res.status).toBe(200); // understood, deliberately not acted on
    expect(ledger.balance()).toBe(0);
  });

  it('credits a payment carrying this agent id', async () => {
    const { url, ledger } = await serve();
    const body = paymentEvent('pay_MINE', 20_000, { agent_id: AGENT });

    await post(url, body, sign(body));
    expect(ledger.balance()).toBe(rupees(200));
  });

  it('acknowledges irrelevant events without touching the ledger', async () => {
    const { url, ledger } = await serve();
    const body = JSON.stringify({ event: 'refund.created', payload: {} });

    const res = await post(url, body, sign(body));

    // 200 matters: a non-2xx makes Razorpay retry an event we do not want.
    expect(res.status).toBe(200);
    expect(ledger.balance()).toBe(0);
  });

  it('surfaces payout status updates', async () => {
    const { url, payouts } = await serve();
    const body = JSON.stringify({
      event: 'payout.processed',
      payload: { payout: { entity: { id: 'pout_XYZ', amount: 15_000, status: 'processed' } } },
    });

    await post(url, body, sign(body));

    expect(payouts).toEqual([{ railRef: 'pout_XYZ', status: 'processed', amount: rupees(150) }]);
  });
});

describe('interpretEvent — pure branches', () => {
  it('converts paise to µINR', () => {
    const outcome = interpretEvent(JSON.parse(paymentEvent('pay_1', 4_000)));
    expect(outcome.kind).toBe('credited');
    expect(outcome.kind === 'credited' && outcome.amount).toBe(rupees(40));
  });

  it('refuses a non-INR payment', () => {
    const outcome = interpretEvent({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_usd', amount: 100, currency: 'USD' } } },
    });
    expect(outcome.kind).toBe('ignored');
  });

  it('refuses a payment with no amount', () => {
    const outcome = interpretEvent({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_x' } } },
    });
    expect(outcome.kind).toBe('ignored');
  });
});
