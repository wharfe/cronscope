import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Availability, Job, JobSource } from '../types.js';
import { isUndetermined } from '../core/sources.js';

export type NoticeClass =
  | 'no-token' | 'no-remote' | 'http-4xx' | 'http-5xx' | 'network'
  | 'skipped' | 'parse-error' | 'api-shape' | 'workflow-state' | 'run-conclusion' | 'other';

export interface NotifyState {
  schemaVersion: 1;
  lastCheckAt?: string;
  jobs: Record<string, { status: 'failure' | 'overdue'; notifiedAt: string; source: JobSource }>;
  // key -> when that key was last sent to Slack. Per key, not one timestamp for
  // the set: with a shared timestamp, one class recovering changes the set and
  // re-sends the classes that did not change, so a flapping reason alarms hourly.
  notices: Record<string, string>;
}

const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;

// Job ids are `<prefix>|<...>`; these are every prefix the connectors emit
// (crontab.ts:10, systemd.ts, github-actions.ts, hermes.ts, cloudflare.ts:39, launchd.ts).
// Nothing here needs guessing, and a wrong label would send carry-over to the
// wrong connector's availability and drop the entry -- a spurious re-notify.
const ID_PREFIX: Record<string, JobSource> = {
  crontab: 'crontab', systemd: 'systemd', gha: 'github-actions', hermes: 'hermes', cf: 'cloudflare',
  launchd: 'launchd',
};

// Reasons are free-form and shift with the weather (HTTP 502 one hour, "fetch
// failed" the next). Deduping Slack on the raw string would alarm hourly, so
// fold them into a closed set first.
export function classifyReason(reason: string): NoticeClass {
  if (/no GitHub token/i.test(reason)) return 'no-token';
  if (/origin|remote|repo root/i.test(reason)) return 'no-remote';
  if (/skipped/i.test(reason)) return 'skipped';
  // These used to collapse into `other`, so a parse failure appearing while a
  // neutral-run notice already stood was not a new incident and waited 24h.
  if (/could not be read or parsed/i.test(reason)) return 'parse-error';
  if (/unexpected response shape|not present in the GitHub API listing/i.test(reason)) return 'api-shape';
  if (/unexpected workflow state/i.test(reason)) return 'workflow-state';
  if (/neutral|no conclusion/i.test(reason)) return 'run-conclusion';
  const http = reason.match(/HTTP (\d{3})/);
  if (http) return http[1].startsWith('4') ? 'http-4xx' : http[1].startsWith('5') ? 'http-5xx' : 'other';
  if (/fetch failed|timeout|abort|ENOTFOUND|ECONN|network/i.test(reason)) return 'network';
  return 'other';
}

export function noticeKeys(jobs: Job[]): string[] {
  const keys = new Set<string>();
  for (const j of jobs) {
    if (!isUndetermined(j)) continue;
    keys.add(`${j.source}/${classifyReason(j.lastRun!.undeterminedReason!)}`);
  }
  return [...keys].sort();
}

// The keys worth sending right now: ones never sent, plus ones standing long
// enough to be worth repeating. A token that expired three weeks ago must not be
// invisible just because its notice was posted once.
export function noticesToSend(
  prev: NotifyState['notices'], keys: string[], now: Date, resendAfterMs = RESEND_AFTER_MS,
): string[] {
  return keys.filter((k) => {
    const at = prev?.[k];
    return !at || now.getTime() - new Date(at).getTime() >= resendAfterMs;
  });
}

export function nextNoticeState(
  prev: NotifyState['notices'], keys: string[], sent: string[], at: string,
): NotifyState['notices'] {
  const next: NotifyState['notices'] = {};
  // Keys that vanished are dropped; keys we stayed quiet about keep their old
  // timestamp so the re-send clock keeps running instead of restarting hourly.
  for (const k of keys) next[k] = sent.includes(k) ? at : (prev?.[k] ?? at);
  return next;
}

export function jobsForKeys(jobs: Job[], keys: string[]): Job[] {
  return jobs.filter((j) => isUndetermined(j)
    && keys.includes(`${j.source}/${classifyReason(j.lastRun!.undeterminedReason!)}`));
}

export function carryOverJobs(
  prev: NotifyState['jobs'],
  jobs: Job[],
  connectors: Partial<Record<JobSource, Availability>>,
  current: Map<string, 'failure' | 'overdue'>,
  at: string,
): NotifyState['jobs'] {
  const undetermined = new Set(jobs.filter(isUndetermined).map((j) => j.id));
  const present = new Set(jobs.map((j) => j.id));
  // A workflow the user switched off is resolved, not frozen. Without this, a
  // run-history failure on the same run would carry the old alarm forever and
  // the next real failure after re-enabling would not read as new.
  const intentionallyOff = new Set(jobs.filter((j) => j.state === 'disabled_manually').map((j) => j.id));
  const next: NotifyState['jobs'] = {};
  for (const [id, entry] of Object.entries(prev)) {
    // Keep what we could not read this run: either the job said so, or its
    // whole connector fell over and took its jobs out of the snapshot.
    // cloudflare goes `skipped` without a token and its jobs vanish exactly as
    // on a hard failure, so that counts too. `degraded` does NOT: such a
    // connector still emits its jobs, so a job missing from the snapshot
    // really is gone.
    const st = connectors[entry.source]?.state;
    const connectorDown = !present.has(id) && st !== 'available' && st !== 'degraded';
    if ((undetermined.has(id) || connectorDown) && !intentionallyOff.has(id)) next[id] = entry;
  }
  for (const [id, status] of current) {
    // `current` is built from these same jobs, so the lookup always hits; the
    // fallback exists only to satisfy the type checker.
    const source = jobs.find((j) => j.id === id)?.source ?? prev[id]?.source;
    if (source) next[id] = { status, notifiedAt: at, source };
  }
  return next;
}

export async function loadNotifyState(path: string): Promise<NotifyState> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    // `notices` and `jobs[].source` arrived after the first v1 files were
    // written; fill them in rather than bumping the version for additive fields.
    if (data?.schemaVersion === 1) {
      const jobs: NotifyState['jobs'] = {};
      for (const [id, e] of Object.entries<any>(data.jobs ?? {})) {
        const source: JobSource | undefined = e.source ?? ID_PREFIX[id.split('|')[0]];
        if (!source) continue;                     // unknown prefix -> drop, do not mislabel
        jobs[id] = { status: e.status, notifiedAt: e.notifiedAt, source };
      }
      const rawNotices = data.notices;
      // Older shapes: absent, null, or the {keys,notifiedAt} form this replaced.
      const notices: NotifyState['notices'] = rawNotices && !Array.isArray(rawNotices) && !rawNotices.keys
        ? rawNotices : {};
      return { schemaVersion: 1, lastCheckAt: data.lastCheckAt, jobs, notices };
    }
  } catch { /* fall through */ }
  return { schemaVersion: 1, jobs: {}, notices: {} };
}

export async function saveNotifyState(path: string, state: NotifyState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}
