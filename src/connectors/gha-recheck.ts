import type { Ctx } from '../types.js';
import {
  listScheduledRuns, judgeListing, fetchRun,
  type GhRepoRef, type RunListing, type RunHistory,
} from './github-api.js';
import {
  Budget, FRESHNESS_DEFAULTS, FIRST_ATTEMPT_DEFERRED, classifyProbe, isBehind, recheckOrder, stopsRechecks,
  type Baseline, type FreshEntry, type FreshIdentity, type Unresolved,
} from '../core/freshness.js';

export interface RecheckCandidate {
  jobId: string;
  ref: GhRepoRef;
  identity: FreshIdentity;
  baseline: Baseline;
  firstPage: RunListing['page'];
}

export type RecheckResult =
  | { outcome: 'recovered'; touched: true; retries: number; pages: RunListing['page'][];
      listing: RunListing; judged: { ok: true; value: RunHistory } | { ok: false; reason: string } }
  | { outcome: Unresolved; touched: boolean; retries: number; pages: RunListing['page'][];
      probe?: 'not-found' | 'shape' | 'mismatch' | 'http' | 'network' | 'ok'; stop?: 401 | 403 | 429 };

// The second stage of a writer scan: re-fetch the jobs whose listing came back
// older than their baseline, within ONE budget for the whole check.
//
// Order is recheckOrder(); a job counts as `touched` from the moment it starts
// its first wait, which is the only thing that moves it to the back next time.
// A 401 / 403 / 429 anywhere stops every remaining re-fetch in this check.
export async function recheckCandidates(
  ctx: Ctx, token: string, cands: RecheckCandidate[], entries: Record<string, FreshEntry>,
  opts: { budgetMs?: number } = {},
): Promise<Map<string, RecheckResult>> {
  const d = FRESHNESS_DEFAULTS;
  const mono = ctx.monoMs ?? (() => performance.now());
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = new Budget(mono, opts.budgetMs ?? d.budgetMs);
  const byId = new Map(cands.map((c) => [c.jobId, c]));
  const out = new Map<string, RecheckResult>();
  let stopped: 401 | 403 | 429 | undefined;
  let started = 0;

  for (const id of recheckOrder([...byId.keys()], entries)) {
    const c = byId.get(id)!;
    const pages: RunListing['page'][] = [c.firstPage];
    const deferred = (touched: boolean, retries: number): RecheckResult =>
      ({ outcome: 'deferred', touched, retries, pages, ...(stopped ? { stop: stopped } : {}) });

    if (stopped || ctx.abort?.aborted || started >= d.maxTargets || !budget.canWaitThenCall(d.waitsMs[0], d.minSliceMs)) {
      out.set(id, deferred(false, 0));
      continue;
    }
    started++;
    let retries = 0;
    let result: RecheckResult | undefined;

    for (const waitMs of d.waitsMs) {
      if (!budget.canWaitThenCall(waitMs, d.minSliceMs)) { result = deferred(true, retries); break; }
      await sleep(waitMs);
      if (ctx.abort?.aborted || !budget.canCall(d.minSliceMs)) { result = deferred(true, retries); break; }
      retries++;
      const got = await listScheduledRuns(ctx, c.ref, c.identity.workflowId, token, budget.callTimeout(d.callTimeoutMs));
      if (!got.ok) {
        if (stopsRechecks(got.status)) stopped = got.status as 401 | 403 | 429;
        result = { outcome: 'unverified', touched: true, retries, pages, ...(stopped ? { stop: stopped } : {}) };
        break;
      }
      pages.push(got.value.page);
      if (!isBehind(c.baseline, got.value.newest?.createdAt ?? null)) {
        // Fresh again. The verdict may still need the attempt-1 lookup, which
        // is paid from the same budget; without it the freshness is resolved
        // but the verdict is the ordinary "first attempt unavailable".
        const needsCall = (got.value.newest?.runAttempt ?? 1) > 1;
        let judged: { ok: true; value: RunHistory } | { ok: false; reason: string };
        if (needsCall && !budget.canCall(d.minSliceMs)) {
          judged = { ok: false, reason: FIRST_ATTEMPT_DEFERRED };
        } else {
          const j = await judgeListing(ctx, c.ref, got.value, token, budget.callTimeout(d.callTimeoutMs));
          if (!j.ok && stopsRechecks(j.status)) stopped = j.status as 401 | 403 | 429;
          judged = j.ok ? j : { ok: false, reason: j.reason };
        }
        result = { outcome: 'recovered', touched: true, retries, pages, listing: got.value, judged };
        break;
      }
    }

    if (!result) {
      // Still older after both re-fetches: ask whether the baseline run exists.
      if (ctx.abort?.aborted || !budget.canCall(d.minSliceMs)) {
        result = deferred(true, retries);
      } else {
        const got = await fetchRun(ctx, c.ref, c.baseline.runId, token, budget.callTimeout(d.callTimeoutMs));
        if (!got.ok && stopsRechecks(got.status)) stopped = got.status as 401 | 403 | 429;
        const v = classifyProbe(c.baseline, c.identity, got.ok
          ? { ok: true, value: got.value }
          : { ok: false, status: got.status, shapeError: /unexpected response shape/.test(got.reason) });
        result = {
          outcome: v.outcome, touched: true, retries, pages,
          probe: v.outcome === 'unverified' ? v.note : 'ok',
          ...(stopped ? { stop: stopped } : {}),
        };
      }
    }
    out.set(id, result);
  }
  return out;
}
