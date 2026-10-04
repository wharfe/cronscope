import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from './runtime.js';

describe('runtime glob', () => {
  it('finds GitHub workflow files under hidden .github directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cronscope-glob-'));
    mkdirSync(join(root, 'repo', '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, 'repo', '.github', 'workflows', 'daily.yml'), 'name: daily\n');

    const ctx = makeCtx([root]);
    expect(await ctx.glob('**/.github/workflows/*.{yml,yaml}', root)).toEqual([
      join(root, 'repo', '.github', 'workflows', 'daily.yml'),
    ]);
  });
});

describe('anySignal (Node 18 has no AbortSignal.any)', () => {
  it('aborts when either side aborts', async () => {
    const { anySignal } = await import('./runtime.js');
    const a = new AbortController(); const b = new AbortController();
    const s = anySignal(a.signal, b.signal)!;
    expect(s.aborted).toBe(false);
    b.abort();
    expect(s.aborted).toBe(true);
    expect(anySignal(undefined, a.signal)).toBe(a.signal);
  });

  it('the check ctx passes its abort signal into every fetch', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const real = globalThis.fetch;
    (globalThis as any).fetch = async (_u: string, init: any) => { seen.push(init?.signal); return { ok: true }; };
    try {
      const c = new AbortController();
      const ctx = makeCtx([], c.signal);
      await ctx.fetch('https://example.invalid', { signal: AbortSignal.timeout(10_000) } as any);
      c.abort();
      expect(seen[0]?.aborted).toBe(true);
    } finally { (globalThis as any).fetch = real; }
  });
});
