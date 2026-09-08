import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot, loadSnapshot } from './snapshot.js';
import { loadNotifyState, saveNotifyState } from './notify-state.js';
import type { Snapshot } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronscope-')); });

const snap: Snapshot = {
  schemaVersion: 1, generatedAt: '2026-06-12T10:00:00Z',
  host: { bootAt: '2026-06-12T09:00:00Z' }, connectors: {}, jobs: [],
};

describe('snapshot store', () => {
  it('round-trips and returns null for a missing file', async () => {
    expect(await loadSnapshot(join(dir, 'state.json'))).toBeNull();
    await saveSnapshot(join(dir, 'state.json'), snap);
    expect((await loadSnapshot(join(dir, 'state.json')))?.schemaVersion).toBe(1);
  });

  it('ignores a snapshot with an unknown schemaVersion (regenerable cache)', async () => {
    await saveSnapshot(join(dir, 's.json'), { ...snap, schemaVersion: 99 as any });
    expect(await loadSnapshot(join(dir, 's.json'))).toBeNull();
  });
});

describe('notify-state store', () => {
  it('round-trips notified states', async () => {
    const p = join(dir, 'notify.json');
    expect((await loadNotifyState(p)).jobs).toEqual({});
    await saveNotifyState(p, { schemaVersion: 1, lastCheckAt: '2026-06-12T10:00:00Z',
      jobs: { a: { status: 'failure', notifiedAt: 't', source: 'systemd' } }, notices: null });
    expect((await loadNotifyState(p)).jobs.a.status).toBe('failure');
  });
});

import { writeFile } from 'node:fs/promises';
import { classifyReason, noticeKeys, shouldSendNotices, carryOverJobs } from './notify-state.js';
import type { Availability, Job, JobSource } from '../types.js';

const mkJob = (id: string, source: JobSource, over: Partial<Job> = {}): Job => ({
  id, source, name: id, target: 't', location: 'l',
  schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' },
  lastRun: { status: 'success', at: 'x', fetchedAt: 'x' },
  ...over,
});

const undet = (id: string, source: JobSource, reason: string) =>
  mkJob(id, source, { lastRun: { status: 'unknown', fetchedAt: 'x', undeterminedReason: reason } });

describe('classifyReason', () => {
  it('folds free-form reasons into a closed set', () => {
    expect(classifyReason('no GitHub token')).toBe('no-token');
    expect(classifyReason('no GitHub origin remote in this checkout')).toBe('no-remote');
    expect(classifyReason('workflow list unavailable: HTTP 401')).toBe('http-4xx');
    expect(classifyReason('run history unavailable: HTTP 502')).toBe('http-5xx');
    expect(classifyReason('run history unavailable: fetch failed')).toBe('network');
    expect(classifyReason('newest scheduled run was skipped (all jobs skipped)')).toBe('skipped');
    expect(classifyReason('something else entirely')).toBe('other');
  });
});

describe('noticeKeys', () => {
  it('collapses many jobs with the same class into one key', () => {
    const jobs = [
      undet('a', 'github-actions', 'workflow list unavailable: HTTP 401'),
      undet('b', 'github-actions', 'run history unavailable: HTTP 403'),
      mkJob('c', 'github-actions'),
    ];
    expect(noticeKeys(jobs)).toEqual(['github-actions/http-4xx']);
  });

  it('ignores sources that are unknown by construction', () => {
    // crontab and cloudflare never report status; that is not a reading failure.
    expect(noticeKeys([mkJob('x', 'crontab', { lastRun: { status: 'unknown', fetchedAt: 'x' } })])).toEqual([]);
    expect(noticeKeys([mkJob('y', 'cloudflare', { lastRun: { status: 'unknown', fetchedAt: 'x' } })])).toEqual([]);
  });
});

describe('shouldSendNotices', () => {
  const t0 = new Date('2026-09-08T00:00:00Z');
  it('sends the first time and stays quiet while the key set is unchanged', () => {
    expect(shouldSendNotices(null, ['github-actions/no-token'], t0)).toBe(true);
    const prev = { keys: ['github-actions/no-token'], notifiedAt: t0.toISOString() };
    expect(shouldSendNotices(prev, ['github-actions/no-token'], new Date('2026-09-08T05:00:00Z'))).toBe(false);
  });

  it('does not re-send when one repo of many recovers but the class remains', () => {
    const prev = { keys: ['github-actions/http-4xx'], notifiedAt: t0.toISOString() };
    expect(shouldSendNotices(prev, ['github-actions/http-4xx'], new Date('2026-09-08T01:00:00Z'))).toBe(false);
  });

  it('sends again when a new class appears', () => {
    const prev = { keys: ['github-actions/http-4xx'], notifiedAt: t0.toISOString() };
    expect(shouldSendNotices(prev, ['github-actions/http-4xx', 'github-actions/no-token'], t0)).toBe(true);
  });

  it('re-sends after 24h so a long-running degradation is not forgotten', () => {
    const prev = { keys: ['github-actions/no-token'], notifiedAt: t0.toISOString() };
    expect(shouldSendNotices(prev, ['github-actions/no-token'], new Date('2026-09-09T00:00:00Z'))).toBe(true);
  });

  it('sends nothing when there is nothing undetermined', () => {
    expect(shouldSendNotices(null, [], t0)).toBe(false);
  });
});

describe('carryOverJobs', () => {
  const avail: Partial<Record<JobSource, Availability>> = {
    'github-actions': { state: 'available' }, crontab: { state: 'available' },
  };
  const at = '2026-09-08T00:00:00Z';

  it('does NOT freeze a crontab job that is unknown by construction', () => {
    // The bug this test exists for: keying on status==='unknown' kept every
    // crontab entry forever, so a job that recovered and failed again never
    // alarmed a second time.
    const prev = { 'crontab|1': { status: 'overdue' as const, notifiedAt: 'old', source: 'crontab' as JobSource } };
    const jobs = [mkJob('crontab|1', 'crontab', { lastRun: { status: 'unknown', fetchedAt: 'x' } })];
    expect(carryOverJobs(prev, jobs, avail, new Map(), at)).toEqual({});
  });

  it('keeps an entry for a job we failed to read this run', () => {
    const prev = { 'gha|1': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource } };
    const jobs = [undet('gha|1', 'github-actions', 'workflow list unavailable: HTTP 401')];
    expect(carryOverJobs(prev, jobs, avail, new Map(), at)['gha|1'].notifiedAt).toBe('old');
  });

  it('keeps an entry when the whole connector fell over and its jobs vanished', () => {
    const prev = { 'gha|1': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource } };
    const broken: Partial<Record<JobSource, Availability>> = { 'github-actions': { state: 'unavailable', reason: 'boom' } };
    expect(carryOverJobs(prev, [], broken, new Map(), at)['gha|1'].notifiedAt).toBe('old');
  });

  it('keeps an entry when the connector went skipped, not just unavailable', () => {
    // cloudflare goes `skipped` when its token is absent and its jobs vanish
    // exactly as on a hard failure.
    const prev = { 'cf|1': { status: 'failure' as const, notifiedAt: 'old', source: 'cloudflare' as JobSource } };
    const skipped: Partial<Record<JobSource, Availability>> = { cloudflare: { state: 'skipped', reason: 'no token' } };
    expect(carryOverJobs(prev, [], skipped, new Map(), at)['cf|1'].notifiedAt).toBe('old');
  });

  it('drops an entry for a job that recovered', () => {
    const prev = { 'gha|1': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource } };
    expect(carryOverJobs(prev, [mkJob('gha|1', 'github-actions')], avail, new Map(), at)).toEqual({});
  });

  it('records the source alongside a newly alarming job', () => {
    const cur = new Map([['gha|1', 'failure' as const]]);
    expect(carryOverJobs({}, [mkJob('gha|1', 'github-actions')], avail, cur, at)['gha|1'])
      .toEqual({ status: 'failure', notifiedAt: at, source: 'github-actions' });
  });
});

describe('notify-state migration', () => {
  it('fills notices and infers source from the id prefix of a pre-existing file', async () => {
    const p = join(dir, 'legacy.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1,
      jobs: { 'systemd|x.timer': { status: 'failure', notifiedAt: 't' } } }), 'utf8');
    const st = await loadNotifyState(p);
    expect(st.notices).toBeNull();
    expect(st.jobs['systemd|x.timer'].source).toBe('systemd');
  });

  it('drops an entry whose id prefix is not a known connector rather than mislabelling it', async () => {
    const p = join(dir, 'weird.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1,
      jobs: { 'mystery|x': { status: 'failure', notifiedAt: 't' } } }), 'utf8');
    expect((await loadNotifyState(p)).jobs).toEqual({});
  });
});
