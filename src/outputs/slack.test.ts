import { describe, it, expect } from 'vitest';
import { formatDigest, sendSlack } from './slack.js';
import type { Job } from '../types.js';

const j = (id: string, source: any): Job => ({
  id, source, name: id, target: '', location: id,
  schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' },
});

describe('slack', () => {
  it('formats a digest of failures and overdues', () => {
    const text = formatDigest([j('a', 'systemd')], [j('b', 'cloudflare')]);
    expect(text).toContain('FAILURE');
    expect(text).toContain('a');
    expect(text).toContain('OVERDUE');
    expect(text).toContain('b');
  });

  it('posts to the webhook url', async () => {
    let body = ''; let called = '';
    const fetchStub = (async (url: string, init: any) => { called = url; body = init.body; return { ok: true }; }) as any;
    await sendSlack(fetchStub, 'https://hooks.slack/x', 'hello');
    expect(called).toBe('https://hooks.slack/x');
    expect(body).toContain('hello');
  });
});
