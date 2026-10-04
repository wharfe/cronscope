import type { RunStatus } from '../types.js';

// GitHub Actions run freshness (wharfe/cronscope#4). Pure: no I/O, no clock of
// its own. The contract is docs/specs/2026-10-04-gha-run-freshness.md.
//
// Every number below is a provisional default, not a measured one. The only
// evidence behind them is one stale page that fixed itself a second later and
// the hourly log of 2026-10-03; revisit them from the `# gha-freshness` lines.
export const FRESHNESS_DEFAULTS = {
  budgetMs: 30_000,          // shared by every re-fetch in one check
  maxTargets: 3,             // jobs re-fetched per check
  waitsMs: [1_000, 3_000],   // before R1, before R2
  minSliceMs: 2_000,         // never start a wait or a call with less left than this
  callTimeoutMs: 10_000,     // same as every other GitHub call
  threshold: 2,              // consecutive saved checks before Slack hears of it
  forgetAfterMs: 30 * 24 * 60 * 60 * 1000, // entries NOT seen in a scan for this long
} as const;

// Bump when the listing query changes: a baseline from another population is
// not comparable and must not survive the change.
export const FRESHNESS_QUERY = 'q1:event=schedule,status=completed';

export type FreshOutcome = 'fresh' | 'recovered' | 'behind' | 'rerunning' | 'unverified' | 'deferred';
export type Unresolved = Extract<FreshOutcome, 'behind' | 'rerunning' | 'unverified' | 'deferred'>;
export type StreakOp = 'reset' | 'inc' | 'keep';

export interface FreshIdentity { repo: string; workflowId: number; path: string; query: string }

export interface Baseline {
  runId: number;
  createdAt: string;
  judgedStatus: RunStatus;
  conclusion: string | null;   // safeConclusion()-guarded
  judgedAttempt: number;
  latestAttempt: number;
  confirmedAt: string;         // when a check last saw it as the newest
}

export interface FreshEntry {
  identity: FreshIdentity;
  baseline?: Baseline;
  streak: number;
  lastOutcome?: FreshOutcome;
  notFound?: boolean;          // the last baseline GET answered 404 / 410
  lastRecheckAt?: string;      // the last check that started spending budget on this job
  lastSeenAt: string;          // the last check whose scan emitted this job
}

// What the connector tells the writer about one job; the writer (check) turns
// it into the next entry. A reader never applies proposals.
export interface FreshProposal {
  identity: FreshIdentity;
  baseline?: Baseline;         // undefined = keep the previous one
  op: StreakOp;
  outcome?: FreshOutcome;      // undefined when nothing was observed (listing failed)
  touched: boolean;            // spent budget on this job in this check
  notFound?: boolean;
}

// Fixed wording only: these strings reach the snapshot, stdout and the
// undetermined line. They must start with `run freshness:` (classifyReason
// keys on it) and must not contain a word another class matches on (HTTP,
// timeout, remote, skipped, ...).
export const FRESHNESS_REASONS: Record<Unresolved | 'reader', string> = {
  behind: 'run freshness: listing is older than a run seen before',
  rerunning: 'run freshness: the newest run seen before is being re-run',
  unverified: 'run freshness: could not confirm the newest run seen before',
  deferred: 'run freshness: not rechecked in this check (budget)',
  reader: 'run freshness: listing is older than the last check record (not rechecked here)',
};

// A re-fetch that found the listing fresh again but had no budget left for
// the attempt-1 lookup its verdict needs. Classified as run-freshness so the
// shared undetermined key does not fire on a budget this check cut itself;
// the streak is reset (freshness WAS confirmed), so no freshness key either.
export const FIRST_ATTEMPT_DEFERRED = 'run freshness: listing is fresh again; first attempt not fetched in this check';

export function sameIdentity(a: FreshIdentity | undefined, b: FreshIdentity): boolean {
  return !!a && a.repo === b.repo && a.workflowId === b.workflowId && a.path === b.path && a.query === b.query;
}

// `behind` means the listing's newest is strictly older than the baseline, or
// the listing is empty while a baseline exists. Equal created_at is not behind:
// nothing distinguishes the two runs.
export function isBehind(baseline: Baseline | undefined, newestCreatedAt: string | null): boolean {
  if (!baseline) return false;
  if (newestCreatedAt === null) return true;
  return new Date(newestCreatedAt).getTime() < new Date(baseline.createdAt).getTime();
}

// Re-fetch order: the job that went longest without budget first, never-tried
// first of all, ties by job id. A job that started spending budget gets a fresh
// lastRecheckAt even when it ran out half-way, so it moves behind every job
// that was not touched at all (see the contract's fairness rule).
export function recheckOrder(ids: string[], entries: Record<string, FreshEntry | undefined>): string[] {
  const at = (id: string) => entries[id]?.lastRecheckAt;
  return [...ids].sort((a, b) => {
    const x = at(a), y = at(b);
    if (x !== y) {
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const d = new Date(x).getTime() - new Date(y).getTime();
      if (d !== 0) return d;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// Status codes after which no further re-fetch is made in this check. 403 is
// in the set because it MAY be a rate limit -- it is not labelled as one.
export function stopsRechecks(status: number | undefined): boolean {
  return status === 401 || status === 403 || status === 429;
}

export interface ProbeResult {
  ok: boolean; status?: number;
  value?: { id: number; workflowId: number; event: string; status: string; createdAt: string };
  shapeError?: boolean;
}
export type ProbeVerdict =
  | { outcome: 'behind' | 'rerunning'; note?: undefined }
  | { outcome: 'unverified'; note: 'not-found' | 'shape' | 'mismatch' | 'http' | 'network' };

// What a GET of the baseline run says. Nothing here releases the baseline: a
// 404 cannot be told apart from a permission gap or a stale answer.
export function classifyProbe(baseline: Baseline, identity: FreshIdentity, r: ProbeResult): ProbeVerdict {
  if (!r.ok) {
    if (r.status === 404 || r.status === 410) return { outcome: 'unverified', note: 'not-found' };
    if (r.status !== undefined) return { outcome: 'unverified', note: 'http' };
    return { outcome: 'unverified', note: r.shapeError ? 'shape' : 'network' };
  }
  const v = r.value!;
  if (v.id !== baseline.runId || v.workflowId !== identity.workflowId || v.event !== 'schedule'
      || new Date(v.createdAt).getTime() !== new Date(baseline.createdAt).getTime()) {
    return { outcome: 'unverified', note: 'mismatch' };
  }
  return { outcome: v.status === 'completed' ? 'behind' : 'rerunning' };
}

// One wallet for the whole second stage of a check, read from a monotonic
// clock that the caller injects.
export class Budget {
  private readonly start: number;
  constructor(private readonly mono: () => number, private readonly totalMs: number) { this.start = mono(); }
  remaining(): number { return Math.max(0, this.totalMs - (this.mono() - this.start)); }
  // Room for a wait of `waitMs` followed by a call of at least minSliceMs.
  canWaitThenCall(waitMs: number, minSliceMs: number): boolean { return this.remaining() - waitMs >= minSliceMs; }
  canCall(minSliceMs: number): boolean { return this.remaining() >= minSliceMs; }
  callTimeout(capMs: number): number { return Math.min(capMs, this.remaining()); }
}

export function nextStreak(prev: number, op: StreakOp): number {
  return op === 'reset' ? 0 : op === 'inc' ? prev + 1 : prev;
}
