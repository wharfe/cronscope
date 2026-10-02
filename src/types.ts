export type JobSource = 'crontab' | 'systemd' | 'github-actions' | 'cloudflare' | 'hermes' | 'launchd';
export type RunStatus = 'success' | 'failure' | 'unknown' | 'never';

export type Availability =
  | { state: 'available' }
  | { state: 'degraded'; reason: string }   // discovery works, status enrichment does not
  | { state: 'unavailable'; reason: string }
  | { state: 'skipped'; reason: string };

export interface LastRun {
  status: RunStatus; at?: string; exitCode?: number; fetchedAt: string; observableSince?: string;
  // When the last run started (launchd only). Anchors the stale window, since a
  // long run has a start but no finish yet.
  startedAt?: string;
  // Why the status could not be determined. Its presence -- not `status ===
  // 'unknown'` -- is what marks a job as undetermined: crontab and cloudflare
  // are unknown by construction and must never be reported as a reading failure.
  undeterminedReason?: string;
  // github-actions only: which run and attempt `status` was derived from. The
  // snapshot is overwritten every check, so `check` also prints this as one
  // `# gha` line per job, which the launchd log keeps (wharfe/cronscope#4).
  // Absent when no run history was obtained (never ran, no token, API failure).
  run?: {
    id: number;
    judgedAttempt: number;            // attempt the verdict came from (1 under the current rule)
    latestAttempt: number;            // attempt count the listing showed; > 1 = a re-run exists
    conclusion: string | null;        // GitHub conclusion of the judged attempt (charset-guarded)
    latestConclusion: string | null;  // same for the latest attempt
  };
}

export interface Job {
  id: string;
  source: JobSource;
  name: string;
  schedule: {
    raw: string;
    kind: 'cron' | 'systemd-oncalendar' | 'interval' | 'launchd-calendar';
    timezone?: string;
    nextRun?: string;
    nextRunSource: 'source-authoritative' | 'computed' | 'unknown';
    // launchd only: the longest gap between two scheduled fires. Present only when
    // a stale check is meaningful (see docs/specs/2026-09-26-launchd-connector.md).
    maxGapSeconds?: number;
  };
  target: string;
  location: string;
  state?: 'active' | 'disabled_manually' | 'disabled_inactivity';
  // Recorded only; no overdue window is derived from these yet (see #3).
  observed?: { medianGapHours?: number; maxGapHours?: number; samples: number };
  lastRun?: LastRun;
}

export interface Snapshot {
  schemaVersion: 1;
  generatedAt: string;
  host: { bootAt?: string };
  connectors: Partial<Record<JobSource, Availability>>;
  jobs: Job[];
}

export interface RunResult { stdout: string; stderr: string; code: number; }

export interface Ctx {
  now(): Date;
  run(cmd: string[]): Promise<RunResult>;            // exec a command, never throws on non-zero
  readFile(path: string): Promise<string>;
  glob(pattern: string, cwd: string): Promise<string[]>;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  homeDir: string;
  scanRoots: string[];
  timezone?: string;   // IANA tz (e.g. 'Asia/Tokyo'); resolved in runtime, used by the crontab connector
}

export interface Connector {
  id: JobSource;
  tier: 0 | 1;
  availability(ctx: Ctx): Promise<Availability>;
  discover(ctx: Ctx): Promise<Job[]>;
}
