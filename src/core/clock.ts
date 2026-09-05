/**
 * An injectable clock.
 *
 * Rolling spend windows ("max ₹2 per hour") are only testable if time is a
 * parameter. Nothing in the policy engine or ledger may call `Date.now()`
 * directly — they take a Clock.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock you drive by hand. Tests use this to jump across window boundaries. */
export class TestClock implements Clock {
  private t: number;

  constructor(start: number | Date = 0) {
    this.t = start instanceof Date ? start.getTime() : start;
  }

  now(): number {
    return this.t;
  }

  /** Move forward. Time never moves backwards. */
  advance(ms: number): this {
    if (ms < 0) throw new RangeError('TestClock cannot move backwards');
    this.t += ms;
    return this;
  }

  advanceSeconds(s: number): this {
    return this.advance(s * 1_000);
  }

  advanceMinutes(m: number): this {
    return this.advance(m * 60_000);
  }

  advanceHours(h: number): this {
    return this.advance(h * 3_600_000);
  }

  advanceDays(d: number): this {
    return this.advance(d * 86_400_000);
  }

  set(ms: number): this {
    if (ms < this.t) throw new RangeError('TestClock cannot move backwards');
    this.t = ms;
    return this;
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
