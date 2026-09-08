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
