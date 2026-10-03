import { describe, it, expect } from 'vitest';
import { runScan } from './pipeline.js';
import type { Connector, Ctx, Job } from './types.js';

const ctx: Ctx = {
  now: () => new Date('2026-06-12T10:00:00Z'),
  run: async () => ({ stdout: '', stderr: '', code: 0 }),
  readFile: async () => '', glob: async () => [],
  fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: [],
};

const okConn = (id: any, jobs: Job[]): Connector => ({
  id, tier: 0, availability: async () => ({ state: 'available' }), discover: async () => jobs,
});
const j = (id: string): Job => ({ id, source: 'systemd', name: id, target: '', location: '',
  schedule: { raw: 'x', kind: 'cron', nextRunSource: 'computed' } });

describe('runScan', () => {
  it('collects jobs from available connectors and records availability', async () => {
    const failing: Connector = { id: 'crontab', tier: 0,
      availability: async () => ({ state: 'unavailable', reason: 'no crontab' }),
      discover: async () => { throw new Error('should not be called'); } };
    const snap = await runScan([okConn('systemd', [j('a')]), failing], ctx, undefined);
    expect(snap.jobs.map(x => x.id)).toEqual(['a']);
    expect(snap.connectors.systemd?.state).toBe('available');
    expect(snap.connectors.crontab?.state).toBe('unavailable');
  });

  it('isolates a throwing connector without aborting the scan', async () => {
    const boom: Connector = { id: 'cloudflare', tier: 1,
      availability: async () => ({ state: 'available' }),
      discover: async () => { throw new Error('boom'); } };
    const snap = await runScan([okConn('systemd', [j('a')]), boom], ctx, undefined);
    expect(snap.jobs.map(x => x.id)).toEqual(['a']);
    expect(snap.connectors.cloudflare?.state).toBe('unavailable');
  });
});

describe('runScan: degraded connectors', () => {
  it('still discovers from a degraded connector and records the reason', async () => {
    const gha = (id: string): Job => ({ id, source: 'github-actions', name: id, target: '', location: '',
      schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' } });
    const degraded: Connector = { id: 'github-actions', tier: 0,
      availability: async () => ({ state: 'degraded', reason: 'no GitHub token' }),
      discover: async () => [gha('gha-1')] };
    const snap = await runScan([degraded], ctx, undefined);
    expect(snap.jobs.map(x => x.id)).toEqual(['gha-1']);
    expect(snap.connectors['github-actions']?.state).toBe('degraded');
  });
});

describe('runScan: which unavailable came from an exception (wharfe/cronscope#5)', () => {
  const conn = (id: any, over: Partial<Connector>): Connector => ({ ...okConn(id, []), ...over });

  it('marks an availability() that threw', async () => {
    const snap = await runScan([conn('cloudflare', { availability: async () => { throw new Error('boom'); } })], ctx, undefined);
    expect(snap.connectors.cloudflare).toEqual({ state: 'unavailable', reason: 'boom', thrownBy: 'availability' });
  });

  it('marks a discover() that threw', async () => {
    const snap = await runScan([conn('cloudflare', { discover: async () => { throw new Error('boom'); } })], ctx, undefined);
    expect(snap.connectors.cloudflare).toEqual({ state: 'unavailable', reason: 'boom', thrownBy: 'discover' });
  });

  it('marks a degraded connector whose discover() threw', async () => {
    const snap = await runScan([conn('github-actions', {
      availability: async () => ({ state: 'degraded', reason: 'no GitHub token' }),
      discover: async () => { throw new Error('boom'); },
    })], ctx, undefined);
    expect(snap.connectors['github-actions']).toEqual({ state: 'unavailable', reason: 'boom', thrownBy: 'discover' });
  });

  it('leaves a declared unavailable, skipped, degraded or available unmarked', async () => {
    const snap = await runScan([
      conn('crontab', { availability: async () => ({ state: 'unavailable', reason: 'no crontab' }) }),
      conn('cloudflare', { availability: async () => ({ state: 'skipped', reason: 'no token' }) }),
      conn('github-actions', { availability: async () => ({ state: 'degraded', reason: 'no GitHub token' }) }),
      okConn('systemd', []),
    ], ctx, undefined);
    expect(snap.connectors).toEqual({
      crontab: { state: 'unavailable', reason: 'no crontab' },
      cloudflare: { state: 'skipped', reason: 'no token' },
      'github-actions': { state: 'degraded', reason: 'no GitHub token' },
      systemd: { state: 'available' },
    });
  });

  it('drops a marker a connector set on itself', async () => {
    // The type forbids it; this is the runtime half, for a connector that got around the type.
    const snap = await runScan([conn('crontab', {
      availability: async () => ({ state: 'unavailable', reason: 'no crontab', thrownBy: 'availability' }) as any,
    })], ctx, undefined);
    expect(snap.connectors.crontab).toEqual({ state: 'unavailable', reason: 'no crontab' });
  });
});
