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

  it('round-trips the run identity on a job (wharfe/cronscope#4)', async () => {
    const run = { id: 9, judgedAttempt: 1, latestAttempt: 2, conclusion: 'failure', latestConclusion: 'success' };
    const withRun: Snapshot = { ...snap, jobs: [{
      id: 'gha|1', source: 'github-actions', name: 'n', target: 't', location: 'l',
      schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'failure', at: 'a', fetchedAt: 'f', run },
    }] };
    await saveSnapshot(join(dir, 'r.json'), withRun);
    expect((await loadSnapshot(join(dir, 'r.json')))?.jobs[0].lastRun?.run).toStrictEqual(run);
  });

  it('still reads a snapshot written before the run identity existed', async () => {
    // Same schemaVersion on purpose: the field is optional, so an older file
    // must load as-is rather than being discarded as an unknown version.
    const p = join(dir, 'old.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1, generatedAt: 'g', host: {}, connectors: {}, jobs: [{
      id: 'gha|1', source: 'github-actions', name: 'n', target: 't', location: 'l',
      schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' },
      lastRun: { status: 'failure', at: 'a', fetchedAt: 'f' },
    }] }), 'utf8');
    const loaded = await loadSnapshot(p);
    expect(loaded?.jobs[0].lastRun?.status).toBe('failure');
    expect(loaded?.jobs[0].lastRun?.run).toBeUndefined();
  });
});

describe('notify-state store', () => {
  it('round-trips notified states', async () => {
    const p = join(dir, 'notify.json');
    expect((await loadNotifyState(p)).jobs).toEqual({});
    await saveNotifyState(p, { schemaVersion: 1, lastCheckAt: '2026-06-12T10:00:00Z',
      jobs: { a: { status: 'failure', notifiedAt: 't', source: 'systemd' } }, notices: {} });
    expect((await loadNotifyState(p)).jobs.a.status).toBe('failure');
  });
});

import { writeFile } from 'node:fs/promises';
import { classifyReason, noticeKeys, noticesToSend, nextNoticeState, jobsForKeys, carryOverJobs } from './notify-state.js';
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

  it('ignores sources that are unknown by construction, even with a reason attached', () => {
    // crontab and cloudflare never report status; that is not a reading failure.
    // The reason is set deliberately: without it the assertion would still pass
    // with the STATUS_KNOWABLE check deleted, and constrain nothing.
    expect(noticeKeys([undet('x', 'crontab', 'HTTP 500')])).toEqual([]);
    expect(noticeKeys([undet('y', 'cloudflare', 'HTTP 500')])).toEqual([]);
  });

  it('ignores a workflow the user disabled on purpose', () => {
    // README says disabled_manually is display-only; a run-history failure on
    // it must not become a notice about it.
    const j = mkJob('gha|1', 'github-actions', { state: 'disabled_manually',
      lastRun: { status: 'unknown', fetchedAt: 'x', undeterminedReason: 'HTTP 500' } });
    expect(noticeKeys([j])).toEqual([]);
  });
});

describe('noticesToSend', () => {
  const t0 = new Date('2026-09-08T00:00:00Z');
  const T0 = t0.toISOString();

  it('sends a key the first time and stays quiet afterwards', () => {
    expect(noticesToSend({}, ['github-actions/no-token'], t0)).toEqual(['github-actions/no-token']);
    expect(noticesToSend({ 'github-actions/no-token': T0 }, ['github-actions/no-token'],
      new Date('2026-09-08T05:00:00Z'))).toEqual([]);
  });

  it('does not re-send a standing key when a different one disappears', () => {
    // The bug this guards: comparing the whole key set meant one class
    // recovering re-sent every other class, so a flapping reason alarmed hourly.
    const prev = { 'github-actions/http-4xx': T0, 'github-actions/http-5xx': T0 };
    expect(noticesToSend(prev, ['github-actions/http-4xx'], new Date('2026-09-08T01:00:00Z'))).toEqual([]);
  });

  it('sends only the newly appeared key', () => {
    const prev = { 'github-actions/http-4xx': T0 };
    expect(noticesToSend(prev, ['github-actions/http-4xx', 'github-actions/no-token'], t0))
      .toEqual(['github-actions/no-token']);
  });

  it('re-sends after 24h so a long-running degradation is not forgotten', () => {
    const prev = { 'github-actions/no-token': T0 };
    expect(noticesToSend(prev, ['github-actions/no-token'], new Date('2026-09-09T00:00:00Z')))
      .toEqual(['github-actions/no-token']);
  });

  it('sends nothing when there is nothing undetermined', () => {
    expect(noticesToSend({}, [], t0)).toEqual([]);
  });
});

describe('nextNoticeState', () => {
  const T0 = '2026-09-08T00:00:00Z';
  const AT = '2026-09-08T06:00:00Z';

  it('stamps sent keys, preserves quiet ones, and drops vanished ones', () => {
    const prev = { 'github-actions/http-4xx': T0, 'github-actions/http-5xx': T0 };
    const next = nextNoticeState(prev, ['github-actions/http-4xx', 'github-actions/no-token'],
      ['github-actions/no-token'], AT);
    expect(next).toEqual({ 'github-actions/http-4xx': T0, 'github-actions/no-token': AT });
  });

  it('does not restart the re-send clock for a key we stayed quiet about', () => {
    // Re-stamping every hour would mean the 24h timer never elapses.
    const prev = { 'github-actions/no-token': T0 };
    expect(nextNoticeState(prev, ['github-actions/no-token'], [], AT))
      .toEqual({ 'github-actions/no-token': T0 });
  });
});

describe('jobsForKeys', () => {
  it('selects only the jobs whose folded key was sent', () => {
    const jobs = [
      undet('a', 'github-actions', 'workflow list unavailable: HTTP 401'),
      undet('b', 'github-actions', 'no GitHub token'),
    ];
    expect(jobsForKeys(jobs, ['github-actions/no-token']).map(j => j.id)).toEqual(['b']);
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

  it('drops an entry for a workflow the user disabled on purpose', () => {
    // Intentionally off is resolved, not frozen: otherwise a run-history failure
    // on the same run carries the old alarm forever, and the next real failure
    // after re-enabling would not read as new.
    const prev = { 'gha|1': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource } };
    const jobs = [mkJob('gha|1', 'github-actions', { state: 'disabled_manually',
      lastRun: { status: 'unknown', fetchedAt: 'x', undeterminedReason: 'HTTP 500' } })];
    expect(carryOverJobs(prev, jobs, avail, new Map(), at)).toEqual({});
  });

  it('does not keep an orphan entry just because the connector is degraded', () => {
    // A degraded connector still emits its jobs, so a missing job really is gone.
    const prev = { 'gha|1': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource } };
    const degraded: Partial<Record<JobSource, Availability>> = { 'github-actions': { state: 'degraded', reason: 'no token' } };
    expect(carryOverJobs(prev, [], degraded, new Map(), at)).toEqual({});
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
    expect(st.notices).toEqual({});
    expect(st.jobs['systemd|x.timer'].source).toBe('systemd');
  });

  it('keeps a launchd entry written without a source field (I6)', async () => {
    const p = join(dir, 'launchd.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1,
      jobs: { 'launchd|com.wharfe.local-schedules.x': { status: 'failure', notifiedAt: 't' } } }), 'utf8');
    expect((await loadNotifyState(p)).jobs['launchd|com.wharfe.local-schedules.x']?.source).toBe('launchd');
  });

  it('drops an entry whose id prefix is not a known connector rather than mislabelling it', async () => {
    const p = join(dir, 'weird.json');
    await writeFile(p, JSON.stringify({ schemaVersion: 1,
      jobs: { 'mystery|x': { status: 'failure', notifiedAt: 't' } } }), 'utf8');
    expect((await loadNotifyState(p)).jobs).toEqual({});
  });
});

describe('failure classes stay distinct', () => {
  it('does not collapse unrelated github-actions failures into one key', () => {
    // Collapsed into `other`, a parse failure arriving while a neutral-run
    // notice already stood was not a new incident and waited up to 24h.
    expect(classifyReason('workflow file could not be read or parsed')).toBe('parse-error');
    expect(classifyReason('run history unavailable: unexpected response shape (run entry)')).toBe('api-shape');
    expect(classifyReason('unexpected workflow state: disabled_fork')).toBe('workflow-state');
    expect(classifyReason('newest scheduled run ended neutral')).toBe('run-conclusion');
    expect(new Set([
      classifyReason('workflow file could not be read or parsed'),
      classifyReason('unexpected workflow state: disabled_fork'),
    ]).size).toBe(2);
  });
});

describe('an undelivered alert must not swallow another job recovery', () => {
  const avail2: Partial<Record<JobSource, Availability>> = { 'github-actions': { state: 'available' } };

  it('drops the recovered job while the undelivered one goes back to pending', () => {
    // The sequence that used to lose an alert permanently: A is recorded as
    // notified; on the run where A recovers, something else cannot be
    // delivered. Skipping the whole save kept A recorded as failing, so A
    // failing again never read as `newly` and was never sent.
    const prev = {
      'gha|A': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource },
      'gha|B': { status: 'failure' as const, notifiedAt: 'old', source: 'github-actions' as JobSource },
    };
    const jobs = [mkJob('gha|A', 'github-actions'), mkJob('gha|B', 'github-actions')];
    const current = new Map([['gha|B', 'failure' as const]]);   // A recovered, B still failing
    const saved = carryOverJobs(prev, jobs, avail2, current, 'now');
    // What cli.ts does when delivery failed: only the alerts it tried to send
    // are put back to pending.
    delete saved['gha|B'];
    expect(saved['gha|A']).toBeUndefined();   // recovery recorded, not frozen
    expect(saved['gha|B']).toBeUndefined();   // stays pending, so it retries
  });
});
