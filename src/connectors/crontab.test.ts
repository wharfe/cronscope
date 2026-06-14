import { describe, it, expect } from 'vitest';
import { crontabConnector } from './crontab.js';
import type { Ctx } from '../types.js';

function ctxWith(stdout: string, over: Partial<Ctx> = {}): Ctx {
  return {
    now: () => new Date('2026-06-12T10:05:00Z'),
    run: async (cmd) => cmd[0] === 'crontab' ? { stdout, stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 },
    readFile: async () => { throw new Error('ENOENT'); }, glob: async () => [],
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: [], timezone: 'UTC',
    ...over,
  };
}

describe('crontab connector', () => {
  it('is unavailable when crontab is empty/missing', async () => {
    const a = await crontabConnector.availability(ctxWith('', { run: async () => ({ stdout:'', stderr:'', code:1 }) }));
    expect(a.state).toBe('unavailable');
  });

  it('parses a job, computes nextRun in ctx.timezone, status unknown', async () => {
    const ctx = ctxWith('# comment\n0 */2 * * * /home/u/x.sh --quiet\n');
    const jobs = await crontabConnector.discover(ctx);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('crontab');
    expect(jobs[0].schedule.raw).toBe('0 */2 * * *');
    expect(jobs[0].schedule.timezone).toBe('UTC');
    expect(jobs[0].schedule.nextRun).toBe('2026-06-12T12:00:00.000Z'); // UTC tz -> same as before
    expect(jobs[0].lastRun?.status).toBe('unknown');
    expect(jobs[0].target).toContain('x.sh');
  });

  it('skips env-assignment and blank lines', async () => {
    const ctx = ctxWith('PATH=/usr/bin\n\n5 9 * * * echo hi\n');
    const jobs = await crontabConnector.discover(ctx);
    expect(jobs).toHaveLength(1);
  });

  it('injects last-fired time + observableSince when cron logs are readable', async () => {
    const since = '2026-06-01T00:00:00Z';
    const fires = JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.parse('2026-06-12T08:00:00Z') * 1000), MESSAGE: '(u) CMD (/home/u/x.sh --quiet)' }); // 2026-06-12T08:00:00Z
    const earliest = JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.parse(since) * 1000), MESSAGE: '(u) pam_unix(cron:session): opened' });
    const ctx = ctxWith('0 */2 * * * /home/u/x.sh --quiet\n', {
      run: async (cmd) => {
        if (cmd[0] === 'crontab') return { stdout: '0 */2 * * * /home/u/x.sh --quiet\n', stderr: '', code: 0 };
        if (cmd[0] === 'journalctl') return { stdout: [earliest, fires].join('\n'), stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 1 };
      },
    });
    const j = (await crontabConnector.discover(ctx))[0];
    expect(j.lastRun?.at).toBe('2026-06-12T08:00:00.000Z');
    expect(j.lastRun?.observableSince).toBe('2026-06-01T00:00:00.000Z');
    expect(j.lastRun?.status).toBe('unknown');
  });

  it('degrades (no at/observableSince) when cron logs are unreadable', async () => {
    const ctx = ctxWith('0 */2 * * * /home/u/x.sh\n'); // journalctl code 1, syslog throws
    const j = (await crontabConnector.discover(ctx))[0];
    expect(j.lastRun?.at).toBeUndefined();
    expect(j.lastRun?.observableSince).toBeUndefined();
    expect(j.lastRun?.status).toBe('unknown');
  });
});
