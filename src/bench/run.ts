/**
 * The benchmark.
 *
 * Runs N autonomous tool requests across free, honestly-paid and hostile APIs
 * and reports the three numbers the project is judged on:
 *
 *   throughput        requests per second, end to end over real HTTP
 *   budget adherence  measured overspend against every cap — must be exactly 0
 *   audit trail       a hash-chained receipt per rupee, verified from genesis
 *
 * Overspend is not asserted from the engine's own bookkeeping — that would be
 * marking our own homework. It is recomputed independently from the receipt
 * log with a sliding window, which is the same thing an auditor would do.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { HOUR, systemClock } from '../core/clock.js';
import { isMainModule } from '../core/main.js';
import { isPaiseError, type ErrorCode } from '../core/errors.js';
import { Ledger } from '../core/ledger.js';
import { type Micros, ZERO, format, micros } from '../core/money.js';
import { PolicyEngine, windowMs } from '../core/policy.js';
import { HmacSigner } from '../core/signer.js';
import type { Receipt, SpendCap } from '../core/types.js';
import { DEMO_POLICY, DEMO_TOPUP, SIGNING_SECRET } from '../config.js';
import { FLEET, type ProviderSpec } from '../providers/fleet.js';
import { startProviders } from '../providers/server.js';
import { PaidClient } from '../x402/client.js';

const POLICY_CODES = new Set<ErrorCode>([
  'BUDGET_EXHAUSTED',
  'PER_CALL_LIMIT',
  'PROVIDER_LIMIT',
  'INSUFFICIENT_FUNDS',
  'PROVIDER_NOT_ALLOWED',
]);

interface Outcome {
  readonly index: number;
  readonly provider: string;
  readonly hostile: boolean;
  readonly status: 'served-free' | 'paid' | 'refused-policy' | 'refused-hostile' | 'http-error';
  readonly cost: Micros;
  readonly code?: ErrorCode;
  readonly message?: string;
  readonly durationMs: number;
}

/** Deterministic PRNG so a benchmark run is reproducible from its seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A realistic mix: mostly cheap or free lookups, a steady minority of paid
 * calls, and a hostile tail. Weighted, not uniform — an agent that hits a
 * wallet-drain attempt on one call in three is not a scenario anyone believes.
 */
function buildWorkload(count: number, rng: () => number): ProviderSpec[] {
  const free = FLEET.filter((p) => p.behaviour.kind === 'free');
  const honest = FLEET.filter((p) => !p.hostile && p.behaviour.kind !== 'free');
  const hostile = FLEET.filter((p) => p.hostile);

  const pick = (pool: readonly ProviderSpec[]) => pool[Math.floor(rng() * pool.length)]!;

  const workload: ProviderSpec[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.25) workload.push(pick(free));
    else if (roll < 0.72) workload.push(pick(honest));
    else workload.push(pick(hostile));
  }
  return workload;
}

/** Largest total settled inside any window of the given length. */
function maxWindowSpend(receipts: readonly Receipt[], span: number): Micros {
  if (span === Number.POSITIVE_INFINITY) {
    return micros(receipts.reduce((acc, r) => acc + r.settledAmount, 0));
  }
  let max = 0;
  let sum = 0;
  let lo = 0;
  for (let hi = 0; hi < receipts.length; hi++) {
    sum += receipts[hi]!.settledAmount;
    while (receipts[hi]!.settledAt - receipts[lo]!.settledAt >= span) {
      sum -= receipts[lo]!.settledAmount;
      lo++;
    }
    if (sum > max) max = sum;
  }
  return micros(max);
}

/** Fixed-size worker pool — concurrency is what exercises the hold logic. */
async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface BenchOptions {
  readonly requests?: number;
  readonly concurrency?: number;
  readonly seed?: number;
}

export async function runBenchmark(opts: BenchOptions = {}) {
  const requests = opts.requests ?? 100;
  const concurrency = opts.concurrency ?? 8;
  const seed = opts.seed ?? 20260905;

  const ledger = new Ledger(DEMO_POLICY.agentId, systemClock);
  const engine = new PolicyEngine({
    policy: DEMO_POLICY,
    ledger,
    clock: systemClock,
    signer: new HmacSigner(SIGNING_SECRET),
  });

  // The mandate debit that funds the run. In production this credit is written
  // by a Razorpay webhook, never by the agent asking for it.
  ledger.credit({
    kind: 'topup',
    amount: DEMO_TOPUP,
    railRef: 'pay_benchmarkfixture',
    note: 'UPI Autopay mandate debit (simulated)',
  });

  let server: Server | undefined;
  const outcomes: Outcome[] = [];

  try {
    const started = await startProviders(0);
    server = started.server;
    const base = `http://127.0.0.1:${started.port}`;
    const client = new PaidClient({ engine, timeoutMs: 8_000 });

    const workload = buildWorkload(requests, lcg(seed));
    const wallStart = Date.now();

    await pool(workload, concurrency, async (spec, index): Promise<void> => {
      const t0 = Date.now();
      try {
        const result = await client.get(`${base}${spec.path}`);
        outcomes.push({
          index,
          provider: spec.id,
          hostile: spec.hostile,
          status: result.paid ? 'paid' : result.ok ? 'served-free' : 'http-error',
          cost: result.cost,
          durationMs: result.durationMs,
        });
      } catch (e) {
        if (isPaiseError(e)) {
          outcomes.push({
            index,
            provider: spec.id,
            hostile: spec.hostile,
            status: POLICY_CODES.has(e.code) ? 'refused-policy' : 'refused-hostile',
            cost: ZERO,
            code: e.code,
            message: e.message,
            durationMs: Date.now() - t0,
          });
        } else {
          outcomes.push({
            index,
            provider: spec.id,
            hostile: spec.hostile,
            status: 'http-error',
            cost: ZERO,
            message: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - t0,
          });
        }
      }
    });

    const wallMs = Date.now() - wallStart;
    const report = buildReport({ ledger, engine, outcomes, wallMs, requests, concurrency, seed });
    printReport(report);
    persist(report);
    return report;
  } finally {
    server?.close();
  }
}

function buildReport(input: {
  ledger: Ledger;
  engine: PolicyEngine;
  outcomes: Outcome[];
  wallMs: number;
  requests: number;
  concurrency: number;
  seed: number;
}) {
  const { ledger, engine, outcomes, wallMs } = input;
  const receipts = ledger.receipts();

  const capAudit = DEMO_POLICY.caps.map((cap: SpendCap) => {
    const span = windowMs(cap.window);
    const peak = maxWindowSpend(receipts, span);
    return {
      window: cap.window,
      limit: cap.limit,
      peakObserved: peak,
      overspend: micros(Math.max(0, peak - cap.limit)),
      utilisationPct: cap.limit === 0 ? 0 : Number(((peak / cap.limit) * 100).toFixed(1)),
    };
  });

  const byStatus = (s: Outcome['status']) => outcomes.filter((o) => o.status === s);
  const byCode = new Map<string, number>();
  for (const o of outcomes) {
    if (o.code) byCode.set(o.code, (byCode.get(o.code) ?? 0) + 1);
  }

  const perCallOverPolicy = receipts.filter((r) => r.settledAmount > DEMO_POLICY.perCallLimit);
  const hostilePaid = outcomes.filter((o) => o.hostile && o.status === 'paid');
  const latencies = outcomes.map((o) => o.durationMs).sort((a, b) => a - b);

  return {
    meta: {
      requests: input.requests,
      concurrency: input.concurrency,
      seed: input.seed,
      startedAt: new Date().toISOString(),
    },
    throughput: {
      wallMs,
      requestsPerSecond: Number(((outcomes.length / wallMs) * 1000).toFixed(2)),
      p50Ms: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
      p95Ms: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    },
    outcomes: {
      total: outcomes.length,
      servedFree: byStatus('served-free').length,
      paid: byStatus('paid').length,
      refusedByPolicy: byStatus('refused-policy').length,
      refusedForMisbehaviour: byStatus('refused-hostile').length,
      httpErrors: byStatus('http-error').length,
      byCode: Object.fromEntries(byCode),
    },
    budget: {
      funded: DEMO_TOPUP,
      totalSpent: ledger.totalSpent(),
      balance: ledger.balance(),
      available: ledger.available(),
      caps: capAudit,
      /** The headline. Independently recomputed from receipts, not from the engine. */
      totalOverspend: micros(capAudit.reduce((acc, c) => acc + c.overspend, 0)),
      perCallBreaches: perCallOverPolicy.length,
      /** Money that reached a provider that tried to cheat. Must be zero. */
      paidToHostileProviders: hostilePaid.length,
    },
    audit: {
      receipts: receipts.length,
      chain: ledger.verifyChain(),
      doubleEntry: ledger.verifyIntegrity(),
      leakedHolds: ledger.liveHoldCount(),
      tip: receipts.at(-1)?.hash ?? null,
    },
    finalStatus: engine.status(),
    receipts: receipts.map((r) => ({
      seq: r.seq,
      provider: r.provider,
      resource: r.resource,
      quoted: r.quotedAmount,
      settled: r.settledAmount,
      at: new Date(r.settledAt).toISOString(),
      hash: r.hash.slice(0, 16),
    })),
  };
}

type Report = ReturnType<typeof buildReport>;

function printReport(r: Report): void {
  const pass = (ok: boolean) => (ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
  const line = (l: string, v: string) => console.log(`  ${l.padEnd(34)} ${v}`);

  console.log('\n\x1b[1mpaise — autonomous agent budget benchmark\x1b[0m');
  console.log('─'.repeat(64));

  console.log('\n\x1b[1mThroughput\x1b[0m');
  line('requests', String(r.outcomes.total));
  line('wall clock', `${r.throughput.wallMs} ms`);
  line('throughput', `${r.throughput.requestsPerSecond} req/s`);
  line('latency p50 / p95', `${r.throughput.p50Ms} ms / ${r.throughput.p95Ms} ms`);

  console.log('\n\x1b[1mOutcomes\x1b[0m');
  line('served free', String(r.outcomes.servedFree));
  line('paid successfully', String(r.outcomes.paid));
  line('refused — budget policy', String(r.outcomes.refusedByPolicy));
  line('refused — provider misbehaviour', String(r.outcomes.refusedForMisbehaviour));
  line('http errors', String(r.outcomes.httpErrors));
  for (const [code, n] of Object.entries(r.outcomes.byCode)) {
    line(`  ${code}`, String(n));
  }

  console.log('\n\x1b[1mBudget adherence\x1b[0m');
  line('funded', format(r.budget.funded));
  line('total spent', format(r.budget.totalSpent));
  for (const cap of r.budget.caps) {
    line(
      `cap: ${cap.window}`,
      `peak ${format(cap.peakObserved)} of ${format(cap.limit)} (${cap.utilisationPct}%)`,
    );
  }
  line('overspend', `${format(r.budget.totalOverspend)}  ${pass(r.budget.totalOverspend === 0)}`);
  line('per-call breaches', `${r.budget.perCallBreaches}  ${pass(r.budget.perCallBreaches === 0)}`);
  line(
    'paid to hostile providers',
    `${r.budget.paidToHostileProviders}  ${pass(r.budget.paidToHostileProviders === 0)}`,
  );

  console.log('\n\x1b[1mAudit trail\x1b[0m');
  line('receipts written', String(r.audit.receipts));
  line('hash chain verified', pass(r.audit.chain.ok));
  line('double-entry balanced', pass(r.audit.doubleEntry.ok));
  line('leaked holds', `${r.audit.leakedHolds}  ${pass(r.audit.leakedHolds === 0)}`);
  line('chain tip', r.audit.tip ? `${r.audit.tip.slice(0, 32)}…` : '—');

  const allPass =
    r.budget.totalOverspend === 0 &&
    r.budget.perCallBreaches === 0 &&
    r.budget.paidToHostileProviders === 0 &&
    r.audit.chain.ok &&
    r.audit.doubleEntry.ok &&
    r.audit.leakedHolds === 0;

  console.log('\n' + '─'.repeat(64));
  console.log(`  overall: ${pass(allPass)}\n`);
}

function persist(report: Report): void {
  try {
    mkdirSync('bench-results', { recursive: true });
    const path = `bench-results/run-${Date.now()}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`  full report: ${path}\n`);
  } catch (e) {
    console.warn(`  (could not persist report: ${String(e)})`);
  }
}

const flag = (name: string): number | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : undefined;
};

if (isMainModule(import.meta.url)) {
  runBenchmark({
    requests: flag('requests') ?? 100,
    concurrency: flag('concurrency') ?? 8,
    seed: flag('seed') ?? 20260905,
  })
    .then((r) => {
      process.exit(r.budget.totalOverspend === 0 && r.audit.chain.ok ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { HOUR };
