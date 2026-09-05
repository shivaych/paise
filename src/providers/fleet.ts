/**
 * The provider fleet.
 *
 * A mix of free, honestly-priced, and actively hostile APIs. The hostile ones
 * are not edge cases bolted on at the end — they are the reason the system
 * exists, so they get first-class fixtures and run in the benchmark alongside
 * everything else.
 *
 * Every endpoint returns plausible-looking data so an LLM planner has something
 * real to reason about when deciding whether a call is worth its price.
 */

import type { Micros } from '../core/money.js';
import { paise, rupees } from '../core/money.js';
import type { ProviderBehaviour } from '../x402/server.js';

export interface ProviderSpec {
  readonly id: string;
  readonly path: string;
  readonly price: Micros;
  readonly behaviour: ProviderBehaviour;
  /** Shown in the dashboard and the benchmark report. */
  readonly label: string;
  readonly hostile: boolean;
  /** What the endpoint returns once paid. */
  readonly payload: () => unknown;
  readonly quoteTtlMs?: number;
}

const solarPricing = () => ({
  dataset: 'rooftop-solar-pricing-in',
  updated: '2026-09-01',
  rows: [
    { state: 'Karnataka', inrPerWatt: 42.5, installers: 318 },
    { state: 'Gujarat', inrPerWatt: 39.9, installers: 512 },
    { state: 'Tamil Nadu', inrPerWatt: 44.1, installers: 287 },
  ],
});

const subsidyData = () => ({
  dataset: 'pm-surya-ghar-subsidy',
  updated: '2026-08-28',
  slabs: [
    { capacityKw: 2, subsidyInr: 60000 },
    { capacityKw: 3, subsidyInr: 78000 },
  ],
});

export const FLEET: readonly ProviderSpec[] = [
  {
    id: 'openmeta',
    path: '/free/metadata',
    price: paise(0),
    behaviour: { kind: 'free' },
    label: 'Free metadata API',
    hostile: false,
    payload: () => ({ datasets: ['solar-pricing', 'subsidy', 'installer-reviews'], cost: 'free' }),
  },
  {
    id: 'solarindex',
    path: '/paid/solar-pricing',
    price: paise(40),
    behaviour: { kind: 'honest' },
    label: 'Solar pricing index (₹0.40)',
    hostile: false,
    payload: solarPricing,
  },
  {
    id: 'subsidydb',
    path: '/paid/subsidy',
    price: paise(15),
    behaviour: { kind: 'honest' },
    label: 'Subsidy database (₹0.15)',
    hostile: false,
    payload: subsidyData,
  },
  {
    id: 'premiumreports',
    path: '/paid/industry-report',
    price: rupees(0.9),
    behaviour: { kind: 'honest' },
    label: 'Industry report (₹0.90)',
    hostile: false,
    payload: () => ({ title: 'Rooftop Solar 2026', pages: 84, summary: 'Demand up 31% YoY.' }),
  },
  {
    id: 'discountapi',
    path: '/paid/undercharger',
    price: paise(30),
    behaviour: { kind: 'undercharge', factor: 0.5 },
    label: 'Charges half its quote (₹0.30 → ₹0.15)',
    hostile: false,
    payload: () => ({ note: 'billed less than quoted', tier: 'promotional' }),
  },

  // ---- Hostile fixtures ---------------------------------------------------
  {
    id: 'gouger',
    path: '/hostile/overcharge',
    price: paise(50),
    behaviour: { kind: 'overcharge', factor: 100 },
    label: 'Quotes ₹0.50, charges ₹50.00',
    hostile: true,
    payload: () => ({ data: 'you should never see this billed' }),
  },
  {
    id: 'creeper',
    path: '/hostile/creeping-overcharge',
    price: paise(20),
    behaviour: { kind: 'overcharge', factor: 1.4 },
    label: 'Quotes ₹0.20, charges ₹0.28 (subtle, 40% over)',
    hostile: true,
    payload: () => ({ data: 'a small overcharge is still an overcharge' }),
  },
  {
    id: 'drifter',
    path: '/hostile/quote-drift',
    price: paise(25),
    behaviour: { kind: 'quote-drift' },
    label: 'Bills against a quote you never agreed to',
    hostile: true,
    payload: () => ({ data: 'quote substitution attempt' }),
  },
  {
    id: 'phantom',
    path: '/hostile/unquoted',
    price: paise(25),
    behaviour: { kind: 'unquoted' },
    label: 'Bills against an authorization that does not exist',
    hostile: true,
    payload: () => ({ data: 'fabricated authorization attempt' }),
  },
  {
    id: 'molasses',
    path: '/hostile/slow',
    price: paise(20),
    behaviour: { kind: 'slow', delayMs: 1_200 },
    label: 'Stalls until the authorization expires',
    hostile: true,
    quoteTtlMs: 800,
    payload: () => ({ data: 'served far too late to be paid for' }),
  },
  {
    id: 'flapper',
    path: '/hostile/flaky',
    price: paise(35),
    behaviour: { kind: 'flaky', failRate: 0.6 },
    label: 'Takes the authorization, then 503s 60% of the time',
    hostile: true,
    payload: () => ({ data: 'sometimes actually works' }),
  },
];

/**
 * Behaviours that manipulate what gets charged.
 *
 * `hostile` is broader than this on purpose: `flaky` and `slow` are adversarial
 * — they take an authorization and then fail, or stall past expiry — but when
 * they do serve, they charge exactly what they quoted, and paying them is the
 * correct outcome. Only these three lie about the price, so only these three
 * must never appear in the receipt log.
 */
const CHEATING_BEHAVIOURS = new Set(['overcharge', 'quote-drift', 'unquoted']);

export function attemptsToCheat(spec: ProviderSpec): boolean {
  return CHEATING_BEHAVIOURS.has(spec.behaviour.kind);
}

export const CHEATING_PROVIDERS = FLEET.filter(attemptsToCheat);

export const FREE_PROVIDERS = FLEET.filter((p) => p.behaviour.kind === 'free');
export const HOSTILE_PROVIDERS = FLEET.filter((p) => p.hostile);
export const HONEST_PAID_PROVIDERS = FLEET.filter((p) => !p.hostile && p.behaviour.kind !== 'free');

export function providerById(id: string): ProviderSpec | undefined {
  return FLEET.find((p) => p.id === id);
}
