import { describe, it, expect } from 'vitest';
import { bootAt } from './host.js';
import type { Ctx } from '../types.js';

function ctx(statContent: string): Ctx {
  return {
    now: () => new Date('2026-06-12T10:05:00Z'),
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    readFile: async () => statContent, glob: async () => [],
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: [],
  };
}

describe('host bootAt', () => {
  it('reads btime from /proc/stat', async () => {
    // btime 1749722400 = 2025-06-12T10:00:00Z
    const at = await bootAt(ctx('cpu 1 2 3\nbtime 1749722400\n'));
    expect(at).toBe('2025-06-12T10:00:00.000Z');
  });
  it('returns undefined when btime is absent', async () => {
    expect(await bootAt(ctx('cpu 1 2 3\n'))).toBeUndefined();
  });
});
