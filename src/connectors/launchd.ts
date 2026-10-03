import type { Connector, DeclaredAvailability, Ctx, Job, LastRun, RunStatus } from '../types.js';

// Reads macOS launchd user agents (~/Library/LaunchAgents/com.wharfe.*.plist).
// Design and its limits: docs/specs/2026-09-26-launchd-connector.md.
//
// The run result comes from the `launchd-run.sh` log lines when the job goes
// through that wrapper: launchctl forgets `last exit code` on every bootstrap
// and reboot, the log does not.

const LOG_TAIL_BYTES = 262144;
// 75: lock contention. 129/130/143: HUP/INT/TERM -- a reinstall (bootout),
// logout or reboot stopped the run. None of them means the job is broken.
const NOT_FAILURE_RC = new Set([75, 129, 130, 143]);
const PARSE_ERROR = 'plist could not be read or parsed';

type CalendarDict = Record<string, number>;

// Longest gap between two fires over one week, taken cyclically so that a
// weekly job (one fire) gets 7 days. Anything but Minute/Hour/Weekday (Day,
// Month, a misspelt key, a non-dict) gets no window (undefined).
const WEEKLY_KEYS = new Set(['Minute', 'Hour', 'Weekday']);
export function calendarMaxGapSeconds(sci: unknown): number | undefined {
  const dicts: unknown[] = Array.isArray(sci) ? sci : [sci];
  const fires = new Set<number>(); // minute of week, Sunday 00:00 = 0
  for (const raw of dicts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const d = raw as CalendarDict;
    if (!Object.entries(d).every(([k, v]) => WEEKLY_KEYS.has(k) && Number.isInteger(v))) return undefined;
    const minutes = d.Minute !== undefined ? [d.Minute] : range(60);
    const hours = d.Hour !== undefined ? [d.Hour] : range(24);
    const days = d.Weekday !== undefined ? [d.Weekday % 7] : range(7);
    for (const w of days) for (const h of hours) for (const m of minutes) fires.add(w * 1440 + h * 60 + m);
  }
  const sorted = [...fires].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  let max = sorted[0] + 7 * 1440 - sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i++) max = Math.max(max, sorted[i] - sorted[i - 1]);
  return max * 60;
}

function range(n: number): number[] { return Array.from({ length: n }, (_, i) => i); }

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// `%z` prints +0900, which is not ISO 8601; make it +09:00 before parsing.
function parseLogTime(s: string): string | undefined {
  const d = new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Not anchored at line start: output without a trailing newline glues the
// wrapper's line onto the job's last line.
export function parseRunLog(text: string, job: string): { startAt?: string; finish?: { rc: number; at?: string } } {
  const j = escapeRe(job);
  const startRe = new RegExp(`launchd-run: ${j} start (\\S+)$`);
  const finishRe = new RegExp(`launchd-run: ${j} finish rc=(\\d+) (\\S+)$`);
  let startAt: string | undefined;
  let finish: { rc: number; at?: string } | undefined;
  for (const line of text.split('\n')) {
    const s = line.match(startRe);
    // A line whose time does not parse (cut by the tail, mangled) is skipped,
    // not allowed to erase the last good value.
    if (s) { startAt = parseLogTime(s[1]) ?? startAt; continue; }
    const f = line.match(finishRe);
    if (f && parseLogTime(f[2])) finish = { rc: Number(f[1]), at: parseLogTime(f[2]) };
  }
  return { startAt, finish };
}

// launchctl answers "not loaded" per label, explicitly: exit 113 and "Could
// not find service". Only that exact answer marks a job stopped (bootout). Any
// other failure to read is not evidence of anything and leaves the job active,
// so a format or permission surprise can never silence real failures.
// (Parsing the `gui/<uid>` service list was tried and dropped: every way that
// parse could misread marked live jobs disabled -- Gate3 rounds 2-3.)
export function isNotLoaded(r: { code: number; stdout: string; stderr: string }): boolean {
  return r.code === 113 && /Could not find service/i.test(r.stderr + r.stdout);
}

export type LaunchctlLast = { kind: 'exit'; rc: number } | { kind: 'never' } | { kind: 'interrupted' } | { kind: 'signal' } | { kind: 'none' };

export function parseLaunchctlLast(stdout: string): LaunchctlLast {
  const sig = stdout.match(/last terminating signal = (.+)/);
  if (sig) return /Hangup|Interrupt|Terminated/.test(sig[1]) ? { kind: 'interrupted' } : { kind: 'signal' };
  const ex = stdout.match(/last exit code = (.+)/);
  if (!ex) return { kind: 'none' };
  if (/never exited/.test(ex[1])) return { kind: 'never' };
  const n = ex[1].match(/^(\d+)/);
  return n ? { kind: 'exit', rc: Number(n[1]) } : { kind: 'none' };
}

function statusOfRc(rc: number): RunStatus {
  if (rc === 0) return 'success';
  return NOT_FAILURE_RC.has(rc) ? 'unknown' : 'failure';
}

async function uid(ctx: Ctx): Promise<string | undefined> {
  const r = await ctx.run(['id', '-u']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

function agentsDir(ctx: Ctx): string {
  return ctx.env.CRONSCOPE_LAUNCHAGENTS_DIR ?? `${ctx.homeDir}/Library/LaunchAgents`;
}

// The id comes from the file name, not the Label, so it stays the same while
// the plist is broken and after it is fixed (notify-state carry-over, I6).
// Without a readable Label we cannot ask launchd whether it is stopped, so a
// broken plist is always reported -- even for an agent that was stopped.
function unreadable(ctx: Ctx, dir: string, file: string): Job {
  const stem = file.replace(/\.plist$/, '');
  return {
    id: `launchd|${stem}`, source: 'launchd', name: stem, location: `${dir}/${file}`, target: '',
    schedule: { raw: '', kind: 'launchd-calendar', nextRunSource: 'unknown' },
    lastRun: { status: 'unknown', fetchedAt: ctx.now().toISOString(), undeterminedReason: PARSE_ERROR },
  };
}

// null: a readable plist with no schedule (not a scheduled job, not our concern).
async function jobOf(ctx: Ctx, dir: string, file: string, domain: string): Promise<Job | null> {
  const path = `${dir}/${file}`;
  const fetchedAt = ctx.now().toISOString();
  const stem = file.replace(/\.plist$/, '');
  const base = { source: 'launchd' as const, location: path, target: '' };
  let plist: any;
  const conv = await ctx.run(['plutil', '-convert', 'json', '-o', '-', path]);
  try { plist = conv.code === 0 ? JSON.parse(conv.stdout) : undefined; } catch { plist = undefined; }
  if (!plist || typeof plist.Label !== 'string') return unreadable(ctx, dir, file);
  const sci = plist.StartCalendarInterval;
  const interval = plist.StartInterval;
  if (sci === undefined && typeof interval !== 'number') return null;
  const label: string = plist.Label;
  const args: string[] = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const jobArg = args.indexOf('--job');
  const jobName = jobArg >= 0 ? args[jobArg + 1] : undefined;
  const sep = args.indexOf('--');
  const target = (sep >= 0 ? args.slice(sep + 1) : args).join(' ');

  const schedule: Job['schedule'] = sci !== undefined
    ? { raw: JSON.stringify(sci), kind: 'launchd-calendar', nextRunSource: 'unknown',
        maxGapSeconds: jobName ? calendarMaxGapSeconds(sci) : undefined }
    : { raw: `every ${interval}s`, kind: 'interval', nextRunSource: 'unknown' };

  let startAt: string | undefined;
  let finish: { rc: number; at?: string } | undefined;
  if (jobName && typeof plist.StandardOutPath === 'string') {
    const t = await ctx.run(['tail', '-c', String(LOG_TAIL_BYTES), plist.StandardOutPath]);
    if (t.code === 0) ({ startAt, finish } = parseRunLog(t.stdout, jobName)); // no log = no lines
  }

  const p = await ctx.run(['launchctl', 'print', `${domain}/${label}`]);
  let lastRun: LastRun;
  if (finish) {
    lastRun = { status: statusOfRc(finish.rc), at: finish.at, exitCode: finish.rc, startedAt: startAt, fetchedAt };
  } else {
    const last = p.code === 0 ? parseLaunchctlLast(p.stdout) : { kind: 'none' as const };
    lastRun =
      last.kind === 'exit' ? { status: statusOfRc(last.rc), exitCode: last.rc, startedAt: startAt, fetchedAt }
      : last.kind === 'signal' ? { status: 'failure', startedAt: startAt, fetchedAt }
      : last.kind === 'interrupted' ? { status: 'unknown', startedAt: startAt, fetchedAt }
      : { status: startAt ? 'unknown' : 'never', startedAt: startAt, fetchedAt };
  }
  // cronscope-check cannot deliver its own failure (the failure may be Slack
  // itself). XPC_SERVICE_NAME covers a renamed label when launchd runs us; the
  // suffix covers a hand-run `check`.
  const self = label === ctx.env.XPC_SERVICE_NAME || /\.cronscope-check$/.test(label);
  if (self && lastRun.status === 'failure') lastRun = { ...lastRun, status: 'unknown' };

  return {
    ...base, id: `launchd|${stem}`, name: label, target, schedule, lastRun,
    state: isNotLoaded(p) ? 'disabled_manually' : 'active',
  };
}

export const launchdConnector: Connector = {
  id: 'launchd',
  tier: 0,
  async availability(ctx): Promise<DeclaredAvailability> {
    const u = await uid(ctx);
    if (!u) return { state: 'unavailable', reason: 'cannot determine uid' };
    const r = await ctx.run(['launchctl', 'print', `gui/${u}`]);
    if (r.code === 0) return { state: 'available' };
    // execFile reports a missing binary as a string code (runtime.ts).
    if (typeof r.code === 'string' || /ENOENT/.test(r.stderr)) return { state: 'unavailable', reason: 'launchctl not found' };
    return { state: 'degraded', reason: 'cannot read the gui launchd domain' };
  },
  async discover(ctx) {
    const u = await uid(ctx);
    if (!u) return [];
    const domain = `gui/${u}`;
    const dir = agentsDir(ctx);
    const ls = await ctx.run(['ls', dir]);
    // Throwing marks the connector unavailable, which keeps notify-state entries
    // (carryOverJobs) instead of reading "zero jobs" as "all recovered".
    if (ls.code !== 0) throw new Error(`cannot list ${dir}`);
    const files = ls.stdout.split('\n').map((s) => s.trim()).filter((f) => /^com\.wharfe\..+\.plist$/.test(f));
    const jobs: Job[] = [];
    for (const f of files) {
      // One bad agent must not take the connector down with it, nor vanish:
      // it is reported as unreadable.
      let job: Job | null;
      try { job = await jobOf(ctx, dir, f, domain); }
      catch { job = unreadable(ctx, dir, f); }
      if (job) jobs.push(job);
    }
    return jobs;
  },
};
