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

describe('evaluate: github-actions', () => {
  const GHA_NOW = new Date('2026-09-08T12:00:00Z');
  function gha(over: Partial<Job> = {}): Job {
    return {
      id: 'gha|1', source: 'github-actions', name: 'proj/.github/workflows/daily.yml',
      target: 'x', location: 'x',
      schedule: { raw: '0 21 * * *', kind: 'cron', timezone: 'UTC',
                  nextRun: '2026-09-08T21:00:00.000Z', nextRunSource: 'computed' },
      lastRun: { status: 'success', at: '2026-09-07T21:00:00.000Z', fetchedAt: 'x' },
      ...over,
    } as Job;
  }

  it('reports a failed scheduled run', () => {
    const r = evaluate([gha({ lastRun: { status: 'failure', at: '2026-09-07T21:00:00.000Z', fetchedAt: 'x' } })],
      { now: GHA_NOW, graceMinutes: 60 });
    expect(r.failures.map(j => j.id)).toEqual(['gha|1']);
  });

  it('reports a workflow GitHub disabled for inactivity, with no run history at all', () => {
    const r = evaluate([gha({ state: 'disabled_inactivity',
      schedule: { raw: '*/15 * * * *', kind: 'cron', timezone: 'UTC', nextRunSource: 'unknown' },
      lastRun: { status: 'never', fetchedAt: 'x' } })], { now: GHA_NOW, graceMinutes: 60 });
    expect(r.overdues.map(j => j.id)).toEqual(['gha|1']);
  });

  it('stays silent about a workflow the user disabled on purpose', () => {
    const r = evaluate([gha({ state: 'disabled_manually',
      lastRun: { status: 'failure', at: '2026-06-02T21:00:00.000Z', fetchedAt: 'x' } })],
      { now: GHA_NOW, graceMinutes: 60 });
    expect(r.failures).toEqual([]);
    expect(r.overdues).toEqual([]);
  });

  it('never derives overdue from the declared cron, however stale the last run', () => {
    // A */15 workflow GitHub throttles to hours must not alarm just because the
    // declared period elapsed -- measured 2026-09-08: open-gikai/uptime fires
    // every 4.4h against a 15-minute declaration.
    const r = evaluate([gha({
      schedule: { raw: '*/15 * * * *', kind: 'cron', timezone: 'UTC', nextRunSource: 'computed' },
      lastRun: { status: 'success', at: '2026-09-08T07:30:00.000Z', fetchedAt: 'x' } })],
      { now: GHA_NOW, graceMinutes: 60 });
    expect(r.overdues).toEqual([]);
  });

  it('does not alarm on an undetermined or never-run workflow that is still active', () => {
    const never = gha({ id: 'gha|never', lastRun: { status: 'never', fetchedAt: 'x' } });
    const unknown = gha({ id: 'gha|unknown', lastRun: { status: 'unknown', fetchedAt: 'x', undeterminedReason: 'HTTP 401' } });
    const r = evaluate([never, unknown], { now: GHA_NOW, graceMinutes: 60 });
    expect(r.overdues).toEqual([]);
    expect(r.failures).toEqual([]);
  });
});

describe('evaluate: launchd stale window (last start + max gap + 24h)', () => {
  const NOW = new Date('2026-09-26T06:00:00Z');
  const ld = (p: Partial<Job>): Job => job({
    id: 'launchd|x', source: 'launchd',
    schedule: { raw: '{"Hour":9,"Minute":10}', kind: 'launchd-calendar', nextRunSource: 'unknown', maxGapSeconds: 86400 },
    ...p,
  });
  const run = (startedAt?: string, at?: string) => ({ status: 'success' as const, startedAt, at, fetchedAt: 't' });

  it('is not overdue within max gap + 24h of the last start (sleep, long runs)', () => {
    const r = evaluate([ld({ lastRun: run('2026-09-24T07:00:00Z') })], { now: NOW, graceMinutes: 60 });
    expect(r.overdues).toEqual([]);
  });
  it('is overdue once max gap + 24h has passed since the last start', () => {
    const r = evaluate([ld({ lastRun: run('2026-09-24T05:59:00Z') })], { now: NOW, graceMinutes: 60 });
    expect(r.overdues.map(j => j.id)).toEqual(['launchd|x']);
  });
  it('falls back to the last finish when no start line survived the tail', () => {
    const r = evaluate([ld({ lastRun: run(undefined, '2026-09-24T05:59:00Z') })], { now: NOW, graceMinutes: 60 });
    expect(r.overdues).toHaveLength(1);
  });
  it('I1: a launchd failure reaches failures (launchd is alarmable)', () => {
    const r = evaluate([ld({ lastRun: { status: 'failure', exitCode: 1, fetchedAt: 't' } })], { now: NOW, graceMinutes: 60 });
    expect(r.failures.map(j => j.id)).toEqual(['launchd|x']);
  });
  it('a bootout launchd job is neither failure nor overdue', () => {
    const r = evaluate([ld({ state: 'disabled_manually', lastRun: { status: 'failure', startedAt: '2026-01-01T00:00:00Z', fetchedAt: 't' } })], { now: NOW, graceMinutes: 60 });
    expect(r.failures).toEqual([]);
    expect(r.overdues).toEqual([]);
  });
  it('never flags a job that has never run, or one without a stale window', () => {
    const never = ld({ lastRun: { status: 'never', fetchedAt: 't' } });
    const noWindow = ld({ schedule: { raw: 'every 300s', kind: 'interval', nextRunSource: 'unknown' }, lastRun: run('2026-01-01T00:00:00Z') });
    const r = evaluate([never, noWindow], { now: NOW, graceMinutes: 60 });
    expect(r.overdues).toEqual([]);
  });
  it('ignores bootAt: a start before boot is still judged by the window', () => {
    const r = evaluate([ld({ lastRun: run('2026-09-20T00:00:00Z') })], { now: NOW, bootAt: '2026-09-26T05:00:00Z', graceMinutes: 60 });
    expect(r.overdues).toHaveLength(1);
  });
});
