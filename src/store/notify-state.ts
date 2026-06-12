import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface NotifyState {
  schemaVersion: 1;
  lastCheckAt?: string;
  jobs: Record<string, { status: 'failure' | 'overdue'; notifiedAt: string }>;
}

export async function loadNotifyState(path: string): Promise<NotifyState> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data?.schemaVersion === 1) return data as NotifyState;
  } catch { /* fall through */ }
  return { schemaVersion: 1, jobs: {} };
}

export async function saveNotifyState(path: string, state: NotifyState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}
