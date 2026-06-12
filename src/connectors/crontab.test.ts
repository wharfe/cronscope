import { describe, it, expect } from 'vitest';
import { crontabConnector } from './crontab.js';
import type { Ctx } from '../types.js';

function ctxWith(stdout: string, code = 0): Ctx {
  return {
    now: () => new Date('2026-06-12T10:05:00Z'),
    run: async () => ({ stdout, stderr: '', code }),
    readFile: async () => '', glob: async () => [],
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: [],
  };
}

describe('crontab connector', () => {
  it('is unavailable when crontab is empty/missing', async () => {
    const a = await crontabConnector.availability(ctxWith('', 1));
    expect(a.state).toBe('unavailable');
  });

  it('parses a job line and computes nextRun, status unknown', async () => {
    const ctx = ctxWith('# comment\n0 */2 * * * /home/u/x.sh --quiet\n');
    expect((await crontabConnector.availability(ctx)).state).toBe('available');
    const jobs = await crontabConnector.discover(ctx);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('crontab');
    expect(jobs[0].schedule.raw).toBe('0 */2 * * *');
    expect(jobs[0].schedule.nextRun).toBe('2026-06-12T12:00:00.000Z');
    expect(jobs[0].lastRun?.status).toBe('unknown');
    expect(jobs[0].target).toContain('x.sh');
  });

  it('skips env-assignment and blank lines', async () => {
    const ctx = ctxWith('PATH=/usr/bin\n\n5 9 * * * echo hi\n');
    const jobs = await crontabConnector.discover(ctx);
    expect(jobs).toHaveLength(1);
  });
});
