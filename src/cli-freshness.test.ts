import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// Wiring test for run freshness (wharfe/cronscope#4) through the real cli.ts
// main(), the real github-actions connector and the real state files. Only the
// I/O is replaced: home directory, clock, GitHub, Slack. Same approach as
// cli.test.ts, with the github-actions connector left real.

const h = vi.hoisted(() => ({
  home: '',
  now: new Date(0),
  mono: 0,
  // workflow name -> listing answers for the CURRENT check (last one repeats)
  lists: {} as Record<string, { status: number; body?: any }[]>,
  probes: {} as Record<string, { status: number; body?: any }>,
  used: {} as Record<string, number>,
  wf: ['a'] as string[],
  slack: [] as string[],
  calls: [] as string[],
  exitCodes: [] as unknown[],
  guardViolations: [] as string[],
  freshSaves: 0,
  failFreshSave: false,
  failSlack: false,
  onFetch: null as null | ((url: string) => void),
  events: [] as string[],
  globThrows: false,
  done: null as null | (() => void),
}));

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  const homedir = () => h.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const WORKFLOW = 'name: w\non:\n  schedule:\n    - cron: "0 21 * * *"\njobs: {}\n';
const ROOT = '/home/u/dev';
const WEBHOOK = 'https://hooks.invalid/cronscope-test';

vi.mock('./runtime.js', () => ({
  makeCtx: (scanRoots: string[], abort?: AbortSignal) => {
    const files = Object.fromEntries(h.wf.map((w) => [`${ROOT}/proj/.github/workflows/${w}.yml`, WORKFLOW]));
    const workflows = h.wf.map((w, i) => ({ id: 7 + i, path: `.github/workflows/${w}.yml`, state: 'active' }));
    return {
      now: () => h.now,
      run: async (cmd: string[]) => cmd.includes('rev-parse')
        ? { stdout: `${ROOT}/proj\n`, stderr: '', code: 0 }
        : { stdout: 'https://github.com/wharfe/proj.git\n', stderr: '', code: 0 },
      readFile: async (p: string) => files[p] ?? '',
      glob: async () => { if (h.globThrows) throw new Error('scan root vanished'); return Object.keys(files); },
      env: { CRONSCOPE_GH_TOKEN: 'ghp_dummy_token_0123456789' }, homeDir: h.home, scanRoots: [ROOT],
      monoMs: () => h.mono,
      sleep: async (ms: number) => { h.mono += ms; },
      abort,
      fetch: async (url: string, init: any) => {
        try { return await answer(url, init); } finally { h.events.push('fetch-done'); }
      },
    };
    async function answer(url: string, init: any) {
        h.mono += 100;
        h.onFetch?.(url);
        // Lets the release, if it were (wrongly) started now, run first.
        await new Promise((r) => setTimeout(r, 5));
        if (abort?.aborted) throw new Error('This operation was aborted');
        const u = String(url);
        if (u === WEBHOOK) {
          h.slack.push(JSON.parse(init.body).text);
          return { ok: !h.failSlack, status: h.failSlack ? 500 : 200 };
        }
        let r: { status: number; body?: any };
        const lm = u.match(/\/workflows\/(\d+)\/runs\?/);
        const pm = u.match(/\/actions\/runs\/(\d+)$/);
        if (lm) {
          const name = h.wf[Number(lm[1]) - 7];
          h.calls.push(`list:${name}`);
          const s = h.lists[name] ?? [];
          const i = h.used[name] ?? 0; h.used[name] = i + 1;
          r = s[Math.min(i, s.length - 1)] ?? { status: 500 };
        } else if (pm) { h.calls.push(`probe:${pm[1]}`); r = h.probes[pm[1]] ?? { status: 500 }; }
        else { r = { status: 200, body: { total_count: workflows.length, workflows } }; }
        return { ok: r.status === 200, status: r.status, json: async () => r.body };
    }
  },
}));
vi.mock('./core/host.js', () => ({ bootAt: async () => undefined }));
const fake = (id: string) => ({ id, tier: 0, availability: async () => ({ state: 'available' }), discover: async () => [] });
vi.mock('./connectors/crontab.js', () => ({ crontabConnector: fake('crontab') }));
vi.mock('./connectors/systemd.js', () => ({ systemdConnector: fake('systemd') }));
vi.mock('./connectors/cloudflare.js', () => ({ cloudflareConnector: fake('cloudflare') }));
vi.mock('./connectors/hermes.js', () => ({ hermesConnector: fake('hermes') }));
vi.mock('./connectors/launchd.js', () => ({ launchdConnector: fake('launchd') }));

// Every writer refuses a path outside the test home before writing.
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
    saveSnapshot: async (p: string, s: any) => {
      await guard(p);
      await actual.saveSnapshot(p, s);
      // `scan` ends at its snapshot write (it has no lock and no exit).
      if (process.argv[2] === 'scan') { const done = h.done; setTimeout(() => done?.(), 0); }
    },
  };
});
vi.mock('./store/notify-state.js', async (orig) => {
  const actual = await orig<typeof import('./store/notify-state.js')>();
  return { ...actual, saveNotifyState: async (p: string, s: any) => { await guard(p); return actual.saveNotifyState(p, s); } };
});
vi.mock('./store/gha-freshness.js', async (orig) => {
  const actual = await orig<typeof import('./store/gha-freshness.js')>();
  return {
    ...actual,
    saveFreshState: async (p: string, s: any) => {
      await guard(p);
      if (h.failFreshSave) throw new Error('ENOSPC: no space left on device');
      h.freshSaves++;
      return actual.saveFreshState(p, s);
    },
  };
});
// A run ends when the lock is released (or the process "exits", below).
vi.mock('./store/check-lock.js', async (orig) => {
  const actual = await orig<typeof import('./store/check-lock.js')>();
  return {
    ...actual,
    acquireCheckLock: async (p: string, now: Date, deps?: any) => {
      await guard(p);
      const got = await actual.acquireCheckLock(p, now, deps);
      if (!got.ok) return got;
      // Bound to THIS run's promise: a late callback must not end the next run.
      const done = h.done;
      return { ...got, release: async () => { h.events.push('release'); await got.release(); setTimeout(() => done?.(), 0); } };
    },
  };
});

const CFG = () => join(h.home, '.config', 'cronscope');
const FRESH = () => join(CFG(), 'gha-freshness.json');
const NOTIFY = () => join(CFG(), 'notify-state.json');
const SNAP = () => join(CFG(), 'state.json');
const LOCK = () => join(CFG(), 'check.lock');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

const run = (id: number, created: string, conclusion = 'success') =>
  ({ id, run_attempt: 1, conclusion, created_at: created, workflow_id: 7, event: 'schedule' });
const page = (...runs: any[]) => ({ status: 200, body: { total_count: 9, workflow_runs: runs } });
const NEW_OK = run(100, '2026-10-03T02:13:07Z', 'success');
const OLD_FAIL = run(50, '2026-09-17T11:55:17Z', 'failure');
const NEWER_OK = run(101, '2026-10-03T08:06:11Z', 'success');
const completed = (id: number, created: string, wf = 7) =>
  ({ status: 200, body: { id, workflow_id: wf, event: 'schedule', status: 'completed', created_at: created } });

let logs: string[];
let errors: unknown[];

async function cli(args: string[], at: string) {
  h.now = new Date(at);
  h.used = {}; h.slack = []; h.calls = []; h.exitCodes = []; h.freshSaves = 0;
  logs = []; errors = [];
  const finished = new Promise<void>((resolve) => { h.done = resolve; });
  vi.resetModules();
  process.argv = ['node', 'cli.js', ...args];
  await import('./cli.js');
  await finished;
  h.done = null;
}
const check = (at: string) => cli(['check'], at);

const argv = process.argv;
beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'cronscope-fresh-cli-'));
  h.wf = ['a']; h.lists = {}; h.probes = {}; h.mono = 0;
  h.failFreshSave = false; h.failSlack = false; h.onFetch = null; h.guardViolations = []; h.events = []; h.globThrows = false;
  vi.stubEnv('CRONSCOPE_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a[0]); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { h.exitCodes.push(code); const done = h.done; setTimeout(() => done?.(), 0); }) as never);
  vi.stubGlobal('fetch', async () => { throw new Error('global fetch reached in the wiring test'); });
  expect(homedir()).toBe(h.home);
});
afterEach(() => {
  expect(h.guardViolations).toEqual([]);
  rmSync(h.home, { recursive: true, force: true });
  process.argv = argv;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jobId = async (name: string) => {
  const { createHash } = await import('node:crypto');
  return 'gha|' + createHash('sha1').update(`proj/.github/workflows/${name}.yml`).digest('hex').slice(0, 12);
};
const T = (hour: number) => `2026-10-03T${String(hour).padStart(2, '0')}:17:05.000Z`;

describe('check: run freshness end to end', () => {
  it('#5 #6 #20 #21: baseline, then two stale checks -- no FAILURE, the failure entry kept, Slack only on the 2nd', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    expect(errors).toEqual([]);
    expect(readJson(FRESH()).entries[A]).toMatchObject({ baseline: { runId: 100 }, streak: 0 });
    // A failure notified earlier for this job must survive the unknown checks.
    const ns = readJson(NOTIFY());
    ns.jobs[A] = { status: 'failure', notifiedAt: T(0), source: 'github-actions' };
    writeFileSync(NOTIFY(), JSON.stringify(ns));

    h.lists = { a: [page(OLD_FAIL)] };
    h.probes = { 100: completed(100, '2026-10-03T02:13:07Z') };
    await check(T(2));
    expect(errors).toEqual([]);
    expect(logs.some((l) => l.startsWith('FAILURE'))).toBe(false);
    expect(h.slack).toEqual([]);
    expect(readJson(NOTIFY()).jobs[A]).toMatchObject({ status: 'failure' });
    expect(readJson(FRESH()).entries[A]).toMatchObject({ streak: 1, baseline: { runId: 100 }, lastOutcome: 'behind' });
    expect(logs.find((l) => l.startsWith('# gha-freshness'))).toMatch(/outcome=behind streak=1 retries=2 probe=ok stop=- mark_run=100 /);

    await check(T(3));
    expect(h.slack).toHaveLength(1);
    expect(h.slack[0]).toContain('github-actions: proj/.github/workflows/a.yml の run 鮮度を 2 回続けて確認できていない（behind');
    expect(h.slack[0]).not.toMatch(/FAILURE|HTTP|37089|ghp_/);
    expect(readJson(NOTIFY()).notices).toHaveProperty([`github-actions/run-freshness/${A}`]);
    expect(readJson(NOTIFY()).jobs[A]).toMatchObject({ status: 'failure' });

    // #22 recovery: silent, key gone, streak 0.
    h.lists = { a: [page(NEWER_OK)] };
    await check(T(4));
    expect(h.slack).toEqual([]);
    expect(readJson(NOTIFY()).notices).not.toHaveProperty([`github-actions/run-freshness/${A}`]);
    expect(readJson(FRESH()).entries[A]).toMatchObject({ streak: 0, baseline: { runId: 101 } });
  });

  it('#9 a 404 baseline is kept and the notice says a person may release it', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    h.lists = { a: [page(OLD_FAIL)] };
    h.probes = { 100: { status: 404 } };
    await check(T(2));
    await check(T(3));
    expect(readJson(FRESH()).entries[A]).toMatchObject({ baseline: { runId: 100 }, streak: 2, notFound: true });
    expect(h.slack[0]).toContain('（unverified。基準 run が API で見つからない。削除を確かめたら人が基準を解放する（README）');
    expect(logs.some((l) => l.startsWith('FAILURE'))).toBe(false);
  });

  it('#18 a failed first listing keeps the streak: 1 -> (502) -> 2 sends', async () => {
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    h.lists = { a: [page(OLD_FAIL)] }; h.probes = { 100: completed(100, '2026-10-03T02:13:07Z') };
    await check(T(2));
    h.lists = { a: [{ status: 502 }] };
    await check(T(3));
    expect(h.slack.join('\n')).not.toContain('run 鮮度');
    h.lists = { a: [page(OLD_FAIL)] };
    await check(T(4));
    expect(h.slack.join('\n')).toContain('run 鮮度を 2 回続けて');
  });
});

describe('check: several jobs, one key each', () => {
  it('#25 #26 #27: A alone at 2; B reaching 2 is sent at once; A recovering leaves B\'s clock alone', async () => {
    const [A, B] = [await jobId('a'), await jobId('b')];
    h.wf = ['a', 'b'];
    const wfRun = (wf: number, r: any) => ({ ...r, workflow_id: wf });
    h.lists = { a: [page(wfRun(7, NEW_OK))], b: [page(wfRun(8, NEW_OK))] };
    await check(T(1));
    h.probes = { 100: completed(100, '2026-10-03T02:13:07Z') };
    // The probe answers for workflow 7 only; B's baseline GET is a mismatch -> unverified. Both stay behind.
    h.lists = { a: [page(wfRun(7, OLD_FAIL))], b: [page(wfRun(8, NEW_OK))] };
    await check(T(2));                       // A=1, B=0
    h.lists = { a: [page(wfRun(7, OLD_FAIL))], b: [page(wfRun(8, OLD_FAIL))] };
    await check(T(3));                       // A=2 -> sent, B=1 -> not
    expect(h.slack).toHaveLength(1);
    expect(h.slack[0]).toContain('workflows/a.yml');
    expect(h.slack[0]).not.toContain('workflows/b.yml');
    await check(T(4));                       // A=3 (standing), B=2 -> sent now, alone
    expect(h.slack).toHaveLength(1);
    expect(h.slack[0]).toContain('workflows/b.yml');
    expect(h.slack[0]).not.toContain('workflows/a.yml');
    const sentB = readJson(NOTIFY()).notices[`github-actions/run-freshness/${B}`];
    expect(sentB).toBe(T(4));
    h.lists = { a: [page(wfRun(7, NEWER_OK))], b: [page(wfRun(8, OLD_FAIL))] };
    await check(T(5));                       // A recovers; B keeps its own timer
    const n = readJson(NOTIFY()).notices;
    expect(n).not.toHaveProperty([`github-actions/run-freshness/${A}`]);
    expect(n[`github-actions/run-freshness/${B}`]).toBe(sentB);
    expect(h.slack).toEqual([]);
  });
});

describe('check: the state file failing to save (bundle 2)', () => {
  it('#34 an unsaved check is not counted, says so, and its new baseline is lost (documented limit)', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(run(90, '2026-10-02T00:00:00Z'))] };
    await check(T(1));                                        // baseline 90
    // Check 2 sees a newer run 100 but cannot save it.
    h.lists = { a: [page(NEW_OK)] }; h.failFreshSave = true;
    await check(T(2));
    expect(h.exitCodes).toEqual([1]);
    expect(h.slack).toHaveLength(1);
    expect(h.slack[0]).toContain('鮮度の状態ファイルを保存できなかった');
    expect(readJson(FRESH()).entries[A].baseline.runId).toBe(90);
    expect(readJson(NOTIFY()).lastCheckAt).toBe(T(2));        // notify-state still saved
    // Check 3: a listing older than the LOST baseline (100) but newer than the saved one (90)
    // is accepted as normal -- its old failure becomes a FAILURE. This is the limit.
    h.failFreshSave = false;
    h.lists = { a: [page(run(95, '2026-10-02T12:00:00Z', 'failure'))] };
    await check(T(3));
    expect(logs).toContain('FAILURE  [github-actions] proj/.github/workflows/a.yml');
  });

  it('a stale observation in an unsaved check does not advance the count used for Slack', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    h.lists = { a: [page(OLD_FAIL)] }; h.probes = { 100: completed(100, '2026-10-03T02:13:07Z') };
    await check(T(2));                                        // saved: streak 1
    h.failFreshSave = true;
    await check(T(3));                                        // stale again, NOT saved: still 1
    expect(h.slack.join('\n')).not.toContain('run 鮮度');
    expect(logs.find((l) => l.startsWith('# gha-freshness'))).toContain('streak=1');
    expect(readJson(FRESH()).entries[A].streak).toBe(1);
    h.failFreshSave = false;
    await check(T(4));                                        // saved: 2 -> sent
    expect(h.slack.join('\n')).toContain('run 鮮度を 2 回続けて');
  });

  it('an unsaved check that saw a recovery does not drop a standing key (it judges on saved data only)', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    h.lists = { a: [page(OLD_FAIL)] }; h.probes = { 100: completed(100, '2026-10-03T02:13:07Z') };
    await check(T(2));
    await check(T(3));                                        // key sent at T(3)
    const key = `github-actions/run-freshness/${A}`;
    expect(readJson(NOTIFY()).notices[key]).toBe(T(3));
    h.lists = { a: [page(NEWER_OK)] }; h.failFreshSave = true;
    await check(T(4));                                        // recovered, but not saved
    expect(readJson(NOTIFY()).notices[key]).toBe(T(3));       // still standing, clock kept
    h.failFreshSave = false;
    h.lists = { a: [page(OLD_FAIL)] };
    await check(T(5));                                        // stale again: no immediate re-send
    expect(h.slack.join('\n')).not.toContain('run 鮮度');
  });

  it('#35 Slack failing does not cost the saved streak', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    h.lists = { a: [page(OLD_FAIL)] }; h.probes = { 100: completed(100, '2026-10-03T02:13:07Z') };
    await check(T(2));
    h.failSlack = true;
    await check(T(3));                                        // tries to send, Slack rejects
    expect(h.exitCodes).toEqual([1]);
    expect(readJson(FRESH()).entries[A].streak).toBe(2);
    expect(readJson(NOTIFY()).lastCheckAt).toBe(T(2));        // notify-state not saved (existing contract)
    h.failSlack = false;
    await check(T(4));
    expect(h.slack.join('\n')).toContain('run 鮮度を 3 回続けて');
    expect(existsSync(LOCK())).toBe(false);
  });
});

describe('check: a corrupt or foreign state file', () => {
  it('#36 moves a corrupt file aside, starts empty and says so once', async () => {
    mkdirSync(CFG(), { recursive: true });
    writeFileSync(FRESH(), '{ broken');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    expect(readFileSync(`${FRESH()}.corrupt`, 'utf8')).toBe('{ broken');
    expect(readJson(FRESH()).entries[await jobId('a')].baseline.runId).toBe(100);
    expect(h.slack[0]).toContain('鮮度の状態ファイルが壊れていたので退避して作り直した');
    await check(T(2));
    expect(h.slack).toEqual([]);
  });

  it('#37 leaves an unknown version untouched and turns freshness off', async () => {
    mkdirSync(CFG(), { recursive: true });
    writeFileSync(FRESH(), JSON.stringify({ schemaVersion: 2, entries: {} }));
    h.lists = { a: [page(OLD_FAIL)] };
    await check(T(1));
    expect(readJson(FRESH())).toEqual({ schemaVersion: 2, entries: {} });
    expect(h.freshSaves).toBe(0);
    expect(logs).toContain('FAILURE  [github-actions] proj/.github/workflows/a.yml');   // as before freshness existed
    expect(h.slack[0]).toContain('知らない版なので触らず');
  });
});

describe('check: forgetting unseen entries', () => {
  it('#45 #49 forgets an entry unseen for 30 days only when the connector really ran', async () => {
    const A = await jobId('a');
    mkdirSync(CFG(), { recursive: true });
    const old = { identity: { repo: 'wharfe/proj', workflowId: 9, path: '.github/workflows/gone.yml', query: 'q1:event=schedule,status=completed' },
      baseline: { runId: 1, createdAt: '2026-08-01T00:00:00.000Z', judgedStatus: 'success', conclusion: 'success', judgedAttempt: 1, latestAttempt: 1, confirmedAt: '2026-08-01T00:00:00.000Z' },
      streak: 0, lastSeenAt: '2026-08-01T00:00:00.000Z' };
    writeFileSync(FRESH(), JSON.stringify({ schemaVersion: 1, entries: { 'gha|gone00000000': old } }));
    h.globThrows = true;                                       // github-actions connector falls over
    await check(T(1));
    expect(Object.keys(readJson(FRESH()).entries)).toEqual(['gha|gone00000000']);
    h.globThrows = false; h.lists = { a: [page(NEW_OK)] };
    await check(T(2));
    expect(Object.keys(readJson(FRESH()).entries)).toEqual([A]);
  });
});

describe('check: a corrupt file that cannot be moved aside', () => {
  it('is never overwritten (the evidence stays) and freshness is off for that check', async () => {
    mkdirSync(join(`${FRESH()}.corrupt`, 'x'), { recursive: true });   // rename onto a non-empty dir fails
    writeFileSync(FRESH(), '{ broken');
    h.lists = { a: [page(OLD_FAIL)] };
    await check(T(1));
    expect(errors).toEqual([]);
    expect(readFileSync(FRESH(), 'utf8')).toBe('{ broken');
    expect(h.freshSaves).toBe(0);
    expect(logs).toContain('FAILURE  [github-actions] proj/.github/workflows/a.yml');   // as before freshness existed
    expect(h.slack[0]).toContain('鮮度の状態ファイルが壊れていた');
  });
});

describe('the check lock', () => {
  const seedLock = (acquiredAt: string, pid = process.pid) => {
    mkdirSync(CFG(), { recursive: true });
    writeFileSync(LOCK(), JSON.stringify({ pid, acquiredAt, nonce: 'other' }));
  };
  const nothingWritten = () => {
    expect(existsSync(SNAP())).toBe(false);
    expect(existsSync(FRESH())).toBe(false);
    expect(existsSync(NOTIFY())).toBe(false);
    expect(h.slack).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(readJson(LOCK()).nonce).toBe('other');
  };

  it('#29 a held lock: rc 75, nothing read or written', async () => {
    seedLock(new Date(Date.now() - 60_000).toISOString());
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    expect(h.exitCodes).toEqual([75]);
    expect(logs[0]).toMatch(/^# check skipped: another check holds the lock \(pid=\d+, alive=yes, held 1m\); nothing was changed$/);
    nothingWritten();
  });

  it('#32 held for more than 2h: rc 1 and a fixed line, still not taken over', async () => {
    seedLock(new Date(Date.now() - 3 * 3600_000).toISOString());
    await check(T(1));
    expect(h.exitCodes).toEqual([1]);
    expect(logs[0]).toContain('lock held for more than 2h');
    nothingWritten();
  });

  it('#30 a dead holder\'s lock is NOT reclaimed (no automatic recovery in v1)', async () => {
    seedLock(new Date(Date.now() - 60_000).toISOString(), 999999);
    await check(T(1));
    expect(h.exitCodes).toEqual([75]);
    nothingWritten();
  });

  it('a normal check removes its own lock', async () => {
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    expect(h.exitCodes).toEqual([]);
    expect(readdirSync(CFG()).sort()).toEqual(['gha-freshness.json', 'notify-state.json', 'state.json']);
  });

  it('SIGTERM mid-scan: stops the work, saves nothing, sends nothing, then releases and exits 143', async () => {
    h.wf = ['a', 'b'];
    h.lists = { a: [page(NEW_OK)], b: [page(NEW_OK)] };
    const tried: string[] = [];
    h.onFetch = (u) => {
      if (u.includes('/runs?')) tried.push(u.match(/workflows\/(\d+)\//)![1]);
      if (u.includes('/workflows/7/runs?')) process.emit('SIGTERM', 'SIGTERM');
    };
    await check(T(1));
    await new Promise((r) => setTimeout(r, 50));   // let any still-running fetch finish
    // The lock went only after the last fetch of this check had settled.
    expect(tried).toEqual(['7', '8']);   // b's listing (workflow 8) was really attempted after the signal
    expect(h.events.indexOf('release')).toBeGreaterThan(h.events.lastIndexOf('fetch-done'));
    expect(h.exitCodes).toEqual([143]);
    expect(logs).toContain('# check: received SIGTERM; stopping its work before releasing the lock');
    expect(existsSync(SNAP())).toBe(false);
    expect(existsSync(FRESH())).toBe(false);
    expect(existsSync(NOTIFY())).toBe(false);
    expect(h.slack).toEqual([]);
    expect(existsSync(LOCK())).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('scan stays a reader', () => {
  it('#38-#42: compares with the saved baseline, never writes the freshness state', async () => {
    const A = await jobId('a');
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    const before = readFileSync(FRESH(), 'utf8');
    h.lists = { a: [page(OLD_FAIL), page(NEWER_OK)] };
    await cli(['scan'], T(2));
    expect(h.calls).toEqual(['list:a']);                      // no re-fetch, no baseline GET
    expect(logs.join('\n')).toContain('[unknown]');
    expect(logs).toContain('# github-actions: run freshness: listing is older than the last check record (not rechecked here) (1 job undetermined)');
    expect(readFileSync(FRESH(), 'utf8')).toBe(before);        // not even lastSeenAt moved
    expect(readJson(SNAP()).jobs[0].lastRun).toMatchObject({ status: 'unknown', lastObserved: { runId: 100 } });
    expect(h.slack).toEqual([]);
    // #41 a newer listing is shown as is, and the baseline is still not moved.
    h.lists = { a: [page(NEWER_OK)] };
    await cli(['scan'], T(3));
    expect(logs.join('\n')).toContain('[success]');
    expect(readFileSync(FRESH(), 'utf8')).toBe(before);
    expect(readJson(FRESH()).entries[A].streak).toBe(0);
  });
});

describe('gha-freshness release (D1)', () => {
  const setup = async () => {
    h.lists = { a: [page(NEW_OK)] };
    await check(T(1));
    return jobId('a');
  };
  const args = (id: string, over: Partial<Record<'repo' | 'wf' | 'run', string>> = {}, yes = true) =>
    ['gha-freshness', 'release', id, '--repo', over.repo ?? 'wharfe/proj', '--workflow-id', over.wf ?? '7', '--run', over.run ?? '100', ...(yes ? ['--yes'] : [])];

  it('explains first and changes nothing without --yes', async () => {
    const A = await setup();
    const before = readFileSync(FRESH(), 'utf8');
    await cli(args(A, {}, false), T(2));
    expect(h.exitCodes).toEqual([0]);
    expect(logs[0]).toContain('NOT a confirmation that the workflow recovered');
    expect(logs.join('\n')).toContain('an old failure included, which can then be notified as a FAILURE');
    expect(readFileSync(FRESH(), 'utf8')).toBe(before);
  });

  it.each([['repo', { repo: 'wharfe/other' }], ['workflow id', { wf: '8' }], ['run', { run: '99' }], ['job', {}]] as const)(
    'refuses a mismatching %s and changes nothing (no fallback)', async (what, over) => {
      const A = await setup();
      const before = readFileSync(FRESH(), 'utf8');
      await cli(args(what === 'job' ? 'gha|000000000000' : A, over), T(2));
      expect(h.exitCodes).toEqual([2]);
      expect(readFileSync(FRESH(), 'utf8')).toBe(before);
      expect(existsSync(LOCK())).toBe(false);
    });

  it('releases exactly that entry under the lock; the next check treats the job as new', async () => {
    const A = await setup();
    const notifyBefore = readFileSync(NOTIFY(), 'utf8');
    const lastCheckAt = readJson(FRESH()).lastCheckAt;
    await cli(args(A), T(2));
    expect(h.exitCodes).toEqual([]);
    expect(readJson(FRESH()).entries).toEqual({});
    expect(readJson(FRESH()).lastCheckAt).toBe(lastCheckAt);
    expect(readFileSync(NOTIFY(), 'utf8')).toBe(notifyBefore);
    expect(existsSync(LOCK())).toBe(false);
    // The warning comes true: an old failure is now adopted and notified.
    h.lists = { a: [page(OLD_FAIL)] };
    await check(T(3));
    expect(logs).toContain('FAILURE  [github-actions] proj/.github/workflows/a.yml');
  });

  it('refuses (rc 1, nothing changed) when other entries in the file are malformed -- they would be lost', async () => {
    const A = await setup();
    const st = readJson(FRESH());
    st.entries['gha|bad000000000'] = { broken: true };
    writeFileSync(FRESH(), JSON.stringify(st));
    const before = readFileSync(FRESH(), 'utf8');
    await cli(args(A), T(2));
    expect(h.exitCodes).toEqual([1]);
    expect(readFileSync(FRESH(), 'utf8')).toBe(before);
  });

  it('a missing state file is "no such baseline" (rc 2) with or without --yes', async () => {
    await cli(args('gha|000000000000'), T(2));
    expect(h.exitCodes).toEqual([2]);
    await cli(args('gha|000000000000', {}, false), T(2));
    expect(h.exitCodes).toEqual([2]);
  });

  it('does nothing while a check holds the lock', async () => {
    const A = await setup();
    writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), nonce: 'other' }));
    const before = readFileSync(FRESH(), 'utf8');
    await cli(args(A), T(2));
    expect(h.exitCodes).toEqual([75]);
    expect(readFileSync(FRESH(), 'utf8')).toBe(before);
  });
});
