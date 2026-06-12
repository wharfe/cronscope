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
});
