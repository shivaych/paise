import { describe, expect, it } from 'vitest';
import {
  add,
  format,
  micros,
  paise,
  parseINR,
  rupees,
  scale,
  sub,
  withToleranceBps,
} from '../src/core/money.js';

describe('money', () => {
  it('represents sub-paisa amounts exactly', () => {
    expect(rupees(0.004)).toBe(4_000);
    expect(paise(0.4)).toBe(4_000);
    expect(rupees(1)).toBe(1_000_000);
  });

  it('does not drift when summing many tiny amounts', () => {
    // 0.1 + 0.2 !== 0.3 in floats. Ten thousand of them is how budgets rot.
    let total = micros(0);
    for (let i = 0; i < 10_000; i++) total = add(total, rupees(0.03));
    expect(total).toBe(rupees(300));
  });

  it('rejects non-integer µINR', () => {
    expect(() => micros(1.5)).toThrow(RangeError);
    expect(() => micros(Number.NaN)).toThrow(RangeError);
  });

  it('formats with at least two places, and more when needed', () => {
    expect(format(rupees(12))).toBe('₹12.00');
    expect(format(rupees(0.4))).toBe('₹0.40');
    expect(format(rupees(0.0004))).toBe('₹0.0004');
    expect(format(rupees(-1.5))).toBe('-₹1.50');
    expect(format(rupees(1234567))).toBe('₹12,34,567.00'); // Indian grouping
  });

  it('applies tolerance in basis points, rounding down', () => {
    expect(withToleranceBps(rupees(1), 0)).toBe(rupees(1));
    expect(withToleranceBps(rupees(1), 500)).toBe(rupees(1.05));
    expect(withToleranceBps(rupees(10), 250)).toBe(rupees(10.25));
    expect(() => withToleranceBps(rupees(1), -1)).toThrow(RangeError);
  });

  it('round-trips through parseINR', () => {
    expect(parseINR('₹0.40')).toBe(rupees(0.4));
    expect(parseINR('1,234.56')).toBe(rupees(1234.56));
    expect(() => parseINR('free')).toThrow(RangeError);
  });

  it('does basic arithmetic in integers', () => {
    expect(sub(rupees(1), paise(40))).toBe(rupees(0.6));
    expect(scale(rupees(1), 0.5)).toBe(rupees(0.5));
  });
});
