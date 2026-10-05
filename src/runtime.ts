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

// Either signal aborts the result. Hand-rolled: AbortSignal.any is Node 20.3+
// and CI still runs Node 18.
export function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const c = new AbortController();
  if (a.aborted || b.aborted) { c.abort(); return c.signal; }
  const on = () => c.abort();
  a.addEventListener('abort', on, { once: true });
  b.addEventListener('abort', on, { once: true });
  return c.signal;
}

// `abort` (check only) stops every fetch and child process this ctx started,
// so a check at its deadline or on a signal can be shown to have stopped
// before it releases the lock.
export function makeCtx(scanRoots: string[], abort?: AbortSignal): Ctx {
  const realFetch = globalThis.fetch;
  return {
    now: () => new Date(),
    async run(cmd) {
      if (!abort) {
        try {
          const { stdout, stderr } = await pexec(cmd[0], cmd.slice(1), { maxBuffer: 10 * 1024 * 1024 });
          return { stdout, stderr, code: 0 };
        } catch (e: any) {
          return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e), code: e.code ?? 1 };
        }
      }
      // Under the check's abort signal: execFile calls back as soon as it has
      // SENT the kill, before the child is gone. Resolve only once the child
      // has closed, so "the check settled" really means its children stopped
      // (a child that ignores SIGTERM keeps the lock held until the grace
      // timer gives up on it -- cli.ts).
      return new Promise((resolve) => {
        const child = execFile(cmd[0], cmd.slice(1), { maxBuffer: 10 * 1024 * 1024, signal: abort }, (e: any, stdout, stderr) => {
          const result = e
            ? { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || String(e), code: typeof e.code === 'number' ? e.code : 1 }
            : { stdout: String(stdout), stderr: String(stderr), code: 0 };
          // Never started (ENOENT and the like): there is nothing to wait for.
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) resolve(result);
          else child.once('close', () => resolve(result));
        });
      });
    },
    readFile: (p) => readFile(p, 'utf8'),
    async glob(pattern, cwd) {
      if (pattern === '**/.github/workflows/*.{yml,yaml}') return workflowFiles(cwd);
      return [];
    },
    fetch: abort
      ? ((url: any, init?: any) => realFetch(url, { ...init, signal: anySignal(init?.signal, abort) })) as typeof fetch
      : realFetch,
    abort,
    env: process.env,
    homeDir: homedir(),
    scanRoots,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    monoMs: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
