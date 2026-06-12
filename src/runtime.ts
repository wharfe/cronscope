import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from './types.js';

const pexec = promisify(execFile);

async function workflowFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(path);
      } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) && path.includes('/.github/workflows/')) {
        out.push(path);
      }
    }
  }
  await walk(cwd);
  return out.sort();
}

export function makeCtx(scanRoots: string[]): Ctx {
  return {
    now: () => new Date(),
    async run(cmd) {
      try {
        const { stdout, stderr } = await pexec(cmd[0], cmd.slice(1), { maxBuffer: 10 * 1024 * 1024 });
        return { stdout, stderr, code: 0 };
      } catch (e: any) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e), code: e.code ?? 1 };
      }
    },
    readFile: (p) => readFile(p, 'utf8'),
    async glob(pattern, cwd) {
      if (pattern === '**/.github/workflows/*.{yml,yaml}') return workflowFiles(cwd);
      return [];
    },
    fetch: globalThis.fetch,
    env: process.env,
    homeDir: homedir(),
    scanRoots,
  };
}
