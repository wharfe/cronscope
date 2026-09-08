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

import { undeterminedNotices } from './slack.js';

const gha = (over: Partial<Job>): Job => ({ id: 'x', source: 'github-actions', name: 'n',
  target: 't', location: 'l', schedule: { raw: '0 0 * * *', kind: 'cron', nextRunSource: 'computed' },
  ...over });

describe('digest with notices and workflow state', () => {
  it('renders notices after the job lines', () => {
    const text = formatDigest([], [], ['github-actions: HTTP 401 (8 jobs undetermined)']);
    expect(text).toContain(':grey_question:');
    expect(text).toContain('8 jobs undetermined');
  });

  it('explains an inactivity-disabled workflow and shows its last run', () => {
    const line = formatDigest([], [gha({ state: 'disabled_inactivity',
      lastRun: { status: 'failure', at: 'x', fetchedAt: 'x' } })]);
    expect(line).toContain('GitHub が無操作により無効化');
    expect(line).toContain('last=failure');
  });

  it('is still all clear with nothing to report', () => {
    expect(formatDigest([], [], [])).toBe('cronscope: all clear');
  });
});

describe('undeterminedNotices', () => {
  it('groups by source and reason with a count', () => {
    const jobs = [
      gha({ lastRun: { status: 'unknown', fetchedAt: 'x', undeterminedReason: 'HTTP 401' } }),
      gha({ lastRun: { status: 'unknown', fetchedAt: 'x', undeterminedReason: 'HTTP 401' } }),
      gha({ lastRun: { status: 'success', at: 'x', fetchedAt: 'x' } }),
    ];
    expect(undeterminedNotices(jobs)).toEqual(['github-actions: HTTP 401 (2 jobs undetermined)']);
  });

  it('says nothing about a source that is unknown by construction', () => {
    const cron: Job = { ...gha({}), source: 'crontab', lastRun: { status: 'unknown', fetchedAt: 'x' } };
    expect(undeterminedNotices([cron])).toEqual([]);
  });
});
