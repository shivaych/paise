/**
 * Shared configuration. Everything is overridable by environment variable so
 * the same code runs in tests, the benchmark, and a live demo.
 */

import { rupees } from './core/money.js';
import type { BudgetPolicy } from './core/types.js';

export const SIGNING_SECRET =
  process.env['PAISE_SIGNING_SECRET'] ?? 'paise-dev-signing-key-change-me';

export const PROVIDERS_PORT = Number(process.env['PAISE_PROVIDERS_PORT'] ?? 4021);
export const DASHBOARD_PORT = Number(process.env['PAISE_DASHBOARD_PORT'] ?? 4020);

export const providersBaseUrl = (port: number = PROVIDERS_PORT) => `http://127.0.0.1:${port}`;

/**
 * The demo agent's allowance.
 *
 * These numbers are deliberately small. The interesting behaviour of this
 * system is what happens at the edge of the budget, so the budget has to be
 * reachable inside a sixty-second demo.
 */
export const DEMO_POLICY: BudgetPolicy = {
  agentId: 'research-agent-01',
  caps: [
    // Sized so a 100-request benchmark exhausts the hourly cap near the end of
    // the run: early requests exercise the hostile providers, late ones
    // exercise the budget ceiling. Both behaviours need to appear in one demo.
    { window: 'hour', limit: rupees(15) },
    { window: 'day', limit: rupees(50) },
  ],
  perCallLimit: rupees(1),
  quoteToleranceBps: 0,
  authorizationTtlMs: 30_000,
};

/** What a mandate debit tops the agent up by, and the bank-enforced ceiling on it. */
export const DEMO_TOPUP = rupees(500);
export const DEMO_MANDATE_CEILING = rupees(500);
