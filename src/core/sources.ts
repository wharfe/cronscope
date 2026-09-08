import type { JobSource } from '../types.js';

// Sources whose jobs can raise a failure / overdue alarm.
export const ALARMABLE: ReadonlySet<JobSource> =
  new Set(['systemd', 'cloudflare', 'hermes', 'crontab', 'github-actions']);

// Sources where an `unknown` status means "we failed to read it", not "this
// source cannot report status". crontab (crontab.ts:43-44) and cloudflare
// (cloudflare.ts:45) are permanently unknown by construction, so they are
// deliberately absent -- reporting them as undetermined froze their
// notify-state entries and made a recovered-then-failed job silent forever.
//
// Membership is necessary but not sufficient: a job counts as undetermined
// only when it also carries lastRun.undeterminedReason. Today only the
// github-actions connector sets that; systemd and hermes are listed because
// they could, not because they do.
export const STATUS_KNOWABLE: ReadonlySet<JobSource> = new Set(['systemd', 'hermes', 'github-actions']);
