# 確定 spec: vitest 4 更新と Node 18.11 の配布物検査（Gate 1 出力）

裁定: grok（非参加・予約席）。採用は設計 B（codex）＋ A と批評からの移植。下の「裁定から変えた点」は repo 実測で裏を取った修正。

## 守ること（不変条件）
- I1. 利用者への約束 `engines.node >=18.11`（package.json:34）は変えず、CI で **Node 18.11.0** 上の配布 tarball が
  インストールでき、空環境で `scan` と `check` が connector を例外で落とさず状態ファイルを正しい版で書くことを毎回確かめる。
- I2. 開発用テスト一式（`npm test`）は Node 22 と 24 で全件回す。
- I3. Dependabot の open alert を devDependencies の vitest 4.1.12 更新だけで 0 にする（dependencies・engines・src・tsx・typescript・@types/node の範囲は不変。vitest 5 にしない）。
- I4. 検査は外部ネットワーク・トークン・runner の HOME に触れない。トリガー（push main / pull_request）は不変。

## やらないこと
ブランチ保護・ruleset の追加（「必須チェック」とは書かない）／Node 20・18 系最新・26 の実行／`serve`・`gha-freshness release`・本物の GitHub/Cloudflare/Slack／第二のテスト一式。

## 既存の仕組みの確認
npm overrides（tinypool 2 が Node 20+ で同じ問題）、Dependabot 自動 PR（Node 18 CI を解かない）、node:test 移植（347 件、過大）、
setup-node の 1 job 内 2 回呼び（採用）。古い Node で配布物を検査する既製 action は探していない。

## 変更
1. `package.json` / lockfile: `vitest ^4.1.12`（作業ツリーで済み。`npm audit` 0 件を実測）。
2. `ci.yml`: `test` の matrix を `[22, 24]` に（他は不変）。新 job `runtime-compat`（`timeout-minutes: 15`）:
   setup-node 22（cache npm）→ `npm ci` → `npm run build` →
   型の段 `npm install --no-save --legacy-peer-deps --no-audit --no-fund @types/node@18.11.0`、入った版が 18.11.0 であることを確かめる（`npm ls` は invalid で rc 1 になるので使わない）、`npx tsc -p tsconfig.json --noEmit`、
   その後 `git diff --exit-code package.json package-lock.json` →
   `npm pack --ignore-scripts --json --pack-destination "$RUNNER_TEMP"`（パスは JSON の filename から）→
   setup-node `18.11.0`（cache なし）→ `node scripts/smoke-package.mjs <tgz 絶対パス>`。
3. `scripts/smoke-package.mjs`（新規、node: 標準モジュールのみ、配布されない）:
   - 冒頭で `process.version === 'v18.11.0'` を確認。checkout 外の consumer に
     `npm install --omit=dev --engine-strict --no-audit --no-fund <tgz>`。vitest/typescript/tsx が無いことを確認。失敗時は `npm ls --all` を出す。
   - fixture: 一時 HOME に `.hermes/cron/jobs.json`（`schedule: {kind:"cron", expr:"0 0 * * *"}`, id `smoke1`）、
     `.config/cronscope/config.json`（`scanRoots` = 一時 repo 1 つ、`.github/workflows/daily.yml` に cron `0 0 * * *`）。
   - CLI は `process.execPath <consumer>/node_modules/cronscope/dist/cli.js <cmd>`、env は HOME・PATH（空ディレクトリ）・TZ=UTC・TMPDIR のみ、cwd は空の一時ディレクトリ、各 30 秒で打ち切り。stdout の文言は判定に使わない。
   - 合否:
     | 検査 | 合格 |
     |---|---|
     | パッケージ | consumer に `dist/cli.js`、`bin.cronscope === 'dist/cli.js'` |
     | scan | rc 0、`state.json` の `schemaVersion === 1` |
     | check | rc 0、`state.json`・`notify-state.json`・`gha-freshness.json` が `schemaVersion === 1`、`check.lock` が残らない |
     | connector | 既知 6 つ（crontab・systemd・github-actions・cloudflare・hermes・launchd）が全部あり、どれにも `thrownBy` が無い（増えても失敗にしない） |
     | 状態 | `connectors.<name>.state`: hermes=`available`、github-actions=`degraded`、cloudflare=`skipped`、crontab/systemd/launchd=`unavailable` |
     | job | `hermes\|smoke1` の `schedule.kind==='cron'`。github-actions の job 1 つで `schedule.nextRunSource==='computed'`、`schedule.nextRun` が ISO 8601 |
     | 未知のサブコマンド | `nosuch` で rc 2 |
     | 中断の合成 | `globalThis.fetch` をスタブ（受けた signal を記録）に差し替えて**から** consumer の `dist/runtime.js` の `makeCtx([], controller.signal)` を呼ぶ（`realFetch` は makeCtx 内で捕捉: src/runtime.ts:46）。`ctx.fetch(url, {signal: AbortSignal.timeout(60000)})` を 1 回呼ぶ。記録した signal が controller.signal と別物、abort 前は未中断、abort 後は aborted。終わったら fetch を戻す |
     | 中断の子プロセス | `ctx.run([process.execPath,'-e','setInterval(()=>{},1e3)'])` を 200ms 後に abort、5 秒以内に解決し code≠0（src/runtime.ts:64） |
   - `dist/cli.js` は import しない（末尾で `main()` が走る: src/cli.ts:402）。`node --check` は使わない。
4. README に 1 文（下限は Node 18.11。テスト一式は 22/24、18.11 は配布 CLI の起動と状態ファイルを CI で検査）。
5. `docs/specs/2026-10-31-node18-runtime-check.md`: 残すもの／保証しないもの、型の段がグローバル（`AbortSignal.any` 等）を見ないこと、CI 実走後の job 別所要時間。

## 裁定から変えた点（実測根拠）
- snapshot の connector は `status` ではなく `state`、`nextRun` は job 直下ではなく `schedule.nextRun`（Node 18.11.0 で試作して確認）。
- fetch スタブは makeCtx より前に差し替える（`realFetch` の捕捉位置）。
- `cronNext` の内部パス直接 import はやめる。github-actions fixture の `nextRunSource: computed` が同じ計算を配布物経由で通すので重複で、内部配置に縛られるだけ（批評 B の指摘）。

## 試作の実測（Node 18.11.0 / npm 8.19.2、ローカル）
tarball install（cron-parser・luxon・yaml・cronscope の 4 つ、engine-strict で成功）、scan rc 0、check rc 0、nosuch rc 2、
3 状態ファイル schemaVersion 1、hermes=available、github-actions=degraded、job `gha|…` computed / `hermes|smoke1` cron。
型の段（Gate 2 で vitest 4 の lock 上で再測。`--package-lock=false` 版は peer 衝突で rc 1 だったので上の形に修正）: 現 src は rc 0、`node:fs/promises` の `glob` を足すと TS2305 で rc 2（赤→緑を確認済み）。

## 入口表（不変条件が破れうる場所）
| 不変条件 | 場所 | 行 |
|---|---|---|
| I1 | package.json:34 | `"node": ">=18.11"` |
| I1 | src/runtime.ts:29-39 | `anySignal`（「AbortSignal.any is Node 20.3+」の手書き代替） |
| I1 | src/runtime.ts:64 | `execFile(..., { signal: abort })`（check 経路のみ） |
| I1 | src/pipeline.ts:15 | 例外を `unavailable` + `thrownBy` に変換（rc 0 だけでは故障を見逃す理由） |
| I1 | src/cli.ts:402 | `main().catch(...)`（import すると副作用） |
| I1 | src/cli.ts:106 | `unknown command`（rc 2） |
| I2 | .github/workflows/ci.yml:13 | `node: [18, 22]` |
| I3 | package.json:53 / package-lock.json | `"vitest": "^4.1.12"` |
| I4 | src/connectors/github-api.ts:25 | `CRONSCOPE_GH_TOKEN` / `GITHUB_TOKEN` を env から読む |
| I4 | src/connectors/cloudflare.ts:4-5 | `CRONSCOPE_CF_API_TOKEN` / `CRONSCOPE_CF_ACCOUNT_ID` |
| I4 | src/config.ts:14 | scanRoots 既定 `~/dev`（fixture で上書き必須） |
| I4 | src/cli.ts:293 | `CRONSCOPE_SLACK_WEBHOOK_URL`（外部副作用のある唯一の env。fixture の check は OVERDUE を出す） |
| I4 | src/connectors/launchd.ts:103,166 | `CRONSCOPE_LAUNCHAGENTS_DIR` / `XPC_SERVICE_NAME` |
| I4 | src/connectors/github-api.ts:29,39・github-actions.ts:75・cron-log.ts:28 他 | PATH 経由の `gh auth token`・`git`・`crontab`・`systemctl`・`journalctl`・`launchctl`・`id`（空 PATH で遮断） |
| I4 | consumer の npm install | `~/.npm` キャッシュ（`npm_config_cache` を一時ディレクトリに） |

## 受け入れコマンド
1. `npm ci && npm run build && npm test` rc 0、`npm audit` 0 件。
2. ローカルで Node 18.11.0 に対し `node scripts/smoke-package.mjs <tgz>` rc 0。赤の確認: 検査の 1 つを意図的に壊して rc≠0。
3. PR で `test (22)`・`test (24)`・`runtime-compat` が success、所要時間を記録。
4. マージ後 Dependabot open alert 0。

## 残存リスク
Node 18 でのテスト 347 件の振る舞い差のうち、上の経路を通らないもの。型の段はグローバルを見ない。consumer install は registry 最新解決なので依存の engines 変更や一時障害で赤くなりうる（前者は利用者と同じ失敗）。runner が 18.11.0 を取れなくなったら環境起因で落ちる。
