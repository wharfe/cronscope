import { describe, it, expect } from 'vitest';
import { cronNext, cronPrev } from './schedule.js';

const base = new Date('2026-06-12T10:05:00Z');

describe('schedule', () => {
  it('computes next run for a cron expr (UTC)', () => {
    expect(cronNext('0 */2 * * *', base, 'UTC')).toBe('2026-06-12T12:00:00.000Z');
  });
  it('computes prev run for a cron expr (UTC)', () => {
    expect(cronPrev('0 */2 * * *', base, 'UTC')).toBe('2026-06-12T10:00:00.000Z');
  });
  it('returns null for an invalid expr', () => {
    expect(cronNext('not a cron', base, 'UTC')).toBeNull();
  });
});
