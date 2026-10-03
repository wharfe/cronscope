import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { Job } from './types.js';

// Wiring test for `cronscope check` (wharfe/cronscope#5). The notice functions
// are each unit-tested; what broke in #5 was the wiring between them, and the
// only copy of that wiring is cli.ts's main(). So this imports the real cli.ts
// and replaces only its I/O: the home directory, the ctx (clock, fetch), the
// boot time and the six connectors. Everything between the scan and the saved
// notify-state -- evaluate, key selection, digest assembly, state update -- is
// the shipped code.

const h = vi.hoisted(() => {
  type Behaviour = { availability?: () => Promise<unknown>; discover?: () => Promise<unknown[]> };
  const s = {
    home: '',
    now: new Date(0),
    behave: {} as Record<string, Behaviour>,
    fetch: (async () => ({ ok: true, status: 200 })) as (url: string, init: any) => Promise<any>,
    fetchCalls: [] as { url: string; body: string }[],
    makeCtxCalls: 0,
    snapshotSaves: [] as string[],
    notifySaves: [] as string[],
    guardViolations: [] as string[],
    exitCodes: [] as unknown[],
    // One pending run at a time; it settles when main() saved notify-state or exited.
    done: null as null | (() => void),
    fake(id: string) {
      return {
        id, tier: 0,
        availability: () => (s.behave[id]?.availability ?? (async () => ({ state: 'available' })))(),
        discover: () => (s.behave[id]?.discover ?? (async () => []))(),
      };
    },
  };
  return s;
});

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  const homedir = () => h.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('./runtime.js', () => ({
  makeCtx: (scanRoots: string[]) => {
    h.makeCtxCalls++;
    return {
      now: () => h.now,
      run: async () => { throw new Error('ctx.run reached in the wiring test'); },
      readFile: async () => { throw new Error('ctx.readFile reached in the wiring test'); },
      glob: async () => [],
      fetch: async (url: string, init: any) => {
        h.fetchCalls.push({ url, body: String(init?.body) });
        return h.fetch(url, init);
      },
      env: {}, homeDir: h.home, scanRoots,
    };
  },
}));
vi.mock('./core/host.js', () => ({ bootAt: async () => undefined }));
vi.mock('./connectors/crontab.js', () => ({ crontabConnector: h.fake('crontab') }));
vi.mock('./connectors/systemd.js', () => ({ systemdConnector: h.fake('systemd') }));
vi.mock('./connectors/github-actions.js', () => ({ githubActionsConnector: h.fake('github-actions') }));
vi.mock('./connectors/cloudflare.js', () => ({ cloudflareConnector: h.fake('cloudflare') }));
vi.mock('./connectors/hermes.js', () => ({ hermesConnector: h.fake('hermes') }));
vi.mock('./connectors/launchd.js', () => ({ launchdConnector: h.fake('launchd') }));

// The two writers are wrapped, not replaced: each refuses a path outside the
// test home BEFORE writing, so a broken homedir mock fails loudly instead of
// overwriting the live ~/.config/cronscope.
async function guard(p: string) {
  const { relative, isAbsolute } = await import('node:path');
  const rel = relative(h.home, p);
  if (!h.home || !rel || rel.startsWith('..') || isAbsolute(rel)) {
    h.guardViolations.push(p);
    throw new Error(`write outside the test home: ${p}`);
  }
}
vi.mock('./store/snapshot.js', async (orig) => {
  const actual = await orig<typeof import('./store/snapshot.js')>();
  return {
    ...actual,
    saveSnapshot: async (p: string, snap: any) => {
      await guard(p);
      h.snapshotSaves.push(p);
      return actual.saveSnapshot(p, snap);
    },
  };
});
vi.mock('./store/notify-state.js', async (orig) => {
  const actual = await orig<typeof import('./store/notify-state.js')>();
  return {
    ...actual,
    saveNotifyState: async (p: string, st: any) => {
      await guard(p);
      await actual.saveNotifyState(p, st);
      h.notifySaves.push(p);
      // Only the notify-state write -- the last step of check -- ends a run.
      const { join } = await import('node:path');
      if (p === join(h.home, '.config', 'cronscope', 'notify-state.json')) h.done?.();
    },
  };
});

const WEBHOOK = 'https://hooks.invalid/cronscope-test';
const SENTINEL = 'SENTINEL-7f3a /Users/someone/private token=abc123';
const K = (id: string) => `connector/${id}/unavailable`;
const T = (iso: string) => new Date(iso);
const NOW = '2026-10-03T06:00:00.000Z';

let logs: string[];
let errors: unknown[];
const notifyPath = () => join(h.home, '.config', 'cronscope', 'notify-state.json');
const readState = () => JSON.parse(readFileSync(notifyPath(), 'utf8'));
function seedState(state: object) {
  mkdirSync(join(h.home, '.config', 'cronscope'), { recursive: true });
  writeFileSync(notifyPath(), JSON.stringify(state), 'utf8');
}

async function runCheck(at = NOW) {
  h.now = T(at);
  h.fetchCalls = []; h.makeCtxCalls = 0; h.snapshotSaves = []; h.notifySaves = []; h.exitCodes = [];
  logs = []; errors = [];
  const finished = new Promise<void>((resolve) => { h.done = resolve; });
  vi.resetModules();
  process.argv = ['node', 'cli.js', 'check'];
  await import('./cli.js');
  await finished;
  h.done = null;
}

// A successful run: main() reached the notify-state save and never exited.
function expectCompleted() {
  expect(h.exitCodes).toEqual([]);
  expect(errors).toEqual([]);
  expect(h.guardViolations).toEqual([]);
  expect(h.makeCtxCalls).toBe(1);
  expect(h.notifySaves).toEqual([notifyPath()]);
}

const throwing = (where: 'availability' | 'discover') => where === 'availability'
  ? { availability: async () => { throw new Error(SENTINEL); } }
  : { discover: async () => { throw new Error(SENTINEL); } };

const ghaUndetermined: Job = {
  id: 'gha|repo/.github/workflows/w.yml', source: 'github-actions', name: 'w', target: 't', location: 'l',
  schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' },
  lastRun: { status: 'unknown', fetchedAt: NOW, undeterminedReason: 'workflow list unavailable: HTTP 401' },
};
const systemdFailing: Job = {
  id: 'systemd|backup.timer', source: 'systemd', name: 'backup.timer', target: 't', location: 'backup.service',
  schedule: { raw: 'daily', kind: 'systemd-oncalendar', nextRunSource: 'source-authoritative' },
  lastRun: { status: 'failure', at: '2026-10-03T05:00:00.000Z', fetchedAt: NOW },
};

const argv = process.argv;
beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'cronscope-cli-'));
  h.behave = {};
  h.fetch = async () => ({ ok: true, status: 200 });
  h.guardViolations = [];
  vi.stubEnv('CRONSCOPE_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a[0]); });
  // A no-op: throwing from inside main().catch would be an unhandled rejection.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { h.exitCodes.push(code); h.done?.(); }) as never);
  // The fake ctx fetch is the only network the CLI may use.
  vi.stubGlobal('fetch', async () => { throw new Error('global fetch reached in the wiring test'); });
  // The mock must be in effect before cli.ts computes its paths at import time.
  expect(homedir()).toBe(h.home);
});
afterEach(() => {
  rmSync(h.home, { recursive: true, force: true });
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cronscope check: a connector that fell over (wharfe/cronscope#5)', () => {
  it.each(['availability', 'discover'] as const)('sends one fixed line when %s throws and no job is left', async (where) => {
    h.behave.cloudflare = throwing(where);
    await runCheck();
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe(WEBHOOK);
    const text = JSON.parse(h.fetchCalls[0].body).text as string;
    expect(text).not.toBe('cronscope: all clear');
    expect(text).toContain(':grey_question: cloudflare:');
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('abc123');
    const saved = readState();
    expect(saved.notices).toEqual({ [K('cloudflare')]: NOW });
    expect(JSON.stringify(saved)).not.toContain('SENTINEL');
  });

  it('keeps the key stable when the exception text changes', async () => {
    h.behave.cloudflare = { discover: async () => { throw new Error('HTTP 502 one hour'); } };
    await runCheck();
    h.behave.cloudflare = { discover: async () => { throw new Error('fetch failed the next'); } };
    await runCheck('2026-10-03T07:00:00.000Z');
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(0);
    expect(readState().notices).toEqual({ [K('cloudflare')]: NOW });
  });

  it('sends both connectors in one message, in a fixed order', async () => {
    h.behave.systemd = throwing('discover');
    h.behave.cloudflare = throwing('availability');
    await runCheck();
    expectCompleted();
    const text = JSON.parse(h.fetchCalls[0].body).text as string;
    expect(text.split('\n').map((l) => l.split(':')[2]?.trim())).toEqual(['cloudflare', 'systemd']);
    expect(Object.keys(readState().notices)).toEqual([K('cloudflare'), K('systemd')]);
  });

  it('keeps a standing job key and its time when a connector key joins it', async () => {
    const T0 = '2026-10-03T05:00:00.000Z';
    seedState({ schemaVersion: 1, jobs: {}, notices: { 'github-actions/http-4xx': T0 } });
    h.behave['github-actions'] = { discover: async () => [ghaUndetermined] };
    h.behave.cloudflare = throwing('discover');
    await runCheck();
    expectCompleted();
    const text = JSON.parse(h.fetchCalls[0].body).text as string;
    expect(text).toContain('cloudflare:');
    expect(text).not.toContain('github-actions');
    expect(readState().notices).toEqual({ 'github-actions/http-4xx': T0, [K('cloudflare')]: NOW });
  });

  it('keeps a standing connector key when a job key appears', async () => {
    const T0 = '2026-10-03T05:00:00.000Z';
    seedState({ schemaVersion: 1, jobs: {}, notices: { [K('cloudflare')]: T0 } });
    h.behave['github-actions'] = { discover: async () => [ghaUndetermined] };
    h.behave.cloudflare = throwing('discover');
    await runCheck();
    expectCompleted();
    const text = JSON.parse(h.fetchCalls[0].body).text as string;
    expect(text).toContain('github-actions: workflow list unavailable: HTTP 401');
    expect(text).not.toContain('cloudflare');
    expect(readState().notices).toEqual({ [K('cloudflare')]: T0, 'github-actions/http-4xx': NOW });
  });

  it('does not repeat a standing connector line alongside a new failure', async () => {
    const T0 = '2026-10-03T05:00:00.000Z';
    seedState({ schemaVersion: 1, jobs: {}, notices: { [K('cloudflare')]: T0 } });
    h.behave.cloudflare = throwing('discover');
    h.behave.systemd = { discover: async () => [systemdFailing] };
    await runCheck();
    expectCompleted();
    const text = JSON.parse(h.fetchCalls[0].body).text as string;
    expect(text).toContain(':red_circle: FAILURE  [systemd] backup.timer');
    expect(text).not.toContain('cloudflare');
    expect(readState().notices).toEqual({ [K('cloudflare')]: T0 });
  });

  it('keeps the carried-over failure of the fallen connector and does not re-send it', async () => {
    const old = { status: 'failure', notifiedAt: '2026-10-02T00:00:00.000Z', source: 'cloudflare' };
    seedState({ schemaVersion: 1, jobs: { 'cf|w|0 * * * *': old }, notices: {} });
    h.behave.cloudflare = throwing('discover');
    await runCheck();
    expectCompleted();
    const text = JSON.parse(h.fetchCalls[0].body).text as string;
    expect(text).not.toContain('FAILURE');
    expect(text).toContain('cloudflare:');
    const saved = readState();
    expect(saved.jobs).toEqual({ 'cf|w|0 * * * *': old });
    expect(saved.notices).toEqual({ [K('cloudflare')]: NOW });
  });

  it('stays quiet under 24h and re-sends at exactly 24h', async () => {
    const T0 = '2026-10-02T06:00:00.000Z';
    seedState({ schemaVersion: 1, jobs: {}, notices: { [K('cloudflare')]: T0 } });
    h.behave.cloudflare = throwing('discover');
    await runCheck('2026-10-03T05:59:59.999Z');
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(0);
    expect(readState().notices).toEqual({ [K('cloudflare')]: T0 });
    await runCheck('2026-10-03T06:00:00.000Z');
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(1);
    expect(readState().notices).toEqual({ [K('cloudflare')]: '2026-10-03T06:00:00.000Z' });
  });

  it('re-sends a key standing for more than 24h', async () => {
    seedState({ schemaVersion: 1, jobs: {}, notices: { [K('cloudflare')]: '2026-10-01T00:00:00.000Z' } });
    h.behave.cloudflare = throwing('discover');
    await runCheck();
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(1);
    expect(readState().notices).toEqual({ [K('cloudflare')]: NOW });
  });

  it('drops the key on recovery and sends again at once when it falls over again', async () => {
    seedState({ schemaVersion: 1, jobs: {}, notices: { [K('cloudflare')]: '2026-10-03T05:00:00.000Z' } });
    await runCheck();
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(0);
    expect(readState().notices).toEqual({});
    h.behave.cloudflare = throwing('discover');
    await runCheck('2026-10-03T07:00:00.000Z');
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(1);
    expect(readState().notices).toEqual({ [K('cloudflare')]: '2026-10-03T07:00:00.000Z' });
  });

  it.each([
    ['a declared unavailable', { availability: async () => ({ state: 'unavailable', reason: 'no crontab' }) }],
    ['skipped', { availability: async () => ({ state: 'skipped', reason: 'no token' }) }],
    ['degraded', { availability: async () => ({ state: 'degraded', reason: 'no GitHub token' }) }],
  ])('says nothing about %s', async (_, behaviour) => {
    h.behave.crontab = behaviour;
    await runCheck();
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(0);
    expect(readState().notices).toEqual({});
  });

  it('treats a degraded connector whose discover throws as fallen over', async () => {
    h.behave['github-actions'] = {
      availability: async () => ({ state: 'degraded', reason: 'no GitHub token' }),
      discover: async () => { throw new Error(SENTINEL); },
    };
    await runCheck();
    expectCompleted();
    expect(JSON.parse(h.fetchCalls[0].body).text).toContain('github-actions:');
    expect(readState().notices).toEqual({ [K('github-actions')]: NOW });
  });
});

describe('cronscope check: delivery behaviour kept as it was', () => {
  it('without a webhook prints the digest and still stamps the new key', async () => {
    vi.stubEnv('CRONSCOPE_SLACK_WEBHOOK_URL', undefined);
    h.behave.cloudflare = throwing('discover');
    await runCheck();
    expectCompleted();
    expect(h.fetchCalls).toHaveLength(0);
    const out = logs.join('\n');
    const digest = out.slice(out.indexOf('would notify:\n'));
    expect(digest).toContain(':grey_question: cloudflare:');
    expect(digest).not.toContain('SENTINEL');
    // Existing behaviour (notify-state.ts nextNoticeState): a new key is stamped
    // even though nothing was sent, so configuring a webhook later waits up to 24h.
    expect(readState().notices).toEqual({ [K('cloudflare')]: NOW });
  });

  it.each([
    ['rejects the post', async () => ({ ok: false, status: 500 }), /Slack webhook responded 500/],
    ['cannot be reached', async () => { throw new Error('network down'); }, /network down/],
  ])('saves nothing when Slack %s', async (_, fetchImpl, why) => {
    const before = JSON.stringify({ schemaVersion: 1, jobs: {}, notices: { 'github-actions/http-4xx': '2026-10-01T00:00:00.000Z' } });
    mkdirSync(join(h.home, '.config', 'cronscope'), { recursive: true });
    writeFileSync(notifyPath(), before, 'utf8');
    h.fetch = fetchImpl as any;
    h.behave.cloudflare = throwing('discover');
    await runCheck();
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe(WEBHOOK);
    expect(h.exitCodes).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toMatch(why);
    expect(h.guardViolations).toEqual([]);
    expect(h.snapshotSaves).toEqual([join(h.home, '.config', 'cronscope', 'state.json')]);
    expect(h.notifySaves).toEqual([]);
    expect(readFileSync(notifyPath(), 'utf8')).toBe(before);
    expect(existsSync(join(h.home, '.config', 'cronscope', 'state.json'))).toBe(true);
  });
});
