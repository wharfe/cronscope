import { describe, it, expect } from 'vitest';
import { systemdConnector, parseSystemdTime } from './systemd.js';
import type { Ctx, RunResult } from '../types.js';

function makeCtx(map: Record<string, RunResult>): Ctx {
  return {
    now: () => new Date('2026-06-12T10:05:00Z'),
    run: async (cmd) => map[cmd.join(' ')] ?? { stdout: '', stderr: 'x', code: 1 },
    readFile: async () => '', glob: async () => [],
    fetch: globalThis.fetch, env: {}, homeDir: '/home/u', scanRoots: [],
  };
}

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', code: 0 });

describe('systemd connector', () => {
  it('is unavailable when the user bus is down', async () => {
    const ctx = makeCtx({}); // every command returns code 1
    expect((await systemdConnector.availability(ctx)).state).toBe('unavailable');
  });

  it('parses a timer + service into a job with last-run status', async () => {
    const ctx = makeCtx({
      'systemctl --user show --property=Version': ok('Version=255'),
      'systemctl --user list-units --type=timer --all --no-legend --plain':
        ok('etl.timer loaded active waiting Run ETL\n'),
      'systemctl --user show etl.timer --property=Unit,NextElapseUSecRealtime':
        ok('Unit=etl.service\nNextElapseUSecRealtime=Fri 2026-06-12 12:00:00 UTC'),
      'systemctl --user show etl.service --property=Result,ExecMainStatus,ExecMainExitTimestamp,ActiveEnterTimestamp':
        ok('Result=success\nExecMainStatus=0\nExecMainExitTimestamp=Fri 2026-06-12 09:11:23 UTC\nActiveEnterTimestamp=Fri 2026-06-12 09:11:19 UTC'),
    });
    expect((await systemdConnector.availability(ctx)).state).toBe('available');
    const jobs = await systemdConnector.discover(ctx);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('systemd|etl.timer');
    expect(jobs[0].schedule.nextRunSource).toBe('source-authoritative');
    expect(jobs[0].lastRun?.status).toBe('success');
    expect(jobs[0].lastRun?.exitCode).toBe(0);
  });

  it('maps Result=failed to failure status', async () => {
    const ctx = makeCtx({
      'systemctl --user show --property=Version': ok('Version=255'),
      'systemctl --user list-units --type=timer --all --no-legend --plain':
        ok('etl.timer loaded active waiting Run ETL\n'),
      'systemctl --user show etl.timer --property=Unit,NextElapseUSecRealtime':
        ok('Unit=etl.service\nNextElapseUSecRealtime=Fri 2026-06-12 12:00:00 UTC'),
      'systemctl --user show etl.service --property=Result,ExecMainStatus,ExecMainExitTimestamp,ActiveEnterTimestamp':
        ok('Result=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=Fri 2026-06-12 09:11:23 UTC\nActiveEnterTimestamp=Fri 2026-06-12 09:11:19 UTC'),
    });
    const jobs = await systemdConnector.discover(ctx);
    expect(jobs[0].lastRun?.status).toBe('failure');
    expect(jobs[0].lastRun?.exitCode).toBe(1);
  });
});

describe('parseSystemdTime', () => {
  it('parses a timezone-abbreviation timestamp (e.g. JST) systemd renders', () => {
    // JS Date cannot parse "... JST" directly; the fallback reads the
    // YYYY-MM-DD HH:MM:SS core as local time. Compare against the same
    // local interpretation so the assertion is runner-timezone-independent.
    const got = parseSystemdTime('Fri 2026-06-12 22:00:00 JST');
    expect(got).toBe(new Date('2026-06-12T22:00:00').toISOString());
  });

  it('still parses UTC and returns undefined for empty', () => {
    expect(parseSystemdTime('Fri 2026-06-12 12:00:00 UTC')).toBe('2026-06-12T12:00:00.000Z');
    expect(parseSystemdTime('')).toBeUndefined();
    expect(parseSystemdTime('n/a')).toBeUndefined();
  });
});
