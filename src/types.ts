import type { FreshEntry, FreshProposal } from './core/freshness.js';

// Every connector id, as a value: the closed list a connector notice key is
// checked against (wharfe/cronscope#5).
export const JOB_SOURCES = ['crontab', 'systemd', 'github-actions', 'cloudflare', 'hermes', 'launchd'] as const;
export type JobSource = typeof JOB_SOURCES[number];
export type RunStatus = 'success' | 'failure' | 'unknown' | 'never';

// Which call the pipeline caught an exception from. Present only when the
// pipeline set it: a connector reporting itself unavailable (no crontab, no
// systemd user manager) is usually a machine without that scheduler, not an
// incident, and must never be notified as one.
export type UnavailableThrownBy = 'availability' | 'discover';

export type Availability =
  | { state: 'available' }
  | { state: 'degraded'; reason: string }   // discovery works, status enrichment does not
  | { state: 'unavailable'; reason: string; thrownBy?: UnavailableThrownBy }
  | { state: 'skipped'; reason: string };

// What a connector may say about itself: everything except `thrownBy`.
export type DeclaredAvailability =
  | Exclude<Availability, { state: 'unavailable' }>
  | { state: 'unavailable'; reason: string; thrownBy?: never };

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
  // github-actions only, and only when the listing was compared with a
  // baseline a check recorded before (wharfe/cronscope#4). `state` is what the
  // comparison concluded; the rest is numbers, times and fixed words for the
  // trace line. Absent when there was nothing to compare with.
  freshness?: {
    state: 'recovered' | 'behind' | 'rerunning' | 'unverified' | 'deferred' | 'unrechecked';
    retries: number;                          // list re-fetches made (0-2)
    probe?: 'not-found' | 'shape' | 'mismatch' | 'http' | 'network' | 'ok';
    stop?: 401 | 403 | 429;                   // the status that stopped re-fetching in this check
    pages: { n: number; newest?: string; oldest?: string; total?: number }[];
  };
  // The baseline: the newest run a check confirmed before. Past evidence only
  // -- never the current health, never proof the API told the truth.
  lastObserved?: { runId: number; createdAt: string; status: RunStatus; confirmedAt: string };
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
  // Monotonic milliseconds and a sleep, for the freshness re-fetch budget.
  // Injected so tests drive time instead of waiting for it.
  // Set by `check` only: aborted at the deadline or on SIGINT / SIGTERM.
  abort?: AbortSignal;
  monoMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // Run-freshness baselines (wharfe/cronscope#4). Absent = the feature is off
  // for this scan (unsupported state file). `reader` never re-fetches and its
  // proposals are never saved; only `check` runs as `writer`.
  freshness?: {
    mode: 'writer' | 'reader';
    entries: Record<string, FreshEntry>;
    proposals: Map<string, FreshProposal>;
  };
}

export interface Connector {
  id: JobSource;
  tier: 0 | 1;
  availability(ctx: Ctx): Promise<DeclaredAvailability>;
  discover(ctx: Ctx): Promise<Job[]>;
}
