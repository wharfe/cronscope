import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot, loadSnapshot } from './snapshot.js';
import { loadNotifyState, saveNotifyState } from './notify-state.js';
import type { Snapshot } from '../types.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cronscope-')); });

const snap: Snapshot = {
  schemaVersion: 1, generatedAt: '2026-06-12T10:00:00Z',
  host: { bootAt: '2026-06-12T09:00:00Z' }, connectors: {}, jobs: [],
};

describe('snapshot store', () => {
  it('round-trips and returns null for a missing file', async () => {
    expect(await loadSnapshot(join(dir, 'state.json'))).toBeNull();
    await saveSnapshot(join(dir, 'state.json'), snap);
    expect((await loadSnapshot(join(dir, 'state.json')))?.schemaVersion).toBe(1);
  });

  it('ignores a snapshot with an unknown schemaVersion (regenerable cache)', async () => {
    await saveSnapshot(join(dir, 's.json'), { ...snap, schemaVersion: 99 as any });
    expect(await loadSnapshot(join(dir, 's.json'))).toBeNull();
  });
});

describe('notify-state store', () => {
  it('round-trips notified states', async () => {
    const p = join(dir, 'notify.json');
    expect((await loadNotifyState(p)).jobs).toEqual({});
    await saveNotifyState(p, { schemaVersion: 1, lastCheckAt: '2026-06-12T10:00:00Z', jobs: { a: { status: 'failure', notifiedAt: 't' } } });
    expect((await loadNotifyState(p)).jobs.a.status).toBe('failure');
  });
});
