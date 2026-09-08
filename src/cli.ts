#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
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
import { loadNotifyState, saveNotifyState, noticeKeys, shouldSendNotices, carryOverJobs } from './store/notify-state.js';
import { saveSnapshot } from './store/snapshot.js';
import { evaluate } from './core/evaluate.js';
import { formatDigest, sendSlack, undeterminedNotices } from './outputs/slack.js';
import { serveSnapshot } from './outputs/web.js';

const CONNECTORS = [crontabConnector, systemdConnector, githubActionsConnector, cloudflareConnector, hermesConnector];
const CFG_DIR = join(homedir(), '.config', 'cronscope');
const SNAP_PATH = join(CFG_DIR, 'state.json');
const NOTIFY_PATH = join(CFG_DIR, 'notify-state.json');

async function loadConfig() {
  let raw: RawConfig = {};
  try { raw = JSON.parse(await readFile(join(CFG_DIR, 'config.json'), 'utf8')); } catch { /* defaults */ }
  return resolveConfig(raw, { homeDir: homedir(), env: process.env });
}

async function doScan() {
  const cfg = await loadConfig();
  const ctx = makeCtx(cfg.scanRoots);
  const snap = await runScan(CONNECTORS, ctx, await bootAt(ctx));
  await saveSnapshot(SNAP_PATH, snap);
  return { snap, cfg, ctx };
}

async function main() {
  const cmd = process.argv[2] ?? 'scan';
  if (cmd === 'scan') {
    const { snap } = await doScan();
    for (const j of snap.jobs) {
      const flag = j.state && j.state !== 'active' ? `  (${j.state})` : '';
      console.log(`${j.source.padEnd(15)} ${j.name.padEnd(40)} ${j.schedule.nextRun ?? '-'}  [${j.lastRun?.status ?? 'unknown'}]${flag}`);
    }
    for (const [k, v] of Object.entries(snap.connectors)) if (v!.state !== 'available') console.log(`# ${k}: ${v!.state} (${(v as any).reason ?? ''})`);
    for (const n of undeterminedNotices(snap.jobs)) console.log(`# ${n}`);
  } else if (cmd === 'serve') {
    const port = Number(process.argv[3] ?? 8787);
    // discover() now calls the GitHub API (~15 requests per scan). Serving a
    // fresh scan per request would burn the 5000/h budget from one open tab and
    // starve `check` into reporting everything as undetermined.
    let cached: { at: number; snap: Snapshot } | null = null;
    serveSnapshot(async () => {
      if (!cached || Date.now() - cached.at >= 60_000) cached = { at: Date.now(), snap: (await doScan()).snap };
      return cached.snap;
    }, port);
    console.log(`cronscope serving on http://localhost:${port}`);
  } else if (cmd === 'check') {
    const { snap, cfg, ctx } = await doScan();
    const { failures, overdues } = evaluate(snap.jobs, { now: ctx.now(), bootAt: snap.host.bootAt, graceMinutes: cfg.graceMinutes });
    const state = await loadNotifyState(NOTIFY_PATH);
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

    const at = ctx.now().toISOString();
    const keys = noticeKeys(snap.jobs);
    const sendNotices = shouldSendNotices(state.notices, keys, ctx.now());

    if (newly.length || sendNotices) {
      const webhook = process.env.CRONSCOPE_SLACK_WEBHOOK_URL;
      const text = formatDigest(
        newly.filter(([, s]) => s === 'failure').map(([id]) => failures.find(j => j.id === id)!),
        newly.filter(([, s]) => s === 'overdue').map(([id]) => overdues.find(j => j.id === id)!),
        sendNotices ? notices : [],
      );
      if (webhook) await sendSlack(ctx.fetch, webhook, text);
      else console.log('[no CRONSCOPE_SLACK_WEBHOOK_URL] would notify:\n' + text);
    }

    state.lastCheckAt = at;
    state.jobs = carryOverJobs(state.jobs, snap.jobs, snap.connectors, current, at);
    // Keep the old notifiedAt when we deliberately stayed quiet, or the 24h
    // re-send timer would reset every hour and never elapse.
    state.notices = keys.length
      ? { keys, notifiedAt: sendNotices ? at : (state.notices?.notifiedAt ?? at) }
      : null;
    await saveNotifyState(NOTIFY_PATH, state);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
