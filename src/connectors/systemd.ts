import type { Connector, Ctx, Job, LastRun, RunStatus } from '../types.js';

function parseProps(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

export function parseSystemdTime(v: string | undefined): string | undefined {
  if (!v || v === 'n/a' || v === '') return undefined;
  // Direct parse handles ISO and tz tokens JS understands (UTC/GMT).
  const direct = new Date(v);
  if (!isNaN(direct.getTime())) return direct.toISOString();
  // `systemctl show` renders timestamps like "Fri 2026-06-12 22:00:00 JST"
  // with a timezone abbreviation that JS Date cannot parse. Extract the
  // "YYYY-MM-DD HH:MM:SS" core and interpret it in the local timezone — the
  // cronscope process shares the host TZ that systemd used to render it.
  const m = v.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return undefined;
  const local = new Date(`${m[1]}T${m[2]}`);
  return isNaN(local.getTime()) ? undefined : local.toISOString();
}

function mapStatus(result: string | undefined, lastAt: string | undefined, lastTriggerAt?: string): RunStatus {
  if (!lastAt && lastTriggerAt) return 'unknown';
  if (!lastAt) return 'never';
  if (result === undefined) return 'unknown';
  return result === 'success' ? 'success' : 'failure';
}

function parseTimerUnits(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((unit) => unit?.endsWith('.timer'));
}

export const systemdConnector: Connector = {
  id: 'systemd',
  tier: 0,
  async availability(ctx) {
    const probe = await ctx.run(['systemctl', '--user', 'show', '--property=Version']);
    if (probe.code !== 0) return { state: 'unavailable', reason: 'systemd user manager not running' };
    return { state: 'available' };
  },
  async discover(ctx) {
    const list = await ctx.run(['systemctl', '--user', 'list-units', '--type=timer', '--all', '--no-legend', '--plain']);
    if (list.code !== 0) return [];
    const timers = parseTimerUnits(list.stdout);
    const jobs: Job[] = [];
    for (const timerUnit of timers) {
      const tShow = await ctx.run(['systemctl', '--user', 'show', timerUnit, '--property=Unit,NextElapseUSecRealtime,LastTriggerUSec']);
      const tp = parseProps(tShow.stdout);
      const service = tp['Unit'];
      const nextRun = parseSystemdTime(tp['NextElapseUSecRealtime']);
      const lastTriggerAt = parseSystemdTime(tp['LastTriggerUSec']);
      let lastRun: LastRun;
      if (service) {
        const sShow = await ctx.run(['systemctl', '--user', 'show', service,
          '--property=Result,ExecMainStatus,ExecMainExitTimestamp,ActiveEnterTimestamp']);
        const sp = parseProps(sShow.stdout);
        const at = parseSystemdTime(sp['ExecMainExitTimestamp']) ?? parseSystemdTime(sp['ActiveEnterTimestamp']);
        const exitCode = at && sp['ExecMainStatus'] !== undefined && sp['ExecMainStatus'] !== '' ? Number(sp['ExecMainStatus']) : undefined;
        lastRun = { status: mapStatus(sp['Result'], at, lastTriggerAt), at: at ?? lastTriggerAt, exitCode, fetchedAt: ctx.now().toISOString() };
      } else {
        lastRun = { status: 'unknown', fetchedAt: ctx.now().toISOString() };
      }
      jobs.push({
        id: 'systemd|' + timerUnit,
        source: 'systemd',
        name: timerUnit,
        schedule: {
          raw: nextRun ? `next=${nextRun}` : 'systemd-timer',
          kind: 'systemd-oncalendar',
          nextRun,
          nextRunSource: nextRun ? 'source-authoritative' : 'unknown',
        },
        target: service ?? timerUnit,
        location: `systemd user: ${timerUnit}`,
        lastRun,
      });
    }
    return jobs;
  },
};
