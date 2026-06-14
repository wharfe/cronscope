import type { Ctx } from '../types.js';

export interface CronFires {
  available: boolean;
  observableSince?: string;                // ISO; earliest cron log line we could read
  lastFireByCommand: Map<string, string>;  // cronCommandLogKey -> latest fire ISO
}

// `(user) CMD (command)` — command may contain ')', so capture greedily to the last ')'.
const CMD_RE = /\([^)]*\)\s+CMD\s+\((.+)\)\s*$/;
const MONTHS: Record<string, number> = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };

// cron runs the command up to the first UNescaped %, with \% -> literal %.
export function cronCommandLogKey(cmd: string): string {
  return cmd.split(/(?<!\\)%/)[0].replace(/\\%/g, '%').trim();
}

function record(fires: Map<string, string>, cmd: string, iso: string): void {
  const key = cronCommandLogKey(cmd);
  if (!key) return;
  const prev = fires.get(key);
  if (!prev || prev < iso) fires.set(key, iso);
}

async function readJournal(ctx: Ctx): Promise<CronFires | null> {
  // CMD lines are logged by the forked cron child under SYSLOG_IDENTIFIER=CRON,
  // which `-u cron` (the cron.service cgroup) does NOT capture — only `-t CRON` does.
  const r = await ctx.run(['journalctl', '-t', 'CRON', '--since', '35 days ago', '--output=json']);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const fires = new Map<string, string>();
  let earliest: string | undefined;
  for (const line of r.stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try { obj = JSON.parse(s); } catch { continue; }
    const usec = obj.__REALTIME_TIMESTAMP;
    if (!usec) continue;
    const iso = new Date(Number(usec) / 1000).toISOString();
    if (Number.isNaN(Date.parse(iso))) continue;
    if (!earliest || iso < earliest) earliest = iso;
    const msg = typeof obj.MESSAGE === 'string' ? obj.MESSAGE : '';
    const m = msg.match(CMD_RE);
    if (m) record(fires, m[1], iso);
  }
  return { available: true, observableSince: earliest, lastFireByCommand: fires };
}

function parseSyslogTs(line: string, now: Date): string | undefined {
  const m = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const mon = MONTHS[m[1]];
  if (mon === undefined) return undefined;
  let d = new Date(now.getFullYear(), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  if (d.getTime() > now.getTime() + 60_000) d = new Date(now.getFullYear() - 1, mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return d.toISOString();
}

async function readSyslog(ctx: Ctx): Promise<CronFires | null> {
  let text: string;
  try { text = await ctx.readFile('/var/log/syslog'); } catch { return null; }
  const fires = new Map<string, string>();
  let earliest: string | undefined;
  const now = ctx.now();
  for (const line of text.split('\n')) {
    if (!line.includes('CRON')) continue;
    const iso = parseSyslogTs(line, now);
    if (!iso) continue;
    if (!earliest || iso < earliest) earliest = iso;
    const m = line.match(CMD_RE);
    if (m) record(fires, m[1], iso);
  }
  if (!earliest && fires.size === 0) return null;
  return { available: true, observableSince: earliest, lastFireByCommand: fires };
}

export async function readCronFires(ctx: Ctx): Promise<CronFires> {
  try {
    return (await readJournal(ctx)) ?? (await readSyslog(ctx)) ?? { available: false, lastFireByCommand: new Map() };
  } catch {
    return { available: false, lastFireByCommand: new Map() };
  }
}
