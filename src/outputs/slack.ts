import type { Job } from '../types.js';
import { isUndetermined } from '../core/sources.js';
import { connectorOfNoticeKey, jobOfFreshnessKey, freshStoreKey, FRESH_STORE_PROBLEMS } from '../store/notify-state.js';

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

// One fixed line per freshness key being sent (wharfe/cronscope#4). Only the
// job name (as on a FAILURE line), the saved count and a fixed word reach
// Slack -- never a reason string, a status code, a run id or a response.
const FRESH_WORD: Record<string, string> = {
  behind: 'behind', rerunning: 'rerunning', unverified: 'unverified', deferred: 'deferred',
};
export function freshnessNotices(
  sentKeys: string[], jobs: Job[], info: (id: string) => { streak: number; outcome?: string; notFound?: boolean } | undefined,
): string[] {
  const lines: string[] = [];
  for (const k of sentKeys) {
    const id = jobOfFreshnessKey(k);
    const j = id ? jobs.find((x) => x.id === id) : undefined;
    const i = id ? info(id) : undefined;
    if (!j || !i) continue;
    const word = FRESH_WORD[i.outcome ?? ''] ?? 'unconfirmed';
    const tail = i.notFound ? '。基準 run が API で見つからない。削除を確かめたら人が基準を解放する（README）' : '';
    lines.push(`github-actions: ${j.name} の run 鮮度を ${i.streak} 回続けて確認できていない（${word}${tail}。詳細は check のログ）`);
  }
  return lines;
}

const STORE_TEXT: Record<string, string> = {
  unsaved: '鮮度の状態ファイルを保存できなかった。この回の連続回数と基準は残らず、次の回は前に保存した基準で比べる（詳細は check のログ）',
  corrupt: '鮮度の状態ファイルに壊れた部分があった。壊れた部分の基準は失われ、その job は初回扱いになる（ファイルを退避して作り直したか、退避できずに鮮度の判定を止めているかは check のログ）',
  unsupported: '鮮度の状態ファイルを読めない、または知らない版なので触らず、鮮度の判定を止めている（詳細は check のログ）',
};
export function freshStoreNotices(sentKeys: string[]): string[] {
  return FRESH_STORE_PROBLEMS.filter((p) => sentKeys.includes(freshStoreKey(p))).map((p) => `cronscope: ${STORE_TEXT[p]}`);
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
    // A hung webhook would hold the check lock with it.
    signal: AbortSignal.timeout(10_000),
  } as any);
  if (!res?.ok) throw new Error(`Slack webhook responded ${res?.status ?? 'with no status'}`);
}
