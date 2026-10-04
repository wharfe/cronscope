import { describe, it, expect } from 'vitest';
import { Budget, classifyProbe, isBehind, nextStreak, recheckOrder, stopsRechecks, type Baseline, type FreshEntry } from './freshness.js';

const ID = { repo: 'wharfe/open-gikai', workflowId: 247190830, path: '.github/workflows/uptime.yml', query: 'q1:event=schedule,status=completed' };
const B: Baseline = {
  runId: 37089018801, createdAt: '2026-10-03T02:13:07.000Z', judgedStatus: 'success', conclusion: 'success',
  judgedAttempt: 1, latestAttempt: 1, confirmedAt: '2026-10-03T06:17:05.212Z',
};

describe('isBehind', () => {
  it('is behind only when strictly older, or empty with a baseline', () => {
    expect(isBehind(B, '2026-09-17T11:55:17Z')).toBe(true);           // the 16:17 observation
    expect(isBehind(B, '2026-10-03T02:13:07Z')).toBe(false);          // same created_at
    expect(isBehind(B, '2026-10-03T08:06:11Z')).toBe(false);
    expect(isBehind(B, null)).toBe(true);
    expect(isBehind(undefined, '2020-01-01T00:00:00Z')).toBe(false);  // first run: cannot tell
  });
});

describe('classifyProbe (the baseline GET never releases the baseline)', () => {
  const run = { id: B.runId, workflowId: ID.workflowId, event: 'schedule', status: 'completed', createdAt: '2026-10-03T02:13:07Z' };
  it('reads the documented cases', () => {
    expect(classifyProbe(B, ID, { ok: true, value: run })).toEqual({ outcome: 'behind' });
    expect(classifyProbe(B, ID, { ok: true, value: { ...run, status: 'in_progress' } })).toEqual({ outcome: 'rerunning' });
    expect(classifyProbe(B, ID, { ok: false, status: 404 })).toEqual({ outcome: 'unverified', note: 'not-found' });
    expect(classifyProbe(B, ID, { ok: false, status: 410 })).toEqual({ outcome: 'unverified', note: 'not-found' });
    for (const status of [401, 403, 429, 500]) {
      expect(classifyProbe(B, ID, { ok: false, status })).toEqual({ outcome: 'unverified', note: 'http' });
    }
    expect(classifyProbe(B, ID, { ok: false })).toEqual({ outcome: 'unverified', note: 'network' });
    expect(classifyProbe(B, ID, { ok: false, shapeError: true })).toEqual({ outcome: 'unverified', note: 'shape' });
  });
  it('treats any identity disagreement as unverified, not as a reason to drop the baseline', () => {
    for (const v of [{ ...run, workflowId: 1 }, { ...run, event: 'workflow_dispatch' }, { ...run, id: 5 }, { ...run, createdAt: '2026-10-03T02:13:08Z' }]) {
      expect(classifyProbe(B, ID, { ok: true, value: v })).toEqual({ outcome: 'unverified', note: 'mismatch' });
    }
  });
});

describe('stopsRechecks', () => {
  it('stops on 401 / 403 / 429 only', () => {
    expect([401, 403, 429].map(stopsRechecks)).toEqual([true, true, true]);
    expect([undefined, 404, 500, 502].map(stopsRechecks)).toEqual([false, false, false, false]);
  });
});

describe('recheckOrder', () => {
  const e = (lastRecheckAt?: string): FreshEntry => ({ identity: ID, streak: 1, lastSeenAt: '2026-10-03T00:00:00Z', ...(lastRecheckAt ? { lastRecheckAt } : {}) });
  it('never-tried first, then the oldest attempt, ties by job id', () => {
    const entries = { a: e('2026-10-03T03:00:00Z'), b: e(), c: e('2026-10-03T01:00:00Z'), d: e(), z: e('2026-10-03T01:00:00Z') };
    expect(recheckOrder(['a', 'z', 'c', 'd', 'b'], entries)).toEqual(['b', 'd', 'c', 'z', 'a']);
  });
});

describe('Budget', () => {
  it('measures from its creation on the injected clock and clips timeouts', () => {
    let t = 1000;
    const b = new Budget(() => t, 30_000);
    expect(b.remaining()).toBe(30_000);
    t += 27_000;
    expect(b.remaining()).toBe(3_000);
    expect(b.canCall(2_000)).toBe(true);
    expect(b.canWaitThenCall(1_000, 2_000)).toBe(true);
    expect(b.canWaitThenCall(3_000, 2_000)).toBe(false);
    expect(b.callTimeout(10_000)).toBe(3_000);
    t += 5_000;
    expect(b.remaining()).toBe(0);
    expect(b.canCall(2_000)).toBe(false);
  });
});

describe('Budget on a real (fractional) clock', () => {
  it('hands AbortSignal.timeout an integer it accepts', () => {
    let t = 0.25;
    const b = new Budget(() => t, 30_000);
    t += 22_000.58;
    const ms = b.callTimeout(10_000);
    expect(Number.isInteger(ms)).toBe(true);
    expect(ms).toBeLessThanOrEqual(b.remaining());
    expect(() => AbortSignal.timeout(ms)).not.toThrow();
  });
});

describe('nextStreak', () => {
  it('resets, increments or keeps', () => {
    expect([nextStreak(3, 'reset'), nextStreak(3, 'inc'), nextStreak(3, 'keep')]).toEqual([0, 4, 3]);
  });
});
