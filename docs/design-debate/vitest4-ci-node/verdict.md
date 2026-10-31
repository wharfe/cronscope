判定の前に、両案と批評が前提にしている実装（例外の握りつぶし、`check` の経路、CLI の起動、CI の形）をリポジトリで確認します。**判定: 採用するのは設計 B（Codex）です。** 利用者への約束は「Node 18.11 以上で、配った CLI が動く」ことなので、検査は vitest が動く Node と、配布物を動かす Node を分け、下限は浮動の `18` ではなく `18.11.0` に固定します。設計 A の合格条件（終了コード 0 と、コネクタ名が出力に出ること）は、このコードでは故障を成功と見なします。`src/pipeline.ts` はコネクタ内部の例外を捕捉して `unavailable` に変え、`thrownBy` を付けたうえで scan は 0 で終わります。加えて A の「dist の全 `.js` を `import()`」は `src/cli.ts` 末尾の `main()` を実行し、ランナーの普段のホームに状態ファイルを書きます。B はスナップショットの `thrownBy` と、checkout の `node_modules` を使わないインストールでこの穴を避けています。その代わり B は、Node 18 向けに手書きした中断処理が動く経路（`check`）を検査から外しており、名前付きの `node:` API を型で見る段もありません。ここを A と批評から足します。

## 移植する部品

設計 A から足すのは、ビルドの直後に `@types/node@18.11.0` で `tsc -p tsconfig.json --noEmit` する段だけです。`import { glob } from 'node:fs/promises'` のような、Node 22 の型にはあって 18.11 の型にはない名前付き API を、テストが通らない経路でも落とせます。`tsconfig.json` は変えません。`lib` を足すと DOM の `fetch` が消え、今のソースが別の理由で落ちます。したがって `AbortSignal.any` のようなグローバルは、この段では見えない、と文書に書きます。

設計 A から捨てるのは、浮動の Node 18、標準出力のコネクタ名、dist 全ファイルの `import()` です。

批評で B に足すのは次です。

- `check` を 1 回実行する。中断付きの `ctx.run`（`execFile` に `signal` を渡す経路）は `check` だけが通ります。`scan` は `abort` 無しの経路です。
- ネットワーク無しで `anySignal` を 18.11.0 上で実行する。空の環境の `check` は `fetch` を呼ばないので、`makeCtx` の `fetch` をスタブして呼びます。
- Hermes の fixture は文字列の `schedule` ではなく `{ kind: "cron", expr }` にする。文字列は黙って interval 扱いになります（`src/connectors/hermes.ts`）。
- CLI は npm の bin シムではなく、`process.execPath` とインストール先の `dist/cli.js` で起動する。子プロセスの `PATH` を空にすると、シムの `#!/usr/bin/env node` は `node` を見つけられません。
- `node --check` は合格条件にしない。`tsc` の出力は ES2022 で、存在しない `node:` の名前は `--check` では落ちません。
- 「必須チェック」とは書きません。このリポジトリのマージを GitHub が止める設定は、今回いじりません。

`--engine-strict` は残します。公開パッケージを Node 18.11.0 で入れたとき、依存が下限を拒否したら利用者も失敗します。ロックファイルと違う最新解決で赤くなるのは、その公開時の失敗を先に見ているからです。失敗時は依存一覧を出し、依存の版は上げて解消しません。

## 確定仕様

### 守ること

Node 18.11 で、利用者が受け取る tarball が起動し、空の環境で `scan` と `check` が例外でコネクタを落とさず、状態ファイルを正しい版で書くこと。開発用のテストは、いまサポートされている Node 22 と現行 LTS の Node 24 で全件回すこと。Dependabot の現在の alert は、vitest を 4.1.12 に上げた依存木で解消すること。

`package.json` の `engines.node` は `>=18.11` のままです。`dependencies` の cron-parser と yaml は上げません。`src/` は変えません。tsx、TypeScript、`@types/node` の範囲も変えません。vitest 5 には上げません。`push`（main）と `pull_request` のトリガーは変えません。

### 依存の終状態

`devDependencies.vitest` は `^4.1.12`。ロックファイルの `vitest` と `@vitest/mocker` は 4.1.12。この作業ツリーは既にその状態です。`npm audit`（devDependencies を含む）が 0 件なら、依存は触りません。0 件でなければ vitest の依存木だけを直し、cron-parser と yaml の解決結果は動かしません。

### CI

`.github/workflows/ci.yml` の既存 job 名 `test`、action の版、ステップの並びは維持します。matrix だけ `node: [18, 22]` から `node: [22, 24]` に変えます。中身は `npm ci`、`npm run build`、`npm test` のままです。20 はサポート終了、26 は current なので必須の matrix には入れません。

新しい job `runtime-compat` を 1 つ足します。`test` とは独立で、artifact の受け渡しはしません。`timeout-minutes: 15`。Node の取得は 1 job の中で 2 回です。

1. `actions/setup-node@v4` で `22`。`cache: npm` と今の `cache-dependency-path` は付けます。
2. `npm ci`、`npm run build`。`prepublishOnly` は使いません（テストまで走るため）。
3. 型の段。Node 22 のまま `npm install --no-save --package-lock=false @types/node@18.11.0` を実行し、解決された版をログに出します。続けて `npx tsc -p tsconfig.json --noEmit`。その後 `package.json` と `package-lock.json` が汚れていたら失敗です。`tsconfig.json` と `tsconfig.test.json` は変えません。テスト用の tsconfig はここでは回しません。今の `src` のままこの `tsc` が失敗したら、ファイルを除外したり `lib` を足したりして通さず、仕様に戻します。
4. `npm pack --ignore-scripts --json --pack-destination "$RUNNER_TEMP"`。tarball のパスは JSON の filename から作ります。版の文字列からファイル名を組み立てません。今は `prepare` も `prepack` も無いので `--ignore-scripts` は将来の `prepare` がこの job でテストを走らせないためのものです。
5. 同じ job でもう一度 `setup-node`。`node-version: 18.11.0`。2 回目に `cache` は付けません。
6. `node --version` が `v18.11.0` であることを確認し、`node scripts/smoke-package.mjs <tarball の絶対パス>` を実行します。

### 検査スクリプト

新規 `scripts/smoke-package.mjs`。Node 標準モジュールだけを使います（`node:assert/strict`、`node:fs/promises`、`node:child_process`、`node:os`、`node:path`）。テストフレームワークは足しません。`files` は `["dist"]` のままなので、このスクリプトは配布されません。

冒頭で `process.version === 'v18.11.0'` と `process.execPath` を出力し、違えば失敗します。

checkout の外に consumer ディレクトリを作り、最小の `package.json`（private）を置きます。Node 18.11.0 に付く npm で、tarball の絶対パスを次のように入れます。

```sh
npm install --omit=dev --engine-strict --no-audit --no-fund /absolute/path/cronscope.tgz
```

checkout の `node_modules` と `NODE_PATH` は使いません。consumer に `vitest`、`typescript`、`tsx` が無いことを確認します。失敗したら npm のエラーと consumer の `npm ls --all` を出し、依存の版や override では直しません。

CLI の子プロセスは、環境を置き換えます。渡すのは `HOME`（空の一時ディレクトリ）、`PATH`（空のディレクトリ。空文字列にはしない）、`TZ=UTC`、`TMPDIR` だけです。`GITHUB_TOKEN`、`GH_TOKEN`、`CRONSCOPE_GH_TOKEN`、`CRONSCOPE_CF_API_TOKEN`、`CRONSCOPE_CF_ACCOUNT_ID`、`NODE_OPTIONS`、`NODE_PATH` は渡しません。GitHub Actions は `GITHUB_TOKEN` を job に注入するので、継承すると github-actions が API を呼びます。作業ディレクトリは空の一時ディレクトリで、リポジトリ本体は走査させません。起動コマンドは `process.execPath` と `<consumer>/node_modules/cronscope/dist/cli.js` です。各子プロセスのタイムアウトは 30 秒です。失敗時は標準出力、標準エラー、アサーションを出します。標準出力の文言や行数は合格条件にしません。

実行前に HOME へ次を置きます。

- `~/.hermes/cron/jobs.json`  
  `{ "jobs": [{ "id": "smoke1", "name": "smoke", "enabled": true, "schedule": { "kind": "cron", "expr": "0 0 * * *" }, "next_run_at": "2099-01-01T00:00:00.000Z" }] }`
- `~/.config/cronscope/config.json`  
  `scanRoots` は、一時ディレクトリに作った 1 リポジトリの絶対パスだけ。その中に `.github/workflows/daily.yml` を置き、中身は `on.schedule` の cron `0 0 * * *` の 1 本。トークンは置かないので、この fixture は GitHub API を呼びません。`cronNext` はトークン無しでも計算されます。

合格条件は次のとおりです。

| 検査 | 合格 |
|---|---|
| パッケージ | 展開結果に `dist/cli.js` があり、`package.json` の `bin.cronscope` が `dist/cli.js` |
| `scan` | 終了コード 0。`~/.config/cronscope/state.json` の `schemaVersion === 1` |
| `check` | 終了コード 0。`state.json`、`notify-state.json`、`gha-freshness.json` がいずれも `schemaVersion === 1`。`check.lock` は残っていない |
| コネクタ | 両コマンドの snapshot に `crontab`、`systemd`、`github-actions`、`cloudflare`、`hermes`、`launchd` があり、どれにも `thrownBy` が無い。増えたコネクタは失敗にしない |
| 状態 | `hermes` は `available`。`github-actions` は `degraded`。`cloudflare` は `skipped`。`crontab`、`systemd`、`launchd` は `unavailable`。理由の文言は固定しない |
| ジョブ | `hermes\|smoke1` があり、その `schedule.kind` は `cron`。github-actions のジョブが 1 つあり、`schedule.nextRunSource` は `computed`、`nextRun` は ISO 8601 の文字列。時刻の完全一致は見ない（時計を注入できないため） |
| 未知のサブコマンド | 引数 `nosuch` で終了コード 2 |
| `cronNext` | consumer の `dist/core/schedule.js` を直接 import し、`cronNext('0 0 * * *', new Date('2026-01-01T00:00:00.000Z'), 'UTC')` が `2026-01-02T00:00:00.000Z`。実装時に Node 22 で同じ戻り値になることを 1 回確認する。18.11 だけ違う場合はテストを緩めず、製品側の差として報告する |
| 中断の合成 | consumer の `dist/runtime.js` の `makeCtx([], controller.signal)` を使う。`globalThis.fetch` を、引数の `signal` を記録して `{ ok: true }` を返す関数に置き換え、`ctx.fetch` を 1 回呼んでから controller を abort し、記録した signal が aborted であること。終わったら `fetch` を戻す。ネットワークは使わない |

`dist/cli.js` は import しません。`node --check` も使いません。`serve`、`gha-freshness release`、本物の GitHub / Cloudflare / Slack は対象外です。

### 検出力

残すもの:

- Node 22 と 24 で、今の `npm test`（vitest 全件とテスト用の型検査）。
- Node 18.11.0 で、配布 tarball のインストール、CLI の静的 import のリンク、`scan` の非中断経路、`check` の中断付き子プロセス経路、ロックの取得と解放、3 つの状態ファイル。
- Hermes の読み取り成功と、トークン無しの workflow 1 本に対する yaml のパースと `cronNext`。
- `@types/node@18.11.0` による、`src` の名前付き `node:` API の型検査。
- `makeCtx` 経由の `anySignal` が 18.11.0 で例外を出さないこと。

保証しないもの:

- Node 18 上での 347 件の振る舞い。実装差だけが 18 にあり、上記の経路を通らないものは落ちません。
- 実行されない分岐の Node API。型の段は DOM 由来のグローバル（`AbortSignal.any` を含む）を見ません。`anySignal` を残したまま別の場所に `AbortSignal.any` を書いた場合も、その場所が `check` の今回の経路で呼ばれなければ落ちません。
- `ctx.run` の「子プロセスが SIGTERM を無視したとき close を待つ」経路。空の `PATH` ではコマンドが ENOENT で即返ります。この経路は Node 22/24 の vitest が持ちます。
- Node 20、18 系の最新、26。macOS の launchd の実コマンド。`serve` の待受。
- 開発ツールが Node 18 で動くこと。

### 文書

`README.md` の「インストール / 使い方」に 1 文追加します。動作の下限は Node 18.11 のままです。テスト一式は Node 22 と 24 で回し、Node 18.11 では配った CLI の起動と状態ファイルの検査だけを CI で見ます。

新規 `docs/specs/2026-10-31-node18-runtime-check.md` に、上の「残すもの / 保証しないもの」、型検査がグローバルを見ないこと、CI を実走したあとの job 別所要時間と workflow 全体の時間を書きます。時間は実走前に埋めません。

### 完了の定義

次が全部そろうまで完了にしません。YAML を書いた時点や、開発用 Node での成功時点では完了ではありません。CI 定義の変更は、このリポジトリでは不可逆な差分としてレビューします。

1. 開発用 Node で `npm ci && npm run build && npm test` が終了コード 0。`npm audit` が 0 件。
2. PR で `test (22)`、`test (24)`、`runtime-compat` が成功。
3. 上記の仕様文書に、各 job の所要時間と workflow 全体の経過時間を書いた。
4. main へマージしたあと、Dependabot の open alert が 0 件であること。再スキャンの遅れは失敗ではないが、0 件を見るまでこの作業は閉じません。残った alert が今回の依存と無関係なら、その名前を完了報告に書きます。

ブランチ保護や ruleset は今回足しません。job がワークフローに含まれることと、マージが機械的に拒否されることは別です。

## 残存リスク

Node 18 の全テストを外すので、今回の smoke が通らない経路の実装差は CI が知りません。新しい `node:` API やグローバルを足す変更では、レビューで下限 18.11 を見る、と仕様文書に残すところまでがこの変更の範囲です。第二のテスト一式は作りません。

`@types/node@18.11.0` の段は、今の `src` がそのまま通ることを設計 A が実測しています。この裁定では再実行していません。実装の最初に赤と緑を取り、今の `src` で赤なら `tsconfig` を曲げずにこの段を外して仕様へ戻します。

18.11.0 はサポートが終わっています。この job は「約束した下限で配布物が起動する」ことを見るだけで、その Node 自体の安全性は保証しません。将来 runner が 18.11.0 を取れなくなったら、この job は製品の回帰ではなく実行環境の消滅として失敗します。

consumer のインストールはレジストリの最新解決です。ロックファイルが固定している cron-parser と yaml の版とはずれます。依存が Node 18 を `engines` で拒否した場合、またはレジストリが一時的に失敗した場合に赤くなります。前者は利用者と同じ失敗なのでテストを外さず、後者は `npm ls` の出力で切り分けます。

`check` は空の `PATH` では `anySignal` を通しません。`anySignal` は `makeCtx` のスタブ `fetch` で見ます。`fetch` スタブは「`makeCtx` が合成した signal を `fetch` に渡す」ことまでで、本物の HTTP や Slack は見ません。
