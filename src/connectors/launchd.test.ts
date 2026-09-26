import { describe, it, expect } from 'vitest';
import {
  launchdConnector, calendarMaxGapSeconds, parseRunLog, isNotLoaded, parseLaunchctlLast,
} from './launchd.js';
import type { Ctx, RunResult } from '../types.js';

const ok = (stdout: string): RunResult => ({ stdout, stderr: '', code: 0 });
const fail = (code: number | string, stderr = ''): RunResult => ({ stdout: '', stderr, code: code as number });

const DIR = '/Users/u/Library/LaunchAgents';
const P = 'com.wharfe.local-schedules.';

function makeCtx(map: Record<string, RunResult>, env: Record<string, string> = {}): Ctx {
  return {
    now: () => new Date('2026-09-26T06:00:00Z'),
    run: async (cmd) => map[cmd.join(' ')] ?? fail(1, 'not mapped'),
    readFile: async () => '', glob: async () => [],
    fetch: globalThis.fetch, env: { CRONSCOPE_LAUNCHAGENTS_DIR: DIR, ...env }, homeDir: '/Users/u', scanRoots: [],
  };
}

// Real plist (claude-hours-rollup, converted with `plutil -convert json`), trimmed of env.
const hoursRollup = {
  Label: `${P}claude-hours-rollup`,
  StandardOutPath: '/Users/u/Library/Logs/local-schedules/claude-hours-rollup.log',
  StartCalendarInterval: { Hour: 10, Minute: 0, Weekday: 1 },
  ProgramArguments: ['/opt/homebrew/bin/bash', '/x/launchd-run.sh', '--job', 'claude-hours-rollup', '--timeout', '600', '--', '/x/claude-hours-rollup.py'],
};
const etl = {
  Label: `${P}my-mcp-server-daily-metrics-etl`,
  StandardOutPath: '/Users/u/Library/Logs/local-schedules/etl.log',
  StartCalendarInterval: { Hour: 9, Minute: 10 },
  ProgramArguments: ['/opt/homebrew/bin/bash', '/x/launchd-run.sh', '--job', 'my-mcp-server-daily-metrics-etl', '--', 'x'],
};
const clipper = {
  Label: 'com.wharfe.obsidian-url-clipper.sync',
  StandardOutPath: '/Users/u/Library/Logs/obsidian-url-clipper-sync.log',
  StartInterval: 300,
  ProgramArguments: ['/bin/bash', '/x/remote-sync.sh'],
};
// Real ETL log lines from 2026-09-26: two failures, then a success.
const ETL_LOG = [
  'launchd-run: my-mcp-server-daily-metrics-etl start 2026-09-26T13:02:41+0900',
  'some job output',
  'launchd-run: my-mcp-server-daily-metrics-etl finish rc=1 2026-09-26T13:06:03+0900',
  'launchd-run: my-mcp-server-daily-metrics-etl start 2026-09-26T13:15:11+0900',
  'launchd-run: my-mcp-server-daily-metrics-etl finish rc=1 2026-09-26T13:18:57+0900',
  'launchd-run: my-mcp-server-daily-metrics-etl start 2026-09-26T13:24:07+0900',
  'launchd-run: my-mcp-server-daily-metrics-etl finish rc=0 2026-09-26T13:27:00+0900',
].join('\n');

// Real shape of `launchctl print gui/501/<label>` for a label that is not loaded.
const NOT_LOADED = (l: string): RunResult => ({ stdout: '', stderr: `Bad request.\nCould not find service "${l}" in domain for user gui: 501\n`, code: 113 });

function world(plists: Record<string, object>, logs: Record<string, string>, loaded = Object.values(plists).map((p: any) => p.Label)) {
  const map: Record<string, RunResult> = {
    'id -u': ok('501\n'),
    'launchctl print gui/501': ok('gui/501 = {\n}\n'),
    // Files are named after their label; a non-com.wharfe plist must be ignored.
    [`ls ${DIR}`]: ok(Object.values(plists).map((p: any) => `${p.Label}.plist`).join('\n') + '\ncom.apple.other.plist\n'),
  };
  for (const p of Object.values(plists) as any[]) {
    map[`plutil -convert json -o - ${DIR}/${p.Label}.plist`] = ok(JSON.stringify(p));
    map[`launchctl print gui/501/${p.Label}`] = loaded.includes(p.Label) ? ok('\tstate = not running\n') : NOT_LOADED(p.Label);
  }
  for (const [path, text] of Object.entries(logs)) map[`tail -c 262144 ${path}`] = ok(text);
  return map;
}

describe('calendarMaxGapSeconds', () => {
  it('weekly job with a single fire -> 7 days (cyclic gap, not -Infinity)', () => {
    expect(calendarMaxGapSeconds({ Hour: 10, Minute: 0, Weekday: 1 })).toBe(7 * 86400);
  });
  it('daily job -> 1 day', () => {
    expect(calendarMaxGapSeconds({ Hour: 9, Minute: 10 })).toBe(86400);
  });
  it('array of dicts (trend-news every 2h) -> 2 hours', () => {
    const d = Array.from({ length: 12 }, (_, i) => ({ Hour: i * 2, Minute: 0 }));
    expect(calendarMaxGapSeconds(d)).toBe(2 * 3600);
  });
  it('missing Hour = every hour', () => {
    expect(calendarMaxGapSeconds({ Minute: 17 })).toBe(3600);
  });
  it('missing Minute = every minute', () => {
    expect(calendarMaxGapSeconds({ Hour: 3 })).toBe(23 * 3600 + 60);
  });
  it('Weekday 0 and 7 are both Sunday', () => {
    expect(calendarMaxGapSeconds([{ Weekday: 0, Hour: 0, Minute: 0 }, { Weekday: 7, Hour: 0, Minute: 0 }])).toBe(7 * 86400);
  });
  it('Day or Month keys are not supported -> undefined (no stale check)', () => {
    expect(calendarMaxGapSeconds({ Day: 1, Hour: 0, Minute: 0 })).toBeUndefined();
  });
  it('a misspelt key or a non-dict entry gets no window instead of a bogus one', () => {
    expect(calendarMaxGapSeconds({ Hour: 9, Minutes: 10 })).toBeUndefined();
    expect(calendarMaxGapSeconds([5])).toBeUndefined();
  });
});

describe('parseRunLog', () => {
  it('takes the last finish and the last start by line order', () => {
    const r = parseRunLog(ETL_LOG, 'my-mcp-server-daily-metrics-etl');
    expect(r.finish).toEqual({ rc: 0, at: '2026-09-26T04:27:00.000Z' });
    expect(r.startAt).toBe('2026-09-26T04:24:07.000Z');
  });
  it('finds a finish line glued to output without a trailing newline', () => {
    const r = parseRunLog('partial outputlaunchd-run: j finish rc=1 2026-09-26T13:00:00+0900', 'j');
    expect(r.finish?.rc).toBe(1);
  });
  it('finds a start line glued to the previous run output', () => {
    const r = parseRunLog('previous outputlaunchd-run: j start 2026-09-26T13:00:00+0900', 'j');
    expect(r.startAt).toBe('2026-09-26T04:00:00.000Z');
  });
  it('a start line with an unreadable time does not erase the last good start', () => {
    const r = parseRunLog('launchd-run: j start 2026-09-26T13:00:00+0900\nlaunchd-run: j start garbage', 'j');
    expect(r.startAt).toBe('2026-09-26T04:00:00.000Z');
  });
  it('ignores lines of another job whose name only shares a prefix', () => {
    const r = parseRunLog('launchd-run: j2 finish rc=1 2026-09-26T13:00:00+0900', 'j');
    expect(r.finish).toBeUndefined();
  });
});

describe('isNotLoaded / parseLaunchctlLast', () => {
  it('only the explicit 113 + "Could not find service" answer means not loaded', () => {
    expect(isNotLoaded(NOT_LOADED('a.b'))).toBe(true);
    expect(isNotLoaded({ stdout: '', stderr: 'Could not find service', code: 1 })).toBe(false);
    expect(isNotLoaded({ stdout: '', stderr: 'Operation not permitted', code: 113 })).toBe(false);
    expect(isNotLoaded(ok('\tstate = running\n'))).toBe(false);
  });
  it('reads the leading integer of last exit code', () => {
    expect(parseLaunchctlLast('\tlast exit code = 78: EX_CONFIG\n')).toEqual({ kind: 'exit', rc: 78 });
    expect(parseLaunchctlLast('\tlast exit code = (never exited)\n')).toEqual({ kind: 'never' });
    expect(parseLaunchctlLast('\tlast terminating signal = Terminated: 15\n')).toEqual({ kind: 'interrupted' });
    expect(parseLaunchctlLast('\tlast terminating signal = Killed: 9\n')).toEqual({ kind: 'signal' });
  });
});

describe('launchd connector', () => {
  it('is unavailable where launchctl does not exist (Linux)', async () => {
    const ctx = makeCtx({ 'id -u': ok('1000\n'), 'launchctl print gui/1000': fail('ENOENT', 'spawn launchctl ENOENT') });
    expect((await launchdConnector.availability(ctx)).state).toBe('unavailable');
  });
  it('is degraded, not available, when the gui domain cannot be read', async () => {
    const ctx = makeCtx({ 'id -u': ok('501\n'), 'launchctl print gui/501': fail(113, 'Could not find domain') });
    expect((await launchdConnector.availability(ctx)).state).toBe('degraded');
  });

  it('I1: last finish rc=1 is a failure; id carries no schedule', async () => {
    const log = ETL_LOG.split('\n').slice(0, 5).join('\n');
    const ctx = makeCtx(world({ 'etl.plist': etl }, { [etl.StandardOutPath]: log }));
    const [job] = await launchdConnector.discover(ctx);
    expect(job.id).toBe(`launchd|${etl.Label}`);
    expect(job.lastRun?.status).toBe('failure');
    expect(job.lastRun?.exitCode).toBe(1);
  });

  it('I2: a job running now keeps the previous finish', async () => {
    const log = ETL_LOG.split('\n').slice(0, 6).join('\n'); // started 13:24, not finished
    const ctx = makeCtx(world({ 'etl.plist': etl }, { [etl.StandardOutPath]: log }));
    const [job] = await launchdConnector.discover(ctx);
    expect(job.lastRun?.status).toBe('failure');
    expect(job.lastRun?.startedAt).toBe('2026-09-26T04:24:07.000Z');
  });

  it('I2: interrupted (143) and lock contention (75) are not failures', async () => {
    for (const rc of [75, 129, 130, 143]) {
      const log = `launchd-run: my-mcp-server-daily-metrics-etl finish rc=${rc} 2026-09-26T13:27:00+0900`;
      const ctx = makeCtx(world({ 'etl.plist': etl }, { [etl.StandardOutPath]: log }));
      const [job] = await launchdConnector.discover(ctx);
      expect(job.lastRun?.status).not.toBe('failure');
      expect(job.lastRun?.exitCode).toBe(rc);
    }
  });

  it('I2: a bootout job is disabled_manually even if its log ends in failure', async () => {
    const log = 'launchd-run: my-mcp-server-daily-metrics-etl finish rc=1 2026-09-26T13:27:00+0900';
    const ctx = makeCtx(world({ 'etl.plist': etl }, { [etl.StandardOutPath]: log }, []));
    const [job] = await launchdConnector.discover(ctx);
    expect(job.state).toBe('disabled_manually');
  });

  it('I2: no log file falls back to launchctl and never ran -> never, no undeterminedReason', async () => {
    const map = world({ 'r.plist': hoursRollup }, {});
    map[`launchctl print gui/501/${hoursRollup.Label}`] = ok('\truns = 0\n\tlast exit code = (never exited)\n');
    const [job] = await launchdConnector.discover(makeCtx(map));
    expect(job.lastRun?.status).toBe('never');
    expect(job.lastRun?.undeterminedReason).toBeUndefined();
  });

  it('I2: cronscope-check itself is never a failure when it is the running label', async () => {
    const self = { ...etl, Label: `${P}cronscope-check`, ProgramArguments: ['bash', 'x', '--job', 'cronscope-check'] };
    const log = 'launchd-run: cronscope-check finish rc=1 2026-09-26T13:17:00+0900';
    const ctx = makeCtx(world({ 'c.plist': self }, { [self.StandardOutPath]: log }), { XPC_SERVICE_NAME: self.Label });
    const [job] = await launchdConnector.discover(ctx);
    expect(job.lastRun?.status).not.toBe('failure');
  });

  it('I2: cronscope-check is recognised by its label when run by hand (no XPC_SERVICE_NAME)', async () => {
    const self = { ...etl, Label: `${P}cronscope-check`, ProgramArguments: ['bash', 'x', '--job', 'cronscope-check'] };
    const log = 'launchd-run: cronscope-check finish rc=1 2026-09-26T13:17:00+0900';
    const [job] = await launchdConnector.discover(makeCtx(world({ c: self }, { [self.StandardOutPath]: log })));
    expect(job.lastRun?.status).not.toBe('failure');
  });

  it('I1/I2: a killing signal from launchctl is a failure, TERM is not', async () => {
    for (const [line, failure] of [['Killed: 9', true], ['Terminated: 15', false]] as const) {
      const map = world({ o: clipper }, {});
      map[`launchctl print gui/501/${clipper.Label}`] = ok(`\tlast terminating signal = ${line}\n`);
      const [job] = await launchdConnector.discover(makeCtx(map));
      expect(job.lastRun?.status === 'failure').toBe(failure);
    }
  });

  it('I3: a calendar job without --job gets no stale window', async () => {
    const bare = { ...etl, ProgramArguments: ['/bin/bash', '/x/run.sh'] };
    const map = world({ b: bare }, {});
    map[`launchctl print gui/501/${bare.Label}`] = ok('\tlast exit code = 0\n');
    const [job] = await launchdConnector.discover(makeCtx(map));
    expect(job.schedule.maxGapSeconds).toBeUndefined();
  });

  it('an agent with no schedule is not a job', async () => {
    const daemon = { Label: 'com.wharfe.daemon', ProgramArguments: ['/x'], KeepAlive: true };
    expect(await launchdConnector.discover(makeCtx(world({ d: daemon }, {})))).toEqual([]);
  });

  it('I4: an unlistable LaunchAgents dir throws (connector unavailable, notify-state kept)', async () => {
    const map = world({}, {});
    map[`ls ${DIR}`] = fail(1, 'Operation not permitted');
    await expect(launchdConnector.discover(makeCtx(map))).rejects.toThrow(/cannot list/);
  });

  it('I4: an agent whose processing throws is reported as unreadable, not dropped', async () => {
    const map = world({ e: etl }, {});
    const ctx = makeCtx(map);
    const run = ctx.run;
    ctx.run = async (cmd) => { if (cmd[0] === 'tail') throw new Error('boom'); return run(cmd); };
    const [job] = await launchdConnector.discover(ctx);
    expect(job.id).toBe(`launchd|${etl.Label}`);
    expect(job.lastRun?.undeterminedReason).toMatch(/could not be read or parsed/);
  });

  it('I2: a launchctl failure other than "not loaded" leaves the job active and its failure reported', async () => {
    const log = 'launchd-run: my-mcp-server-daily-metrics-etl finish rc=1 2026-09-26T13:27:00+0900';
    const map = world({ e: etl }, { [etl.StandardOutPath]: log });
    map[`launchctl print gui/501/${etl.Label}`] = fail(1, 'Operation not permitted');
    const [job] = await launchdConnector.discover(makeCtx(map));
    expect(job.state).toBe('active');
    expect(job.lastRun?.status).toBe('failure');
  });

  it('a broken plist is reported even if the agent may be stopped (its label is unknown)', async () => {
    const map = world({ e: etl }, {}, []);
    map[`plutil -convert json -o - ${DIR}/${etl.Label}.plist`] = fail(1, 'bad plist');
    const [job] = await launchdConnector.discover(makeCtx(map));
    expect(job.state).not.toBe('disabled_manually');
    expect(job.lastRun?.undeterminedReason).toMatch(/could not be read or parsed/);
  });

  it('I6: the id comes from the file name, so a broken plist keeps it', async () => {
    const map = world({ e: etl }, {});
    map[`plutil -convert json -o - ${DIR}/${etl.Label}.plist`] = fail(1, 'bad plist');
    const [broken] = await launchdConnector.discover(makeCtx(map));
    expect(broken.id).toBe(`launchd|${etl.Label}`);
  });

  it('I6: a plist whose Label differs from its file name keeps one id when it breaks', async () => {
    const file = 'com.wharfe.renamed.plist';
    const map = world({}, {});
    map[`ls ${DIR}`] = ok(`${file}\n`);
    map[`plutil -convert json -o - ${DIR}/${file}`] = ok(JSON.stringify(etl));
    map[`launchctl print gui/501/${etl.Label}`] = ok('\tlast exit code = 0\n');
    const [fine] = await launchdConnector.discover(makeCtx(map));
    map[`plutil -convert json -o - ${DIR}/${file}`] = fail(1, 'bad plist');
    const [broken] = await launchdConnector.discover(makeCtx(map));
    expect(fine.id).toBe(broken.id);
  });

  it('I3: StartInterval and --job-less jobs get no stale window; results come from launchctl', async () => {
    const map = world({ 'o.plist': clipper }, {});
    map[`launchctl print gui/501/${clipper.Label}`] = ok('\tlast exit code = 1\n');
    const [job] = await launchdConnector.discover(makeCtx(map));
    expect(job.schedule.maxGapSeconds).toBeUndefined();
    expect(job.lastRun?.status).toBe('failure');
  });

  it('I3: calendar job with --job gets max gap and start time', async () => {
    const log = 'launchd-run: claude-hours-rollup start 2026-09-26T13:02:09+0900\nlaunchd-run: claude-hours-rollup finish rc=0 2026-09-26T13:02:09+0900';
    const ctx = makeCtx(world({ 'r.plist': hoursRollup }, { [hoursRollup.StandardOutPath]: log }));
    const [job] = await launchdConnector.discover(ctx);
    expect(job.schedule.maxGapSeconds).toBe(7 * 86400);
    expect(job.lastRun?.status).toBe('success');
    expect(job.lastRun?.startedAt).toBe('2026-09-26T04:02:09.000Z');
  });

  it('I4: one unparsable plist does not drop the others', async () => {
    const map = world({ 'etl.plist': etl }, { [etl.StandardOutPath]: ETL_LOG });
    map[`ls ${DIR}`] = ok(`${etl.Label}.plist\ncom.wharfe.broken.plist\n`);
    map[`plutil -convert json -o - ${DIR}/com.wharfe.broken.plist`] = fail(1, 'bad plist');
    const jobs = await launchdConnector.discover(makeCtx(map));
    expect(jobs.map((j) => j.lastRun?.status)).toContain('success');
    const broken = jobs.find((j) => j.name.includes('broken'));
    expect(broken?.lastRun?.undeterminedReason).toMatch(/could not be read or parsed/);
  });
});
