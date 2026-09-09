import type { Ctx } from '../types.js';
import { redact } from '../redact.js';

export interface GhRepoRef { owner: string; repo: string }

// Covers what git actually writes into remote.origin.url: https (with or
// without embedded credentials), scp-style ssh, and ssh://. The host may carry
// an ssh-config alias suffix (github.com-work). A trailing slash must not end
// up inside the repo name.
const REMOTE_RE = /^(?:https:\/\/(?:[^@/]+@)?github\.com(?:-[\w.-]+)?\/|git@github\.com(?:-[\w.-]+)?:|ssh:\/\/git@github\.com(?:-[\w.-]+)?\/)([^/]+)\/(.+?)(?:\.git)?\/?$/;

export function parseRemoteUrl(url: string): GhRepoRef | null {
  const m = url.trim().match(REMOTE_RE);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// `gh auth token` spawns a process; availability() and discover() both need the
// token, so memoize per Ctx rather than paying for it twice a scan.
const tokenCache = new WeakMap<Ctx, Promise<string | null>>();

export function resolveToken(ctx: Ctx): Promise<string | null> {
  let hit = tokenCache.get(ctx);
  if (!hit) {
    hit = (async () => {
      for (const name of ['CRONSCOPE_GH_TOKEN', 'GITHUB_TOKEN']) {
        const v = ctx.env[name];
        if (v && v.trim()) return v.trim();
      }
      const r = await ctx.run(['gh', 'auth', 'token']);
      const out = r.stdout.trim();
      return r.code === 0 && out ? out : null;
    })();
    tokenCache.set(ctx, hit);
  }
  return hit;
}

export async function resolveRepoRef(ctx: Ctx, repoDir: string): Promise<GhRepoRef | null> {
  const r = await ctx.run(['git', '-C', repoDir, 'remote', 'get-url', 'origin']);
  return r.code === 0 ? parseRemoteUrl(r.stdout) : null;
}

export type Fetched<T> = { ok: true; value: T } | { ok: false; reason: string };
// GitHub also returns `disabled_fork` and `deleted`, and may add more. Anything
// outside the three we act on becomes `other` and is reported as undetermined
// rather than silently treated as active -- a `disabled_fork` workflow is one
// GitHub has stopped, and calling it active would show a future nextRun for
// something that will never fire.
export type WorkflowState = 'active' | 'disabled_manually' | 'disabled_inactivity' | 'other';
export interface WorkflowInfo { id: number; state: WorkflowState; rawState: string }
export interface RunHistory {
  newest: { conclusion: string | null; createdAt: string } | null;
  medianGapHours?: number;
  maxGapHours?: number;
  samples: number;
}

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cronscope',
  };
}

// The token can surface inside an underlying error message, so a reason string
// is scrubbed twice: once for this exact token, then through the shared
// redactor that already guards the snapshot and Slack output.
//
// The length guard is not cosmetic, and removing the split is not a valid fix
// for a failing test: redact() alone does not mask a bare `ghp_...`, so this
// split is the only thing between a leaked token and Slack.
function safeReason(e: unknown, token: string): string {
  const raw = e instanceof Error && e.message ? e.message : String(e);
  const scrubbed = token && token.length >= 8 ? raw.split(token).join('[redacted]') : raw;
  return redact(scrubbed);
}

async function getJson(ctx: Ctx, url: string, token: string): Promise<Fetched<any>> {
  try {
    // Without a deadline a stalled GitHub response hangs the hourly check until
    // the next timer fires on top of it.
    const res: any = await ctx.fetch(url, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) } as any);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, value: await res.json() };
  } catch (e) {
    return { ok: false, reason: safeReason(e, token) };
  }
}

const KNOWN_STATES = new Set(['active', 'disabled_manually', 'disabled_inactivity']);
const MAX_WORKFLOW_PAGES = 5;

export async function fetchWorkflows(ctx: Ctx, ref: GhRepoRef, token: string): Promise<Fetched<Map<string, WorkflowInfo>>> {
  const map = new Map<string, WorkflowInfo>();
  let total = Infinity;
  // Paginate: a repo with more than one page of workflows would otherwise leave
  // the overflow looking like "not present in the listing" forever.
  for (let page = 1; page <= MAX_WORKFLOW_PAGES && map.size < total; page++) {
    const got = await getJson(ctx, `${API}/repos/${ref.owner}/${ref.repo}/actions/workflows?per_page=100&page=${page}`, token);
    if (!got.ok) return got;
    const list = got.value?.workflows;
    // A 200 with an unexpected body must not read as "this repo has no
    // workflows" -- that fails open into a clean-looking result.
    if (!Array.isArray(list)) return { ok: false, reason: 'unexpected response shape (workflows)' };
    total = typeof got.value.total_count === 'number' ? got.value.total_count : map.size + list.length;
    for (const w of list) {
      if (typeof w?.path !== 'string' || typeof w?.id !== 'number') continue;
      const rawState = typeof w.state === 'string' ? w.state : '';
      map.set(w.path, { id: w.id, state: KNOWN_STATES.has(rawState) ? rawState as WorkflowState : 'other', rawState });
    }
    if (list.length === 0) break;
  }
  return { ok: true, value: map };
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// `null` means "not finished / no verdict"; anything else must be a string, or
// statusOf() would coerce a stray object into a failure.
function isConclusion(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function fetchScheduledRuns(ctx: Ctx, ref: GhRepoRef, workflowId: number, token: string): Promise<Fetched<RunHistory>> {
  // event=schedule is the whole point: a manual re-run that succeeded must not
  // silence a scheduled slot that failed (measured 2026-09-08 on sumorikishi).
  const url = `${API}/repos/${ref.owner}/${ref.repo}/actions/workflows/${workflowId}/runs?event=schedule&status=completed&per_page=10`;
  const got = await getJson(ctx, url, token);
  if (!got.ok) return got;
  const raw = got.value?.workflow_runs;
  // Same fail-open guard as the workflow listing: a 200 whose body is not the
  // shape we expect would otherwise become "this workflow never ran", which
  // reads as healthy and drops any standing alarm.
  if (!Array.isArray(raw)) return { ok: false, reason: 'unexpected response shape (workflow_runs)' };
  // The API returns newest-first in practice but does not promise it, and a
  // re-run keeps its original created_at. Sort explicitly: an out-of-order page
  // would pick the wrong `newest` and make every gap negative.
  // Every element has to be usable. Silently dropping malformed ones lets a
  // wholly malformed page collapse to "this workflow never ran" -- which reads
  // as healthy AND drops any standing alarm as recovered.
  for (const r of raw) {
    if (typeof r?.created_at !== 'string' || isNaN(new Date(r.created_at).getTime())) {
      return { ok: false, reason: 'unexpected response shape (run entry)' };
    }
  }
  const runs = [...raw].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  if (runs.length === 0) return { ok: true, value: { newest: null, samples: 0 } };
  const times = runs.map((r) => new Date(r.created_at).getTime());
  const gaps: number[] = [];
  for (let i = 0; i < times.length - 1; i++) gaps.push((times[i] - times[i + 1]) / 3_600_000);
  // Gap stats are recorded, never judged on: GitHub throttles sub-hourly
  // schedules hard (measured: */15 firing every 4.4h), so there is no honest
  // window to derive from a declared cron yet. Stored to calibrate one later
  // (wharfe/cronscope#3).
  const newest = runs[0];
  // GitHub always sends these. Missing them would silently skip the re-run
  // check below, which is the whole point of this function.
  // Positive integers, not merely "a number": run_attempt 0 or -1 would skip
  // the re-run check below and let a re-run's success stand as the scheduled
  // slot's own, which is the masking this function exists to prevent.
  if (!isPositiveInt(newest.id) || !isPositiveInt(newest.run_attempt)) {
    return { ok: false, reason: 'unexpected response shape (run entry: id/run_attempt)' };
  }
  if (!isConclusion(newest.conclusion)) {
    return { ok: false, reason: 'unexpected response shape (run entry: conclusion)' };
  }
  let conclusion: string | null = newest.conclusion ?? null;
  // A re-run does NOT get a new run: GitHub adds an attempt to the same run and
  // the event stays `schedule`. So the listing's conclusion is the re-run's,
  // and a manual re-run that went green would hide the scheduled slot that
  // failed -- the exact masking `event=schedule` was chosen to prevent. Ask for
  // the first attempt, which is the scheduled slot's own outcome.
  if (newest.run_attempt > 1) {
    const first = await getJson(ctx, `${API}/repos/${ref.owner}/${ref.repo}/actions/runs/${newest.id}/attempts/1`, token);
    if (!first.ok) return { ok: false, reason: `first attempt of the newest scheduled run unavailable: ${first.reason}` };
    // A number or object here would be coerced into "not success" = failure.
    if (!isConclusion(first.value?.conclusion)) return { ok: false, reason: 'unexpected response shape (run attempt)' };
    conclusion = first.value.conclusion ?? null;
  }
  return {
    ok: true,
    value: {
      newest: { conclusion, createdAt: newest.created_at },
      samples: runs.length,
      ...(gaps.length ? { medianGapHours: median(gaps), maxGapHours: Math.max(...gaps) } : {}),
    },
  };
}
