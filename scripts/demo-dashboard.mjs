// Renders a SYNTHETIC dashboard to demo.html using the real web renderer.
// All job data here is fake/demo — no real account ids, worker, or job names.
import { renderHtml } from '../dist/outputs/web.js';
import { writeFileSync } from 'node:fs';

const snap = {
  schemaVersion: 1,
  generatedAt: '2026-06-13T09:00:00.000Z',
  host: { bootAt: '2026-06-13T07:00:00.000Z' },
  connectors: {
    crontab: { state: 'available' },
    systemd: { state: 'available' },
    'github-actions': { state: 'available' },
    cloudflare: { state: 'available' },
    hermes: { state: 'available' },
  },
  jobs: [
    { id: 'systemd|backup.timer', source: 'systemd', name: 'backup.timer',
      schedule: { raw: 'next=2026-06-13T12:00:00.000Z', kind: 'systemd-oncalendar', nextRun: '2026-06-13T12:00:00.000Z', nextRunSource: 'source-authoritative' },
      target: 'backup.service', location: 'systemd user: backup.timer',
      lastRun: { status: 'success', at: '2026-06-13T06:00:00.000Z', fetchedAt: '2026-06-13T09:00:00.000Z' } },
    { id: 'systemd|report.timer', source: 'systemd', name: 'report.timer',
      schedule: { raw: 'next=2026-06-13T18:00:00.000Z', kind: 'systemd-oncalendar', nextRun: '2026-06-13T18:00:00.000Z', nextRunSource: 'source-authoritative' },
      target: 'report.service', location: 'systemd user: report.timer',
      lastRun: { status: 'failure', at: '2026-06-13T06:00:00.000Z', exitCode: 1, fetchedAt: '2026-06-13T09:00:00.000Z' } },
    { id: 'crontab|0', source: 'crontab', name: 'cleanup-tmp',
      schedule: { raw: '0 3 * * *', kind: 'cron', timezone: 'UTC', nextRun: '2026-06-14T03:00:00.000Z', nextRunSource: 'computed' },
      target: 'cleanup-tmp.sh', location: 'crontab',
      lastRun: { status: 'unknown', fetchedAt: '2026-06-13T09:00:00.000Z' } },
    { id: 'gha|demo-app/.github/workflows/nightly.yml#0', source: 'github-actions', name: 'demo-app/.github/workflows/nightly.yml',
      schedule: { raw: '0 0 * * *', kind: 'cron', timezone: 'UTC', nextRun: '2026-06-14T00:00:00.000Z', nextRunSource: 'computed' },
      target: 'nightly.yml', location: 'demo-app',
      lastRun: { status: 'unknown', fetchedAt: '2026-06-13T09:00:00.000Z' } },
    { id: 'cf|demo|newsletter-cron', source: 'cloudflare', name: 'newsletter-cron',
      schedule: { raw: '0 9 * * 1', kind: 'cron', timezone: 'UTC', nextRun: '2026-06-15T09:00:00.000Z', nextRunSource: 'computed' },
      target: 'newsletter-cron', location: 'cloudflare:demo-account',
      lastRun: { status: 'unknown', fetchedAt: '2026-06-13T09:00:00.000Z' } },
    { id: 'hermes|demojob', source: 'hermes', name: 'daily-digest',
      schedule: { raw: '0 7 * * *', kind: 'cron', nextRun: '2026-06-14T07:00:00.000Z', nextRunSource: 'source-authoritative' },
      target: 'digest.sh', location: 'hermes cron',
      lastRun: { status: 'success', at: '2026-06-13T07:00:00.000Z', fetchedAt: '2026-06-13T09:00:00.000Z' } },
  ],
};

writeFileSync(new URL('../demo.html', import.meta.url), renderHtml(snap));
console.log('wrote demo.html');
