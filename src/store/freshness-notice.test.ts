import { describe, it, expect } from 'vitest';
import { classifyReason, freshnessNoticeKeys, freshnessNoticeKey, jobsForKeys, noticeKeys, freshStoreKey } from './notify-state.js';
import { freshnessNotices, freshStoreNotices } from '../outputs/slack.js';
import { FRESHNESS_REASONS, FIRST_ATTEMPT_DEFERRED } from '../core/freshness.js';
import type { Job } from '../types.js';

const gha = (id: string, reason?: string, over: Partial<Job> = {}): Job => ({
  id, source: 'github-actions', name: `proj/.github/workflows/${id}.yml`, target: 't', location: 'l',
  schedule: { raw: '0 21 * * *', kind: 'cron', nextRunSource: 'computed' }, state: 'active',
  lastRun: { status: 'unknown', fetchedAt: '2026-10-03T08:17:05.000Z', ...(reason ? { undeterminedReason: reason } : {}) },
  ...over,
});

describe('run freshness keys (wharfe/cronscope#4)', () => {
  it('every fixed freshness reason folds to run-freshness and no other class', () => {
    for (const r of [...Object.values(FRESHNESS_REASONS), FIRST_ATTEMPT_DEFERRED]) expect(classifyReason(r)).toBe('run-freshness');
    // ...and the existing classes are untouched.
    expect(classifyReason('run history unavailable: HTTP 502')).toBe('http-5xx');
    expect(classifyReason('run history unavailable: first attempt of the newest scheduled run unavailable: HTTP 500')).toBe('http-5xx');
  });

  it('the shared per-class keys skip freshness jobs entirely', () => {
    const jobs = [gha('a', FRESHNESS_REASONS.behind), gha('b', 'run history unavailable: HTTP 502')];
    expect(noticeKeys(jobs)).toEqual(['github-actions/http-5xx']);
    expect(jobsForKeys(jobs, ['github-actions/run-freshness']).map((j) => j.id)).toEqual([]);
  });

  it('keys per job, only at the threshold, never for a job reset this check or switched off', () => {
    const jobs = [gha('a'), gha('b'), gha('c'), gha('d', undefined, { state: 'disabled_manually' })];
    const streak: Record<string, number> = { a: 2, b: 1, c: 5, d: 9 };
    const keys = freshnessNoticeKeys(jobs, (id) => streak[id] ?? 0, (id) => id === 'c', 2);
    expect(keys).toEqual([freshnessNoticeKey('a')]);
  });

  it('a Slack line carries the name, the count and a fixed word -- nothing raw', () => {
    const jobs = [gha('a'), gha('b')];
    const lines = freshnessNotices([freshnessNoticeKey('a'), 'github-actions/http-5xx'], jobs,
      () => ({ streak: 3, outcome: 'unverified', notFound: true }));
    expect(lines).toEqual([
      'github-actions: proj/.github/workflows/a.yml の run 鮮度を 3 回続けて確認できていない（unverified。基準 run が API で見つからない。削除を確かめたら人が基準を解放する（README）。詳細は check のログ）',
    ]);
    expect(freshnessNotices([freshnessNoticeKey('a')], jobs, () => ({ streak: 2, outcome: 'whatever' as any }))[0])
      .toContain('（unconfirmed。詳細は check のログ）');
  });

  it('store problems are one fixed line each', () => {
    expect(freshStoreNotices([freshStoreKey('unsaved'), freshStoreKey('corrupt'), 'x'])).toHaveLength(2);
    expect(freshStoreNotices([freshStoreKey('unsupported')])[0]).toMatch(/^cronscope: /);
  });
});
