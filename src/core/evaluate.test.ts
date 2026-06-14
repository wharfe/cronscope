import { describe, it, expect } from 'vitest';
import { evaluate } from './evaluate.js';
import type { Job } from '../types.js';

const now = new Date('2026-06-12T10:05:00Z');
const bootAt = '2026-06-12T00:00:00Z'; // host up since midnight

function job(p: Partial<Job> & Pick<Job, 'id' | 'source'>): Job {
  return {
    name: p.id, target: '', location: '',
    schedule: { raw: '0 */2 * * *', kind: 'cron', nextRunSource: 'computed' },
    ...p,
  } as Job;
}

describe('evaluate', () => {
  it('flags a status-bearing failure', () => {
    const jobs = [job({ id: 'a', source: 'systemd', lastRun: { status: 'failure', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.failures.map(j => j.id)).toEqual(['a']);
  });

  it('does NOT flag crontab (unknown status) as failure/overdue', () => {
    const jobs = [job({ id: 'c', source: 'crontab', lastRun: { status: 'unknown', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.failures).toHaveLength(0);
    expect(r.overdues).toHaveLength(0);
  });

  it('flags overdue when the host was up through the missed run', () => {
    // prev of "0 */2 * * *" before 10:05 is 10:00; +60m grace not yet... use a job overdue at 08:00
    const jobs = [job({ id: 'o', source: 'cloudflare', schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'success', at: '2026-06-11T08:00:00Z', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues.map(j => j.id)).toEqual(['o']); // 08:00 today missed, host up since 00:00
  });

  it('does NOT flag overdue when the missed run fell during host downtime', () => {
    const jobs = [job({ id: 'n', source: 'cloudflare', schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'success', at: '2026-06-11T08:00:00Z', fetchedAt: 't' } })];
    // host only booted at 09:00, after the 08:00 scheduled run -> not overdue
    const r = evaluate(jobs, { now, bootAt: '2026-06-12T09:00:00Z', graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  it('flags a hermes failure (now status-bearing)', () => {
    const jobs = [job({ id: 'hf', source: 'hermes', lastRun: { status: 'failure', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.failures.map(j => j.id)).toEqual(['hf']);
  });

  it('flags a hermes job overdue via stale authoritative nextRun (gateway down)', () => {
    // next_run_at stuck in the past at 08:00; host up since midnight; last run before it
    const jobs = [job({ id: 'ho', source: 'hermes',
      schedule: { raw: 'every 10m', kind: 'interval', nextRun: '2026-06-12T08:00:00Z', nextRunSource: 'source-authoritative' },
      lastRun: { status: 'success', at: '2026-06-12T07:50:00Z', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues.map(j => j.id)).toEqual(['ho']);
  });

  it('does NOT flag a healthy hermes job (authoritative nextRun in the future)', () => {
    const jobs = [job({ id: 'hh', source: 'hermes',
      schedule: { raw: '*/10 * * * *', kind: 'cron', nextRun: '2026-06-12T12:00:00Z', nextRunSource: 'source-authoritative' },
      lastRun: { status: 'success', at: '2026-06-12T10:00:00Z', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  it('does NOT flag a disabled hermes job (no nextRun, non-cron) as overdue', () => {
    const jobs = [job({ id: 'hd', source: 'hermes',
      schedule: { raw: 'every 2h', kind: 'interval', nextRunSource: 'unknown' },
      lastRun: { status: 'success', at: '2026-06-12T07:00:00Z', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  it('systemd non-regression: healthy authoritative nextRun (future) is NOT overdue', () => {
    const jobs = [job({ id: 'sd', source: 'systemd',
      schedule: { raw: 'next=2026-06-12T20:00:00Z', kind: 'systemd-oncalendar', nextRun: '2026-06-12T20:00:00Z', nextRunSource: 'source-authoritative' },
      lastRun: { status: 'success', at: '2026-06-12T08:00:00Z', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  // NOTE: these use a daily '0 8 * * *' schedule (prev slot 08:00 today = 2h5m before now,
  // well beyond the 60-min grace) so the crontab gate/logic — not grace — decides the outcome.
  // An hourly schedule would put prev at 10:00 (5m ago, inside grace) and mask the behavior.

  it('flags a crontab job overdue when it fired before, not at the latest slot (in window)', () => {
    // daily 08:00 missed today; last observed fire was yesterday 08:00; observableSince covers it
    const jobs = [job({ id: 'co', source: 'crontab',
      schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'unknown', at: '2026-06-11T08:00:00Z', observableSince: '2026-06-01T00:00:00Z', fetchedAt: 't' } })];
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues.map(j => j.id)).toEqual(['co']);
  });

  it('does NOT flag a crontab job with NO observed fire (just-added / %-mismatch)', () => {
    const jobs = [job({ id: 'cn', source: 'crontab',
      schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'unknown', observableSince: '2026-06-01T00:00:00Z', fetchedAt: 't' } })]; // no `at`
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  it('does NOT flag a crontab job when logs were unreadable (no observableSince)', () => {
    const jobs = [job({ id: 'cu', source: 'crontab',
      schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'unknown', at: '2026-06-11T08:00:00Z', fetchedAt: 't' } })]; // no observableSince
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  it('does NOT flag a crontab job whose missed slot predates the observable window', () => {
    const jobs = [job({ id: 'cw', source: 'crontab',
      schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'unknown', at: '2026-06-11T08:00:00Z', observableSince: '2026-06-12T09:00:00Z', fetchedAt: 't' } })];
    // prev 08:00 today < observableSince 09:00 today -> can't vouch -> skip
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });

  it('does NOT flag a crontab job that fired at/after its latest slot', () => {
    const jobs = [job({ id: 'cf', source: 'crontab',
      schedule: { raw: '0 8 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'unknown', at: '2026-06-12T08:00:30Z', observableSince: '2026-06-01T00:00:00Z', fetchedAt: 't' } })];
    // prev 08:00 today, last fire 08:00:30 >= prev -> ran
    const r = evaluate(jobs, { now, bootAt, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(0);
  });
});
