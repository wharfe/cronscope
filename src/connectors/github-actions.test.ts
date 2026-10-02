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
    run: async (cmd) => {
      if (cmd[0] !== 'git') return { stdout: '', stderr: '', code: 1 };
      // The workflow file must sit at the repo root; rev-parse is what proves it.
      if (cmd.includes('rev-parse')) return { stdout: '/home/u/dev/proj\n', stderr: '', code: 0 };
      return { stdout: 'https://github.com/wharfe/proj.git\n', stderr: '', code: 0 };
    },
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
      fetch: ghFetch(ACTIVE, [{ id: 1, run_attempt: 1, conclusion: 'failure', created_at: '2026-06-11T21:00:00Z' }]) });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs[0].lastRun?.status).toBe('failure');
    expect(jobs[0].lastRun?.at).toBe('2026-06-11T21:00:00.000Z');
    expect(jobs[0].state).toBe('active');
  });

  it('treats cancelled as a failure', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch(ACTIVE, [{ id: 1, run_attempt: 1, conclusion: 'cancelled', created_at: '2026-06-11T21:00:00Z' }]) });
    expect((await githubActionsConnector.discover(c))[0].lastRun?.status).toBe('failure');
  });

  it('treats skipped as undetermined, with a reason', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch(ACTIVE, [{ id: 1, run_attempt: 1, conclusion: 'skipped', created_at: '2026-06-11T21:00:00Z' }]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.undeterminedReason).toContain('skipped');
  });

  it('marks a disabled workflow and suppresses its future nextRun', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch([{ id: 7, path: '.github/workflows/daily.yml', state: 'disabled_inactivity' }],
        [{ id: 1, run_attempt: 1, conclusion: 'success', created_at: '2026-06-01T21:00:00Z' }]) });
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
      { id: 1, run_attempt: 1, conclusion: 'success', created_at: '2026-06-12T00:00:00Z' },
      { id: 1, run_attempt: 1, conclusion: 'success', created_at: '2026-06-11T00:00:00Z' },
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

describe('github-actions connector: states GitHub can report', () => {
  it('does not alarm on a neutral conclusion, but does not call it success either', async () => {
    // GitHub treats neutral as non-failing; branch protection passes on it.
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch(ACTIVE, [{ id: 1, run_attempt: 1, conclusion: 'neutral', created_at: '2026-06-11T21:00:00Z' }]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.undeterminedReason).toContain('neutral');
  });

  it('reports an unrecognised workflow state instead of treating it as active', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: ghFetch([{ id: 7, path: '.github/workflows/daily.yml', state: 'disabled_fork' }], []) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.state).toBeUndefined();
    expect(j.lastRun?.undeterminedReason).toContain('disabled_fork');
    // GitHub has stopped it, so promising a next run would be a lie.
    expect(j.schedule.nextRun).toBeUndefined();
  });

  it('emits no job for a workflow file that is not at the repository root', async () => {
    // GitHub only runs .github/workflows at the repo root, but `git -C` walks
    // up -- so this file would otherwise borrow the parent repo's run history.
    const nested = '/home/u/dev/proj/examples/.github/workflows/daily.yml';
    const c = apiCtx({ [nested]: WORKFLOW }, {
      run: async (cmd) => {
        if (cmd[0] !== 'git') return { stdout: '', stderr: '', code: 1 };
        if (cmd.includes('rev-parse')) return { stdout: '/home/u/dev/proj\n', stderr: '', code: 0 };
        return { stdout: 'https://github.com/wharfe/proj.git\n', stderr: '', code: 0 };
      },
      fetch: ghFetch(ACTIVE, [{ id: 1, run_attempt: 1, conclusion: 'failure', created_at: '2026-06-11T21:00:00Z' }]),
    });
    expect(await githubActionsConnector.discover(c)).toEqual([]);
  });
});

describe('a workflow file we cannot read', () => {
  const BROKEN = 'name: x\non:\n  schedule:\n    - cron: "0 0 * * *"\n  bad: [unclosed\n';

  it('still emits a job, with the reason, instead of dropping it from the snapshot', async () => {
    // Dropping it reads as "recovered" to the notify state, so a workflow whose
    // file broke would take its standing alarm with it -- and a broken workflow
    // is exactly the one worth watching.
    const c = apiCtx({ [WF_PATH]: BROKEN }, { fetch: ghFetch(ACTIVE, []) });
    const jobs = await githubActionsConnector.discover(c);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastRun?.status).toBe('unknown');
    expect(jobs[0].lastRun?.undeterminedReason).toContain('could not be read or parsed');
    expect(jobs[0].schedule.nextRun).toBeUndefined();
  });

  it('keeps the same job id as when the file parsed, so the alarm survives', async () => {
    const good = await githubActionsConnector.discover(
      apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, []) }));
    const broken = await githubActionsConnector.discover(
      apiCtx({ [WF_PATH]: BROKEN }, { fetch: ghFetch(ACTIVE, []) }));
    expect(broken[0].id).toBe(good[0].id);
  });
});

it('never puts the parser diagnostic into the reason that gets persisted and posted', async () => {
  // A YAML parse error quotes the offending source line. That string reaches
  // the snapshot and Slack, so a token written into a broken workflow file
  // would ride along with it.
  const withSecret = 'on:\n  schedule:\n    - cron: "0 0 * * *"\n  token: ghp_MUSTNOTLEAK_0123456789\n  bad: [unclosed\n';
  const c = apiCtx({ [WF_PATH]: withSecret }, { fetch: ghFetch(ACTIVE, []) });
  const j = (await githubActionsConnector.discover(c))[0];
  expect(j.lastRun?.undeterminedReason).toBe('workflow file could not be read or parsed');
  expect(JSON.stringify(j)).not.toContain('ghp_MUSTNOTLEAK');
});

describe('run identity on the job (wharfe/cronscope#4)', () => {
  const JUNK = { html_url: 'https://github.com/x', head_commit: { message: 'ghp_MUSTNOTLEAK_0123456789' } };
  const RUN = { id: 1, run_attempt: 1, conclusion: 'failure', created_at: '2026-06-11T21:00:00Z', ...JUNK };

  it('records which run and attempt the verdict came from, and only that', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, [RUN]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('failure');
    expect(j.lastRun?.run).toStrictEqual(
      { id: 1, judgedAttempt: 1, latestAttempt: 1, conclusion: 'failure', latestConclusion: 'failure' });
    expect(JSON.stringify(j)).not.toContain('MUSTNOTLEAK');
    // The identity must not have leaked into the gap statistics either.
    expect(j.observed).toEqual({ samples: 1 });
  });

  it('on a re-run, judges attempt 1 and records the listing attempt and both conclusions', async () => {
    // ghFetch answers every URL containing `/runs` with the listing, which would
    // also swallow `/actions/runs/9/attempts/1`; route the attempt explicitly.
    const routed = (async (url: string) => ({
      ok: true, status: 200,
      json: async () => String(url).includes('/attempts/1')
        ? { conclusion: 'failure', ...JUNK }
        : String(url).includes('/runs')
          ? { workflow_runs: [{ id: 9, run_attempt: 2, conclusion: 'success', created_at: '2026-06-11T21:00:00Z', ...JUNK }] }
          : { workflows: ACTIVE },
    })) as unknown as typeof fetch;
    const j = (await githubActionsConnector.discover(apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: routed })))[0];
    expect(j.lastRun?.status).toBe('failure');
    expect(j.lastRun?.run).toStrictEqual(
      { id: 9, judgedAttempt: 1, latestAttempt: 2, conclusion: 'failure', latestConclusion: 'success' });
    expect(JSON.stringify(j)).not.toContain('MUSTNOTLEAK');
  });

  it('keeps the identity on a skipped run (status unknown, but there IS a run to trace)', async () => {
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, [{ ...RUN, conclusion: 'skipped' }]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('unknown');
    expect(j.lastRun?.run?.conclusion).toBe('skipped');
  });

  it('records no identity when there is no run to point at', async () => {
    const never = (await githubActionsConnector.discover(apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, []) })))[0];
    expect(never.lastRun?.status).toBe('never');
    expect('run' in (never.lastRun ?? {})).toBe(false);
    const failed = (await githubActionsConnector.discover(apiCtx({ [WF_PATH]: WORKFLOW }, {
      fetch: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch })))[0];
    expect('run' in (failed.lastRun ?? {})).toBe(false);
    const noToken = (await githubActionsConnector.discover(ctx({ [WF_PATH]: WORKFLOW })))[0];
    expect('run' in (noToken.lastRun ?? {})).toBe(false);
  });

  it('guards the persisted conclusion, not the verdict', async () => {
    // The charset guard sits on the persistence path only: an unknown
    // conclusion is still a failure, and the raw string stays out of the Job.
    const c = apiCtx({ [WF_PATH]: WORKFLOW }, { fetch: ghFetch(ACTIVE, [{ ...RUN, conclusion: 'Weird Value!' }]) });
    const j = (await githubActionsConnector.discover(c))[0];
    expect(j.lastRun?.status).toBe('failure');
    expect(j.lastRun?.run?.conclusion).toBe('unrecognized');
    expect(JSON.stringify(j)).not.toContain('Weird');
  });
});
