import { describe, it, expect } from 'vitest';
import { githubActionsConnector } from './github-actions.js';
import type { Ctx } from '../types.js';

const WORKFLOW = `name: daily
on:
  schedule:
    - cron: "0 21 * * *"
jobs:
  build: { runs-on: ubuntu-latest, steps: [] }
`;

function ctx(files: Record<string, string>): Ctx {
  return {
    now: () => new Date('2026-06-12T10:05:00Z'),
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    readFile: async (p) => files[p] ?? '',
    glob: async () => Object.keys(files),
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: ['/home/u/dev'],
  };
}

describe('github-actions connector', () => {
  it('does NOT mis-parse the on: key as boolean true (YAML 1.2)', async () => {
    const c = ctx({ '/home/u/dev/proj/.github/workflows/daily.yml': WORKFLOW });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule.raw).toBe('0 21 * * *');
    expect(jobs[0].source).toBe('github-actions');
    expect(jobs[0].lastRun?.status).toBe('unknown');
    expect(jobs[0].schedule.nextRun).toBe('2026-06-12T21:00:00.000Z');
  });

  it('returns no jobs when a workflow has no schedule', async () => {
    const c = ctx({ '/home/u/dev/proj/.github/workflows/ci.yml': 'name: ci\non: [push]\njobs: {}\n' });
    expect(await githubActionsConnector.discover(c)).toHaveLength(0);
  });

  it('excludes workflows under vendored dependency directories', async () => {
    const c = ctx({
      '/home/u/dev/proj/_deps/json-src/.github/workflows/x.yml': WORKFLOW,
      '/home/u/dev/proj/.github/workflows/ci.yml': WORKFLOW,
    });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toBe('proj/.github/workflows/ci.yml');
  });

  it('excludes deeply-nested submodule workflows but keeps org/repo depth', async () => {
    const c = ctx({
      '/home/u/dev/kiku/native/deepfilter-src/.github/workflows/x.yml': WORKFLOW, // depth 3 -> excluded
      '/home/u/dev/org/repo/.github/workflows/ci.yml': WORKFLOW,                  // depth 2 -> kept
    });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs.map((j) => j.location)).toEqual(['org/repo/.github/workflows/ci.yml']);
  });
});

function apiCtx(files: Record<string, string>, over: Partial<Ctx> = {}): Ctx {
  return {
    ...ctx(files),
    env: { CRONSCOPE_GH_TOKEN: 'ghp_dummy_token_0123456789' },
    run: async (cmd) => cmd[0] === 'git'
      ? { stdout: 'https://github.com/wharfe/proj.git\n', stderr: '', code: 0 }
      : { stdout: '', stderr: '', code: 1 },
    ...over,
  };
}

function ghFetch(workflows: any[], runs: any[]): typeof fetch {
  return (async (url: string) => ({
    ok: true, status: 200,
    json: async () => String(url).includes('/runs') ? { workflow_runs: runs } : { workflows },
  })) as unknown as typeof fetch;
}

const WF_PATH = '/home/u/dev/proj/.github/workflows/daily.yml';
const ACTIVE = [{ id: 7, path: '.github/workflows/daily.yml', state: 'active' }];

describe('github-actions connector (API-backed)', () => {
  it('is degraded, not unavailable, when no token can be resolved', async () => {
    expect((await githubActionsConnector.availability(ctx({}))).state).toBe('degraded');
  });

  it('keeps discovering every workflow when degraded, with a reason', async () => {
    const jobs = await githubActionsConnector.discover(ctx({ [WF_PATH]: WORKFLOW }));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastRun?.status).toBe('unknown');
    expect(jobs[0].lastRun?.undeterminedReason).toBeTruthy();
  });

  it('fills lastRun from the newest completed scheduled run', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch(ACTIVE, [{ conclusion: 'failure', created_at: '2026-06-11T21:00:00Z' }]) });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs[0].lastRun?.status).toBe('failure');
    expect(jobs[0].lastRun?.at).toBe('2026-06-11T21:00:00.000Z');
    expect(jobs[0].state).toBe('active');
  });

  it('treats cancelled as a failure', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch(ACTIVE, [{ conclusion: 'cancelled', created_at: '2026-06-11T21:00:00Z' }]) });
    expect((await githubActionsConnector.discover(c))[0].lastRun?.status).toBe('failure');
  });

  it('treats skipped as undetermined, with a reason', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch(ACTIVE, [{ conclusion: 'skipped', created_at: '2026-06-11T21:00:00Z' }]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.undeterminedReason).toContain('skipped');
  });

  it('marks a disabled workflow and suppresses its future nextRun', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch([{ id: 7, path: '.github/workflows/daily.yml', state: 'disabled_inactivity' }],
        [{ conclusion: 'success', created_at: '2026-06-01T21:00:00Z' }]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.state).toBe('disabled_inactivity');
    expect(j.schedule.nextRun).toBeUndefined();
    expect(j.schedule.nextRunSource).toBe('unknown');
  });

  it('reports never when the workflow has no scheduled run yet', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, []) });
    expect((await githubActionsConnector.discover(c))[0].lastRun?.status).toBe('never');
  });

  it('leaves status unknown with a reason when the API fails, never success', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.undeterminedReason).toContain('401');
  });

  it('leaves status unknown with a reason when the checkout has no GitHub origin', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, { run: async () => ({ stdout: '', stderr: '', code: 1 }) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.undeterminedReason).toContain('origin');
  });

  it('records observed gap statistics without judging on them', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, [
      { conclusion: 'success', created_at: '2026-06-12T00:00:00Z' },
      { conclusion: 'success', created_at: '2026-06-11T00:00:00Z' },
    ]) });
    expect((await githubActionsConnector.discover(c))[0].observed).toEqual(
      { samples: 2, medianGapHours: 24, maxGapHours: 24 });
  });

  it('emits one job for a workflow with several cron entries', async () => {
    const two = `name: two\non:\n  schedule:\n    - cron: "0 0 * * *"\n    - cron: "0 12 * * *"\njobs: {}\n`;
    const c = apiCtx({ [WF_PATH]: two }, { fetch: ghFetch(ACTIVE, []) });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule.raw).toBe('0 0 * * *, 0 12 * * *');
  });

  it('queries each repo once even with several workflows', async () => {
    let listCalls = 0;
    const c = apiCtx({
      '/home/u/dev/proj/.github/workflows/a.yml': WORKFLOW,
      '/home/u/dev/proj/.github/workflows/b.yml': WORKFLOW,
    }, {
      fetch: (async (url: string) => {
        if (!String(url).includes('/runs')) listCalls++;
        return { ok: true, status: 200, json: async () => String(url).includes('/runs')
          ? { workflow_runs: [] }
          : { workflows: [
              { id: 1, path: '.github/workflows/a.yml', state: 'active' },
              { id: 2, path: '.github/workflows/b.yml', state: 'active' }] } };
      }) as unknown as typeof fetch,
    });
    await githubActionsConnector.discover(c);
    expect(listCalls).toBe(1);
  });
});
