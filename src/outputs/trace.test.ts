import { describe, it, expect } from 'vitest';
import { runIdentityLines } from './trace.js';
import type { Job } from '../types.js';

const base = (over: Partial<Job>): Job => ({
  id: 'gha|abc123def456', source: 'github-actions', name: 'proj/.github/workflows/daily.yml',
  target: 't', location: 'l',
  schedule: { raw: '0 21 * * *', kind: 'cron', nextRunSource: 'computed' },
  state: 'active',
  lastRun: { status: 'failure', at: '2026-06-11T21:00:00.000Z', fetchedAt: '2026-06-12T10:05:00.000Z',
    run: { id: 9, judgedAttempt: 1, latestAttempt: 2, conclusion: 'failure', latestConclusion: 'success' } },
  ...over,
});

describe('runIdentityLines', () => {
  it('prints one line per GitHub Actions job that has a run, in a fixed key=value form with name last', () => {
    expect(runIdentityLines([base({})])).toEqual([
      '# gha job=gha|abc123def456 run=9 judged_attempt=1 latest_attempt=2 conclusion=failure latest_conclusion=success'
      + ' state=active status=failure created=2026-06-11T21:00:00.000Z fetched=2026-06-12T10:05:00.000Z'
      + ' name=proj/.github/workflows/daily.yml',
    ]);
  });

  it('prints nothing for jobs without a run, and nothing for other sources', () => {
    const noRun = base({ lastRun: { status: 'never', fetchedAt: 'x' } });
    const launchd = base({ id: 'launchd|x', source: 'launchd',
      lastRun: { status: 'success', fetchedAt: 'x', run: { id: 1, judgedAttempt: 1, latestAttempt: 1, conclusion: 'success', latestConclusion: 'success' } } });
    expect(runIdentityLines([noRun, launchd])).toEqual([]);
    expect(runIdentityLines([noRun, base({}), launchd, base({ id: 'gha|2' })])).toHaveLength(2);
  });

  it('renders a null conclusion as the word null and a missing state as -', () => {
    const j = base({ state: undefined, lastRun: { status: 'unknown', at: 'a', fetchedAt: 'f',
      run: { id: 1, judgedAttempt: 1, latestAttempt: 1, conclusion: null, latestConclusion: null } } });
    const [line] = runIdentityLines([j]);
    expect(line).toContain(' conclusion=null latest_conclusion=null state=- status=unknown ');
  });

  it('keeps a name with spaces parseable by putting it last', () => {
    const [line] = runIdentityLines([base({ name: 'my repo/.github/workflows/a b.yml' })]);
    expect(line.slice(line.indexOf(' name=') + ' name='.length)).toBe('my repo/.github/workflows/a b.yml');
  });
});

describe('freshnessLines (wharfe/cronscope#4)', () => {
  it('prints numbers, times and fixed words only, name last', async () => {
    const { freshnessLines } = await import('./trace.js');
    const j = base({
      lastRun: {
        status: 'unknown', fetchedAt: '2026-10-03T07:17:05.379Z', undeterminedReason: 'run freshness: listing is older than a run seen before',
        freshness: { state: 'behind', retries: 2, probe: 'ok', pages: [{ n: 10, newest: '2026-09-17T11:55:17.000Z', oldest: '2026-09-15T00:00:00.000Z', total: 2500 }, { n: 0 }] },
        lastObserved: { runId: 37089018801, createdAt: '2026-10-03T02:13:07.000Z', status: 'success', confirmedAt: '2026-10-03T06:17:05.212Z' },
      },
    });
    expect(freshnessLines([j], () => 1)).toEqual([
      '# gha-freshness job=gha|abc123def456 outcome=behind streak=1 retries=2 probe=ok stop=- mark_run=37089018801'
      + ' mark_created=2026-10-03T02:13:07.000Z pages=10/2026-09-17T11:55:17.000Z/2026-09-15T00:00:00.000Z/2500,0/-/-/- name=proj/.github/workflows/daily.yml',
    ]);
    expect(freshnessLines([base({})], () => 0)).toEqual([]);
  });
});
