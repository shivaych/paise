/**
 * Money primitives.
 *
 * Every amount in this system is an integer count of micro-rupees (µINR):
 *
 *     1 INR = 100 paise = 1_000_000 µINR
 *
 * Micropayments need sub-paisa precision — an API call may genuinely cost
 * ₹0.004 — and IEEE floats cannot represent tenths of a paisa without drift.
 * In a budget engine, accumulated drift *is* an overspend. So: integers only,
 * everywhere, with no exceptions.
 */

/** An integer count of micro-rupees. Construct via {@link micros}/{@link rupees}/{@link paise}. */
export type Micros = number & { readonly __brand: 'µINR' };

export const MICROS_PER_RUPEE = 1_000_000;
export const MICROS_PER_PAISA = 10_000;

export const ZERO = 0 as Micros;

/** Wrap a raw integer count of µINR. Throws if it is not a safe integer. */
export function micros(n: number): Micros {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Money must be a safe integer count of µINR, got ${n}`);
  }
  return n as Micros;
}

/** `rupees(0.40)` -> 400_000 µINR. Rounds to the nearest µINR. */
export function rupees(r: number): Micros {
  if (!Number.isFinite(r)) throw new RangeError(`Not a finite rupee amount: ${r}`);
  return micros(Math.round(r * MICROS_PER_RUPEE));
}

/** `paise(40)` -> 400_000 µINR. Rounds to the nearest µINR. */
export function paise(p: number): Micros {
  if (!Number.isFinite(p)) throw new RangeError(`Not a finite paisa amount: ${p}`);
  return micros(Math.round(p * MICROS_PER_PAISA));
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function add(...amounts: Micros[]): Micros {
  let total = 0;
  for (const a of amounts) total += a;
  return micros(total);
}

export function sub(a: Micros, b: Micros): Micros {
  return micros(a - b);
}

/**
 * Multiply by a real-valued factor, rounding half-up to the nearest µINR.
 * Used for tolerances and rate cards, never for balances.
 */
export function scale(a: Micros, factor: number): Micros {
  if (!Number.isFinite(factor)) throw new RangeError(`Not a finite factor: ${factor}`);
  return micros(Math.round(a * factor));
}

/** Add a tolerance expressed in basis points. `withToleranceBps(x, 500)` = x + 5%. */
export function withToleranceBps(a: Micros, bps: number): Micros {
  if (!Number.isFinite(bps) || bps < 0) {
    throw new RangeError(`Tolerance must be a non-negative number of bps, got ${bps}`);
  }
  return micros(a + Math.floor((a * bps) / 10_000));
}

export function maxOf(a: Micros, b: Micros): Micros {
  return (a > b ? a : b) as Micros;
}

export function minOf(a: Micros, b: Micros): Micros {
  return (a < b ? a : b) as Micros;
}

/** Clamp below at zero. Useful for "remaining budget", which is never negative. */
export function clampAtZero(a: Micros): Micros {
  return (a > 0 ? a : 0) as Micros;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export const gt = (a: Micros, b: Micros): boolean => a > b;
export const gte = (a: Micros, b: Micros): boolean => a >= b;
export const lt = (a: Micros, b: Micros): boolean => a < b;
export const lte = (a: Micros, b: Micros): boolean => a <= b;
export const eq = (a: Micros, b: Micros): boolean => a === b;

export const isZero = (a: Micros): boolean => a === 0;
export const isPositive = (a: Micros): boolean => a > 0;
export const isNegative = (a: Micros): boolean => a < 0;

// ---------------------------------------------------------------------------
// Display / wire
// ---------------------------------------------------------------------------

/**
 * Human-readable, exact. Shows at least 2 decimal places and as many more as
 * the amount actually needs, so a ₹0.0004 charge never renders as "₹0.00".
 */
export function format(m: Micros): string {
  const negative = m < 0;
  const abs = Math.abs(m);
  const whole = Math.floor(abs / MICROS_PER_RUPEE);
  const frac = abs % MICROS_PER_RUPEE;

  let digits = frac.toString().padStart(6, '0').replace(/0+$/, '');
  if (digits.length < 2) digits = digits.padEnd(2, '0');

  return `${negative ? '-' : ''}₹${whole.toLocaleString('en-IN')}.${digits}`;
}

/**
 * Parse a rupee string ("₹0.40", "0.40", "12") into µINR.
 * For config and CLI convenience only — the wire protocol carries raw integers.
 */
export function parseINR(input: string): Micros {
  const cleaned = input.trim().replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d{1,6})?$/.test(cleaned)) {
    throw new RangeError(`Cannot parse as INR: ${JSON.stringify(input)}`);
  }
  return rupees(Number(cleaned));
}
