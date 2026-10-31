# Critique of design B (by fresh Claude subagent, no conversation context)

## 確かめて正しかった主張
- `thrownBy` src/pipeline.ts:15,19、`schemaVersion: 1` :22、state.json src/cli.ts:32-33。
- `dist/core/schedule.js` の `cronNext` は案の固定入力で `2026-01-02T00:00:00.000Z`。
- 未知のサブコマンドは rc 2（src/cli.ts:106-107）。
- 空 PATH + `env -i` の `scan` は rc 0、thrownBy 0 件（`ctx.run` が ENOENT を握りつぶす）。
- 単独の `release` は無く `gha-freshness` 配下（src/cli.ts:102-103）。
- 依存 engines: cron-parser 4.9.0 `>=12`、yaml 2.9.0 `>= 14.6`、luxon 3.7.2 `>=12`。

## 指摘
- high: `check` を検査対象から外したのは誤り。Node 18 用に手で書いた `anySignal`（src/runtime.ts、コメント「AbortSignal.any is Node 20.3+ and CI still runs Node 18」）と execFile への signal 渡しは abort 付き ctx を作る `check` でしか動かない。scan は `if (!abort)` 経路。実測: 空 HOME・空 PATH で `node dist/cli.js check` は 0.12 秒 rc 0、notify-state.json と gha-freshness.json を書く。Slack webhook 無しで通信なし完走。→ `check` 1 回実行を足す。
- medium: `node --check` はほぼ何も足さない（ES2022 構文は 18 で解釈可、`node:*` の存在しない名前の import はリンク時エラーで --check は拾わない。cli.js は全 module を静的 import するので scan 1 回でリンクが通る）。
- medium: `--engine-strict` とロック無しの registry 最新解決は差分と無関係に CI を赤くする。外すか非必須に。
- medium: 内部配置（dist/core/schedule.js 直接 import）や 6 connector の厳密一致、Hermes fixture の形（schedule 文字列だと黙って interval 扱い、src/connectors/hermes.ts:42-47）に縛られ保守負担。→ cronNext 個別検査をやめ、Hermes は `{kind:"cron",expr}` 形で置き `hermes|<id>` と thrownBy 0 だけ見る。connector は「既知 6 つ以上」。
- medium: 「必須」が効かない。main にブランチ保護なし（404）、rulesets []。記述を直すか別件に。
- low: dist/cli.js は 644、bin 直接起動は空 PATH で node が見つからない。起動は process.execPath 経由と明記。
- low: CI 変更量が「最小」制約より大きい。既存 test job 横に 22 で build → 18.11.0 へ切替 → scan と check、で問い1の 8 割。tarball 検査の上乗せは pack 漏れと devDeps 依存の隠蔽だけで、files:["dist"] なので pack 漏れ危険は低い。
- low: Node 20 と最新 18.x が未検査であることを空白表に載せていない。
- low: `npm pack --ignore-scripts` は不要（prepublishOnly は pack で走らない、prepack/prepare 無し）。

## 総評
critical なし。high 1 件（check を足す）を直せば採用水準。推奨形: 18.11.0 で tarball をインストール（engine-strict なし）、空環境で scan と check、thrownBy 0・状態ファイル schemaVersion・Hermes fixture 1 件を見る。「必須」記述は実態に合わせる。
