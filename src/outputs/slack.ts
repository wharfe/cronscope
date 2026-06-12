import type { Job } from '../types.js';

export function formatDigest(failures: Job[], overdues: Job[]): string {
  const lines: string[] = [];
  for (const j of failures) lines.push(`:red_circle: FAILURE  [${j.source}] ${j.name} (${j.location})`);
  for (const j of overdues) lines.push(`:warning: OVERDUE  [${j.source}] ${j.name} (${j.location})`);
  return lines.join('\n') || 'cronscope: all clear';
}

export async function sendSlack(fetchFn: typeof fetch, webhookUrl: string, text: string): Promise<void> {
  await fetchFn(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  } as any);
}
