import type { Connector, Ctx, Job, LastRun } from '../types.js';
import { parse } from 'yaml';            // YAML 1.2: `on` stays a string key, not boolean true
import { cronNext } from '../core/schedule.js';
import { createHash } from 'node:crypto';
import {
  resolveToken, resolveRepoRef, fetchWorkflows, listScheduledRuns, judgeListing,
  type GhRepoRef, type WorkflowInfo, type RunHistory, type RunListing, type Fetched,
} from './github-api.js';
import {
  FRESHNESS_QUERY, FRESHNESS_REASONS, FIRST_ATTEMPT_DEFERRED, isBehind, sameIdentity,
  type Baseline, type FreshIdentity, type Unresolved,
} from '../core/freshness.js';
import { recheckCandidates, type RecheckCandidate } from './gha-recheck.js';

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
    const fresh = ctx.freshness;
    // Jobs whose listing came back older than their baseline; settled after
    // every job's first listing is in, so one budget covers all re-fetches.
    const behind: { index: number; cand: RecheckCandidate }[] = [];

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
        let pending: RecheckCandidate | undefined;
        if (token && info && info.state !== 'other' && split) {
          const ref = refs.get(split.repoDir)!;
          const identity: FreshIdentity = { repo: `${ref.owner}/${ref.repo}`, workflowId: info.id, path: split.wfPath, query: FRESHNESS_QUERY };
          const prev = fresh?.entries[jobId];
          // A baseline from another repo / workflow / path / query is not comparable.
          const baseline = prev && sameIdentity(prev.identity, identity) ? prev.baseline : undefined;
          const listed = await listScheduledRuns(ctx, ref, info.id, token);
          if (!listed.ok) {
            lastRun = { status: 'unknown', fetchedAt, undeterminedReason: `run history unavailable: ${listed.reason}` };
            // Nothing about freshness was observed: the streak stays where it was.
            fresh?.proposals.set(jobId, { identity, op: 'keep', touched: false });
          } else if (fresh && baseline && isBehind(baseline, listed.value.newest?.createdAt ?? null)) {
            pending = { jobId, ref, identity, baseline, firstPage: listed.value.page };
          } else {
            const judged = await judgeListing(ctx, ref, listed.value, token);
            ({ lastRun, observed } = fromHistory(judged, listed.value, fetchedAt));
            fresh?.proposals.set(jobId, {
              identity, op: 'reset', outcome: 'fresh', touched: false,
              baseline: adopt(listed.value, judged, identity, baseline, fetchedAt),
            });
          }
        }

        const state = info && info.state !== 'other' ? info.state : undefined;
        // A disabled workflow has no next run. Computing one shows a future
        // time for something GitHub has already stopped firing.
        const nexts = (state && state !== 'active') || info?.state === 'other'
          ? []
          : crons.map((c) => cronNext(c, now, 'UTC')).filter((x): x is string => !!x).sort();
        const nextRun = nexts[0];

        if (pending) behind.push({ index: jobs.length, cand: pending });
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
    if (fresh && behind.length) await settleBehind(ctx, token!, fresh, jobs, behind, fetchedAt);
    return jobs;
  },
};

type Judged = Fetched<RunHistory>;

// The verdict for one judged listing, exactly as before freshness existed.
function fromHistory(got: Judged, listing: RunListing, fetchedAt: string): { lastRun: LastRun; observed?: Job['observed'] } {
  if (!got.ok) {
    return { lastRun: { status: 'unknown', fetchedAt,
      undeterminedReason: got.reason === FIRST_ATTEMPT_DEFERRED ? got.reason : `run history unavailable: ${got.reason}` } };
  }
  const h = got.value;
  const observed = { samples: h.samples, medianGapHours: h.medianGapHours, maxGapHours: h.maxGapHours };
  if (!h.newest || !listing.newest) return { lastRun: { status: 'never', fetchedAt }, observed };
  const s = statusOf(h.newest.conclusion);
  return {
    observed,
    lastRun: {
      status: s.status,
      at: new Date(h.newest.createdAt).toISOString(),
      fetchedAt,
      undeterminedReason: s.reason,
      // Field by field, not `...h.judged`: the snapshot persists the
      // whole Job, so only the allowlisted identity may ride along.
      ...(h.judged ? { run: {
        id: h.judged.runId,
        judgedAttempt: h.judged.judgedAttempt,
        latestAttempt: h.judged.latestAttempt,
        conclusion: h.judged.conclusion,
        latestConclusion: h.judged.latestConclusion,
      } } : {}),
    },
  };
}

// The listing's newest becomes the baseline only when it is provably a
// scheduled run of THIS workflow and not older than the current baseline.
// Otherwise the previous baseline stands (undefined = keep).
function adopt(listing: RunListing, judged: Judged, identity: FreshIdentity, prev: Baseline | undefined, at: string): Baseline | undefined {
  const n = listing.newest;
  if (!n || n.workflowId !== identity.workflowId || n.event !== 'schedule') return undefined;
  if (prev && new Date(n.createdAt).getTime() < new Date(prev.createdAt).getTime()) return undefined;
  const s = judged.ok && judged.value.newest ? statusOf(judged.value.newest.conclusion).status : 'unknown';
  return {
    runId: n.id,
    createdAt: new Date(n.createdAt).toISOString(),
    judgedStatus: s,
    conclusion: judged.ok ? judged.value.judged?.conclusion ?? null : null,
    judgedAttempt: judged.ok ? judged.value.judged?.judgedAttempt ?? n.runAttempt : n.runAttempt,
    latestAttempt: n.runAttempt,
    confirmedAt: at,
  };
}

function lastObservedOf(b: Baseline): NonNullable<LastRun['lastObserved']> {
  return { runId: b.runId, createdAt: b.createdAt, status: b.judgedStatus, confirmedAt: b.confirmedAt };
}

// Decide every behind job. A reader only reports it; a writer re-fetches
// within the budget and proposes the next entry for the check to save.
async function settleBehind(
  ctx: Ctx, token: string, fresh: NonNullable<Ctx['freshness']>, jobs: Job[],
  behind: { index: number; cand: RecheckCandidate }[], fetchedAt: string,
): Promise<void> {
  const unresolved = (c: RecheckCandidate, state: Unresolved | 'unrechecked', rest: Partial<NonNullable<LastRun['freshness']>> & { pages: NonNullable<LastRun['freshness']>['pages'] }): LastRun => ({
    status: 'unknown', fetchedAt,
    undeterminedReason: FRESHNESS_REASONS[state === 'unrechecked' ? 'reader' : state],
    freshness: { state, retries: 0, ...rest },
    lastObserved: lastObservedOf(c.baseline),
  });

  if (fresh.mode === 'reader') {
    for (const { index, cand } of behind) jobs[index].lastRun = unresolved(cand, 'unrechecked', { pages: [cand.firstPage] });
    return;
  }
  const results = await recheckCandidates(ctx, token, behind.map((b) => b.cand), fresh.entries);
  for (const { index, cand } of behind) {
    const r = results.get(cand.jobId)!;
    if (r.outcome === 'recovered') {
      const { lastRun, observed } = fromHistory(r.judged, r.listing, fetchedAt);
      jobs[index].lastRun = { ...lastRun, freshness: { state: 'recovered', retries: r.retries, pages: r.pages } };
      jobs[index].observed = observed;
      fresh.proposals.set(cand.jobId, {
        identity: cand.identity, op: 'reset', outcome: 'recovered', touched: true,
        baseline: adopt(r.listing, r.judged, cand.identity, cand.baseline, fetchedAt),
      });
    } else {
      jobs[index].lastRun = unresolved(cand, r.outcome, {
        retries: r.retries, pages: r.pages,
        ...(r.probe ? { probe: r.probe } : {}), ...(r.stop ? { stop: r.stop } : {}),
      });
      jobs[index].observed = undefined;
      fresh.proposals.set(cand.jobId, {
        identity: cand.identity, op: 'inc', outcome: r.outcome, touched: r.touched,
        ...(r.probe === 'not-found' ? { notFound: true } : {}),
      });
    }
  }
}

// Cached per checkout: `git rev-parse` is a process spawn and several workflow
// files usually share one repo. When the root cannot be determined we keep the
// job -- being permissive is the pre-existing behaviour and a missing git is
// not evidence that the workflow is bogus.
async function isNotAtRepoRoot(ctx: Ctx, roots: Map<string, string | null>, repoDir: string): Promise<boolean> {
  if (!roots.has(repoDir)) roots.set(repoDir, await repoRootOf(ctx, repoDir));
  const root = roots.get(repoDir) ?? null;
  return root !== null && root !== repoDir;
}
