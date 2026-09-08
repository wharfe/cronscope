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
export type WorkflowState = 'active' | 'disabled_manually' | 'disabled_inactivity';
export interface WorkflowInfo { id: number; state: WorkflowState }
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

export async function fetchWorkflows(ctx: Ctx, ref: GhRepoRef, token: string): Promise<Fetched<Map<string, WorkflowInfo>>> {
  const got = await getJson(ctx, `${API}/repos/${ref.owner}/${ref.repo}/actions/workflows?per_page=100`, token);
  if (!got.ok) return got;
  const map = new Map<string, WorkflowInfo>();
  for (const w of got.value?.workflows ?? []) {
    if (typeof w?.path !== 'string' || typeof w?.id !== 'number') continue;
    const state: WorkflowState = w.state === 'disabled_manually' || w.state === 'disabled_inactivity' ? w.state : 'active';
    map.set(w.path, { id: w.id, state });
  }
  return { ok: true, value: map };
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
  const raw: any[] = got.value?.workflow_runs ?? [];
  // The API returns newest-first in practice but does not promise it, and a
  // re-run keeps its original created_at. Sort explicitly: an out-of-order page
  // would pick the wrong `newest` and make every gap negative.
  const runs = raw
    .filter((r) => !isNaN(new Date(r?.created_at).getTime()))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  if (runs.length === 0) return { ok: true, value: { newest: null, samples: 0 } };
  const times = runs.map((r) => new Date(r.created_at).getTime());
  const gaps: number[] = [];
  for (let i = 0; i < times.length - 1; i++) gaps.push((times[i] - times[i + 1]) / 3_600_000);
  // Gap stats are recorded, never judged on: GitHub throttles sub-hourly
  // schedules hard (measured: */15 firing every 4.4h), so there is no honest
  // window to derive from a declared cron yet. Stored to calibrate one later
  // (wharfe/cronscope#3).
  return {
    ok: true,
    value: {
      newest: { conclusion: runs[0].conclusion ?? null, createdAt: runs[0].created_at },
      samples: runs.length,
      ...(gaps.length ? { medianGapHours: median(gaps), maxGapHours: Math.max(...gaps) } : {}),
    },
  };
}
