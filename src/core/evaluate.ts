import type { Job } from '../types.js';
import { cronPrev } from './schedule.js';
import { ALARMABLE } from './sources.js';

export interface EvalCtx { now: Date; bootAt?: string; graceMinutes: number; }
export interface EvalResult { failures: Job[]; overdues: Job[]; }

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
    if (!ALARMABLE.has(job.source)) continue; // display-only sources

    // A workflow the user switched off on purpose is not an incident.
    if (job.state === 'disabled_manually') continue;

    // GitHub already told us the schedule is off. That is the conclusion --
    // no run history is needed, and none may exist once retention expires.
    if (job.state === 'disabled_inactivity') { overdues.push(job); continue; }

    if (job.lastRun?.status === 'failure') { failures.push(job); continue; }

    // GitHub's scheduler does not honour the declared cron (measured
    // 2026-09-08: a */15 workflow firing every 4.4h), so a missed-slot window
    // computed from it yields either permanent silence or permanent noise.
    // Silence for an *active* GHA workflow is out of scope until there is data
    // to calibrate a window on (#3).
    if (job.source === 'github-actions') continue;

    // launchd on a Mac that sleeps: DarkWake cycles, coalesced fires on wake and
    // long runs make a slot-exact window noisy, so launchd gets a coarse one
    // instead -- no start for (max gap + 24h). No window, or no run ever seen,
    // means no conclusion. See docs/specs/2026-09-26-launchd-connector.md.
    if (job.source === 'launchd') {
      const gap = job.schedule.maxGapSeconds;
      const anchor = job.lastRun?.startedAt ?? job.lastRun?.at;
      if (gap && anchor && ctx.now.getTime() - new Date(anchor).getTime() > (gap + 86_400) * 1000) overdues.push(job);
      continue;
    }

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
