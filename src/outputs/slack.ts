import type { Job } from '../types.js';
import { isUndetermined } from '../core/sources.js';
import { connectorOfNoticeKey } from '../store/notify-state.js';

// One fixed line per connector key being sent. It takes the keys, not the
// connector states, so the exception text (paths, account ids, response
// fragments) cannot reach Slack from here; `check` prints it to stdout.
export function connectorNotices(sentKeys: string[]): string[] {
  const lines: string[] = [];
  for (const k of sentKeys) {
    const id = connectorOfNoticeKey(k);
    if (id) lines.push(`${id}: connector が例外で停止し、この回は job を確認できていない（詳細は check のログ）`);
  }
  return lines;
}

// One line per (source, reason) pair. A job counts only when its source is
// meant to know its status and this run recorded why it could not be read --
// crontab and cloudflare are unknown by construction, which is not a failure to
// report.
export function undeterminedNotices(jobs: Job[]): string[] {
  const counts = new Map<string, number>();
  for (const j of jobs) {
    if (!isUndetermined(j)) continue;
    const key = `${j.source}: ${j.lastRun!.undeterminedReason!}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key} (${n} job${n === 1 ? '' : 's'} undetermined)`);
}

export function formatDigest(failures: Job[], overdues: Job[], notices: string[] = []): string {
  const lines: string[] = [];
  for (const j of failures) lines.push(`:red_circle: FAILURE  [${j.source}] ${j.name} (${j.location})`);
  for (const j of overdues) {
    const why = j.state === 'disabled_inactivity' ? ' — GitHub が無操作により無効化' : '';
    const last = j.lastRun?.status ? ` last=${j.lastRun.status}` : '';
    lines.push(`:warning: OVERDUE  [${j.source}] ${j.name} (${j.location})${why}${last}`);
  }
  for (const n of notices) lines.push(`:grey_question: ${n}`);
  return lines.join('\n') || 'cronscope: all clear';
}

// Throws unless Slack actually accepted it. A 401 / 410 / 429 that resolved
// quietly would let the caller record the alert as delivered, and the next
// state change is the earliest it could ever be sent again.
export async function sendSlack(fetchFn: typeof fetch, webhookUrl: string, text: string): Promise<void> {
  const res: any = await fetchFn(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  } as any);
  if (!res?.ok) throw new Error(`Slack webhook responded ${res?.status ?? 'with no status'}`);
}
