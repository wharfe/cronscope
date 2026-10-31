#!/usr/bin/env node
// Runtime smoke for the published tarball on the lowest supported Node.
// vitest no longer runs on Node 18, so CI checks the floor here instead:
// install the packed tarball into a throwaway consumer, run the CLI in an
// isolated HOME/PATH/env, and judge by the JSON it saves (not by stdout).
// Spec: docs/design-debate/vitest4-ci-node/spec.md
// Usage: node scripts/smoke-package.mjs <absolute path to cronscope-*.tgz>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_NODE = 'v18.11.0';
const CLI_TIMEOUT_MS = 30_000;
const KNOWN_CONNECTORS = ['crontab', 'systemd', 'github-actions', 'cloudflare', 'hermes', 'launchd'];
const EXPECTED_STATE = {
  hermes: 'available',
  'github-actions': 'degraded',
  cloudflare: 'skipped',
  crontab: 'unavailable',
  systemd: 'unavailable',
  launchd: 'unavailable',
};
const REQUIRED_PACKAGES = ['cron-parser', 'cronscope', 'luxon', 'yaml'];
const DEV_ONLY_PACKAGES = ['vitest', '@vitest', 'typescript', 'tsx', 'vite'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Spawn and collect; on timeout SIGKILL the child and report it as a failure.
function run(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : (code ?? -1), signal, stdout, stderr, timedOut });
    });
  });
}

function describe(r) {
  return `code=${r.code} timedOut=${r.timedOut}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

function assertRuntime() {
  console.log(`node ${process.version} at ${process.execPath}`);
  assert.equal(process.version, EXPECTED_NODE, `smoke must run on ${EXPECTED_NODE}`);
}

async function installConsumer(tgz) {
  const dir = await mkdtemp(join(tmpdir(), 'cronscope-consumer-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'smoke-consumer', private: true }));
  // Run npm on this very node so --engine-strict judges against the floor,
  // not whatever `node` PATH would resolve for npm's shebang.
  const npmCli = join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  // Keep PATH and the like, but not the real HOME: no ~/.npmrc (registry,
  // auth tokens), no ~/.npm cache, no tokens.
  const npmHome = await mkdtemp(join(tmpdir(), 'cronscope-npm-home-'));
  const userconfig = join(npmHome, '.npmrc');
  await writeFile(userconfig, '');
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CRONSCOPE_') || k.toLowerCase().startsWith('npm_config_') || ['GITHUB_TOKEN', 'GH_TOKEN', 'NODE_AUTH_TOKEN'].includes(k)) delete env[k];
  }
  Object.assign(env, { HOME: npmHome, npm_config_userconfig: userconfig, npm_config_cache: join(npmHome, 'cache') });
  const args = [npmCli, 'install', '--omit=dev', '--engine-strict', '--no-audit', '--no-fund', tgz];
  const r = await run(process.execPath, args, { cwd: dir, env }, 300_000);
  if (r.code !== 0) {
    const ls = await run(process.execPath, [npmCli, 'ls', '--all'], { cwd: dir, env }, 60_000);
    throw new Error(`npm install failed\n${describe(r)}\n--- npm ls --all ---\n${ls.stdout}${ls.stderr}`);
  }
  // Not an exact set: a range-compatible upstream release may add a
  // transitive dependency, which is not this repo's regression.
  const installed = (await readdir(join(dir, 'node_modules'))).filter((n) => !n.startsWith('.'));
  for (const name of REQUIRED_PACKAGES) assert.ok(installed.includes(name), `consumer is missing ${name}`);
  for (const name of DEV_ONLY_PACKAGES) assert.ok(!installed.includes(name), `consumer got dev-only ${name}`);
  return join(dir, 'node_modules', 'cronscope');
}

async function makeFixtureHome() {
  const root = await mkdtemp(join(tmpdir(), 'cronscope-smoke-'));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const emptyBin = join(root, 'empty-bin');
  const repo = join(root, 'repo');
  const tmp = join(root, 'tmp');
  for (const d of [cwd, emptyBin, tmp, join(home, '.hermes', 'cron'), join(home, '.config', 'cronscope'), join(repo, '.github', 'workflows')]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(home, '.hermes', 'cron', 'jobs.json'), JSON.stringify({
    jobs: [{
      id: 'smoke1', name: 'smoke', enabled: true,
      schedule: { kind: 'cron', expr: '0 0 * * *' },
      next_run_at: '2099-01-01T00:00:00.000Z',
    }],
  }));
  await writeFile(join(home, '.config', 'cronscope', 'config.json'), JSON.stringify({ scanRoots: [repo] }));
  await writeFile(join(repo, '.github', 'workflows', 'daily.yml'),
    'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n');
  return { home, cwd, emptyBin, tmp, stateDir: join(home, '.config', 'cronscope') };
}

// The env is replaced, never inherited: runner/dev tokens and the Slack
// webhook must not reach the CLI.
function runCli(pkgDir, fx, args) {
  const env = { HOME: fx.home, PATH: fx.emptyBin, TZ: 'UTC', TMPDIR: fx.tmp };
  return run(process.execPath, [join(pkgDir, 'dist', 'cli.js'), ...args], { cwd: fx.cwd, env }, CLI_TIMEOUT_MS);
}

function checkSnapshot(snap, label) {
  assert.equal(snap.schemaVersion, 1, `${label}: state.json schemaVersion`);
  // Every connector, including ones added later: a throw is a failure.
  for (const [name, c] of Object.entries(snap.connectors ?? {})) {
    assert.equal(c.thrownBy, undefined, `${label}: connector ${name} threw (${c.thrownBy}: ${c.reason})`);
  }
  for (const name of KNOWN_CONNECTORS) {
    const c = snap.connectors?.[name];
    assert.ok(c, `${label}: connector ${name} missing`);
    assert.equal(c.state, EXPECTED_STATE[name], `${label}: connector ${name} state (reason: ${c.reason})`);
  }
  const hermes = snap.jobs.find((j) => j.id === 'hermes|smoke1');
  assert.ok(hermes, `${label}: job hermes|smoke1 missing`);
  assert.equal(hermes.schedule?.kind, 'cron', `${label}: hermes schedule kind`);
  const gha = snap.jobs.filter((j) => j.source === 'github-actions');
  assert.equal(gha.length, 1, `${label}: github-actions job count`);
  assert.equal(gha[0].schedule?.nextRunSource, 'computed', `${label}: gha nextRunSource`);
  assert.match(String(gha[0].schedule?.nextRun), ISO, `${label}: gha nextRun`);
}

async function checkPackage(pkgDir) {
  assert.ok(await exists(join(pkgDir, 'dist', 'cli.js')), 'dist/cli.js missing in installed package');
  const pkg = await readJson(join(pkgDir, 'package.json'));
  assert.equal(pkg.bin?.cronscope, 'dist/cli.js', 'bin.cronscope');
}

async function checkScan(pkgDir, fx) {
  const r = await runCli(pkgDir, fx, ['scan']);
  assert.equal(r.code, 0, `scan failed\n${describe(r)}`);
  checkSnapshot(await readJson(join(fx.stateDir, 'state.json')), 'scan');
}

async function checkCheck(pkgDir, fx) {
  // Drop scan's snapshot so a passing state.json here must come from check.
  await rm(join(fx.stateDir, 'state.json'));
  const r = await runCli(pkgDir, fx, ['check']);
  assert.equal(r.code, 0, `check failed\n${describe(r)}`);
  checkSnapshot(await readJson(join(fx.stateDir, 'state.json')), 'check');
  for (const f of ['notify-state.json', 'gha-freshness.json']) {
    assert.equal((await readJson(join(fx.stateDir, f))).schemaVersion, 1, `check: ${f} schemaVersion`);
  }
  assert.ok(!(await exists(join(fx.stateDir, 'check.lock'))), 'check: check.lock left behind');
}

async function checkUnknownCommand(pkgDir, fx) {
  const r = await runCli(pkgDir, fx, ['nosuch']);
  assert.equal(r.code, 2, `unknown command must exit 2\n${describe(r)}`);
}

// anySignal is the hand-rolled stand-in for AbortSignal.any (Node 20.3+).
// Pass an init.signal so the composition path actually runs: with none,
// anySignal returns the abort signal unchanged.
async function checkAbortCompose(pkgDir) {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init) => { seen = init?.signal; return { ok: true }; };
  try {
    const { makeCtx } = await import(pathToFileURL(join(pkgDir, 'dist', 'runtime.js')).href);
    const controller = new AbortController();
    const ctx = makeCtx([], controller.signal);
    await ctx.fetch('http://127.0.0.1:9/', { signal: AbortSignal.timeout(60_000) });
    assert.ok(seen, 'fetch got no signal');
    assert.notEqual(seen, controller.signal, 'signal was not composed');
    assert.equal(seen.aborted, false, 'composed signal aborted too early');
    controller.abort();
    assert.equal(seen.aborted, true, 'composed signal did not follow the abort');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ctx.run under an abort kills the child and resolves only after it closed.
// The child records its pid, so the check can tell "started, then stopped"
// apart from "never started" and from "resolved while the child still lives".
async function checkAbortRun(pkgDir) {
  const { makeCtx } = await import(pathToFileURL(join(pkgDir, 'dist', 'runtime.js')).href);
  const pidFile = join(await mkdtemp(join(tmpdir(), 'cronscope-abort-')), 'pid');
  const controller = new AbortController();
  const ctx = makeCtx([], controller.signal);
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1e3);`;
  let settled = false;
  const p = ctx.run([process.execPath, '-e', script]).finally(() => { settled = true; });
  let pid;
  try {
    for (let waited = 0; pid === undefined; waited += 50) {
      if (waited >= 5_000) throw new Error('child never started (no pid file within 5s)');
      if (settled) throw new Error(`ctx.run settled before the child started: ${JSON.stringify(await p)}`);
      await new Promise((r) => setTimeout(r, 50));
      try { pid = Number(await readFile(pidFile, 'utf8')) || undefined; } catch { /* not yet */ }
    }
    assert.equal(settled, false, 'ctx.run settled before abort');
    controller.abort();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ctx.run did not settle within 5s of abort')), 5_000); });
    const r = await Promise.race([p, deadline]).finally(() => clearTimeout(timer));
    assert.notEqual(r.code, 0, 'aborted child reported success');
    assert.equal(isAlive(pid), false, `ctx.run resolved while child ${pid} was still alive`);
  } finally {
    controller.abort(); // also stops a child that started after the pid wait gave up
    if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

async function main() {
  const tgz = process.argv[2];
  if (!tgz) { console.error('usage: smoke-package.mjs <tgz>'); return 2; }
  let pkgDir;
  let fx;
  const steps = [
    ['runtime', async () => assertRuntime()],
    ['install', async () => { pkgDir = await installConsumer(tgz); }],
    ['package', async () => checkPackage(pkgDir)],
    ['scan', async () => { fx = await makeFixtureHome(); await checkScan(pkgDir, fx); }],
    ['check', async () => checkCheck(pkgDir, fx)],
    ['unknown-command', async () => checkUnknownCommand(pkgDir, fx)],
    ['abort-compose', async () => checkAbortCompose(pkgDir)],
    ['abort-run', async () => checkAbortRun(pkgDir)],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (e) {
      console.error(`FAIL ${name}: ${e?.stack ?? e}`);
      return 1;
    }
  }
  return 0;
}

// Exit explicitly: a failed abort check can leave a child keeping the loop alive.
main().then((rc) => process.exit(rc), (e) => { console.error(e); process.exit(1); });
