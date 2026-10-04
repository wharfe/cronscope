import { link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// One `check` (or the freshness release command) at a time. It covers the
// whole read -> fetch/judge -> notify -> save cycle of both state files.
//
// There is deliberately NO stale-lock recovery: a lock is never taken over,
// not by age and not by pid. Moving a live lock aside to inspect it lets a
// third process in, and putting it back afterwards does not undo that. A lock
// left by a crash stays until a person confirms its holder is gone and
// removes the file (README). Every failure to acquire writes nothing.
//
// The pid's liveness is reported in the log as a hint for that person; it
// is never used to decide anything.

export const LOCK_SUSPECT_AFTER_MS = 2 * 60 * 60 * 1000;   // provisional (D2/D3)

export interface LockOwner { pid: number; acquiredAt: string; nonce: string }

export type Acquired =
  | { ok: true; owner: LockOwner; release: () => Promise<void> }
  | { ok: false; heldMs?: number; pid?: number; alive: 'yes' | 'no' | 'unknown'; suspect: boolean };

function pidAlive(pid: number | undefined): 'yes' | 'no' | 'unknown' {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'yes'; }
  catch (e: any) { return e?.code === 'ESRCH' ? 'no' : e?.code === 'EPERM' ? 'yes' : 'unknown'; }
}

export async function acquireCheckLock(path: string, now: Date, deps: { pid?: number; alive?: (pid?: number) => 'yes' | 'no' | 'unknown' } = {}): Promise<Acquired> {
  const owner: LockOwner = { pid: deps.pid ?? process.pid, acquiredAt: now.toISOString(), nonce: randomBytes(12).toString('hex') };
  await mkdir(dirname(path), { recursive: true });
  // Written in full BEFORE it becomes the lock: link() either installs the
  // finished file or fails with EEXIST, so no half-written lock can exist.
  const tmp = `${path}.new-${owner.pid}-${owner.nonce}`;
  const fh = await open(tmp, 'wx', 0o600);
  try { await fh.writeFile(JSON.stringify(owner), 'utf8'); await fh.sync(); } finally { await fh.close(); }
  try {
    await link(tmp, path);
  } catch (e: any) {
    await unlink(tmp).catch(() => {});
    if (e?.code !== 'EEXIST') throw e;
    return describeHeld(path, now, deps.alive ?? pidAlive);
  }
  await unlink(tmp).catch(() => {});
  return {
    ok: true, owner,
    // Removes the lock only while it still carries our nonce.
    release: async () => {
      try {
        const cur = JSON.parse(await readFile(path, 'utf8'));
        if (cur?.nonce === owner.nonce) await unlink(path);
      } catch { /* gone or unreadable: not ours to remove */ }
    },
  };
}

async function describeHeld(path: string, now: Date, alive: (pid?: number) => 'yes' | 'no' | 'unknown'): Promise<Acquired> {
  let pid: number | undefined;
  let since: number | undefined;
  try {
    const cur = JSON.parse(await readFile(path, 'utf8'));
    if (Number.isInteger(cur?.pid)) pid = cur.pid;
    const t = new Date(cur?.acquiredAt).getTime();
    if (!isNaN(t)) since = t;
  } catch { /* unreadable: fall back to the file's mtime below */ }
  if (since === undefined) {
    try { since = (await stat(path)).mtimeMs; } catch { /* vanished meanwhile */ }
  }
  const heldMs = since === undefined ? undefined : Math.max(0, now.getTime() - since);
  return { ok: false, pid, heldMs, alive: alive(pid), suspect: heldMs !== undefined && heldMs > LOCK_SUSPECT_AFTER_MS };
}

// Fixed wording: these lines go to stdout (the launchd log), nowhere else.
export function lockHeldLine(a: Extract<Acquired, { ok: false }>, what: string): string {
  const held = a.heldMs === undefined ? '?' : `${Math.floor(a.heldMs / 60_000)}m`;
  return a.suspect
    ? `# ${what} lock held for more than 2h (pid=${a.pid ?? '?'}, alive=${a.alive}, held ${held}); nothing was changed. If that process is gone, remove ~/.config/cronscope/check.lock by hand (README)`
    : `# ${what} skipped: another check holds the lock (pid=${a.pid ?? '?'}, held ${held}); nothing was changed`;
}
