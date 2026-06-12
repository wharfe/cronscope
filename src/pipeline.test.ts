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
