# Brief: vitest 4 への更新と CI の Node 版の扱い

## 目的
wharfe/cronscope の Dependabot open alert 18 件（critical 3 / high 3 / 残り medium・low）を消す。
同時に、利用者への約束 `package.json` の `engines.node: ">=18.11"` をどう守り続けるかを CI 上で決める。

## 実測した事実
- 全 alert は devDependencies 由来（vitest と推移依存: tinypool・vite・postcss・esbuild・source-map-js・@vitest/mocker）。
  配布物は `files: ["dist"]`、dependencies は cron-parser・yaml のみで、どれも alert に含まれない。
- 全 alert を消せる最小の版は vitest 4.1.12（@vitest/mocker の alert が `< 4.1.12`）。
  vitest 3.2.7（3 系最新・Node 18 対応）では tinypool `< 2.1.2` の critical が残る（3.2.7 は tinypool ^1.1.1 に依存し、
  tinypool 2.1.2 の engines は `^20 || >=22`）。
- vitest 4.1.12 の engines は `^20 || ^22 || >=24`、vite 8.3.5 は `^20.19 || >=22.12` → vitest は Node 18 で動かない。
- 現在の CI `.github/workflows/ci.yml`: push(main) と pull_request で、matrix `node: [18, 22]`、`npm ci → npm run build → npm test`。
  `npm test` は `vitest run && tsc -p tsconfig.test.json --noEmit`。
- コードは Node 18 を意識している（例: `docs/specs/2026-10-04-gha-run-freshness.md` に「Node 18 のため AbortSignal.any は使わず手で合成」）。
- ローカル（Node 26）で vitest を ^4.1.12 に上げた状態: build 成功、`npm test` 27 files / 347 tests 全 pass、`npm audit` 0 件。
- 空の HOME で `node dist/cli.js scan` は 6 つの connector（crontab・systemd・github-actions・cloudflare・hermes・launchd）を
  呼び、各々 unavailable/degraded/skipped を 1 行ずつ出して rc 0。サブコマンドは scan / check / serve / release など。
- Node のサポート状況（2026-10-31 時点）: 18 と 20 はサポート終了、22 はメンテナンス LTS、24 は現行 LTS、26 は current。
- この repo の運用上、CI 定義の変更は「不可逆 diff」扱い（重いレビューと、実走して所要時間を見るまで完了にしない）。

## 制約
- 利用者向けの `engines.node >=18.11` は変えない（ユーザーがこの選択肢を選ばなかった。変えるのは破壊的変更）。
- dependencies（cron-parser・yaml）は触らない。
- CI 定義の変更は最小にし、push / pull_request のトリガーは変えない。

## やらないこと
- Node 18 対応の打ち切り、engines の変更。
- vitest 5 系への更新。tsx・typescript・@types/node の更新。
- 本体コードの変更。

## 問いたいこと
1. Node 18 で「配布物が動く」ことを、vitest 無しの CI でどう・どこまで確かめるか（何を失い、何を残すか）。
2. vitest を回す Node 版の matrix をどうするか。
3. 失う検出力を、追加の仕組みで埋める価値があるか（例: 配布物に対する別の検査）。それとも受け入れて文書に残すか。

## この機能を既に持っている仕組みを探したか
- npm `overrides` で tinypool だけ上げる案: tinypool 2.x が Node 20 以上なので Node 18 で vitest が動かなくなり、同じ問題に戻る。
- Dependabot の自動 security update PR: 版を上げるだけで Node 18 の CI 問題は解かない。
- Node 組み込みの `node:test`（Node 18 にもある）: テスト 347 件は vitest API（vi.mock 等を含みうる）で書かれており、移植は本体並みの作業になる。
- actions/setup-node は 1 job 内で複数回呼べ、後の呼び出しが PATH を上書きする（build と実行で Node 版を分けられる）。
- 他に CI 上で「古い Node で配布物を検査する」既製の action は探していない。

## 受け入れ条件（既知）
- ローカル: `npm ci && npm run build && npm test` が rc 0、`npm audit` 0 件。
- CI: PR 上で全 job が success、所要時間を記録。
- マージ後: Dependabot open alert 0。
