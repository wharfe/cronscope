#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { setMaxListeners } from 'node:events';
import type { Snapshot } from './types.js';
import { makeCtx } from './runtime.js';
import { runScan } from './pipeline.js';
import { bootAt } from './core/host.js';
import { resolveConfig, type RawConfig } from './config.js';
import { crontabConnector } from './connectors/crontab.js';
import { systemdConnector } from './connectors/systemd.js';
import { githubActionsConnector } from './connectors/github-actions.js';
import { cloudflareConnector } from './connectors/cloudflare.js';
import { hermesConnector } from './connectors/hermes.js';
import { launchdConnector } from './connectors/launchd.js';
import {
  loadNotifyState, saveNotifyState, noticeKeys, connectorNoticeKeys, noticesToSend, nextNoticeState, jobsForKeys, carryOverJobs,
  freshnessNoticeKeys, freshStoreKey, type FreshStoreProblem,
} from './store/notify-state.js';
import { saveSnapshot } from './store/snapshot.js';
import { loadFreshState, moveCorruptAside, saveFreshState, applyProposals, type FreshState } from './store/gha-freshness.js';
import { acquireCheckLock, lockHeldLine } from './store/check-lock.js';
import { FRESHNESS_DEFAULTS } from './core/freshness.js';
import type { Ctx } from './types.js';
import { evaluate } from './core/evaluate.js';
import { connectorNotices, formatDigest, freshnessNotices, freshStoreNotices, sendSlack, undeterminedNotices } from './outputs/slack.js';
import { freshnessLines, runIdentityLines } from './outputs/trace.js';
import { serveSnapshot } from './outputs/web.js';

const CONNECTORS = [crontabConnector, systemdConnector, githubActionsConnector, cloudflareConnector, hermesConnector, launchdConnector];
const CFG_DIR = join(homedir(), '.config', 'cronscope');
const SNAP_PATH = join(CFG_DIR, 'state.json');
const NOTIFY_PATH = join(CFG_DIR, 'notify-state.json');
const FRESH_PATH = join(CFG_DIR, 'gha-freshness.json');
const LOCK_PATH = join(CFG_DIR, 'check.lock');
// Provisional (D3). At the deadline, or on SIGINT / SIGTERM, the check aborts
// every fetch and child process it started and waits up to STOP_GRACE_MS for
// its own work to settle; only then is the lock released. Work that does not
// settle in time keeps the lock, for a person to clear (README).
const CHECK_DEADLINE_MS = 600_000;
const STOP_GRACE_MS = 15_000;

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

class CheckAborted extends Error {}

async function loadConfig() {
  let raw: RawConfig = {};
  try { raw = JSON.parse(await readFile(join(CFG_DIR, 'config.json'), 'utf8')); } catch { /* defaults */ }
  return resolveConfig(raw, { homeDir: homedir(), env: process.env });
}

async function doScan(freshness?: Ctx['freshness'], abort?: AbortSignal) {
  const cfg = await loadConfig();
  const ctx = makeCtx(cfg.scanRoots, abort);
  if (freshness) ctx.freshness = freshness;
  const snap = await runScan(CONNECTORS, ctx, await bootAt(ctx));
  // An aborted check's scan is full of cancelled fetches; do not display it.
  if (abort?.aborted) throw new CheckAborted('check aborted');
  await saveSnapshot(SNAP_PATH, snap);
  return { snap, cfg, ctx };
}

// scan / serve compare against what the last check saved, and nothing more:
// no re-fetch, no streak, no write (only check writes the freshness state).
async function readerFreshness(): Promise<Ctx['freshness']> {
  const got = await loadFreshState(FRESH_PATH, 'reader');
  if (got.kind === 'unsupported') return undefined;
  return { mode: 'reader', entries: got.state.entries, proposals: new Map() };
}

async function main() {
  const cmd = process.argv[2] ?? 'scan';
  if (cmd === 'scan') {
    const { snap } = await doScan(await readerFreshness());
    for (const j of snap.jobs) {
      const flag = j.state && j.state !== 'active' ? `  (${j.state})` : '';
      const extra = j.source === 'launchd'
        ? `  ${j.schedule.kind} gap=${j.schedule.maxGapSeconds ?? '-'} start=${j.lastRun?.startedAt ?? '-'} end=${j.lastRun?.at ?? '-'} rc=${j.lastRun?.exitCode ?? '-'}`
        : '';
      console.log(`${j.source.padEnd(15)} ${j.name.padEnd(40)} ${j.schedule.nextRun ?? '-'}  [${j.lastRun?.status ?? 'unknown'}]${flag}${extra}`);
    }
    for (const [k, v] of Object.entries(snap.connectors)) if (v!.state !== 'available') console.log(`# ${k}: ${v!.state} (${(v as any).reason ?? ''})`);
    for (const n of undeterminedNotices(snap.jobs)) console.log(`# ${n}`);
  } else if (cmd === 'serve') {
    const port = Number(process.argv[3] ?? 8787);
    // discover() now calls the GitHub API (~15 requests per scan). Serving a
    // fresh scan per request would burn the 5000/h budget from one open tab and
    // starve `check` into reporting everything as undetermined.
    // Single-flight: the check-then-assign has an await between its halves, so
    // without holding the in-flight promise two concurrent requests both scan.
    let cached: { at: number; snap: Promise<Snapshot> } | null = null;
    serveSnapshot(async () => {
      if (!cached || Date.now() - cached.at >= 60_000) {
        cached = { at: Date.now(), snap: readerFreshness().then((f) => doScan(f)).then((r) => r.snap) };
      }
      return cached.snap;
    }, port);
    console.log(`cronscope serving on http://localhost:${port}`);
  } else if (cmd === 'check') {
    await lockedCheck();
  } else if (cmd === 'gha-freshness') {
    await releaseCommand(process.argv.slice(3));
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
// One check at a time (src/store/check-lock.ts). Failing to get the lock
// writes nothing at all -- no snapshot, no state, no Slack.
async function lockedCheck() {
  // Stopping is: abort -> wait for this check's own work to settle -> release.
  // Never release first: the next check could then run alongside the rest of
  // this one. After the abort nothing new is saved or sent; a write already
  // under way is awaited. Handlers go in BEFORE the lock is taken and come out
  // only after it is released, so no signal falls into a gap between the two.
  const controller = new AbortController();
  // One listener per fetch is added to this signal (runtime.ts anySignal).
  setMaxListeners(0, controller.signal);
  let why: 'deadline' | NodeJS.Signals | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: 'deadline' | NodeJS.Signals) => {
    if (why) return;
    why = reason;
    console.log(reason === 'deadline'
      ? '# check exceeded 600s; stopping its work before releasing the lock'
      : `# check: received ${reason}; stopping its work before releasing the lock`);
    controller.abort();
    grace = setTimeout(() => {
      console.log('# check: its work did not stop in time; exiting WITHOUT releasing the lock (README)');
      process.exit(1);
    }, STOP_GRACE_MS);
    // Not unref'd: a check stuck on a promise that holds nothing open must
    // still end with rc 1 here, not drift out as a silent rc 0.
  };
  const onSignal = (s: NodeJS.Signals) => stop(s);
  for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
  const lock = await acquireCheckLock(LOCK_PATH, new Date());
  if (!lock.ok) {
    for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    console.log(lockHeldLine(lock, 'check'));
    process.exit(lock.suspect ? 1 : 75);
    return;
  }
  // Not unref'd either: a check stuck on a promise that holds nothing open
  // must still reach stop() rather than drift out as a silent rc 0.
  const deadline = setTimeout(() => stop('deadline'), CHECK_DEADLINE_MS);
  let failed = false;
  let error: unknown;
  try {
    failed = await runCheck(controller.signal);
  } catch (e) {
    error = e;
  } finally {
    clearTimeout(deadline);
  }
  // Every await of runCheck has settled here, aborted or not.
  await lock.release();
  for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
  if (grace) clearTimeout(grace);
  if (why) process.exit(why === 'SIGINT' ? 130 : why === 'SIGTERM' ? 143 : why === 'SIGHUP' ? 129 : 1);
  else if (error) throw error;
  else if (failed) process.exit(1);
}

// Returns true when the check completed but must end non-zero (the freshness
// state could not be saved).
async function runCheck(abort: AbortSignal): Promise<boolean> {
  const halt = () => { if (abort.aborted) throw new CheckAborted('check aborted'); };
  const state = await loadNotifyState(NOTIFY_PATH);
  const problems = new Set<FreshStoreProblem>();
  halt();
  const loaded = await loadFreshState(FRESH_PATH, 'writer');
  let prevFresh: FreshState | undefined;
  if (loaded.kind === 'unsupported') {
    problems.add('unsupported');
    console.log('# run freshness: state file unreadable or of an unknown version; left untouched, freshness off');
  } else {
    let usable = true;
    if (loaded.kind === 'corrupt') {
      // The move aside is a write: only now, right after an abort check, and
      // never inside the load (an abort can land while the file is read).
      halt();
      problems.add('corrupt');
      const moved = await moveCorruptAside(FRESH_PATH);
      console.log(moved
        ? '# run freshness: state file was corrupt, moved to gha-freshness.json.corrupt; starting empty'
        : '# run freshness: state file is corrupt and could not be moved aside; left untouched, freshness off');
      // Overwriting a corrupt file that is still in place would destroy the
      // only evidence of what went wrong.
      usable = moved;
    } else if (loaded.kind === 'ok' && loaded.dropped) {
      problems.add('corrupt');
      console.log(`# run freshness: dropped ${loaded.dropped} malformed entries`);
    }
    if (usable) prevFresh = loaded.state;
  }
  const freshCtx: Ctx['freshness'] = prevFresh ? { mode: 'writer', entries: prevFresh.entries, proposals: new Map() } : undefined;

  halt();
  const { snap, cfg, ctx } = await doScan(freshCtx, abort);
  halt();   // an aborted scan is full of "aborted" fetches: judge nothing from it
  const at = ctx.now().toISOString();

  // Saved BEFORE Slack: the streak counts observations, not deliveries, so a
  // rejected webhook must not cost it. Only a saved count may be notified on.
  let saved = false;
  let nextFresh: FreshState | undefined;
  if (prevFresh && freshCtx) {
    const present = new Set(snap.jobs.filter((j) => j.source === 'github-actions').map((j) => j.id));
    // Forgetting unseen entries is only safe when the connector really ran:
    // while it is down every job is unseen, baselines included.
    const ghaState = snap.connectors['github-actions']?.state;
    nextFresh = applyProposals(prevFresh, freshCtx.proposals, present, at,
      { forget: ghaState === 'available' || ghaState === 'degraded' });
    try {
      await saveFreshState(FRESH_PATH, nextFresh);
      saved = true;
    } catch {
      problems.add('unsaved');
      console.log('# run freshness: could not save the state file; this check is not counted (README)');
    }
  }
  // A check whose save failed is not counted: it notifies on the count the
  // last SAVED check left, and its own observation is lost (README).
  const streakFor = (id: string): number => {
    if (!prevFresh) return 0;
    return (saved ? nextFresh! : prevFresh).entries[id]?.streak ?? 0;
  };
  // An unsaved check judges keys on saved data only: its own "resolved" is as
  // lost as its own count, so it does not drop a standing key either.
  const resetThisCheck = (id: string) => saved && freshCtx?.proposals.get(id)?.op === 'reset';
  const freshInfo = (id: string) => {
    const p = freshCtx?.proposals.get(id);
    const e = (saved ? nextFresh : prevFresh)?.entries[id];
    const outcome = p?.outcome ?? e?.lastOutcome;
    return { streak: streakFor(id), outcome, notFound: p?.outcome ? !!p.notFound : !!e?.notFound };
  };

  const { failures, overdues } = evaluate(snap.jobs, { now: ctx.now(), bootAt: snap.host.bootAt, graceMinutes: cfg.graceMinutes });
  const current = new Map<string, 'failure' | 'overdue'>();
  failures.forEach(j => current.set(j.id, 'failure'));
  overdues.forEach(j => current.set(j.id, 'overdue'));
  const newly = [...current].filter(([id, st]) => state.jobs[id]?.status !== st);

  // Everything goes to stdout every run -- it lands in the journal and costs
  // nothing. Only Slack is deduped, because that is where repetition hurts.
  // The original incident was a notice that fired once and was missed, so an
  // ongoing problem must stay visible somewhere.
  const notices = undeterminedNotices(snap.jobs);
  for (const n of notices) console.log(`# ${n}`);
  for (const [k, v] of Object.entries(snap.connectors)) {
    if (v!.state !== 'available') console.log(`# ${k}: ${v!.state} (${(v as any).reason ?? ''})`);
  }
  for (const j of failures) console.log(`FAILURE  [${j.source}] ${j.name}`);
  for (const j of overdues) console.log(`OVERDUE  [${j.source}] ${j.name}${j.state ? ` (${j.state})` : ''}`);
  // Printed before anything that can throw (sendSlack below), so a rejected
  // webhook never costs the record of which run this hour's verdict came from.
  for (const line of runIdentityLines(snap.jobs)) console.log(line);
  for (const line of freshnessLines(snap.jobs, streakFor)) console.log(line);

  // One set for every kind: nextNoticeState drops every key it is not given,
  // so updating them separately would erase each other's send times.
  const keys = [
    ...noticeKeys(snap.jobs),
    ...(prevFresh ? freshnessNoticeKeys(snap.jobs, streakFor, resetThisCheck, FRESHNESS_DEFAULTS.threshold) : []),
    ...connectorNoticeKeys(snap.connectors),
    ...[...problems].map(freshStoreKey),
  ];
  const toSend = noticesToSend(state.notices, keys, ctx.now());

  // Nothing to say counts as delivered; anything else has to actually reach
  // Slack before the state advances. Recording an undelivered alert as sent
  // means it is never sent again until the job changes state -- and with no
  // webhook configured that would also swallow every failure standing at the
  // moment one is finally configured.
  halt();
  let delivered = !(newly.length || toSend.length);
  if (!delivered) {
    const webhook = process.env.CRONSCOPE_SLACK_WEBHOOK_URL;
    const text = formatDigest(
      newly.filter(([, s]) => s === 'failure').map(([id]) => failures.find(j => j.id === id)!),
      newly.filter(([, s]) => s === 'overdue').map(([id]) => overdues.find(j => j.id === id)!),
      [
        ...undeterminedNotices(jobsForKeys(snap.jobs, toSend)),
        ...freshnessNotices(toSend, snap.jobs, freshInfo),
        ...connectorNotices(toSend),
        ...freshStoreNotices(toSend),
      ],
    );
    if (webhook) {
      await sendSlack(ctx.fetch, webhook, text);   // throws unless Slack accepted it (or the check was aborted)
      delivered = true;
    } else {
      console.log('[no CRONSCOPE_SLACK_WEBHOOK_URL] would notify:\n' + text);
    }
  }
  state.lastCheckAt = at;
  state.jobs = carryOverJobs(state.jobs, snap.jobs, snap.connectors, current, at);
  // Only the alerts we failed to deliver stay pending. Skipping the whole
  // save would also discard OTHER jobs' recoveries, and a job still recorded
  // as failing never reads as `newly` when it fails again -- the alert would
  // be lost permanently rather than retried.
  if (!delivered) for (const [id] of newly) delete state.jobs[id];
  // Keep the old notifiedAt when we deliberately stayed quiet, or the 24h
  // re-send timer would reset every hour and never elapse.
  state.notices = nextNoticeState(state.notices, keys, delivered ? toSend : [], at);
  halt();
  await saveNotifyState(NOTIFY_PATH, state);
  return problems.has('unsaved');
}

const RELEASE_USAGE = 'usage: cronscope gha-freshness release <job id> --repo <owner/repo> --workflow-id <id> --run <run id> [--yes]';
const RELEASE_WARNING = [
  '# Releasing a run-freshness baseline is NOT a confirmation that the workflow recovered.',
  '# The next check treats this job as seen for the first time: whatever the listing returns then becomes',
  '# the new baseline -- an old failure included, which can then be notified as a FAILURE.',
  '# Release only after confirming on GitHub that the baseline run is really gone. notify-state is not touched.',
];

// D1: release ONE job's baseline, under the check lock, only when the job id,
// repo, workflow id and baseline run id all match what is saved. Anything else
// changes nothing; there is no "release everything" fallback.
async function releaseCommand(args: string[]) {
  const [sub, jobId, ...rest] = args;
  const opt = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const repo = opt('--repo');
  const wf = Number(opt('--workflow-id'));
  const run = Number(opt('--run'));
  if (sub !== 'release' || !jobId || !repo || !Number.isInteger(wf) || wf <= 0 || !Number.isInteger(run) || run <= 0) {
    console.error(RELEASE_USAGE);
    process.exit(2);
    return;
  }
  for (const l of RELEASE_WARNING) console.log(l);
  const yes = rest.includes('--yes');
  const matches = (st: FreshState) => {
    const e = st.entries[jobId];
    return !!e && e.identity.repo === repo && e.identity.workflowId === wf && e.baseline?.runId === run;
  };
  if (!yes) {
    const got = await loadFreshState(FRESH_PATH, 'reader');
    const ok = got.kind === 'ok' && matches(got.state);
    console.log(ok ? `# dry run: would release the baseline of ${jobId} (run ${run}). Add --yes to do it; nothing was changed`
      : '# dry run: no saved baseline matches that job id, repo, workflow id and run; nothing was changed');
    process.exit(ok ? 0 : 2);
    return;
  }
  const lock = await acquireCheckLock(LOCK_PATH, new Date());
  if (!lock.ok) {
    console.log(lockHeldLine(lock, 'release'));
    process.exit(lock.suspect ? 1 : 75);
    return;
  }
  let code = 0;
  try {
    // Read as a reader: a corrupt file is refused here, not moved aside.
    const got = await loadFreshState(FRESH_PATH, 'reader');
    if (got.kind === 'missing') {
      console.log('# release: no saved baseline matches that job id, repo, workflow id and run; nothing was changed');
      code = 2;
    } else if (got.kind !== 'ok' || got.dropped > 0) {
      // Saving would silently drop every malformed entry along with this one.
      console.log('# release: the freshness state file is corrupt or of an unknown version; nothing was changed');
      code = 1;
    } else if (!matches(got.state)) {
      console.log('# release: no saved baseline matches that job id, repo, workflow id and run; nothing was changed');
      code = 2;
    } else {
      const entries = { ...got.state.entries };
      delete entries[jobId];
      // lastCheckAt is left as it was: this is not a check.
      await saveFreshState(FRESH_PATH, { ...got.state, entries });
      console.log(`# release: released the baseline of ${jobId} (run ${run}); the next check treats it as seen for the first time`);
    }
  } finally {
    await lock.release();
  }
  if (code) process.exit(code);
}

main().catch(e => { console.error(e); process.exit(1); });
