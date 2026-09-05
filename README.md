# paise

**A hard spending allowance for AI agents.** HTTP 402 micropayments over Indian
rails, with budget caps enforced one layer below the code that spends.

---

## The problem

Tell an agent *"research the best rooftop solar setup for my building"* and it
needs paid data — pricing APIs, subsidy databases, an industry report. Today you
have two options:

1. **Give it your card.** It might spend ₹50. It might spend ₹50,000 because it
   looped on an expensive endpoint. You find out tomorrow.
2. **Give it nothing.** It hits free rate limits and produces a worse answer.

There is no middle option: *"here is ₹200, spend it well, and you physically
cannot spend more."* That middle option is this project.

## The shape of the answer

Two halves, and the split between them is the whole safety argument:

| | decides | how |
|---|---|---|
| **Planner** (LLM) | *is this call worth it?* | fuzzy, contextual, model-driven |
| **Policy engine** | *is this call allowed?* | integer arithmetic, no model in the loop |

The model never sees the balance, the caps, or the remaining budget — so a
prompt injection in a provider's own description can at worst make the agent
*want* to overspend. It cannot make it *able* to. Affordability is decided
afterwards, in code, by a component with no natural-language input.

Underneath both sits a **UPI Autopay mandate**: a ceiling enforced by NPCI and
the customer's bank. A bug anywhere in this repository cannot cause a debit
above it. That is a strictly stronger guarantee than an ERC-4337 session key,
because the enforcement is not our software's job.

---

## Quickstart

```bash
npm install
npm test          # 77 tests, including an adversarial fuzz run
npm run bench     # 100 agent requests across free / paid / hostile APIs
npm run dashboard # live console at http://127.0.0.1:4020
```

No credentials, no chain, no external services. Everything runs locally.

Optional, once you have keys (`cp .env.example .env`):

```bash
npm run check:gemini    # lists models your key can reach, runs a live ranking
npm run check:razorpay  # checks API key / webhook secret / RazorpayX separately
```

---

## Benchmark

100 autonomous requests, concurrency 8, over real HTTP against a fleet of free,
honestly-priced and actively hostile APIs:

```
Throughput
  requests                           100
  wall clock                         1355 ms
  throughput                         73.8 req/s
  latency p50 / p95                  5 ms / 1205 ms

Outcomes
  served free                        25
  paid successfully                  42
  refused — budget policy            14
  refused — provider misbehaviour    17
  http errors                        2

Budget adherence
  total spent                        ₹13.70
  cap: hour                          peak ₹13.70 of ₹15.00 (91.3%)
  overspend                          ₹0.00   PASS
  per-call breaches                  0       PASS
  overcharges paid                   0       PASS
  paid to cheating providers         0       PASS
  honest payments to flaky APIs      2       (expected, not a defect)

Audit trail
  receipts written                   42
  hash chain verified                PASS
  double-entry balanced              PASS
  leaked holds                       0       PASS
```

`overcharges paid` is the load-bearing one: it walks the receipt log and counts
anything settled for more than its own quote. It does not depend on how a
provider was labelled, only on what was actually paid.

`honest payments to flaky APIs` is deliberately *not* a failure. The flaky
provider takes an authorization and then 503s 60% of the time — adversarial
about availability — but when it does serve, it charges exactly what it quoted.
Paying it is the correct outcome, and an earlier version of this benchmark
wrongly flagged it.

Overspend is **recomputed independently from the receipt log** with a sliding
window (`maxWindowSpend` in `src/bench/run.ts`) rather than read back from the
engine's own counters. Asking the engine whether it behaved would be marking our
own homework.

---

## How a payment works

Two phases. This is the load-bearing design decision.

```
1. GET /report                      → 402 + quote  ("₹0.40, valid 60s")
2. engine.authorize(quote)          → hold placed, funds reserved
3. GET /report  X-Payment: <auth>   → 200 + X-Payment-Receipt ("charged ₹0.40")
4. engine.settle(charge)            → hold becomes spend, receipt written
```

Step 4 is what most implementations skip, and it is the one that makes
overcharging detectable: the provider states its charge in a header that gets
checked against the hold **before any spend is recorded**.

A one-phase "just pay the quote" design makes two failures unpreventable:

- **Concurrent overspend** — ten requests each check the cap, all pass, all
  settle, and collectively blow it. Holds are counted against caps, so the
  eleventh is refused before anything settles.
- **Hostile overcharge** — a provider quotes ₹0.50 and charges ₹50. The hold is
  the ceiling; the charge is refused, the hold released, no spend recorded.

## What the hostile providers do

Not edge cases bolted on at the end — they are the reason the system exists, so
they run in the benchmark alongside everything else.

| Endpoint | Attack | Refused with |
|---|---|---|
| `/hostile/overcharge` | quotes ₹0.50, charges ₹50 | `QuoteExceededError` |
| `/hostile/creeping-overcharge` | quotes ₹0.20, charges ₹0.28 | `QuoteExceededError` |
| `/hostile/quote-drift` | bills against a quote you never agreed to | `ProtocolViolationError` |
| `/hostile/unquoted` | bills against a fabricated authorization | `UnquotedChargeError` |
| `/hostile/slow` | stalls until the authorization expires | `AuthorizationExpiredError` |
| `/hostile/flaky` | takes the authorization, then 503s | hold released, no charge |
| *(client-side)* | replays a settled authorization | `ReplayDetectedError` |

Every refusal is a **typed exception carrying structured detail** — the agent
can tell "I cannot afford this" from "this API tried to rob me" without parsing
strings.

---

## The micropayment problem, and the honest answer

You cannot run a ₹0.40 bank transaction. The fee dwarfs the payment. Nobody can
— it is the same economics that rules out cards. So there are three tiers:

| tier | frequency | mechanism |
|---|---|---|
| **Funding** | rare | one UPI Autopay mandate debit, bank-enforced ceiling |
| **Consumption** | constant | internal double-entry ledger, µINR precision, free |
| **Settlement** | batched | one RazorpayX payout per provider per batch |

Real money moves twice. The tab moves thousands of times. This is what every
micropayment system that has ever worked does, x402 facilitators included.

Sub-paisa remainders **carry forward** rather than being rounded — rounding in
our favour every batch is a slow theft from the provider, and rounding against
us is a slow leak. `tests/rails.test.ts` asserts across 200 batches that
`paid + owed == earned`, exactly.

---

## Audit trail

Receipts are **hash-chained**: each carries the hash of its predecessor, so
editing, reordering or deleting any entry breaks every hash after it.
`verifyChain()` reports the first broken position. This is the tamper-evidence
property we wanted from a blockchain, without needing one — and it reconciles
against real RazorpayX `payout_id`s once a settlement batch lands.

The ledger is **double-entry**: every movement posts a set of amounts summing to
zero across `external` / `available` / `held` / `spent:<provider>`.
`verifyIntegrity()` checks the sum is still zero. The most likely way to
accidentally overspend is a hold that gets both released *and* settled; in a
double-entry system that surfaces immediately as drift instead of quietly
corrupting the balance.

---

## Status: what is real and what is not

Read this before demoing.

**Fully working, tested, runs anywhere:**
- Policy engine, ledger, holds, rolling-window caps, typed refusals
- x402 protocol, both ends, over real HTTP
- Hostile provider fleet and every defence against it
- Treasury: mandate-gated top-ups, aggregated per-provider settlement, dust carry
- `MockRail` — enforces a mandate ceiling in-process, no credentials
- Hash-chained receipts and double-entry integrity checks
- **Webhook receiver** (`src/rails/webhook.ts`) — signature verification,
  idempotent crediting, correct retry semantics. 13 tests over real HTTP,
  including tampered bodies and redelivery.
- Planner with Gemini / Claude / heuristic reasoners and automatic fallback
- The 100-request benchmark

**Verified against a live Razorpay test account (2026-09-05):**
- `createTopUpLink()` — creates a real hosted payment link (`npm run topup:link`)
- **The full money-in loop.** A real ₹500 test payment (`pay_TYPexHVrGuvCyz`)
  was made through Razorpay checkout; the `payment.captured` webhook reached the
  app over a public tunnel, passed signature verification, and credited the
  ledger. A forged message posted to the same endpoint was rejected with 400.
- `npm run diagnose` — reads back payment status and failure reasons from the API

Note: this account is restricted to **domestic Indian cards**, so the usual
`4111 1111 1111 1111` test card fails at `payment_initiation`. Wallet and UPI
(`success@razorpay`) work. `npm run diagnose` surfaces this — the checkout UI
only says "payment failed".

**Implemented but NOT run against a live account** (`src/rails/razorpay.ts`):
- `debit()` — `POST /v1/payments/create/recurring`, needs an authorised UPI
  Autopay mandate token
- `payout()` — `POST /v1/payouts`, needs a RazorpayX account, which is
  provisioned separately from a standard test key

Run `npm run check:razorpay` to see which of the three credential tiers you
actually have. It checks them independently, because failing on the third is
the common surprise.

The app **defaults to `MockRail`**. Do not describe the Razorpay adapter as a
working integration until a live run has happened and the note at the top of
that file has been updated. Getting RazorpayX payout access is the single
biggest scheduling risk in this project.

**Deliberately not built:**
- ERC-4337 session keys and Base/USDC settlement. The `SettlementRail` interface
  is three methods; a Base adapter is a third file. The safety properties live
  in the policy engine, not in any particular way of moving money.

**On x402 conformance:** this uses the x402 envelope (402 + machine-readable
quote + payment header + retry) with an INR scheme (`paise-ledger-v1`) settling
against a pre-funded ledger. Coinbase's spec settles on-chain against an EVM
scheme. This is a *proposed scheme*, not a conformant implementation, and should
not be presented as one.

---

## Going live

**1. Planner model** (5 minutes, free)

Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
put it in `.env` as `GEMINI_API_KEY`, then `npm run check:gemini`. It lists what
your key can reach and runs a real ranking, including a sanity check that solar
pricing outranks celebrity gossip for a solar task. Pin the model it suggests
with `GEMINI_MODEL`.

The free tier rate-limits at roughly 10–15 requests/minute. The planner runs
once per plan, not once per request, so this is ample — and on a 429 it retries
with backoff, then falls back to the deterministic reasoner. A rate limit never
becomes an unbudgeted decision.

**2. Razorpay test key + webhook** (30 minutes, free, self-serve)

Test-mode keys need no approval. Create a webhook in the dashboard pointing at
`https://<your-tunnel>/webhooks/razorpay`, subscribe to `payment.captured` and
`payout.processed`, and copy the secret into `RAZORPAY_WEBHOOK_SECRET`. The
dashboard mounts the receiver automatically when that variable is set.

For local development you need a public URL — `ngrok http 4020` or
`cloudflared tunnel --url http://localhost:4020`.

**3. RazorpayX payouts** (the risky one)

This is a separate product from the standard API key and access is not
instant. Start it early. Until it lands, settlement runs on `MockRail` and
everything else still works — the `SettlementRail` interface is three methods,
so swapping it in is a constructor change, not a rewrite.

## Layout

```
src/
  core/         money · ledger · policy · errors · signer · clock
  x402/         protocol · server middleware · paying client
  rails/        rail interface · mock · razorpay · treasury
  providers/    the fleet, including the hostile fixtures
  agent/        planner (heuristic + Claude reasoners)
  bench/        the 100-request benchmark
  dashboard/    live console
tests/          53 tests
```

Start reading at `src/core/policy.ts`. Everything else serves it.

## Design notes worth defending

- **Integer µINR everywhere.** 1 INR = 1,000,000 µINR. Floats cannot represent
  tenths of a paisa without drift, and in a budget engine accumulated drift *is*
  an overspend. `money.ts` refuses non-integers at construction.
- **Holds reserve the *tolerated* maximum, not the quote.** If policy allows 5%
  overage at settlement, that 5% is counted against every cap at authorization
  time — otherwise a run of within-tolerance overcharges walks past the daily
  cap while each individual check passes.
- **`InsufficientFundsError` ≠ `BudgetExhaustedError`.** Same stop, different
  remedy: one means top up, the other means wait or raise the cap. The planner
  treats them differently.
- **The ledger is credited from the webhook, never from our own API response.**
  A response says "accepted"; a webhook says "settled". Crediting the former is
  how you spend money that never arrived.
- **`microsToPaise()` throws rather than rounds.** A factor-of-100 slip in that
  conversion is a hundredfold overcharge.
