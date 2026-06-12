import { describe, it, expect } from 'vitest';
import { cloudflareConnector } from './cloudflare.js';
import type { Ctx } from '../types.js';

function ctx(env: Record<string, string>, routes: Record<string, any>): Ctx {
  const fetchStub = (async (url: string) => ({
    ok: true, json: async () => routes[url] ?? { result: [] },
  })) as unknown as typeof fetch;
  return {
    now: () => new Date('2026-06-12T10:05:00Z'),
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    readFile: async () => '', glob: async () => [],
    fetch: fetchStub, env, homeDir: '/home/u', scanRoots: [],
  };
}

describe('cloudflare connector', () => {
  it('is skipped without a token', async () => {
    const a = await cloudflareConnector.availability(ctx({}, {}));
    expect(a.state).toBe('skipped');
  });

  it('lists workers and their cron triggers', async () => {
    const env = { CRONSCOPE_CF_API_TOKEN: 't', CRONSCOPE_CF_ACCOUNT_ID: 'acc1' };
    const base = 'https://api.cloudflare.com/client/v4/accounts/acc1';
    const c = ctx(env, {
      [`${base}/workers/scripts`]: { result: [{ id: 'w1' }] },
      [`${base}/workers/scripts/w1/schedules`]: { result: { schedules: [{ cron: '*/30 * * * *' }] } },
    });
    expect((await cloudflareConnector.availability(c)).state).toBe('available');
    const jobs = await cloudflareConnector.discover(c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('cf|acc1|w1');
    expect(jobs[0].schedule.raw).toBe('*/30 * * * *');
  });
});
