export type JobSource = 'crontab' | 'systemd' | 'github-actions' | 'cloudflare';
export type RunStatus = 'success' | 'failure' | 'unknown' | 'never';

export type Availability =
  | { state: 'available' }
  | { state: 'unavailable'; reason: string }
  | { state: 'skipped'; reason: string };

export interface LastRun { status: RunStatus; at?: string; exitCode?: number; fetchedAt: string; }

export interface Job {
  id: string;
  source: JobSource;
  name: string;
  schedule: {
    raw: string;
    kind: 'cron' | 'systemd-oncalendar';
    timezone?: string;
    nextRun?: string;
    nextRunSource: 'source-authoritative' | 'computed' | 'unknown';
  };
  target: string;
  location: string;
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
}

export interface Connector {
  id: JobSource;
  tier: 0 | 1;
  availability(ctx: Ctx): Promise<Availability>;
  discover(ctx: Ctx): Promise<Job[]>;
}
