import type { Connector, Ctx, Job } from '../types.js';
import { parse } from 'yaml';            // YAML 1.2: `on` stays a string key, not boolean true
import { cronNext } from '../core/schedule.js';
import { createHash } from 'node:crypto';

function relPath(ctx: Ctx, file: string): string {
  for (const root of ctx.scanRoots) if (file.startsWith(root)) return file.slice(root.length).replace(/^\//, '');
  return file;
}

const VENDORED_PATH_SEGMENTS = [
  'node_modules',
  '_deps',
  '_build',
  'vendor',
  'dist',
  'build',
  'target',
  '.git',
];

function isVendoredWorkflowPath(file: string): boolean {
  return VENDORED_PATH_SEGMENTS.some((segment) => file.includes(`/${segment}/`));
}

export const githubActionsConnector: Connector = {
  id: 'github-actions',
  tier: 0,
  async availability(ctx) {
    if (ctx.scanRoots.length === 0) return { state: 'unavailable', reason: 'no scanRoots' };
    return { state: 'available' };
  },
  async discover(ctx) {
    const jobs: Job[] = [];
    for (const root of ctx.scanRoots) {
      const files = await ctx.glob('**/.github/workflows/*.{yml,yaml}', root);
      for (const file of files) {
        if (isVendoredWorkflowPath(file)) continue;
        let doc: any;
        try { doc = parse(await ctx.readFile(file)); } catch { continue; }
        const schedules = doc?.on?.schedule;
        if (!Array.isArray(schedules)) continue;
        schedules.forEach((s: any, i: number) => {
          const cron = typeof s?.cron === 'string' ? s.cron : null;
          if (!cron) return;
          const rel = relPath(ctx, file);
          const nextRun = cronNext(cron, ctx.now(), 'UTC') ?? undefined;
          jobs.push({
            id: 'gha|' + createHash('sha1').update(rel + '#' + i).digest('hex').slice(0, 12),
            source: 'github-actions',
            name: `${rel}`,
            schedule: { raw: cron, kind: 'cron', timezone: 'UTC', nextRun, nextRunSource: nextRun ? 'computed' : 'unknown' },
            target: rel,
            location: rel,
            lastRun: { status: 'unknown', fetchedAt: ctx.now().toISOString() },
          });
        });
      }
    }
    return jobs;
  },
};
