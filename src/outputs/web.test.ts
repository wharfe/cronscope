import { describe, it, expect } from 'vitest';
import { renderHtml } from './web.js';
import type { Snapshot } from '../types.js';

const snap: Snapshot = {
  schemaVersion: 1, generatedAt: '2026-06-12T10:00:00Z', host: {},
  connectors: { systemd: { state: 'available' }, cloudflare: { state: 'skipped', reason: 'no token' } },
  jobs: [
    { id: 'a', source: 'systemd', name: 'etl.timer', target: 'etl.service', location: 'systemd',
      schedule: { raw: 'x', kind: 'systemd-oncalendar', nextRun: '2026-06-12T12:00:00Z', nextRunSource: 'source-authoritative' },
      lastRun: { status: 'success', fetchedAt: 't' } },
  ],
};

describe('renderHtml', () => {
  it('renders jobs grouped by source with status', () => {
    const html = renderHtml(snap);
    expect(html).toContain('etl.timer');
    expect(html).toContain('systemd');
    expect(html).toContain('success');
  });
  it('shows connector availability', () => {
    expect(renderHtml(snap)).toContain('skipped');
  });
});
