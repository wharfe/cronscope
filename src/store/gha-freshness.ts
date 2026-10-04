import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FRESHNESS_DEFAULTS, nextStreak, sameIdentity, type FreshEntry, type FreshProposal } from '../core/freshness.js';

// Run-freshness baselines (wharfe/cronscope#4). Written by `check` and the
// release command only, each under the check lock; scan / serve read it.
// Unlike the snapshot this is control state, not a cache: losing it silently
// drops the protection, so a corrupt file is moved aside and announced.
export interface FreshState {
  schemaVersion: 1;
  lastCheckAt?: string;
  entries: Record<string, FreshEntry>;
}

export type FreshLoad =
  | { kind: 'ok'; state: FreshState; dropped: number }     // dropped > 0: some entries were malformed
  | { kind: 'missing'; state: FreshState }
  | { kind: 'corrupt'; state: FreshState }
  | { kind: 'unsupported' };     // another schemaVersion, or unreadable: never overwrite it

const empty = (): FreshState => ({ schemaVersion: 1, entries: {} });

const STATUSES = new Set(['success', 'failure', 'unknown', 'never']);
const OUTCOMES = new Set(['fresh', 'recovered', 'behind', 'rerunning', 'unverified', 'deferred']);
const isIso = (v: unknown): v is string => typeof v === 'string' && !isNaN(new Date(v).getTime());
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function validEntry(e: any): e is FreshEntry {
  if (!isObj(e)) return false;
  const id = e.identity;
  if (!isObj(id) || typeof id.repo !== 'string' || !isPosInt(id.workflowId) || typeof id.path !== 'string' || typeof id.query !== 'string') return false;
  if (!(typeof e.streak === 'number' && Number.isInteger(e.streak) && e.streak >= 0) || !isIso(e.lastSeenAt)) return false;
  if (e.lastOutcome !== undefined && !OUTCOMES.has(e.lastOutcome)) return false;
  if (e.lastRecheckAt !== undefined && !isIso(e.lastRecheckAt)) return false;
  if (e.notFound !== undefined && typeof e.notFound !== 'boolean') return false;
  const b = e.baseline;
  if (b !== undefined) {
    if (!isObj(b)) return false;
    if (!isPosInt(b.runId) || !isIso(b.createdAt) || !STATUSES.has(b.judgedStatus) || !isIso(b.confirmedAt)) return false;
    if (!(b.conclusion === null || typeof b.conclusion === 'string')) return false;
    if (!isPosInt(b.judgedAttempt) || !isPosInt(b.latestAttempt)) return false;
  }
  return true;
}

// Reading only, for writers and readers alike. Moving a corrupt file aside is
// a write, so it is a separate step (moveCorruptAside) that the check takes
// only after confirming it was not aborted -- a load must never write.
// `mode` is kept for the call sites' readability; it changes nothing here.
export async function loadFreshState(path: string, mode: 'writer' | 'reader'): Promise<FreshLoad> {
  void mode;
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return { kind: 'missing', state: empty() };
    // Exists but cannot be read (permissions, a directory): not ours to replace.
    return { kind: 'unsupported' };
  }
  const corrupt: FreshLoad = { kind: 'corrupt', state: empty() };
  let data: any;
  try { data = JSON.parse(text); } catch { return corrupt; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return corrupt;
  if (data.schemaVersion !== 1) {
    return typeof data.schemaVersion === 'number' ? { kind: 'unsupported' } : corrupt;
  }
  if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)
      || (data.lastCheckAt !== undefined && !isIso(data.lastCheckAt))) return corrupt;
  const entries: Record<string, FreshEntry> = {};
  let dropped = 0;
  for (const [id, e] of Object.entries<any>(data.entries)) {
    if (validEntry(e)) entries[id] = e; else dropped++;
  }
  return { kind: 'ok', state: { schemaVersion: 1, lastCheckAt: data.lastCheckAt, entries }, dropped };
}

// One copy of the evidence, `<path>.corrupt` (a previous copy is replaced).
// Writer only, under the check lock, never after an abort.
export async function moveCorruptAside(path: string): Promise<boolean> {
  try { await rename(path, `${path}.corrupt`); return true; } catch { return false; }
}

// Same directory, then rename: a reader sees the old file or the new one,
// never half of one. This is NOT what keeps two writers apart -- the check
// lock is (src/store/check-lock.ts).
export async function saveFreshState(path: string, state: FreshState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(state, null, 2), 'utf8');
      await fh.sync();
    } finally { await fh.close(); }
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// The next state from the previous one and this scan's proposals.
//  - a proposal with another identity starts the entry over (streak 0, no baseline)
//  - present jobs get lastSeenAt = at; absent entries are kept, and forgotten
//    only after forgetAfterMs unseen (never an active baseline's expiry)
//  - `forget: false` (the connector did not run): nothing is forgotten
export function applyProposals(
  prev: FreshState, proposals: Map<string, FreshProposal>, presentIds: Set<string>, at: string,
  opts: { forget?: boolean } = {},
): FreshState {
  const entries: Record<string, FreshEntry> = {};
  const atMs = new Date(at).getTime();
  for (const [id, e] of Object.entries(prev.entries)) {
    if (opts.forget === false || presentIds.has(id) || atMs - new Date(e.lastSeenAt).getTime() <= FRESHNESS_DEFAULTS.forgetAfterMs) {
      entries[id] = { ...e };
    }
  }
  for (const id of presentIds) if (entries[id]) entries[id].lastSeenAt = at;
  for (const [id, p] of proposals) {
    const old = entries[id] && sameIdentity(entries[id].identity, p.identity) ? entries[id] : undefined;
    const base: FreshEntry = old ?? { identity: p.identity, streak: 0, lastSeenAt: at };
    const next: FreshEntry = {
      ...base,
      identity: p.identity,
      streak: old ? nextStreak(base.streak, p.op) : (p.op === 'inc' ? 1 : 0),
      lastSeenAt: at,
    };
    if (p.baseline) next.baseline = p.baseline;
    if (p.outcome) next.lastOutcome = p.outcome;
    if (p.touched) next.lastRecheckAt = at;
    if (p.outcome) {
      if (p.notFound) next.notFound = true; else delete next.notFound;
    }
    entries[id] = next;
  }
  return { schemaVersion: 1, lastCheckAt: at, entries };
}
