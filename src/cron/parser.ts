import { CronParseError } from './errors.js';

const INTERVAL_RE = /^every\s+(\d+)\s*(m|min|h|hour|d|day)s?$/i;
const CRON_FIELD_COUNT = 5;
const MAX_SCAN_MINUTES = 35 * 24 * 60; // 35 days

export function computeNextRun(cron: string, fromMs: number): number | null {
  const trimmed = cron.trim();

  // One-shot ISO datetime
  if (/^\d{4}-/.test(trimmed)) {
    const ts = new Date(trimmed).getTime();
    if (isNaN(ts)) throw new CronParseError(`Invalid ISO date: ${trimmed}`);
    return ts > fromMs ? ts : null;
  }

  // Interval shorthand: "every 5m", "every 2h"
  const intervalMatch = trimmed.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1]);
    const unit = intervalMatch[2].toLowerCase();
    const ms = unit.startsWith('h') ? value * 3_600_000
      : unit.startsWith('d') ? value * 86_400_000
      : value * 60_000;
    return fromMs + ms;
  }

  // 5-field cron expression
  const fields = trimmed.split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new CronParseError(`Expected 5 cron fields, got ${fields.length}: ${trimmed}`);
  }

  const [minF, hourF, domF, monF, dowF] = fields;
  const start = new Date(fromMs + 60_000); // start from next minute
  start.setSeconds(0, 0);

  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (
      matchField(minF, candidate.getUTCMinutes(), 0, 59) &&
      matchField(hourF, candidate.getUTCHours(), 0, 23) &&
      matchField(domF, candidate.getUTCDate(), 1, 31) &&
      matchField(monF, candidate.getUTCMonth() + 1, 1, 12) &&
      matchField(dowF, candidate.getUTCDay(), 0, 6)
    ) {
      return candidate.getTime();
    }
  }

  return null;
}

export function isOneShot(cron: string): boolean {
  return /^\d{4}-/.test(cron.trim());
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr);
      const start = range === '*' ? min : parseInt(range);
      if ((value - start) >= 0 && (value - start) % step === 0) return true;
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part) === value) return true;
    }
  }

  return false;
}
