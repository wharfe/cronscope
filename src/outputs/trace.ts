import type { Job } from '../types.js';

// One line per GitHub Actions job whose verdict came from a concrete run. The
// snapshot keeps only the latest check, so this line -- appended to the launchd
// log every hour -- is what lets a false FAILURE be traced back to the run id
// and attempt it was judged on (wharfe/cronscope#4). Pure: no I/O.
//
// Tokens are `key=value`. `name=` comes last because a workflow path may
// contain spaces, so a reader takes everything after the first ` name=` as the
// name. Times are the ISO UTC strings already in the snapshot. `null` is the
// literal word (GitHub never returns the string "null").
export function runIdentityLines(jobs: Job[]): string[] {
  const out: string[] = [];
  for (const j of jobs) {
    if (j.source !== 'github-actions' || !j.lastRun?.run) continue;
    const r = j.lastRun.run;
    out.push(
      `# gha job=${j.id} run=${r.id} judged_attempt=${r.judgedAttempt} latest_attempt=${r.latestAttempt}`
      + ` conclusion=${r.conclusion ?? 'null'} latest_conclusion=${r.latestConclusion ?? 'null'}`
      + ` state=${j.state ?? '-'} status=${j.lastRun.status}`
      + ` created=${j.lastRun.at ?? '-'} fetched=${j.lastRun.fetchedAt} name=${j.name}`,
    );
  }
  return out;
}

// One line per GitHub Actions job whose listing was compared with a baseline
// and came back older (wharfe/cronscope#4), including the ones a re-fetch
// recovered. Numbers, times and fixed words only, `name=` last as above.
// `streak` is the count the check is allowed to notify on (the saved one).
export function freshnessLines(jobs: Job[], streakFor: (id: string) => number | undefined): string[] {
  const out: string[] = [];
  for (const j of jobs) {
    const f = j.lastRun?.freshness;
    if (j.source !== 'github-actions' || !f) continue;
    const o = j.lastRun?.lastObserved;
    const pages = f.pages.map((p) => `${p.n}/${p.newest ?? '-'}/${p.oldest ?? '-'}/${p.total ?? '-'}`).join(',');
    out.push(
      `# gha-freshness job=${j.id} outcome=${f.state} streak=${streakFor(j.id) ?? '-'} retries=${f.retries}`
      + ` probe=${f.probe ?? '-'} stop=${f.stop ?? '-'} mark_run=${o?.runId ?? '-'} mark_created=${o?.createdAt ?? '-'}`
      + ` pages=${pages} name=${j.name}`,
    );
  }
  return out;
}
