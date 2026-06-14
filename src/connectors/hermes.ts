import type { Connector, Ctx, Job, LastRun, RunStatus } from '../types.js';

// last_status string values that mean the run failed. Confirmed against the
// real Hermes failure value ('error', with last_error detail) in dogfood
// capture; extend if a new value is observed. Unknown values map to 'unknown'
// (never silently 'success').
const FAILURE_STATUSES = new Set(['error', 'failed', 'failure', 'timeout', 'crashed']);

interface HermesRecord {
  id?: unknown;
  name?: unknown;
  schedule?: { kind?: unknown; expr?: unknown; display?: unknown };
  enabled?: unknown;
  next_run_at?: unknown;
  last_run_at?: unknown;
  last_status?: unknown;
  script?: unknown;
}

function jobsPath(ctx: Ctx): string {
  return `${ctx.homeDir}/.hermes/cron/jobs.json`;
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}

function mapLastRun(rec: HermesRecord, nowIso: string): LastRun {
  const at = asStr(rec.last_run_at);
  if (!at) return { status: 'never', fetchedAt: nowIso };
  const ls = asStr(rec.last_status);
  let status: RunStatus;
  if (ls === 'ok') status = 'success';
  else if (ls && FAILURE_STATUSES.has(ls)) status = 'failure';
  else status = 'unknown';
  return { status, at, fetchedAt: nowIso };
}

function recordToJob(rec: HermesRecord, nowIso: string): Job | null {
  const id = asStr(rec.id);
  if (!id) return null; // not a real record
  const enabled = rec.enabled !== false; // default-enabled unless explicitly false
  const kind = asStr(rec.schedule?.kind) === 'cron' ? 'cron' : 'interval';
  const nextRun = enabled ? asStr(rec.next_run_at) : undefined;
  return {
    id: 'hermes|' + id,
    source: 'hermes',
    name: asStr(rec.name) ?? id,
    schedule: {
      raw: asStr(rec.schedule?.expr) ?? asStr(rec.schedule?.display) ?? '(hermes schedule)',
      kind,
      nextRun,
      nextRunSource: nextRun ? 'source-authoritative' : 'unknown',
    },
    target: asStr(rec.script) ?? '(agent prompt)', // never the prompt text
    location: 'hermes cron',
    lastRun: mapLastRun(rec, nowIso),
  };
}

function extractRecords(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const jobs = (data as { jobs?: unknown }).jobs;
    if (Array.isArray(jobs)) return jobs;
    return Object.values(data as object); // id-keyed map; non-records filtered by recordToJob
  }
  return [];
}

export const hermesConnector: Connector = {
  id: 'hermes',
  tier: 0,
  async availability(ctx) {
    try {
      await ctx.readFile(jobsPath(ctx));
      return { state: 'available' };
    } catch {
      return { state: 'unavailable', reason: 'hermes cron store not found (~/.hermes/cron/jobs.json)' };
    }
  },
  async discover(ctx) {
    let raw: string;
    try { raw = await ctx.readFile(jobsPath(ctx)); } catch { return []; }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return []; }
    const nowIso = ctx.now().toISOString();
    const jobs: Job[] = [];
    for (const rec of extractRecords(data)) {
      try {
        const j = recordToJob(rec as HermesRecord, nowIso);
        if (j) jobs.push(j);
      } catch { /* per-record isolation: skip malformed record */ }
    }
    return jobs;
  },
};
