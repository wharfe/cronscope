import type { Connector, Ctx, Job, LastRun } from '../types.js';
import { parse } from 'yaml';            // YAML 1.2: `on` stays a string key, not boolean true
import { cronNext } from '../core/schedule.js';
import { createHash } from 'node:crypto';
import {
  resolveToken, resolveRepoRef, fetchWorkflows, fetchScheduledRuns,
  type GhRepoRef, type WorkflowInfo,
} from './github-api.js';

function relPath(ctx: Ctx, file: string): string {
  for (const root of ctx.scanRoots) if (file.startsWith(root)) return file.slice(root.length).replace(/^\//, '');
  return file;
}

const VENDORED_PATH_SEGMENTS = [
  'node_modules',
  '_deps',
  '_build',
  'vendor',
  'dist',
  'build',
  'target',
  '.git',
];

function isVendoredWorkflowPath(file: string): boolean {
  return VENDORED_PATH_SEGMENTS.some((segment) => file.includes(`/${segment}/`));
}

// A user's own repos sit at scanRoot/<repo> (depth 1) or scanRoot/<org>/<repo>
// (depth 2). A `.github` nested deeper than this is almost always a vendored
// submodule / bundled dependency (e.g. native/deepfilter-src/.github), not a
// schedule the user owns. `rel` is the path relative to its scanRoot.
const MAX_REPO_DEPTH = 2;

function repoDepth(rel: string): number {
  const gi = rel.split('/').indexOf('.github');
  return gi < 0 ? 0 : gi; // number of path segments before `.github`
}

const WORKFLOW_DIR = '/.github/workflows/';

// `/home/u/dev/proj/.github/workflows/x.yml`
//   -> { repoDir: '/home/u/dev/proj', wfPath: '.github/workflows/x.yml' }
function splitWorkflowPath(file: string): { repoDir: string; wfPath: string } | null {
  const i = file.indexOf(WORKFLOW_DIR);
  return i < 0 ? null : { repoDir: file.slice(0, i), wfPath: file.slice(i + 1) };
}

// `cancelled` counts as a failure: sumorikishi went three consecutive
// cancelled runs unnoticed for two days. `skipped` does not -- a workflow whose
// jobs are all conditioned out is not necessarily broken -- but it is not a
// success either, so it becomes undetermined with a reason rather than passing
// quietly.
function statusOf(conclusion: string | null): { status: 'success' | 'failure' | 'unknown'; reason?: string } {
  if (conclusion === 'success') return { status: 'success' };
  if (conclusion === 'skipped') return { status: 'unknown', reason: 'newest scheduled run was skipped (all jobs skipped)' };
  // GitHub treats `neutral` as non-failing (branch protection passes on it), so
  // alarming would be a false positive -- but it is not a success either.
  if (conclusion === 'neutral') return { status: 'unknown', reason: 'newest scheduled run ended neutral' };
  if (conclusion === null) return { status: 'unknown', reason: 'newest scheduled run has no conclusion' };
  return { status: 'failure' };
}

// GitHub only runs `.github/workflows` at the REPOSITORY root. A workflow file
// under a subdirectory is not a workflow at all -- but `git -C` walks up, so
// resolving its origin would return the parent repo and attach that repo's run
// history to a job that does not exist on GitHub.
async function repoRootOf(ctx: Ctx, dir: string): Promise<string | null> {
  const r = await ctx.run(['git', '-C', dir, 'rev-parse', '--show-toplevel']);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : null;
}

export const githubActionsConnector: Connector = {
  id: 'github-actions',
  tier: 0,
  async availability(ctx) {
    if (ctx.scanRoots.length === 0) return { state: 'unavailable', reason: 'no scanRoots' };
    // Discovery does not need a token; only run status does. Saying `degraded`
    // rather than `available` is what keeps "cannot tell" from reading as "fine".
    if (!(await resolveToken(ctx))) {
      return { state: 'degraded', reason: 'no GitHub token (CRONSCOPE_GH_TOKEN / GITHUB_TOKEN / gh auth token)' };
    }
    return { state: 'available' };
  },
  async discover(ctx) {
    const token = await resolveToken(ctx);
    const refs = new Map<string, GhRepoRef | null>();
    const roots = new Map<string, string | null>();
    const wfIndex = new Map<string, { map: Map<string, WorkflowInfo> | null; reason?: string }>();
    const jobs: Job[] = [];
    const now = ctx.now();
    const fetchedAt = now.toISOString();

    for (const root of ctx.scanRoots) {
      for (const file of await ctx.glob('**/.github/workflows/*.{yml,yaml}', root)) {
        if (isVendoredWorkflowPath(file)) continue;
        const rel = relPath(ctx, file);
        if (repoDepth(rel) > MAX_REPO_DEPTH) continue; // skip deeply-nested vendored/submodule workflows
        const jobId = 'gha|' + createHash('sha1').update(rel).digest('hex').slice(0, 12);
        let doc: any;
        try {
          doc = parse(await ctx.readFile(file));
        } catch {
          // Do NOT drop it. The job vanishing from the snapshot reads as
          // "recovered" to the notify state, so a workflow whose file broke
          // would take its standing alarm with it -- and a broken workflow is
          // exactly the one worth watching. The id is derived from the path,
          // so the job keeps its identity across the failure.
          jobs.push({
            id: jobId, source: 'github-actions', name: rel, target: rel, location: rel,
            schedule: { raw: '(unreadable)', kind: 'cron', timezone: 'UTC', nextRunSource: 'unknown' },
            // Fixed wording on purpose. A YAML parse error quotes the offending
            // source line, and this string is persisted to the snapshot and
            // posted to Slack -- a token written into a broken workflow file
            // would ride along. The detail stays out of every output.
            lastRun: { status: 'unknown', fetchedAt,
                       undeterminedReason: 'workflow file could not be read or parsed' },
          });
          continue;
        }
        const schedules = doc?.on?.schedule;
        if (!Array.isArray(schedules)) continue;
        const crons: string[] = schedules
          .map((s: any) => (typeof s?.cron === 'string' ? s.cron : null))
          .filter((c: string | null): c is string => !!c);
        if (crons.length === 0) continue;

        let info: WorkflowInfo | undefined;
        let undetermined: string | undefined;
        const split = splitWorkflowPath(file);

        if (!token) {
          undetermined = 'no GitHub token';
        } else if (!split) {
          undetermined = 'cannot locate the repo root for this workflow';
        } else if (await isNotAtRepoRoot(ctx, roots, split.repoDir)) {
          continue; // not a real GitHub Actions workflow; do not invent a job for it
        } else {
          // Resolve the repo, and its workflow index, once per checkout.
          if (!refs.has(split.repoDir)) refs.set(split.repoDir, await resolveRepoRef(ctx, split.repoDir));
          const ref = refs.get(split.repoDir) ?? null;
          if (!ref) {
            undetermined = 'no GitHub origin remote in this checkout';
          } else {
            if (!wfIndex.has(split.repoDir)) {
              const got = await fetchWorkflows(ctx, ref, token);
              wfIndex.set(split.repoDir, got.ok ? { map: got.value } : { map: null, reason: got.reason });
            }
            const idx = wfIndex.get(split.repoDir)!;
            if (!idx.map) undetermined = `workflow list unavailable: ${idx.reason}`;
            else {
              info = idx.map.get(split.wfPath);
              if (!info) undetermined = 'workflow not present in the GitHub API listing';
              else if (info.state === 'other') undetermined = `unexpected workflow state: ${info.rawState}`;
            }
          }
        }

        let lastRun: LastRun = { status: 'unknown', fetchedAt, undeterminedReason: undetermined };
        let observed: Job['observed'];
        if (token && info && info.state !== 'other' && split) {
          const got = await fetchScheduledRuns(ctx, refs.get(split.repoDir)!, info.id, token);
          if (!got.ok) {
            lastRun = { status: 'unknown', fetchedAt, undeterminedReason: `run history unavailable: ${got.reason}` };
          } else {
            const h = got.value;
            observed = { samples: h.samples, medianGapHours: h.medianGapHours, maxGapHours: h.maxGapHours };
            if (!h.newest) lastRun = { status: 'never', fetchedAt };
            else {
              const s = statusOf(h.newest.conclusion);
              lastRun = {
                status: s.status,
                at: new Date(h.newest.createdAt).toISOString(),
                fetchedAt,
                undeterminedReason: s.reason,
              };
            }
          }
        }

        const state = info && info.state !== 'other' ? info.state : undefined;
        // A disabled workflow has no next run. Computing one shows a future
        // time for something GitHub has already stopped firing.
        const nexts = (state && state !== 'active') || info?.state === 'other'
          ? []
          : crons.map((c) => cronNext(c, now, 'UTC')).filter((x): x is string => !!x).sort();
        const nextRun = nexts[0];

        jobs.push({
          // One job per workflow, not per cron entry: GitHub reports runs per
          // workflow, so per-entry jobs would share one lastRun and a stopped
          // entry would hide behind a healthy sibling.
          id: jobId,
          source: 'github-actions',
          name: rel,
          schedule: {
            raw: crons.join(', '), kind: 'cron', timezone: 'UTC', nextRun,
            nextRunSource: nextRun ? 'computed' : 'unknown',
          },
          target: rel,
          location: rel,
          state,
          observed,
          lastRun,
        });
      }
    }
    return jobs;
  },
};

// Cached per checkout: `git rev-parse` is a process spawn and several workflow
// files usually share one repo. When the root cannot be determined we keep the
// job -- being permissive is the pre-existing behaviour and a missing git is
// not evidence that the workflow is bogus.
async function isNotAtRepoRoot(ctx: Ctx, roots: Map<string, string | null>, repoDir: string): Promise<boolean> {
  if (!roots.has(repoDir)) roots.set(repoDir, await repoRootOf(ctx, repoDir));
  const root = roots.get(repoDir) ?? null;
  return root !== null && root !== repoDir;
}
