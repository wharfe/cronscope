# vitest 4 更新と Node 18.11 配布物検査 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dependabot alert を vitest 4.1.12 で 0 にし、vitest が動かない Node 18.11.0 では配布 tarball を CI で直接検査する。

**Architecture:** テスト一式は Node 22/24 の既存 `test` job。新 job `runtime-compat` が Node 22 で build・型の段・pack をし、同じ job で Node 18.11.0 に切り替えて `scripts/smoke-package.mjs` を実行する。smoke は checkout 外の consumer に tarball を入れ、隔離した HOME/PATH/env で CLI を子プロセス起動し、保存された JSON で合否を決める。

**Tech Stack:** Node（node: 標準モジュールのみ）、npm、GitHub Actions（actions/setup-node@v4）。

**Spec:** `docs/design-debate/vitest4-ci-node/spec.md`（合否表・入口表はここが正本。計画は写さず参照する）

## Global Constraints
- `engines.node` は `>=18.11` のまま。dependencies・src・tsx・typescript・@types/node の範囲・tsconfig*.json は不変。
- smoke の実行版は厳密に `v18.11.0`。型の段は `@types/node@18.11.0`。
- smoke は node: 標準モジュールだけ。テストフレームワークを足さない。`files: ["dist"]` 不変（scripts は配布しない）。
- CLI 子プロセスの env は `HOME`・`PATH`（空ディレクトリ）・`TZ=UTC`・`TMPDIR` だけ。cwd は空の一時ディレクトリ。各 30 秒で打ち切り。
- ci.yml のトリガー・既存 job 名 `test`・action の版・既存ステップの並びは不変。
- 「必須チェック」とは書かない（ブランチ保護は無い）。

## Review Focus
1. runner や開発機の env（`GITHUB_TOKEN`・`CRONSCOPE_SLACK_WEBHOOK_URL` 等）が CLI 子プロセスへ漏れる → 漏れたら github-actions が API を呼ぶ／check が本物の Slack に送る（fixture では OVERDUE が出る）。Task 2 の env を「置き換え」で作ることと、赤の確認（Step 4b）で検出する。
2. smoke が runner の本物の HOME / checkout の `node_modules` を使ってしまう → consumer は `os.tmpdir()` 配下、`NODE_PATH` を渡さない。Task 2 で consumer に vitest/typescript/tsx が無いことを assert。
3. CLI がハングする（ロック待ち・ネットワーク）→ 30 秒で kill して失敗にし、stdout/stderr を出す。
4. 2 回目の setup-node が効かず Node 22 のまま smoke が走る → smoke 冒頭の `process.version` assert（Task 2）と ci の `node --version` ステップ（Task 3）。
5. 型の段の `npm install --no-save` が lockfile を書き換え、以降の pack に混ざる → `git diff --exit-code package.json package-lock.json`（Task 3）。

---

### Task 1: 依存更新と設計記録のコミット

**Files:**
- Modify: `package.json`（devDependencies `vitest: ^4.1.12`。作業ツリーで済み）, `package-lock.json`
- Add: `docs/design-debate/vitest4-ci-node/*`, `docs/superpowers/plans/2026-10-31-vitest4-ci-node.md`

- [ ] **Step 1:** `npm ci && npm run build && npm test` → rc 0、`Tests  347 passed`。
- [ ] **Step 2:** `npm audit` → `found 0 vulnerabilities`。
- [ ] **Step 3:** `git diff package.json` が vitest の行と devDependencies の並び替えだけであることを確認（dependencies・engines に差分なし）。
- [ ] **Step 4: Commit** `chore(deps): vitest を 4.1.12 に上げ Dependabot alert を解消する`（設計記録も同じコミット）。

### Task 2: `scripts/smoke-package.mjs`

**Files:**
- Create: `scripts/smoke-package.mjs`

**Interfaces:**
- Consumes: 引数 1 つ = tarball の絶対パス。
- Produces: rc 0（全検査合格）／rc 1（いずれか失敗。失敗した検査名・assertion・子プロセスの stdout/stderr を stderr に出す）。Task 3 が `node scripts/smoke-package.mjs <tgz>` で呼ぶ。

構成（関数名は固定。中身は実装者）:
- `assertRuntime()` — `process.version === 'v18.11.0'` でなければ失敗。`process.execPath` を出力。
- `installConsumer(tgz: string): Promise<string>` — `mkdtemp(os.tmpdir())` に `{"name":"smoke-consumer","private":true}` を置き、`process.execPath <prefix>/lib/node_modules/npm/bin/npm-cli.js install --omit=dev --engine-strict --no-audit --no-fund <tgz>` を実行（`<prefix>` = `dirname(dirname(process.execPath))`。PATH 上の別の node で npm が走って engine 判定が空振りしないため）。env は継承するが `npm_config_cache` を一時ディレクトリにし、`CRONSCOPE_*`・`GITHUB_TOKEN`・`GH_TOKEN` は消す。失敗時は `npm ls --all` も出す。consumer の `node_modules` 直下のパッケージ集合が `{cronscope, cron-parser, luxon, yaml}` と一致することを assert。consumer のパスを返す。
- `makeFixtureHome(): Promise<{home: string, cwd: string, emptyBin: string, repo: string}>` — spec §変更 3 の fixture（hermes jobs.json、config.json の scanRoots、daily.yml）。
- `runCli(pkgDir, fx, args: string[]): Promise<{code: number, stdout: string, stderr: string}>` — `process.execPath <pkgDir>/dist/cli.js ...args`、env は Global Constraints の 4 つだけ、cwd は `fx.cwd`、30 秒で SIGKILL して失敗扱い。
- `readJson(path)`、`checkSnapshot(snap)` — spec の合否表の connector・状態・job 行。
- `checkAbortCompose(pkgDir)` — spec の「中断の合成」行。fetch スタブは `makeCtx` を呼ぶ**前**に差し替え、`finally` で戻す。`ctx.fetch(url, { signal: AbortSignal.timeout(60000) })` で呼ぶ（init.signal 無しだと `anySignal(undefined, abort)` が abort をそのまま返し合成を通らない: src/runtime.ts:32）。assert: 記録した signal が `controller.signal` と別物、abort 前 `aborted === false`、abort 後 `true`。
- `checkAbortRun(pkgDir)` — 別の controller で `makeCtx([], c.signal)`、`p = ctx.run([process.execPath, '-e', 'setInterval(()=>{},1e3)'])`、200ms 後 `c.abort()`、5 秒以内に解決し `code !== 0`（src/runtime.ts:64 の kill→close 待ちを 18.11 で通す。空 PATH の CLI ではこの分岐を通らない）。

検査の順: runtime → install → パッケージ → scan → check → 未知のサブコマンド → 中断の合成 → 中断の子プロセス。各検査は名前付きで `ok <name>` を stdout に出す。

- [ ] **Step 1: tarball を作る** `npm run build && npm pack --ignore-scripts --json --pack-destination "$SCRATCH"`（`$SCRATCH` は任意の一時ディレクトリ。repo 直下に tgz を置かない）。
- [ ] **Step 2: スクリプトを書く**（上の関数構成。合否の値は spec の表どおり）。
- [ ] **Step 3: 緑** `~/.local/share/mise/installs/node/18.11.0/bin/node scripts/smoke-package.mjs <tgz>` → rc 0、`ok` 行が 8 つ。
- [ ] **Step 4: 赤の確認**（各々実行後に元へ戻す。コミットしない）
  - 4a. Node 22 で実行 → rc 1、runtime の失敗。
  - 4b. 親に `GITHUB_TOKEN=dummy CRONSCOPE_SLACK_WEBHOOK_URL=http://127.0.0.1:9/hook` を付けて実行 → **rc 0**（隔離が効いている証拠）。続けて env 置き換えを一時的に `{...process.env, ...}` に変え、同じ 2 つを明示して実行 → rc 1（github-actions が `available` になる／Slack 送信が接続拒否）。CF のダミーは使わない（api.cloudflare.com へ通信してしまう）。どちらも外部ネットワークに出ない。漏れ版が rc 0 なら判定を見直す。
  - 4c. repo の `dist/runtime.js` の `export function anySignal` 本体で、`if (!b)` / `return a;`（tsc 出力では 2 行）より後ろだけを `return AbortSignal.any([a, b]);` に書き換え、pack し直して実行 → rc 1（Node 18.11 に AbortSignal.any が無い）。終わったら `npm run build` で戻す（consumer は毎回 tgz から作り直されるので consumer 側は書き換えられない）。
  - 4d. fixture の hermes の schedule を文字列にして実行 → rc 1（`schedule.kind` が `interval`）。
- [ ] **Step 5: Commit** `test(ci): Node 18.11.0 で配布 tarball を検査する smoke を足す`。

### Task 3: CI 定義

**Files:**
- Modify: `.github/workflows/ci.yml:13`（matrix）＋ job `runtime-compat` を追記

**Interfaces:**
- Consumes: Task 2 の `scripts/smoke-package.mjs <tgz>`。

`runtime-compat` のステップ（spec §変更 2 の順。値は spec のまま）:
checkout → setup-node `22`（`cache: npm`, `cache-dependency-path: package-lock.json`）→ `npm ci` → `npm run build` →
`npm install --no-save --legacy-peer-deps --no-audit --no-fund @types/node@18.11.0`（vitest/vite の peerOptional `@types/node >=20` と衝突するので `--legacy-peer-deps`。`--package-lock=false` は tsx を lock 外の版へ動かすので付けない）→ `v=$(node -p "require('@types/node/package.json').version"); echo "$v"; test "$v" = 18.11.0`（`npm ls` は invalid で rc 1 になるので使わない）→ `npx tsc -p tsconfig.json --noEmit` →
`git diff --exit-code package.json package-lock.json` →
`name=$(npm pack ... | node -e '<JSON の [0].filename を出す>')` → `TGZ="$RUNNER_TEMP/$name"` → `test -f "$TGZ"` → `echo "TGZ=$TGZ" >> "$GITHUB_ENV"`（代入と書き込みを分け、`$(...)` 内の失敗を隠さない）→
setup-node `18.11.0`（cache なし）→ `node --version` → `node scripts/smoke-package.mjs "$TGZ"`。`timeout-minutes: 15`。

- [ ] **Step 1:** matrix を `[22, 24]` に、`runtime-compat` を追記。
- [ ] **Step 2: ローカル検算** 同じステップ列を手で順に実行（Node 22 → 18.11.0）して全部 rc 0。`npm install --no-save` の後 `git status --short` が空。
- [ ] **Step 3:** `python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/ci.yml"))'` → エラーなし（構文検算）。
- [ ] **Step 4: Commit** `ci: テストを Node 22/24 に移し、Node 18.11.0 は配布物の smoke で確かめる`。

### Task 4: 文書と CI 実走

**Files:**
- Modify: `README.md:17` 節（1 文）
- Create: `docs/specs/2026-10-31-node18-runtime-check.md`

- [ ] **Step 1:** README の「インストール / 使い方」直下に 1 文: 「動作の下限は Node 18.11。テスト一式は Node 22 と 24 で回し、Node 18.11.0 では配った CLI の起動と状態ファイルを CI で検査している（`scripts/smoke-package.mjs`）。」
- [ ] **Step 2:** `docs/specs/2026-10-31-node18-runtime-check.md` に spec の「残存リスク」と検出力の残す／保証しない、型の段がグローバルを見ないこと、新しい `node:` API・グローバルを足す変更はレビューで下限 18.11 を見ること。所要時間の欄は空けておく。
- [ ] **Step 3:** Gate3（`/code-gate`）。
- [ ] **Step 4:** push・PR 作成（ユーザー許可済みの範囲: 依存更新と CI 変更。マージは別途確認）。`gh pr checks --watch` で `test (22)`・`test (24)`・`runtime-compat` が success。`gh run view <id> --json jobs` で job 別所要時間を取り、Step 2 の文書に記入してコミット・push、再度 checks が success。
- [ ] **Step 5:** マージ（ユーザー確認後）→ `gh api repos/wharfe/cronscope/dependabot/alerts -q '[.[]|select(.state=="open")]|length'` が 0。
