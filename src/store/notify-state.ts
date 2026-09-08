import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Availability, Job, JobSource } from '../types.js';
import { STATUS_KNOWABLE } from '../core/sources.js';

export type NoticeClass = 'no-token' | 'no-remote' | 'http-4xx' | 'http-5xx' | 'network' | 'skipped' | 'other';

export interface NotifyState {
  schemaVersion: 1;
  lastCheckAt?: string;
  jobs: Record<string, { status: 'failure' | 'overdue'; notifiedAt: string; source: JobSource }>;
  notices: { keys: string[]; notifiedAt: string } | null;
}

const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;

// Job ids are `<prefix>|<...>`; these are every prefix the connectors emit
// (crontab.ts:10, systemd.ts, github-actions.ts, hermes.ts, cloudflare.ts:39).
// Nothing here needs guessing, and a wrong label would send carry-over to the
// wrong connector's availability and drop the entry -- a spurious re-notify.
const ID_PREFIX: Record<string, JobSource> = {
  crontab: 'crontab', systemd: 'systemd', gha: 'github-actions', hermes: 'hermes', cf: 'cloudflare',
};

// Reasons are free-form and shift with the weather (HTTP 502 one hour, "fetch
// failed" the next). Deduping Slack on the raw string would alarm hourly, so
// fold them into a closed set first.
export function classifyReason(reason: string): NoticeClass {
  if (/no GitHub token/i.test(reason)) return 'no-token';
  if (/origin|remote|repo root/i.test(reason)) return 'no-remote';
  if (/skipped/i.test(reason)) return 'skipped';
  const http = reason.match(/HTTP (\d{3})/);
  if (http) return http[1].startsWith('4') ? 'http-4xx' : http[1].startsWith('5') ? 'http-5xx' : 'other';
  if (/fetch failed|timeout|abort|ENOTFOUND|ECONN|network/i.test(reason)) return 'network';
  return 'other';
}

// A job is undetermined only when its source is supposed to know its status AND
// this run recorded why it could not be read. crontab / cloudflare are unknown
// by construction; treating those as undetermined froze their notify-state
// entries forever, so a recovered-then-failed job never alarmed twice.
function isUndetermined(j: Job): boolean {
  return STATUS_KNOWABLE.has(j.source) && !!j.lastRun?.undeterminedReason;
}

export function noticeKeys(jobs: Job[]): string[] {
  const keys = new Set<string>();
  for (const j of jobs) {
    if (!isUndetermined(j)) continue;
    keys.add(`${j.source}/${classifyReason(j.lastRun!.undeterminedReason!)}`);
  }
  return [...keys].sort();
}

export function shouldSendNotices(
  prev: NotifyState['notices'], keys: string[], now: Date, resendAfterMs = RESEND_AFTER_MS,
): boolean {
  if (keys.length === 0) return false;
  if (!prev) return true;
  if (prev.keys.join('|') !== keys.join('|')) return true;
  // Re-send periodically: a token that expired three weeks ago must not be
  // invisible just because its notice was posted once.
  return now.getTime() - new Date(prev.notifiedAt).getTime() >= resendAfterMs;
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
  const next: NotifyState['jobs'] = {};
  for (const [id, entry] of Object.entries(prev)) {
    // Keep what we could not read this run: either the job said so, or its
    // whole connector fell over and took its jobs out of the snapshot. Any
    // non-available state counts -- cloudflare goes `skipped` without a token
    // and its jobs vanish exactly as on a hard failure. `degraded` connectors
    // still emit jobs, so this is a no-op for them.
    const connectorDown = !present.has(id) && connectors[entry.source]?.state !== 'available';
    if (undetermined.has(id) || connectorDown) next[id] = entry;
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
      return { schemaVersion: 1, lastCheckAt: data.lastCheckAt, jobs, notices: data.notices ?? null };
    }
  } catch { /* fall through */ }
  return { schemaVersion: 1, jobs: {}, notices: null };
}

export async function saveNotifyState(path: string, state: NotifyState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}
