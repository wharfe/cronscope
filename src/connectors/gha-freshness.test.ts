import { describe, it, expect, vi } from 'vitest';
import { githubActionsConnector } from './github-actions.js';
import type { Ctx, Job } from '../types.js';
import { FRESHNESS_QUERY, type FreshEntry, type FreshProposal } from '../core/freshness.js';

// The connector with a scripted GitHub and a scripted clock: no network, no
// real waiting. Expectations are literals from the contract
// (docs/specs/2026-10-04-gha-run-freshness.md), not re-derived comparisons.

const WORKFLOW = 'name: w\non:\n  schedule:\n    - cron: "0 21 * * *"\njobs: {}\n';
const ROOT = '/home/u/dev';
const TOKEN = 'ghp_dummy_token_0123456789';

type Resp = { status: number; body?: any };
const run = (id: number, created: string, conclusion = 'success', extra: object = {}) =>
  ({ id, run_attempt: 1, conclusion, created_at: created, workflow_id: 7, event: 'schedule', ...extra });
const page = (...runs: any[]): Resp => ({ status: 200, body: { total_count: 2500, workflow_runs: runs } });
const probe = (over: object = {}): Resp => ({ status: 200, body: { id: 100, workflow_id: 7, event: 'schedule', status: 'completed', created_at: '2026-10-03T02:13:07Z', ...over } });

const OLD = run(50, '2026-09-17T11:55:17Z', 'failure');      // an old page whose top is a failure
const FRESH = run(101, '2026-10-03T08:06:11Z');
const BASE = { runId: 100, createdAt: '2026-10-03T02:13:07.000Z', judgedStatus: 'success' as const, conclusion: 'success', judgedAttempt: 1, latestAttempt: 1, confirmedAt: '2026-10-03T06:17:05.000Z' };

interface World {
  ctx: Ctx; calls: string[]; t: { now: number };
  proposals: Map<string, FreshProposal>;
}

// `wf` names workflow files; each gets workflow id 7, 8, 9 ... in order and
// its own scripted list of listing answers (the last answer repeats).
function world(opts: {
  wf?: string[]; lists: Record<string, Resp[]>; probes?: Record<string, Resp[]>; attempts?: Resp;
  entries?: Record<string, FreshEntry>; mode?: 'writer' | 'reader'; latencyMs?: number; noFreshness?: boolean;
}): World {
  const wf = opts.wf ?? ['daily'];
  const files: Record<string, string> = {};
  for (const w of wf) files[`${ROOT}/proj/.github/workflows/${w}.yml`] = WORKFLOW;
  const t = { now: 0 };
  const calls: string[] = [];
  const used: Record<string, number> = {};
  const next = (key: string, script: Resp[] | undefined): Resp => {
    if (!script?.length) return { status: 500 };
    const i = used[key] ?? 0; used[key] = i + 1;
    return script[Math.min(i, script.length - 1)];
  };
  const workflows = wf.map((w, i) => ({ id: 7 + i, path: `.github/workflows/${w}.yml`, state: 'active' }));
  const proposals = new Map<string, FreshProposal>();
  const ctx: Ctx = {
    now: () => new Date('2026-10-03T08:17:05.000Z'),
    run: async (cmd) => cmd.includes('rev-parse')
      ? { stdout: `${ROOT}/proj\n`, stderr: '', code: 0 }
      : { stdout: 'https://github.com/wharfe/proj.git\n', stderr: '', code: 0 },
    readFile: async (p) => files[p] ?? '',
    glob: async () => Object.keys(files),
    env: { CRONSCOPE_GH_TOKEN: TOKEN }, homeDir: '/home/u', scanRoots: [ROOT],
    monoMs: () => t.now,
    sleep: async (ms) => { t.now += ms; },
    fetch: (async (url: string) => {
      const u = String(url);
      t.now += opts.latencyMs ?? 100;
      let r: Resp;
      const lm = u.match(/\/workflows\/(\d+)\/runs\?/);
      const pm = u.match(/\/actions\/runs\/(\d+)$/);
      if (lm) { const name = wf[Number(lm[1]) - 7]; calls.push(`list:${name}`); r = next(`l:${name}`, opts.lists[name]); }
      else if (u.includes('/attempts/1')) { calls.push('attempt1'); r = opts.attempts ?? { status: 200, body: { conclusion: 'failure' } }; }
      else if (pm) { calls.push(`probe:${pm[1]}`); r = next(`p:${pm[1]}`, opts.probes?.[pm[1]]); }
      else { calls.push('workflows'); r = { status: 200, body: { total_count: workflows.length, workflows } }; }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    }) as unknown as typeof fetch,
    ...(opts.noFreshness ? {} : { freshness: { mode: opts.mode ?? 'writer', entries: opts.entries ?? {}, proposals } }),
  };
  return { ctx, calls, t, proposals };
}

const jobIdOf = async (name = 'daily') => {
  const w = world({ wf: [name], lists: { [name]: [page(FRESH)] }, noFreshness: true });
  return (await githubActionsConnector.discover(w.ctx))[0].id;
};
const entryFor = (wfIndex: number, over: Partial<FreshEntry> = {}, name = 'daily'): FreshEntry => ({
  identity: { repo: 'wharfe/proj', workflowId: 7 + wfIndex, path: `.github/workflows/${name}.yml`, query: FRESHNESS_QUERY },
  baseline: BASE, streak: 0, lastSeenAt: '2026-10-03T07:17:05.000Z', ...over,
});

async function discover(w: World): Promise<Job[]> { return githubActionsConnector.discover(w.ctx); }

describe('run freshness in the connector: the first listing', () => {
  it('#1 a newer listing judges normally and proposes it as the new baseline', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(FRESH)] }, entries: { [id]: entryFor(0) } });
    const [j] = await discover(w);
    expect(j.lastRun?.status).toBe('success');
    expect(j.lastRun?.freshness).toBeUndefined();
    expect(w.proposals.get(id)).toMatchObject({ op: 'reset', outcome: 'fresh', touched: false, baseline: { runId: 101, createdAt: '2026-10-03T08:06:11.000Z' } });
    expect(w.calls).toEqual(['workflows', 'list:daily']);
  });

  it('#2 first run: no baseline, the listing is believed (the known limit) and adopted', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(OLD)] } });
    const [j] = await discover(w);
    expect(j.lastRun?.status).toBe('failure');
    expect(w.proposals.get(id)?.baseline?.runId).toBe(50);
  });

  it('#2 a newest that is not provably this workflow\'s scheduled run is never adopted', async () => {
    const id = await jobIdOf();
    for (const extra of [{ workflow_id: 99 }, { event: 'workflow_dispatch' }, { workflow_id: undefined }]) {
      const w = world({ lists: { daily: [page(run(101, '2026-10-03T08:06:11Z', 'success', extra))] }, entries: { [id]: entryFor(0) } });
      await discover(w);
      expect(w.proposals.get(id)).toMatchObject({ op: 'reset', outcome: 'fresh' });
      expect(w.proposals.get(id)?.baseline).toBeUndefined();   // the old baseline stands
    }
  });

  it('#3 an empty first listing without a baseline is `never` and adopts nothing', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page()] } });
    const [j] = await discover(w);
    expect(j.lastRun?.status).toBe('never');
    expect(w.proposals.get(id)?.baseline).toBeUndefined();
  });

  it('#18 a failed first listing keeps the streak (op keep) and does not re-fetch', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [{ status: 502 }] }, entries: { [id]: entryFor(0, { streak: 1 }) } });
    const [j] = await discover(w);
    expect(j.lastRun?.undeterminedReason).toBe('run history unavailable: HTTP 502');
    expect(w.proposals.get(id)).toMatchObject({ op: 'keep', touched: false });
    expect(w.calls).toEqual(['workflows', 'list:daily']);
  });

  it('#43 a baseline recorded under another identity is not compared', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(OLD)] }, entries: { [id]: entryFor(0, {}, 'other') } });
    const [j] = await discover(w);
    expect(j.lastRun?.status).toBe('failure');
    expect(w.calls).toEqual(['workflows', 'list:daily']);
  });

  it('#46 a re-run of the same run is not a step back', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(run(100, '2026-10-03T02:13:07Z', 'success', { run_attempt: 2 }))] }, entries: { [id]: entryFor(0) } });
    const [j] = await discover(w);
    expect(j.lastRun?.status).toBe('failure');   // judged by attempt 1, as before
    expect(w.proposals.get(id)).toMatchObject({ op: 'reset', baseline: { runId: 100, latestAttempt: 2, judgedAttempt: 1 } });
  });
});

describe('run freshness in the connector: re-fetching an older listing (writer)', () => {
  it('#4 recovers on R1 after a 1s wait', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(OLD), page(FRESH)] }, entries: { [id]: entryFor(0) } });
    const [j] = await discover(w);
    expect(j.lastRun).toMatchObject({ status: 'success', at: '2026-10-03T08:06:11.000Z', freshness: { state: 'recovered', retries: 1 } });
    expect(w.proposals.get(id)).toMatchObject({ op: 'reset', outcome: 'recovered', touched: true, baseline: { runId: 101 } });
    expect(w.calls).toEqual(['workflows', 'list:daily', 'list:daily']);
  });

  it('#5 #21 still older after R1, R2 and a completed baseline: unknown/behind, no FAILURE, nothing from the old page', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(OLD)] }, probes: { 100: [probe()] }, entries: { [id]: entryFor(0) } });
    const [j] = await discover(w);
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.undeterminedReason).toBe('run freshness: listing is older than a run seen before');
    expect(j.lastRun?.at).toBeUndefined();
    expect(j.lastRun?.run).toBeUndefined();
    expect(j.observed).toBeUndefined();
    expect(j.lastRun?.lastObserved).toEqual({ runId: 100, createdAt: '2026-10-03T02:13:07.000Z', status: 'success', confirmedAt: '2026-10-03T06:17:05.000Z' });
    expect(j.lastRun?.freshness).toMatchObject({ state: 'behind', retries: 2, probe: 'ok' });
    expect(j.lastRun?.freshness?.pages).toHaveLength(3);
    expect(w.proposals.get(id)).toMatchObject({ op: 'inc', outcome: 'behind', touched: true });
    expect(w.proposals.get(id)?.baseline).toBeUndefined();
    expect(w.calls).toEqual(['workflows', 'list:daily', 'list:daily', 'list:daily', 'probe:100']);
  });

  it('#50 an empty listing with a baseline is a step back too', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page()] }, probes: { 100: [probe()] }, entries: { [id]: entryFor(0) } });
    expect((await discover(w))[0].lastRun?.freshness?.state).toBe('behind');
  });

  it('#8 a baseline being re-run is `rerunning`', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(OLD)] }, probes: { 100: [probe({ status: 'in_progress' })] }, entries: { [id]: entryFor(0) } });
    expect((await discover(w))[0].lastRun?.freshness?.state).toBe('rerunning');
  });

  it('#9 a 404 for the baseline keeps it: unknown/unverified, notFound recorded', async () => {
    const id = await jobIdOf();
    const w = world({ lists: { daily: [page(OLD)] }, probes: { 100: [{ status: 404 }] }, entries: { [id]: entryFor(0) } });
    const [j] = await discover(w);
    expect(j.lastRun).toMatchObject({ status: 'unknown', freshness: { state: 'unverified', probe: 'not-found' } });
    expect(w.proposals.get(id)).toMatchObject({ op: 'inc', outcome: 'unverified', notFound: true });
    expect(w.proposals.get(id)?.baseline).toBeUndefined();
  });

  it('#14 #15 a malformed or mismatching 200 keeps the baseline', async () => {
    const id = await jobIdOf();
    for (const [p, note] of [[probe({ workflow_id: 'x' }), 'shape'], [probe({ workflow_id: 8 }), 'mismatch'], [probe({ event: 'push' }), 'mismatch']] as const) {
      const w = world({ lists: { daily: [page(OLD)] }, probes: { 100: [p] }, entries: { [id]: entryFor(0) } });
      expect((await discover(w))[0].lastRun?.freshness).toMatchObject({ state: 'unverified', probe: note });
      expect(w.proposals.get(id)?.baseline).toBeUndefined();
    }
  });

  it('#13 a 5xx on R2 is unverified and does not stop the other jobs', async () => {
    const [a, b] = [await jobIdOf('a'), await jobIdOf('b')];
    const w = world({
      wf: ['a', 'b'], lists: { a: [page(OLD), page(OLD), { status: 503 }], b: [page(OLD), page(FRESH)] },
      entries: { [a]: entryFor(0, {}, 'a'), [b]: entryFor(1, {}, 'b') },
    });
    const jobs = await discover(w);
    expect(jobs.find((j) => j.id === a)?.lastRun?.freshness).toMatchObject({ state: 'unverified', retries: 2 });
    expect(jobs.find((j) => j.id === b)?.lastRun?.freshness?.state).toBe('recovered');
  });

  it.each([401, 403, 429])('#10 #11 #12 a %i stops every remaining re-fetch in this check', async (code) => {
    const [a, b] = [await jobIdOf('a'), await jobIdOf('b')];
    const w = world({
      wf: ['a', 'b'], lists: { a: [page(OLD), { status: code }], b: [page(OLD), page(FRESH)] },
      entries: { [a]: entryFor(0, {}, 'a'), [b]: entryFor(1, {}, 'b') },
    });
    const jobs = await discover(w);
    expect(jobs.find((j) => j.id === a)?.lastRun?.freshness).toMatchObject({ state: 'unverified', stop: code });
    expect(jobs.find((j) => j.id === b)?.lastRun?.freshness).toMatchObject({ state: 'deferred', retries: 0, stop: code });
    expect(w.proposals.get(b)).toMatchObject({ op: 'inc', outcome: 'deferred', touched: false });
    // b was never re-fetched: only its first listing.
    expect(w.calls.filter((c) => c === 'list:b')).toHaveLength(1);
    // No wait was spent after the stop (only a's 1s wait).
    expect(w.calls.filter((c) => c.startsWith('probe'))).toEqual([]);
  });

  it('#10 a 401 on the baseline GET also stops the rest', async () => {
    const [a, b] = [await jobIdOf('a'), await jobIdOf('b')];
    const w = world({
      wf: ['a', 'b'], lists: { a: [page(OLD)], b: [page(OLD), page(FRESH)] }, probes: { 100: [{ status: 401 }] },
      entries: { [a]: entryFor(0, {}, 'a'), [b]: entryFor(1, {}, 'b') },
    });
    const jobs = await discover(w);
    expect(jobs.find((j) => j.id === a)?.lastRun?.freshness).toMatchObject({ state: 'unverified', probe: 'http', stop: 401 });
    expect(jobs.find((j) => j.id === b)?.lastRun?.freshness?.state).toBe('deferred');
  });

  it('#16 at most 3 jobs are re-fetched; the 4th is deferred untouched', async () => {
    const names = ['a', 'b', 'c', 'd'];
    const ids = await Promise.all(names.map((n) => jobIdOf(n)));
    const lists = Object.fromEntries(names.map((n) => [n, [page(OLD), page(FRESH)]]));
    const entries = Object.fromEntries(ids.map((id, i) => [id, entryFor(i, {}, names[i])]));
    const w = world({ wf: names, lists, entries });
    const jobs = await discover(w);
    const states = ids.map((id) => jobs.find((j) => j.id === id)?.lastRun?.freshness?.state);
    expect(states.filter((s) => s === 'recovered')).toHaveLength(3);
    expect(states.filter((s) => s === 'deferred')).toHaveLength(1);
    const deferred = ids.find((id) => jobs.find((j) => j.id === id)?.lastRun?.freshness?.state === 'deferred')!;
    expect(w.proposals.get(deferred)).toMatchObject({ op: 'inc', touched: false });
  });

  it('the budget bounds the whole second stage, waits and calls included', async () => {
    const names = ['a', 'b', 'c'];
    const ids = await Promise.all(names.map((n) => jobIdOf(n)));
    const lists = Object.fromEntries(names.map((n) => [n, [page(OLD)]]));
    const entries = Object.fromEntries(ids.map((id, i) => [id, entryFor(i, {}, names[i])]));
    // Every call takes 9s. Stage 2 for `a`: wait 1 -> R1 (10s) -> wait 3 -> R2 (22s)
    // -> 8s left >= 2s, so the GET starts with an 8s timeout. The fake does not
    // honour the timeout (the real fetch aborts at it), so it reports 31s here.
    const w = world({ wf: names, lists, probes: { 100: [probe()] }, entries, latencyMs: 9_000 });
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const jobs = await discover(w);
    // Stage 1 (workflows + 3 listings) at 10s, then R1, R2 at 10s, the GET clipped to what is left.
    expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 8_000]);
    timeouts.mockRestore();
    const st = (id: string) => jobs.find((j) => j.id === id)?.lastRun?.freshness;
    expect(st(ids[0])).toMatchObject({ state: 'behind', retries: 2, probe: 'ok' });
    // Nothing is left for b and c: deferred, untouched, never re-fetched.
    for (const id of ids.slice(1)) {
      expect(st(id)).toMatchObject({ state: 'deferred', retries: 0 });
      expect(w.proposals.get(id)).toMatchObject({ op: 'inc', touched: false });
    }
    expect(w.calls.filter((c) => c === 'list:b' || c === 'list:c')).toHaveLength(2);   // first listings only
  });

  it('#17 recovered, but no budget for the attempt-1 lookup: freshness resolved, verdict deferred with a fixed reason', async () => {
    const id = await jobIdOf();
    const rerun = run(101, '2026-10-03T08:06:11Z', 'success', { run_attempt: 2 });
    // 1s wait + R1 at 27.5s leaves 1.5s: below the 2s minimum for the attempt-1 call.
    const w = world({ lists: { daily: [page(OLD), page(rerun)] }, entries: { [id]: entryFor(0) }, latencyMs: 100 });
    let n = 0;
    const base = w.ctx.fetch;
    w.ctx.fetch = (async (u: string, i: any) => { n++; if (n === 3) w.t.now += 27_400; return (base as any)(u, i); }) as any;
    const [j] = await discover(w);
    expect(j.lastRun).toMatchObject({
      status: 'unknown',
      undeterminedReason: 'run freshness: listing is fresh again; first attempt not fetched in this check',
      freshness: { state: 'recovered' },
    });
    expect(w.calls).not.toContain('attempt1');
    expect(w.proposals.get(id)).toMatchObject({ op: 'reset', outcome: 'recovered', baseline: { runId: 101, judgedStatus: 'unknown' } });
  });
});

describe('run freshness: fairness of the re-fetch order (bundle 3)', () => {
  it('a job that spent budget moves behind the untouched ones; nobody waits forever', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const ids = await Promise.all(names.map((n) => jobIdOf(n)));
    let entries: Record<string, FreshEntry> = Object.fromEntries(ids.map((id, i) => [id, entryFor(i, {}, names[i])]));
    const touchedPerCheck: string[][] = [];
    // Every job stays behind and every call is slow, so one check can only
    // start a little more than one job (the first one runs out half-way).
    for (let check = 0; check < 5; check++) {
      const lists = Object.fromEntries(names.map((n) => [n, [page(OLD)]]));
      const w = world({ wf: names, lists, probes: { 100: [probe()] }, entries, latencyMs: 9_000 });
      const at = new Date(Date.parse('2026-10-03T08:00:00Z') + check * 3600_000).toISOString();
      await discover(w);
      const touched = [...w.proposals].filter(([, p]) => p.touched).map(([id]) => id);
      touchedPerCheck.push(touched);
      entries = Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, touched.includes(id) ? { ...e, lastRecheckAt: at } : e]));
    }
    // Each check touches someone new until all five have had a turn.
    const everTouched = new Set(touchedPerCheck.flat());
    expect(everTouched.size).toBe(5);
    // No job is touched twice before every job was touched once.
    const firstFive = touchedPerCheck.flat().slice(0, 5);
    expect(new Set(firstFive).size).toBe(5);
  });
});

describe('run freshness: a job deferred half-way does not keep the front (bundle 3)', () => {
  it('spent budget -> touched -> behind the untouched job next time', async () => {
    const { applyProposals } = await import('../store/gha-freshness.js');
    const names = ['a', 'b'];
    const ids = await Promise.all(names.map((n) => jobIdOf(n)));
    let state = { schemaVersion: 1 as const, entries: Object.fromEntries(ids.map((id, i) => [id, entryFor(i, {}, names[i])])) };
    const lists = Object.fromEntries(names.map((n) => [n, [page(OLD)]]));
    // 14s per call: a gets wait 1 -> R1 -> wait 3 -> R2, then no room for the GET.
    const w1 = world({ wf: names, lists, probes: { 100: [probe()] }, entries: state.entries, latencyMs: 14_000 });
    const j1 = await discover(w1);
    const first = ids[0] < ids[1] ? ids[0] : ids[1];
    const second = first === ids[0] ? ids[1] : ids[0];
    expect(j1.find((j) => j.id === first)?.lastRun?.freshness).toMatchObject({ state: 'deferred', retries: 2 });
    expect(w1.proposals.get(first)).toMatchObject({ outcome: 'deferred', touched: true });
    expect(w1.proposals.get(second)).toMatchObject({ outcome: 'deferred', touched: false });
    state = applyProposals(state, w1.proposals, new Set(ids), '2026-10-03T08:17:05.000Z');
    // Next check: the untouched job goes first.
    const w2 = world({ wf: names, lists, probes: { 100: [probe()] }, entries: state.entries, latencyMs: 14_000 });
    await discover(w2);
    expect(w2.proposals.get(second)).toMatchObject({ touched: true });
    expect(w2.proposals.get(first)).toMatchObject({ touched: false });
  });
});

describe('run freshness: a reader (scan / serve)', () => {
  it('#40 compares only: unknown with the reader reason, no re-fetch, no attempt lookup', async () => {
    const id = await jobIdOf();
    const w = world({ mode: 'reader', lists: { daily: [page(OLD), page(FRESH)] }, entries: { [id]: entryFor(0) } });
    const [j] = await discover(w);
    expect(j.lastRun).toMatchObject({
      status: 'unknown',
      undeterminedReason: 'run freshness: listing is older than the last check record (not rechecked here)',
      freshness: { state: 'unrechecked', retries: 0 },
      lastObserved: { runId: 100 },
    });
    expect(w.calls).toEqual(['workflows', 'list:daily']);
  });

  it('#41 a newer listing is shown as is (the reader does not save anything anyway)', async () => {
    const id = await jobIdOf();
    const w = world({ mode: 'reader', lists: { daily: [page(FRESH)] }, entries: { [id]: entryFor(0) } });
    expect((await discover(w))[0].lastRun?.status).toBe('success');
  });

  it('#38 without a baseline the reader judges as before', async () => {
    const w = world({ mode: 'reader', lists: { daily: [page(OLD)] } });
    expect((await discover(w))[0].lastRun?.status).toBe('failure');
  });
});
