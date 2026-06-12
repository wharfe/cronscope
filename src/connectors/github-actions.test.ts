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
});
