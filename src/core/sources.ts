import type { Job, JobSource } from '../types.js';

// Sources whose jobs can raise a failure / overdue alarm.
export const ALARMABLE: ReadonlySet<JobSource> =
  new Set(['systemd', 'cloudflare', 'hermes', 'crontab', 'github-actions', 'launchd']);

// Sources where an `unknown` status means "we failed to read it", not "this
// source cannot report status". crontab (crontab.ts:43-44) and cloudflare
// (cloudflare.ts:45) are permanently unknown by construction, so they are
// deliberately absent -- reporting them as undetermined froze their
// notify-state entries and made a recovered-then-failed job silent forever.
//
// Membership is necessary but not sufficient: a job counts as undetermined
// only when it also carries lastRun.undeterminedReason. Today github-actions
// and launchd (unparsable plist) set that; systemd and hermes are listed because
// they could, not because they do.
// launchd sets it only when a plist cannot be parsed; a missing log is `never`.
export const STATUS_KNOWABLE: ReadonlySet<JobSource> = new Set(['systemd', 'hermes', 'github-actions', 'launchd']);

// The single test for "we failed to read this", used by both the notify state
// and the Slack output. Keeping it in one place is the point: two copies is how
// a source falls out of one of them unnoticed.
export function isUndetermined(j: Job): boolean {
  // A workflow the user switched off is display-only by contract (README), so
  // a run-history failure on it must not become a notice about it.
  if (j.state === 'disabled_manually') return false;
  return STATUS_KNOWABLE.has(j.source) && !!j.lastRun?.undeterminedReason;
}
