import type { Job } from '../types.js';
import { cronPrev } from './schedule.js';

export interface EvalCtx { now: Date; bootAt?: string; graceMinutes: number; }
export interface EvalResult { failures: Job[]; overdues: Job[]; }

const STATUS_BEARING = new Set(['systemd', 'cloudflare']);

export function evaluate(jobs: Job[], ctx: EvalCtx): EvalResult {
  const failures: Job[] = [];
  const overdues: Job[] = [];
  const graceMs = ctx.graceMinutes * 60_000;
  const boot = ctx.bootAt ? new Date(ctx.bootAt) : undefined;

  for (const job of jobs) {
    if (!STATUS_BEARING.has(job.source)) continue; // unknown-status sources are display-only

    if (job.lastRun?.status === 'failure') { failures.push(job); continue; }

    if (job.schedule.kind !== 'cron') continue; // overdue needs a cron expr in MVP
    const prevIso = cronPrev(job.schedule.raw, ctx.now, job.schedule.timezone ?? 'UTC');
    if (!prevIso) continue;
    const prev = new Date(prevIso);
    if (ctx.now.getTime() - prev.getTime() <= graceMs) continue;     // within grace
    if (boot && prev.getTime() < boot.getTime()) continue;            // missed during downtime
    const lastAt = job.lastRun?.at ? new Date(job.lastRun.at).getTime() : 0;
    if (lastAt >= prev.getTime()) continue;                           // it did run
    overdues.push(job);
  }
  return { failures, overdues };
}
