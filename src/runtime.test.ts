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
