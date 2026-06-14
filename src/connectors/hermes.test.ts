import { describe, it, expect } from 'vitest';
import { hermesConnector } from './hermes.js';
import type { Ctx } from '../types.js';

const NOW = '2026-06-14T10:00:00.000Z';
// jobs.json container shape confirmed against the real file: { jobs: [...], updated_at }.
function ctxWith(jobsJson: string | null): Ctx {
  return {
    now: () => new Date(NOW),
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    readFile: async (p: string) => {
      if (p.endsWith('/.hermes/cron/jobs.json')) {
        if (jobsJson === null) throw new Error('ENOENT');
        return jobsJson;
      }
      return '';
    },
    glob: async () => [],
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: [],
  };
}

// Mirrors a real Hermes --no-agent record (extra fields included to prove we ignore them).
const SUCCESS_REC = {
  id: 'abc123', name: 'cronscope-demo',
  prompt: 'SECRET PROMPT', skills: ['x'], script: 'cronscope-demo.sh', no_agent: true,
  schedule: { kind: 'cron', expr: '*/10 * * * *', display: '*/10 * * * *' },
  enabled: true, state: 'scheduled',
  next_run_at: '2026-06-14T10:10:00Z', last_run_at: '2026-06-14T09:50:00Z',
  last_status: 'ok', last_error: null,
  deliver: 'telegram:-1009999', model: null, provider: null,
};
const wrap = (recs: unknown[]) => JSON.stringify({ jobs: recs, updated_at: NOW });

describe('hermes connector', () => {
  it('is unavailable when jobs.json is missing', async () => {
    const a = await hermesConnector.availability(ctxWith(null));
    expect(a.state).toBe('unavailable');
  });

  it('maps a cron job: authoritative nextRun, success, script target, no prompt/deliver leak', async () => {
    const ctx = ctxWith(wrap([SUCCESS_REC]));
    expect((await hermesConnector.availability(ctx)).state).toBe('available');
    const jobs = await hermesConnector.discover(ctx);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.id).toBe('hermes|abc123');
    expect(j.source).toBe('hermes');
    expect(j.schedule.kind).toBe('cron');
    expect(j.schedule.raw).toBe('*/10 * * * *');
    expect(j.schedule.nextRun).toBe('2026-06-14T10:10:00Z');
    expect(j.schedule.nextRunSource).toBe('source-authoritative');
    expect(j.lastRun?.status).toBe('success');
    expect(j.lastRun?.at).toBe('2026-06-14T09:50:00Z');
    expect(j.target).toContain('cronscope-demo.sh');
    // privacy: prompt / deliver / skills must not appear anywhere on the Job
    expect(JSON.stringify(j)).not.toContain('SECRET PROMPT');
    expect(JSON.stringify(j)).not.toContain('telegram');
  });

  it('maps last_status "error" to failure (real Hermes failure value)', async () => {
    const rec = { ...SUCCESS_REC, id: 'f1', last_status: 'error' };
    const jobs = await hermesConnector.discover(ctxWith(wrap([rec])));
    expect(jobs[0].lastRun?.status).toBe('failure');
  });

  it('never-run job has status never; unknown last_status is unknown (not success)', async () => {
    const never = { ...SUCCESS_REC, id: 'n1', last_run_at: null, last_status: null };
    const weird = { ...SUCCESS_REC, id: 'w1', last_status: 'mystery' };
    const jobs = await hermesConnector.discover(ctxWith(wrap([never, weird])));
    const byId = Object.fromEntries(jobs.map(j => [j.id, j]));
    expect(byId['hermes|n1'].lastRun?.status).toBe('never');
    expect(byId['hermes|w1'].lastRun?.status).toBe('unknown');
  });

  it('interval schedule -> kind interval, still authoritative nextRun', async () => {
    const rec = { ...SUCCESS_REC, id: 'i1', schedule: { kind: 'interval', display: 'every 2h' } };
    const j = (await hermesConnector.discover(ctxWith(wrap([rec]))))[0];
    expect(j.schedule.kind).toBe('interval');
    expect(j.schedule.raw).toBe('every 2h');
    expect(j.schedule.nextRunSource).toBe('source-authoritative');
  });

  it('disabled (enabled:false) job: listed but no nextRun (overdue-exempt)', async () => {
    const rec = { ...SUCCESS_REC, id: 'd1', enabled: false };
    const j = (await hermesConnector.discover(ctxWith(wrap([rec]))))[0];
    expect(j.schedule.nextRun).toBeUndefined();
    expect(j.schedule.nextRunSource).toBe('unknown');
  });

  it('per-record isolation: one malformed record does not drop the others', async () => {
    const bad = { name: 'no-id' }; // missing id
    const jobs = await hermesConnector.discover(ctxWith(wrap([bad, SUCCESS_REC])));
    expect(jobs.map(j => j.id)).toEqual(['hermes|abc123']);
  });

  it('broken jobs.json returns [] (does not throw)', async () => {
    const jobs = await hermesConnector.discover(ctxWith('{not json'));
    expect(jobs).toEqual([]);
  });
});
