import { describe, it, expect } from 'vitest';
import { computeNextRun, isOneShot } from './parser.js';

describe('cron parser', () => {
  describe('interval shorthand', () => {
    it('every 5m', () => {
      const from = Date.now();
      const next = computeNextRun('every 5m', from);
      expect(next).toBe(from + 5 * 60_000);
    });

    it('every 2h', () => {
      const from = Date.now();
      const next = computeNextRun('every 2h', from);
      expect(next).toBe(from + 2 * 3_600_000);
    });

    it('every 1d', () => {
      const from = Date.now();
      const next = computeNextRun('every 1d', from);
      expect(next).toBe(from + 86_400_000);
    });
  });

  describe('one-shot ISO', () => {
    it('future date returns timestamp', () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const next = computeNextRun(future, Date.now());
      expect(next).toBeGreaterThan(Date.now());
    });

    it('past date returns null', () => {
      const past = '2020-01-01T00:00:00Z';
      const next = computeNextRun(past, Date.now());
      expect(next).toBeNull();
    });

    it('isOneShot identifies ISO dates', () => {
      expect(isOneShot('2024-03-15T10:00:00Z')).toBe(true);
      expect(isOneShot('every 5m')).toBe(false);
      expect(isOneShot('*/5 * * * *')).toBe(false);
    });
  });

  describe('5-field cron', () => {
    it('*/5 * * * * — every 5 minutes', () => {
      const base = new Date('2024-01-15T10:03:00Z').getTime();
      const next = computeNextRun('*/5 * * * *', base);
      expect(next).toBe(new Date('2024-01-15T10:05:00Z').getTime());
    });

    it('0 9 * * * — daily at 9:00', () => {
      const base = new Date('2024-01-15T10:00:00Z').getTime();
      const next = computeNextRun('0 9 * * *', base);
      expect(next).toBe(new Date('2024-01-16T09:00:00Z').getTime());
    });

    it('30 14 * * 1 — Monday at 14:30', () => {
      // 2024-01-15 is a Monday
      const base = new Date('2024-01-15T15:00:00Z').getTime();
      const next = computeNextRun('30 14 * * 1', base);
      // Next Monday is 2024-01-22
      expect(next).toBe(new Date('2024-01-22T14:30:00Z').getTime());
    });

    it('0 0 1 * * — first of month at midnight', () => {
      const base = new Date('2024-01-15T00:00:00Z').getTime();
      const next = computeNextRun('0 0 1 * *', base);
      expect(next).toBe(new Date('2024-02-01T00:00:00Z').getTime());
    });

    it('range: 0 9-17 * * * — every hour 9-17', () => {
      const base = new Date('2024-01-15T16:30:00Z').getTime();
      const next = computeNextRun('0 9-17 * * *', base);
      expect(next).toBe(new Date('2024-01-15T17:00:00Z').getTime());
    });

    it('throws on invalid field count', () => {
      expect(() => computeNextRun('* * *', Date.now())).toThrow();
    });
  });
});
