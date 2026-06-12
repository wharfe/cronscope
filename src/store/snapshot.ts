import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Snapshot } from '../types.js';

export async function loadSnapshot(path: string): Promise<Snapshot | null> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data?.schemaVersion !== 1) return null; // unknown version -> discard (cache)
    return data as Snapshot;
  } catch { return null; }
}

export async function saveSnapshot(path: string, snap: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snap, null, 2), { mode: 0o600 });
}
