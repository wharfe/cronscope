import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, resolveToken, resolveRepoRef } from './github-api.js';
import type { Ctx } from '../types.js';

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    now: () => new Date('2026-09-08T12:00:00Z'),
    run: async () => ({ stdout: '', stderr: '', code: 1 }),
    readFile: async () => '', glob: async () => [],
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: ['/home/u/dev'],
    ...over,
  };
}

describe('parseRemoteUrl', () => {
  it('parses the forms git itself writes', () => {
    expect(parseRemoteUrl('https://github.com/wharfe/lex-diff.git')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
    expect(parseRemoteUrl('https://github.com/wharfe/lex-diff')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
    expect(parseRemoteUrl('git@github.com:wharfe/lex-diff.git')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
    expect(parseRemoteUrl('ssh://git@github.com/wharfe/lex-diff.git')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
  });

  it('parses forms that only appear in the wild', () => {
    // credentials embedded by CI / gh
    expect(parseRemoteUrl('https://x-access-token:tok@github.com/wharfe/lex-diff.git')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
    // ssh config host alias
    expect(parseRemoteUrl('git@github.com-work:wharfe/lex-diff.git')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
    // trailing slash must not become part of the repo name
    expect(parseRemoteUrl('https://github.com/wharfe/lex-diff/')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseRemoteUrl('https://gitlab.com/w/x.git')).toBeNull();
    expect(parseRemoteUrl('https://github.com.attacker.net/w/x.git')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
  });
});

describe('resolveToken', () => {
  it('prefers CRONSCOPE_GH_TOKEN over GITHUB_TOKEN', async () => {
    expect(await resolveToken(ctx({ env: { CRONSCOPE_GH_TOKEN: 'a', GITHUB_TOKEN: 'b' } }))).toBe('a');
  });

  it('falls back to gh auth token', async () => {
    const c = ctx({ run: async (cmd) => cmd.join(' ') === 'gh auth token'
      ? { stdout: 'ghp_from_cli\n', stderr: '', code: 0 }
      : { stdout: '', stderr: '', code: 1 } });
    expect(await resolveToken(c)).toBe('ghp_from_cli');
  });

  it('spawns gh only once per ctx', async () => {
    let spawns = 0;
    const c = ctx({ run: async () => { spawns++; return { stdout: 'tok\n', stderr: '', code: 0 }; } });
    await resolveToken(c); await resolveToken(c); await resolveToken(c);
    expect(spawns).toBe(1);
  });

  it('returns null when gh is absent, unauthenticated, or silent', async () => {
    expect(await resolveToken(ctx())).toBeNull();
    expect(await resolveToken(ctx({ run: async () => ({ stdout: '  \n', stderr: '', code: 0 }) }))).toBeNull();
  });
});

describe('resolveRepoRef', () => {
  it('reads origin from the repo directory', async () => {
    const c = ctx({ run: async (cmd) => {
      expect(cmd).toEqual(['git', '-C', '/home/u/dev/lex-diff', 'remote', 'get-url', 'origin']);
      return { stdout: 'https://github.com/wharfe/lex-diff.git\n', stderr: '', code: 0 };
    } });
    expect(await resolveRepoRef(c, '/home/u/dev/lex-diff')).toEqual({ owner: 'wharfe', repo: 'lex-diff' });
  });

  it('returns null when the checkout has no origin', async () => {
    expect(await resolveRepoRef(ctx(), '/home/u/dev/x')).toBeNull();
  });
});

import { fetchWorkflows, fetchScheduledRuns } from './github-api.js';

function fetchStub(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const r = routes[key];
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body };
  }) as unknown as typeof fetch;
}

const REF = { owner: 'wharfe', repo: 'lex-diff' };
const TOKEN = 'ghp_dummy_token_0123456789';

describe('fetchWorkflows', () => {
  it('maps workflow path to id and state', async () => {
    const c = ctx({ fetch: fetchStub({ '/actions/workflows': { body: { workflows: [
      { id: 247794285, path: '.github/workflows/ci.yml', state: 'active' },
      { id: 247794286, path: '.github/workflows/uptime.yml', state: 'disabled_inactivity' },
    ] } } }) });
    const got = await fetchWorkflows(c, REF, TOKEN);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.get('.github/workflows/uptime.yml')).toEqual({ id: 247794286, state: 'disabled_inactivity' });
  });

  it('reports a non-2xx response as not-ok instead of an empty map', async () => {
    const c = ctx({ fetch: fetchStub({ '/actions/workflows': { status: 401, body: {} } }) });
    const got = await fetchWorkflows(c, REF, TOKEN);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toContain('401');
  });

  it('reports a thrown network error as not-ok', async () => {
    const c = ctx({ fetch: (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch });
    expect((await fetchWorkflows(c, REF, TOKEN)).ok).toBe(false);
  });

  it('survives a non-Error throw without losing the reason', async () => {
    const c = ctx({ fetch: (async () => { throw 'plain string'; }) as unknown as typeof fetch });
    // A realistic token length: an unconditional split on a 1-char token would
    // shred the message itself.
    const got = await fetchWorkflows(c, REF, TOKEN);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).toContain('plain string');
  });

  it('never puts the token in the failure reason', async () => {
    const c = ctx({ fetch: (async () => { throw new Error(`bad creds ${TOKEN}`); }) as unknown as typeof fetch });
    const got = await fetchWorkflows(c, REF, TOKEN);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.reason).not.toContain(TOKEN);
  });
});

describe('fetchScheduledRuns', () => {
  it('asks only for completed schedule runs and returns the newest plus gap stats', async () => {
    let seen = '';
    const c = ctx({ fetch: (async (url: string) => {
      seen = String(url);
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [
        { conclusion: 'failure', created_at: '2026-09-08T00:00:00Z' },
        { conclusion: 'success', created_at: '2026-09-07T00:00:00Z' },
        { conclusion: 'success', created_at: '2026-09-05T00:00:00Z' },
      ] }) };
    }) as unknown as typeof fetch });
    const got = await fetchScheduledRuns(c, REF, 42, TOKEN);
    expect(seen).toContain('event=schedule');
    expect(seen).toContain('status=completed');
    expect(seen).toContain('per_page=10');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.newest).toEqual({ conclusion: 'failure', createdAt: '2026-09-08T00:00:00Z' });
    expect(got.value.samples).toBe(3);
    expect(got.value.maxGapHours).toBe(48);
    expect(got.value.medianGapHours).toBe(36); // gaps 24h and 48h -> median 36
  });

  it('picks the newest by created_at even when the page is out of order', async () => {
    const c = ctx({ fetch: fetchStub({ '/runs': { body: { workflow_runs: [
      { conclusion: 'success', created_at: '2026-09-05T00:00:00Z' },
      { conclusion: 'failure', created_at: '2026-09-08T00:00:00Z' },
    ] } } }) });
    const got = await fetchScheduledRuns(c, REF, 42, TOKEN);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.newest?.createdAt).toBe('2026-09-08T00:00:00Z');
    expect(got.value.maxGapHours).toBe(72);
  });

  it('returns ok with a null newest when the workflow never ran on schedule', async () => {
    const c = ctx({ fetch: fetchStub({ '/runs': { body: { workflow_runs: [] } } }) });
    expect(await fetchScheduledRuns(c, REF, 42, TOKEN)).toEqual({ ok: true, value: { newest: null, samples: 0 } });
  });
});
