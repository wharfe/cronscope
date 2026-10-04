import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProposals, loadFreshState, saveFreshState, type FreshState } from './gha-freshness.js';
import type { FreshEntry, FreshProposal } from '../core/freshness.js';

const ID = { repo: 'wharfe/proj', workflowId: 7, path: '.github/workflows/daily.yml', query: 'q1:event=schedule,status=completed' };
const BASE = { runId: 10, createdAt: '2026-06-10T21:00:00.000Z', judgedStatus: 'success' as const, conclusion: 'success', judgedAttempt: 1, latestAttempt: 1, confirmedAt: '2026-06-10T22:00:00.000Z' };
const entry = (over: Partial<FreshEntry> = {}): FreshEntry => ({ identity: ID, baseline: BASE, streak: 0, lastSeenAt: '2026-06-11T00:00:00.000Z', ...over });

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronscope-fresh-')); path = join(dir, 'gha-freshness.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('freshness state file', () => {
  it('round-trips through a temporary file and rename, mode 0600, no leftovers', async () => {
    const st: FreshState = { schemaVersion: 1, lastCheckAt: '2026-06-11T00:00:00.000Z', entries: { 'gha|a': entry() } };
    await saveFreshState(path, st);
    expect(await loadFreshState(path, 'writer')).toEqual({ kind: 'ok', state: st, dropped: 0 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['gha-freshness.json']);
  });

  it('is missing (first run) when there is no file', async () => {
    expect(await loadFreshState(path, 'writer')).toEqual({ kind: 'missing', state: { schemaVersion: 1, entries: {} } });
  });

  it('writer moves a corrupt file aside (one copy) and starts empty', async () => {
    writeFileSync(path, '{ not json');
    const got = await loadFreshState(path, 'writer');
    expect(got).toEqual({ kind: 'corrupt', state: { schemaVersion: 1, entries: {} }, movedAside: true });
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('{ not json');
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '[]');
    await loadFreshState(path, 'writer');
    expect(readFileSync(`${path}.corrupt`, 'utf8')).toBe('[]');
  });

  it('a reader never moves a corrupt file', async () => {
    writeFileSync(path, '{ not json');
    expect((await loadFreshState(path, 'reader')).kind).toBe('corrupt');
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    expect(existsSync(`${path}.corrupt`)).toBe(false);
  });

  it('refuses an unknown schemaVersion and leaves it in place', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, entries: {} }));
    expect(await loadFreshState(path, 'writer')).toEqual({ kind: 'unsupported' });
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
  });

  it('treats an unreadable path as unsupported, not as corrupt', async () => {
    mkdirSync(path);   // EISDIR on read
    expect(await loadFreshState(path, 'writer')).toEqual({ kind: 'unsupported' });
    expect(statSync(path).isDirectory()).toBe(true);
  });

  it('drops only the malformed entries and reports how many', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: {
      'gha|good': entry(), 'gha|bad': { ...entry(), streak: -1 }, 'gha|bad2': { ...entry(), baseline: { ...BASE, runId: 'x' } },
    } }));
    const got = await loadFreshState(path, 'writer');
    expect(got.kind).toBe('ok');
    expect(got.kind === 'ok' && Object.keys(got.state.entries)).toEqual(['gha|good']);
    expect(got.kind === 'ok' && got.dropped).toBe(2);
  });
});

describe('applyProposals', () => {
  const AT = '2026-06-12T00:00:00.000Z';
  const prev = (entries: Record<string, FreshEntry>): FreshState => ({ schemaVersion: 1, lastCheckAt: '2026-06-11T23:00:00.000Z', entries });
  const P = (over: Partial<FreshProposal>): Map<string, FreshProposal> => new Map([['gha|a', { identity: ID, op: 'keep', touched: false, ...over }]]);

  it('increments, resets and keeps the streak; stamps lastCheckAt and lastSeenAt', () => {
    const p = prev({ 'gha|a': entry({ streak: 1 }) });
    const ids = new Set(['gha|a']);
    expect(applyProposals(p, P({ op: 'inc', outcome: 'behind' }), ids, AT).entries['gha|a']).toMatchObject({ streak: 2, lastOutcome: 'behind', lastSeenAt: AT });
    expect(applyProposals(p, P({ op: 'reset', outcome: 'fresh' }), ids, AT).entries['gha|a'].streak).toBe(0);
    expect(applyProposals(p, P({ op: 'keep' }), ids, AT).entries['gha|a'].streak).toBe(1);
    expect(applyProposals(p, P({ op: 'keep' }), ids, AT).lastCheckAt).toBe(AT);
  });

  it('keeps the baseline unless a new one is proposed', () => {
    const p = prev({ 'gha|a': entry() });
    expect(applyProposals(p, P({ op: 'inc', outcome: 'unverified', notFound: true }), new Set(['gha|a']), AT).entries['gha|a'])
      .toMatchObject({ baseline: BASE, notFound: true });
    const nb = { ...BASE, runId: 11, createdAt: '2026-06-11T21:00:00.000Z' };
    expect(applyProposals(p, P({ op: 'reset', outcome: 'fresh', baseline: nb }), new Set(['gha|a']), AT).entries['gha|a'].baseline).toEqual(nb);
  });

  it('starts over when the identity changed', () => {
    const p = prev({ 'gha|a': entry({ streak: 5 }) });
    const moved = { ...ID, workflowId: 8 };
    const got = applyProposals(p, P({ identity: moved, op: 'reset', outcome: 'fresh' }), new Set(['gha|a']), AT).entries['gha|a'];
    expect(got.identity).toEqual(moved);
    expect(got.streak).toBe(0);
    expect(got.baseline).toBeUndefined();
  });

  it('touched sets lastRecheckAt; untouched leaves it as it was', () => {
    const p = prev({ 'gha|a': entry({ lastRecheckAt: '2026-06-11T00:00:00.000Z' }) });
    expect(applyProposals(p, P({ op: 'inc', outcome: 'deferred', touched: true }), new Set(['gha|a']), AT).entries['gha|a'].lastRecheckAt).toBe(AT);
    expect(applyProposals(p, P({ op: 'inc', outcome: 'deferred', touched: false }), new Set(['gha|a']), AT).entries['gha|a'].lastRecheckAt).toBe('2026-06-11T00:00:00.000Z');
  });

  it('forgets only entries unseen for 30 days -- never an entry still in the scan', () => {
    const old = '2026-05-01T00:00:00.000Z';   // 42 days before AT
    const p = prev({ 'gha|seen': entry({ lastSeenAt: old }), 'gha|gone': entry({ lastSeenAt: old }), 'gha|recent': entry({ lastSeenAt: '2026-06-01T00:00:00.000Z' }) });
    const got = applyProposals(p, new Map(), new Set(['gha|seen']), AT);
    expect(Object.keys(got.entries).sort()).toEqual(['gha|recent', 'gha|seen']);
    expect(got.entries['gha|seen'].baseline).toEqual(BASE);
    // While the connector did not run, nothing is forgotten.
    expect(Object.keys(applyProposals(p, new Map(), new Set(), AT, { forget: false }).entries).sort()).toEqual(['gha|gone', 'gha|recent', 'gha|seen']);
  });
});
