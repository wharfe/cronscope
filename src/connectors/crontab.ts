import type { Connector, Ctx, Job } from '../types.js';
import { cronNext } from '../core/schedule.js';
import { redact } from '../redact.js';
import { createHash } from 'node:crypto';

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

function id(command: string, schedule: string): string {
  return 'crontab|' + createHash('sha1').update(command + '|' + schedule).digest('hex').slice(0, 12);
}

async function readCrontab(ctx: Ctx): Promise<string | null> {
  const r = await ctx.run(['crontab', '-l']);
  if (r.code !== 0) return null;
  return r.stdout;
}

export const crontabConnector: Connector = {
  id: 'crontab',
  tier: 0,
  async availability(ctx) {
    const text = await readCrontab(ctx);
    if (text === null || text.trim() === '') return { state: 'unavailable', reason: 'no crontab' };
    return { state: 'available' };
  },
  async discover(ctx) {
    const text = (await readCrontab(ctx)) ?? '';
    const jobs: Job[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || ENV_ASSIGN.test(t)) continue;
      const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (!m) continue;
      const schedule = m[1];
      const command = m[2];
      const nextRun = cronNext(schedule, ctx.now(), 'UTC') ?? undefined;
      jobs.push({
        id: id(command, schedule),
        source: 'crontab',
        name: redact(command).slice(0, 80),
        schedule: { raw: schedule, kind: 'cron', nextRun, nextRunSource: nextRun ? 'computed' : 'unknown' },
        target: redact(command),
        location: 'crontab',
        lastRun: { status: 'unknown', fetchedAt: ctx.now().toISOString() },
      });
    }
    return jobs;
  },
};
