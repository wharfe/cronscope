import type { Connector, Ctx, Job, LastRun, RunStatus } from '../types.js';

function parseProps(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

function parseSystemdTime(v: string | undefined): string | undefined {
  if (!v || v === 'n/a' || v === '') return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function mapStatus(result: string | undefined, lastAt: string | undefined): RunStatus {
  if (!lastAt) return 'never';
  if (result === undefined) return 'unknown';
  return result === 'success' ? 'success' : 'failure';
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
    const list = await ctx.run(['systemctl', '--user', 'list-timers', '--all', '--no-legend', '--output=json']);
    if (list.code !== 0) return [];
    let timers: Array<{ unit: string }>;
    try { timers = JSON.parse(list.stdout); } catch { return []; }
    const jobs: Job[] = [];
    for (const t of timers) {
      const timerUnit = t.unit;
      const tShow = await ctx.run(['systemctl', '--user', 'show', timerUnit, '--property=Unit,NextElapseUSecRealtime']);
      const tp = parseProps(tShow.stdout);
      const service = tp['Unit'];
      const nextRun = parseSystemdTime(tp['NextElapseUSecRealtime']);
      let lastRun: LastRun;
      if (service) {
        const sShow = await ctx.run(['systemctl', '--user', 'show', service,
          '--property=Result,ExecMainStatus,ExecMainExitTimestamp,ActiveEnterTimestamp']);
        const sp = parseProps(sShow.stdout);
        const at = parseSystemdTime(sp['ExecMainExitTimestamp']) ?? parseSystemdTime(sp['ActiveEnterTimestamp']);
        const exitCode = sp['ExecMainStatus'] !== undefined && sp['ExecMainStatus'] !== '' ? Number(sp['ExecMainStatus']) : undefined;
        lastRun = { status: mapStatus(sp['Result'], at), at, exitCode, fetchedAt: ctx.now().toISOString() };
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
