import type { Job } from '../types.js';
import { cronPrev } from './schedule.js';

export interface EvalCtx { now: Date; bootAt?: string; graceMinutes: number; }
export interface EvalResult { failures: Job[]; overdues: Job[]; }

const STATUS_BEARING = new Set(['systemd', 'cloudflare', 'hermes', 'crontab']);

// The relevant scheduled instant that should already have fired. Prefer the
// source-authoritative nextRun (the scheduler's own next fire — it goes stale
// into the past when the scheduler is stuck, e.g. Hermes gateway down). Fall
// back to recomputing the previous cron occurrence from the raw expression.
function scheduledInstant(job: Job, now: Date): Date | undefined {
  const s = job.schedule;
  if (s.nextRunSource === 'source-authoritative' && s.nextRun) {
    const d = new Date(s.nextRun);
    return isNaN(d.getTime()) ? undefined : d;
  }
  if (s.kind === 'cron') {
    const prevIso = cronPrev(s.raw, now, s.timezone ?? 'UTC');
    return prevIso ? new Date(prevIso) : undefined;
  }
  return undefined;
}

export function evaluate(jobs: Job[], ctx: EvalCtx): EvalResult {
  const failures: Job[] = [];
  const overdues: Job[] = [];
  const graceMs = ctx.graceMinutes * 60_000;
  const boot = ctx.bootAt ? new Date(ctx.bootAt) : undefined;

  for (const job of jobs) {
    if (!STATUS_BEARING.has(job.source)) continue; // unknown-status sources are display-only

    if (job.lastRun?.status === 'failure') { failures.push(job); continue; }

    const scheduled = scheduledInstant(job, ctx.now);
    if (!scheduled) continue;                                          // no usable schedule -> not overdue
    if (job.source === 'crontab') {
      const since = job.lastRun?.observableSince;
      if (!since || !job.lastRun?.at) continue;                        // logs unreadable or no observed fire -> can't conclude
      if (scheduled.getTime() < new Date(since).getTime()) continue;   // missed slot predates the observable window
    }
    if (ctx.now.getTime() - scheduled.getTime() <= graceMs) continue;  // future, or within grace
    if (boot && scheduled.getTime() < boot.getTime()) continue;        // missed during host downtime
    const lastAt = job.lastRun?.at ? new Date(job.lastRun.at).getTime() : 0;
    if (lastAt >= scheduled.getTime()) continue;                       // it did run
    overdues.push(job);
  }
  return { failures, overdues };
}
