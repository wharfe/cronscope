import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { glob } from 'node:fs/promises';
import type { Ctx } from './types.js';

const pexec = promisify(execFile);

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
      const out: string[] = [];
      for await (const entry of glob(pattern, { cwd })) out.push(`${cwd}/${entry}`);
      return out;
    },
    fetch: globalThis.fetch,
    env: process.env,
    homeDir: homedir(),
    scanRoots,
  };
}
