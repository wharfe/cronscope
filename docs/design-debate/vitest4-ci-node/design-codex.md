# vitest 4 更新と Node 18 配布物検証の設計案

## 1. 前提と解釈

**vitest は Node 22・24 で実行し、Node 18.11.0 では配布 tarball に対する小さな互換性検査を実行する。** 開発ツールの実行条件と、利用者に配布するプログラムの実行条件を分ける。

脆弱性・必要バージョン・Node のサポート状況は、提示された実測を設計の前提とする。目的は現在の Dependabot alert 18 件の解消であり、将来の alert が発生しないことまで保証するものではない。

リポジトリでは以下を確認した。

- `package.json` は ESM、CLI は `dist/cli.js`、配布対象は `dist`。
- `npm test` は vitest とテストを含む TypeScript 型検査を連続実行する。
- `tsconfig.json` は `target: ES2022`。これは Node API の最低対応版を保証しない。
- `src/pipeline.ts` は connector の例外を捕捉し、snapshot の `thrownBy` に記録する。
- `scan` は snapshot を `~/.config/cronscope/state.json` に保存する。

したがって、**`scan` の終了コード 0 だけを合格条件にしない。** Node API の非互換で connector が例外を投げても、CLI 全体は成功しうる。

`engines.node: ">=18.11"` の下限は **18.11.0** と解釈する。`setup-node` の指定を単に `18` にすると最新の 18 系しか検査できないため、互換性 job は下限を明示する。

提示された「release」について、現コードでは `gha-freshness` がコマンド分岐であり、単独の `release` はない。今回の検査は実装済みの `scan` を中心にする。

他者の提案書にはアクセスせず、ファイルの変更・インストール・CI 実行も行っていない。

## 2. 設計案

### 2.1 変更対象

| ファイル | 変更内容 |
|---|---|
| `package.json` | vitest を `^4.1.12` に更新。既に作業ツリーでは更新済み |
| `package-lock.json` | 対応する依存解決結果。不要な依存更新を含めない |
| `.github/workflows/ci.yml` | テスト matrix の変更と互換性 job の追加 |
| `scripts/smoke-package.mjs`〈新規〉 | Node 標準モジュールだけで配布物を検査 |
| `docs/` 配下の設計記録〈新規〉 | 検査範囲、失う検出力、CI 実測時間を記録 |

`src/`、本体 dependencies、engines、tsx、TypeScript、`@types/node` は変更しない。新規スクリプトは `files: ["dist"]` の外に置き、配布しない。

### 2.2 CI の構成

既存の `push(main)`・`pull_request` は維持する。

| job | Node | 処理 |
|---|---|---|
| 既存 `test` | `[22, 24]` | `npm ci → npm run build → npm test` |
| 新規 `runtime-compat` | build: 24 → runtime: 18.11.0 | build → pack → 隔離インストール → 配布物検査 |

既存の `test` job 名と action の版は維持する。今回、action 更新やキャッシュ再設計を同時に行わない。

vitest の matrix は 22・24 を選ぶ。22 は既存 CI の継続性、24 は現行 LTS を担う。20 は提示された時点でサポート終了、26 は current であるため、必須 job に追加しない。

互換性 job は独立させる。Node 18 の失敗が vitest の失敗と区別でき、22・24 のテスト matrix に条件分岐を持ち込まずに済む。artifact 転送は使わず、その job 内でビルドする。

### 2.3 配布物の生成とインストール

互換性 job の流れは次のとおり。

```text
checkout
  → setup-node: 24
  → npm ci
  → npm run build
  → npm pack --ignore-scripts --json
  → setup-node: 18.11.0
  → node scripts/smoke-package.mjs <tarballの絶対パス>
```

tarball は `$RUNNER_TEMP` 配下に生成する。名前をバージョンから組み立てず、`npm pack --json` の結果から取得する。

`npm pack` は手動 build の後に実行する。現在の `prepublishOnly` を CI の検査経路として利用せず、何を実行したかを明確にする。`--ignore-scripts` の挙動は [npm の設定仕様](https://docs.npmjs.com/cli/using-npm/config/) に従う。

検査スクリプトは checkout の外に一時 consumer ディレクトリを作り、最小の `package.json` を置いて、Node 18 に付属する npm で以下を実行する。

```sh
npm install --omit=dev --engine-strict --no-audit --no-fund /absolute/path/cronscope.tgz
```

これにより、公開パッケージに近い依存解決とインストールを検査する。`--omit=dev` の仕様は [npm install の公式文書](https://docs.npmjs.com/cli/v10/npm-install/) に基づく。

重要な点は次のとおり。

- checkout の `node_modules` を使わない。
- `NODE_PATH` を引き継がない。
- consumer 内に vitest・TypeScript・tsx が存在しないことを確認する。
- 本体 dependencies は consumer の依存としてインストールする。
- `--engine-strict` により、配布先で必要な依存が Node 18.11.0 を拒否した場合も失敗させる。

この経路は元リポジトリの lockfile に固定された依存集合とは異なる。利用者が tarball をインストールする場合の検査であり、その差は意図したものとする。

### 2.4 Node 18 の検査契約

検査スクリプトは `.mjs` とし、`node:assert/strict`、`node:fs/promises`、`node:child_process` などだけを使う。テストフレームワークは追加しない。

子プロセスには `process.execPath` の絶対パスを使い、実際に Node 18.11.0 で実行していることを冒頭で検証・出力する。

| 検査 | 合格条件 |
|---|---|
| 配布ファイル | `dist/cli.js` と package の bin 定義が存在し、CLI ファイルが実行可能 |
| 全配布 JS の構文 | `dist` 配下の全 `.js` に `node --check` が成功 |
| 空環境の `scan` | rc 0、snapshot が存在、`schemaVersion === 1` |
| connector の完走 | 既存 6 connector のキーが存在し、`thrownBy` が一つもない |
| 正常系 fixture | 既知の Hermes job を発見し、主要フィールドが期待値と一致 |
| cron 計算 | 配布された `dist/core/schedule.js` の `cronNext` が固定入力に対して期待値を返す |
| CLI のエラー経路 | 存在しないサブコマンドが rc 2 |

`node --check` はコードを実行せず構文を検査する。そのため API 互換性の証明には用いず、実行検査と併用する。[Node 18 の CLI 仕様](https://nodejs.org/download/release/latest-v18.x/docs/api/cli.html)

cron の固定入力例は以下とする。

```js
cronNext(
  '0 0 * * *',
  new Date('2026-01-01T00:00:00.000Z'),
  'UTC',
)
// '2026-01-02T00:00:00.000Z'
```

Hermes fixture は一時 HOME の `.hermes/cron/jobs.json` に置く。`id`、`name`、`enabled`、`schedule`、`next_run_at` を指定し、snapshot に `hermes|<id>` が現れることを確認する。空環境だけで終わる検査より、実際の読み取り・変換・保存を通せる。

検査対象の CLI は、新しい一時 HOME、空の作業ディレクトリ、`TZ=UTC`、制御した環境変数で起動する。CLI 子プロセスの `PATH` は空ディレクトリにして、ホストの `gh`、`crontab`、`systemctl` などに左右されないようにする。npm のインストール工程にはこの制限を適用しない。

CLI 子プロセスにはタイムアウトを設け、失敗時には stdout・stderr と assertion の内容を出す。空環境時の表示文言や行数は固定しない。判定には保存された構造化 snapshot を使う。

### 2.5 残す検出力と受け入れる空白

| 残すもの | 失う、または保証しないもの |
|---|---|
| Node 22・24 の全 vitest と型検査 | Node 18 における 347 テスト全件の振る舞い検証 |
| Node 18.11.0 の配布物ロード・構文検査 | すべての条件分岐における Node API 互換性 |
| 実 consumer の依存解決・CLI 起動 | Node 18 上での開発・テストツール実行 |
| connector の例外化、正常系 fixture、cron 計算 | 実 GitHub/Cloudflare API、Slack 通知 |
| 一時 HOME への snapshot 保存 | `check` の中断・ロック・通知連携、`serve` の全挙動 |
| Linux 上の最低版検査 | macOS の launchd 実動作、全 Node 中間バージョン |

追加する検査は、この小さな配布物検査までとする。Node 18 用の第二の総合テスト体系は作らない。

### 2.6 検証と完了条件

実装時には次の順序で確認する。

1. 対応する開発 Node で `npm ci && npm run build && npm test` が成功。
2. devDependencies を含む `npm audit` が 0 件。
3. PR 上で `test (22)`・`test (24)`・`runtime-compat` がすべて成功。
4. 各 job の所要時間と workflow 全体の経過時間を設計記録に残す。
5. マージ後、Dependabot open alert が 0 件であることを確認。

CI 定義は提示された運用上の「不可逆 diff」としてレビューする。**YAML を作成した時点やローカル成功時点では完了扱いにしない。**

## 3. 代替案と却下理由

| 代替案 | 却下理由 |
|---|---|
| Node 18 の job を削除する | 利用者向け最低版の実行検査がなくなる |
| vitest 3.2.7 に留める | 提示された critical alert を解消できない |
| tinypool を overrides で更新する | Node 18 で vitest を実行できない問題が残る |
| 全テストを `node:test` へ移植する | 今回の依存更新に対して変更範囲が大きい |
| vitest は 24 だけにする | 既存の 22 検証を残せるため、今回は二版を維持する |
| vitest に 26 も追加する | current 対応の検出力は増えるが、必須 CI の増加を今回は避ける |
| Node 18 の最新版だけを検査する | `>=18.11` の下限を検証できない |
| checkout の `dist/cli.js scan` だけ実行する | devDependencies による依存欠落の隠蔽や、pack の欠落を検出できない |
| 空 HOME の rc 0 だけ確認する | connector 内部の例外を成功として見逃しうる |
| Node API の静的検査を追加する | 補助にはなるが、推移依存・動的分岐の保証にはならず、設定保守も増える |
| 専用 action を導入する | 必要な処理は既存の setup-node と短い検査スクリプトで表現できる |

## 4. リスクと未解決点

**最大の残余リスクは、Node 18 固有の問題が smoke 対象外の経路に入ること。** 現在 Node 18 で動いている全 vitest を外すため、検出力は明確に下がる。この差を文書に残し、Node API を追加する変更のレビューでは最低対応版を確認する。

`@types/node` は 22 系なので、型検査だけでは Node 18 にない API の利用を防げない。今回これを変更しない以上、その制約は残る。

consumer インストールは registry の状態と dependencies の範囲指定に影響される。失敗時には解決された依存一覧を出し、「製品互換性の失敗」と「registry の一時障害」を切り分ける。本体 dependencies の更新や override を自動的な解決策にしない。

18.11.0 はサポート終了済みである。ここで検査を続けることは runtime 自体の安全性を保証しない。また、将来の GitHub runner 上で古い Node を起動できなくなる可能性は残る。

人が判断する必要があるのは、次の二点である。

- **Node 18 の全テスト実行を、上記の配布物検査へ縮小することを受け入れるか。**
- **PR の実走時間が、追加 job を含めて運用上許容できるか。**

本提案ではこの縮小を受け入れ、最低版の配布物検査を必須にする。CI 実走と alert 解消は未確認であり、それらの確認をもって変更を完了とする。
