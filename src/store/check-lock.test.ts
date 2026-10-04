import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCheckLock, lockHeldLine } from './check-lock.js';

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronscope-lock-')); path = join(dir, 'check.lock'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date('2026-10-04T01:00:00.000Z');

describe('check lock', () => {
  it('lets exactly one holder in, and only the holder releases it', async () => {
    const a = await acquireCheckLock(path, NOW);
    expect(a.ok).toBe(true);
    const b = await acquireCheckLock(path, NOW);
    expect(b.ok).toBe(false);
    expect(readdirSync(dir)).toEqual(['check.lock']);   // no temporary file left behind
    if (a.ok) await a.release();
    expect(existsSync(path)).toBe(false);
    expect((await acquireCheckLock(path, NOW)).ok).toBe(true);
  });

  it('does not remove a lock that now belongs to someone else', async () => {
    const a = await acquireCheckLock(path, NOW);
    writeFileSync(path, JSON.stringify({ pid: 1, acquiredAt: NOW.toISOString(), nonce: 'someone-else' }));
    if (a.ok) await a.release();
    expect(JSON.parse(readFileSync(path, 'utf8')).nonce).toBe('someone-else');
  });

  it('never takes over a lock whose holder is dead, however old (no automatic reclaim)', async () => {
    writeFileSync(path, JSON.stringify({ pid: 999999, acquiredAt: '2026-01-01T00:00:00.000Z', nonce: 'crashed' }));
    const got = await acquireCheckLock(path, NOW, { alive: () => 'no' });
    expect(got).toMatchObject({ ok: false, pid: 999999, alive: 'no', suspect: true });
    expect(JSON.parse(readFileSync(path, 'utf8')).nonce).toBe('crashed');
  });

  it('is not suspect within 2h, suspect beyond it', async () => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: '2026-10-03T23:30:00.000Z', nonce: 'n' }));
    expect(await acquireCheckLock(path, NOW)).toMatchObject({ ok: false, suspect: false, alive: 'yes' });
    writeFileSync(path, JSON.stringify({ pid: process.pid, acquiredAt: '2026-10-03T22:59:00.000Z', nonce: 'n' }));
    expect(await acquireCheckLock(path, NOW)).toMatchObject({ ok: false, suspect: true, alive: 'yes' });
  });

  it('falls back to the file mtime when the lock cannot be parsed', async () => {
    writeFileSync(path, 'garbage');
    utimesSync(path, new Date('2026-10-03T20:00:00Z'), new Date('2026-10-03T20:00:00Z'));
    expect(await acquireCheckLock(path, NOW)).toMatchObject({ ok: false, suspect: true, alive: 'unknown' });
    expect(readFileSync(path, 'utf8')).toBe('garbage');
  });

  it('words the two outcomes as fixed lines that say nothing was changed', () => {
    expect(lockHeldLine({ ok: false, pid: 4, heldMs: 5 * 60_000, alive: 'yes', suspect: false }, 'check'))
      .toBe('# check skipped: another check holds the lock (pid=4, held 5m); nothing was changed');
    expect(lockHeldLine({ ok: false, pid: 4, heldMs: 3 * 3600_000, alive: 'no', suspect: true }, 'check'))
      .toContain('lock held for more than 2h (pid=4, alive=no, held 180m); nothing was changed');
  });
});
