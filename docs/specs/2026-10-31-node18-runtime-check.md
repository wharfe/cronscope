# Node 18.11 の配布物検査 — 何を確かめ、何を確かめないか

Status: 運用記録（2026-10-31）。設計の経緯と合否表の正本は `docs/design-debate/vitest4-ci-node/spec.md`。

## 要は
vitest 4 は Node 18 で動かない。そこで Node 18.11 では、テスト一式の代わりに**配った tarball を実際に入れて動かす**検査
（CI の `runtime-compat` job、`scripts/smoke-package.mjs`）をする。テスト一式は Node 22 と 24 で回す。
利用者への約束 `engines.node >=18.11` は変えていない。

## 残す検出力
- Node 22・24: `npm test`（vitest 全件とテスト用の型検査）。
- Node 18.11.0: tarball のインストール（`--engine-strict`）、CLI の静的 import のリンク、`scan`（中断なしの経路）、
  `check`（ロックの取得と解放、3 つの状態ファイル）、未知のサブコマンド、connector が例外を投げていないこと（`thrownBy`）、
  hermes の読み取りと workflow 1 本の cron 計算。
- Node 18.11.0: 手書きの `anySignal`（AbortSignal.any の代わり）の合成と、`ctx.run` の中断（起動した子を kill し、子が消えてから解決する）を dist から直接。
- `@types/node@18.11.0` での `src` の型検査: Node 18.11 に無い `node:*` の名前付き API を、実行経路によらず検出する。

## 保証しないもの
- 開発・publish が Node 18 でできること。`prepublishOnly` は `npm test`（vitest 4）を走らせるので、**publish には Node 20.19 以上**（実際には 22 以上）が要る。
- Node 18 上でのテスト 347 件の振る舞い。上の経路を通らない実装差は検出しない。
- **新しいグローバル**（`AbortSignal.any` など）: 型の段は DOM lib の宣言に隠れて見えない。実行される経路で呼ばれたときだけ smoke が落ちる。
- `serve`、`gha-freshness release`、本物の GitHub / Cloudflare / Slack、macOS の launchd の実コマンド。
- Node 20、18 系の最新、26。

## レビューで見ること
新しい `node:*` API やグローバルを足す変更では、下限 Node 18.11 にあるかをレビューで確かめる（型の段はグローバルを見ない）。

## 失敗したときの読み方
- consumer の install は runner / 開発機の `~/.npmrc` を読まない（HOME と userconfig を一時ディレクトリに置き換える）。registry は npm の既定（npmjs）。
- `install` で落ちた: 依存が Node 18.11 を engines で拒否した（利用者も同じく失敗する）か、registry の一時障害。出力の `npm ls --all` で切り分ける。依存の版や override で黙らせない。
- runner が 18.11.0 を取得できない: 実行環境の消滅であって製品の回帰ではない。下限を上げるかを別に判断する。

## CI 実走の所要時間
PR #15 の初回実走（run 41186132833、2026-10-31、ubuntu-latest、npm cache あり）:

| job | 所要 |
|---|---|
| test (22) | 15 秒 |
| test (24) | 14 秒 |
| runtime-compat | 17 秒（うち smoke 本体 約 1.3 秒） |
| workflow 全体（並列） | 21 秒 |

変更前の matrix `[18, 22]` と比べて job が 1 本増えたが、並列なので全体の待ち時間はほぼ同じ。
