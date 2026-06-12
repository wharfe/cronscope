import type { Connector, Ctx, Job } from '../types.js';
import { cronNext } from '../core/schedule.js';

const TOKEN_ENV = 'CRONSCOPE_CF_API_TOKEN';
const ACCT_ENV = 'CRONSCOPE_CF_ACCOUNT_ID';

function creds(ctx: Ctx) {
  return { token: ctx.env[TOKEN_ENV], account: ctx.env[ACCT_ENV] };
}

async function api(ctx: Ctx, url: string, token: string): Promise<any> {
  const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } } as any);
  if (!(res as any).ok) return { result: null };
  return (res as any).json();
}

export const cloudflareConnector: Connector = {
  id: 'cloudflare',
  tier: 1,
  async availability(ctx) {
    const { token, account } = creds(ctx);
    if (!token || !account) return { state: 'skipped', reason: 'no Cloudflare token/account' };
    return { state: 'available' };
  },
  async discover(ctx) {
    const { token, account } = creds(ctx);
    if (!token || !account) return [];
    const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
    const scripts = (await api(ctx, `${base}/workers/scripts`, token)).result ?? [];
    const jobs: Job[] = [];
    for (const s of scripts) {
      const name = s.id ?? s.name;
      if (!name) continue;
      const sched = (await api(ctx, `${base}/workers/scripts/${name}/schedules`, token)).result;
      const crons: string[] = Array.isArray(sched?.schedules) ? sched.schedules.map((x: any) => x.cron).filter(Boolean) : [];
      for (const cron of crons) {
        const nextRun = cronNext(cron, ctx.now(), 'UTC') ?? undefined;
        jobs.push({
          id: `cf|${account}|${name}`,
          source: 'cloudflare',
          name,
          schedule: { raw: cron, kind: 'cron', timezone: 'UTC', nextRun, nextRunSource: nextRun ? 'computed' : 'unknown' },
          target: name,
          location: `cloudflare:${account}`,
          lastRun: { status: 'unknown', fetchedAt: ctx.now().toISOString() },
        });
      }
    }
    return jobs;
  },
};
