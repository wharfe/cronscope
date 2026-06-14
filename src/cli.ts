#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { makeCtx } from './runtime.js';
import { runScan } from './pipeline.js';
import { bootAt } from './core/host.js';
import { resolveConfig, type RawConfig } from './config.js';
import { crontabConnector } from './connectors/crontab.js';
import { systemdConnector } from './connectors/systemd.js';
import { githubActionsConnector } from './connectors/github-actions.js';
import { cloudflareConnector } from './connectors/cloudflare.js';
import { hermesConnector } from './connectors/hermes.js';
import { loadNotifyState, saveNotifyState } from './store/notify-state.js';
import { saveSnapshot } from './store/snapshot.js';
import { evaluate } from './core/evaluate.js';
import { formatDigest, sendSlack } from './outputs/slack.js';
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
      console.log(`${j.source.padEnd(15)} ${j.name.padEnd(40)} ${j.schedule.nextRun ?? '-'}  [${j.lastRun?.status ?? 'unknown'}]`);
    }
    for (const [k, v] of Object.entries(snap.connectors)) if (v!.state !== 'available') console.log(`# ${k}: ${v!.state} (${(v as any).reason ?? ''})`);
  } else if (cmd === 'serve') {
    const port = Number(process.argv[3] ?? 8787);
    serveSnapshot(async () => (await doScan()).snap, port);
    console.log(`cronscope serving on http://localhost:${port}`);
  } else if (cmd === 'check') {
    const { snap, cfg, ctx } = await doScan();
    const { failures, overdues } = evaluate(snap.jobs, { now: ctx.now(), bootAt: snap.host.bootAt, graceMinutes: cfg.graceMinutes });
    const state = await loadNotifyState(NOTIFY_PATH);
    const current = new Map<string, 'failure' | 'overdue'>();
    failures.forEach(j => current.set(j.id, 'failure'));
    overdues.forEach(j => current.set(j.id, 'overdue'));
    const newly = [...current].filter(([id, st]) => state.jobs[id]?.status !== st);
    if (newly.length) {
      const webhook = process.env.CRONSCOPE_SLACK_WEBHOOK_URL;
      const text = formatDigest(
        newly.filter(([, s]) => s === 'failure').map(([id]) => failures.find(j => j.id === id)!),
        newly.filter(([, s]) => s === 'overdue').map(([id]) => overdues.find(j => j.id === id)!),
      );
      if (webhook) await sendSlack(ctx.fetch, webhook, text);
      else console.log('[no CRONSCOPE_SLACK_WEBHOOK_URL] would notify:\n' + text);
    }
    const at = ctx.now().toISOString();
    state.lastCheckAt = at;
    state.jobs = {};
    for (const [id, st] of current) state.jobs[id] = { status: st, notifiedAt: at };
    await saveNotifyState(NOTIFY_PATH, state);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
