import { describe, it, expect } from 'vitest';
import { readCronFires, cronCommandLogKey } from './cron-log.js';
import type { Ctx } from '../types.js';

function ctx(over: Partial<Ctx>): Ctx {
  return {
    now: () => new Date('2026-06-14T10:00:00Z'),
    run: async () => ({ stdout: '', stderr: '', code: 1 }),
    readFile: async () => { throw new Error('ENOENT'); },
    glob: async () => [], fetch: globalThis.fetch, env: {},
    homeDir: '/home/u', scanRoots: [], timezone: 'UTC',
    ...over,
  };
}
// derive epoch microseconds from an ISO string so fixtures stay self-consistent
const usecOf = (iso: string) => String(Date.parse(iso) * 1000);
const jline = (iso: string, msg: string) => JSON.stringify({ __REALTIME_TIMESTAMP: usecOf(iso), MESSAGE: msg });

describe('cronCommandLogKey', () => {
  it('splits at first unescaped % and unescapes \\%', () => {
    expect(cronCommandLogKey('/bin/foo arg')).toBe('/bin/foo arg');
    expect(cronCommandLogKey('/bin/foo % stdin')).toBe('/bin/foo');
    expect(cronCommandLogKey('/bin/foo 50\\% off')).toBe('/bin/foo 50% off');
  });
});

describe('readCronFires (journalctl json)', () => {
  it('parses CMD lines, keeps latest per command, sets observableSince', async () => {
    // 1718... micro = 2024; use 2026 epochs. 2026-06-14T09:50:00Z = 1781344200 s
    const out = [
      jline('2026-06-14T09:50:00Z', '(u) CMD (/usr/bin/job-a)'),          // latest job-a
      jline('2026-06-14T08:50:00Z', '(u) CMD (/usr/bin/job-a)'),          // older job-a
      jline('2026-06-14T08:40:00Z', '(u) pam_unix(cron:session): opened'),// non-CMD, earliest line
      jline('2026-06-14T09:51:00Z', '(u) CMD (/usr/bin/job-b % x)'),      // job-b, key split at %
    ].join('\n');
    const c = ctx({ run: async (cmd) => cmd[0] === 'journalctl' ? { stdout: out, stderr: '', code: 0 } : { stdout:'', stderr:'', code:1 } });
    const r = await readCronFires(c);
    expect(r.available).toBe(true);
    expect(r.lastFireByCommand.get('/usr/bin/job-a')).toBe('2026-06-14T09:50:00.000Z'); // latest
    expect(r.lastFireByCommand.get('/usr/bin/job-b')).toBe('2026-06-14T09:51:00.000Z'); // key split at %
    expect(r.observableSince).toBe('2026-06-14T08:40:00.000Z'); // earliest line
  });
});

describe('readCronFires (syslog fallback + year rollover)', () => {
  it('falls back to syslog and corrects Dec/Jan rollover', async () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const syslog = [
      'Jan  1 09:00:00 h CRON[1]: (u) CMD (/usr/bin/jan-job)',
      'Dec 31 09:00:00 h CRON[2]: (u) CMD (/usr/bin/dec-job)', // last year, must NOT be future
    ].join('\n');
    const c = ctx({ now: () => now, run: async () => ({ stdout:'', stderr:'', code:1 }), readFile: async (p) => p === '/var/log/syslog' ? syslog : (()=>{throw new Error('x')})() });
    const r = await readCronFires(c);
    expect(r.available).toBe(true);
    expect(new Date(r.lastFireByCommand.get('/usr/bin/dec-job')!).getTime()).toBeLessThan(now.getTime());
    expect(r.lastFireByCommand.has('/usr/bin/jan-job')).toBe(true);
  });
});

describe('readCronFires (degrade)', () => {
  it('returns available:false when neither source is readable', async () => {
    const r = await readCronFires(ctx({}));
    expect(r.available).toBe(false);
    expect(r.lastFireByCommand.size).toBe(0);
  });
});
