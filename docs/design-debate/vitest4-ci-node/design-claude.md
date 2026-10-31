# Design A（Claude）: vitest 4 + テストは 22/24、Node 18 は「型」と「実行」の 2 段で確かめる

## 結論
- `vitest` を `^4.1.12` に（lockfile 更新）。他の依存は触らない。
- `ci.yml` の `test` job matrix を `[18, 22]` → `[22, 24]`。中身（`npm ci → build → test`）は不変。
- 新 job `node18-compat`（1 job、Node 18 の検出力を 2 段で残す）:
  1. setup-node 22 → `npm ci` → `npm run build`（devDependencies は Node 22 で入れる。Node 18 に vitest 4 を入れない）。
  2. **型の段**: `npm install --no-save @types/node@18.11` → `npx tsc -p tsconfig.json --noEmit`。
     Node 18.11 に無い `node:*` モジュールの API を src が使えばここで落ちる。
  3. setup-node 18 に切り替え → `node --version` が `v18.` で始まることを確かめる（PATH 上書きが効いたことの証拠）。
  4. **実行の段（Node 18）**:
     - dist の全 `.js` を `import()` で読み込む（scan が通らない module の構文・トップレベルの問題を拾う）。
     - 空の一時 HOME、`GITHUB_TOKEN` 等を外した環境で `node dist/cli.js scan` → rc 0、6 connector 名の行が全部出ることを確かめる。
- `engines` は `>=18.11` のまま。README か spec に「Node 18 はユニットテストを回さず、型と起動で確かめる」と 1 行残す。

## 実測（この案の根拠）
- ローカル: vitest 4.1.12 で build OK、347 tests pass、`npm audit` 0。
- `@types/node@18.11` で `tsc --noEmit`（今の tsconfig のまま）: 現 src は rc 0。
  赤の確認: `import { glob } from 'node:fs/promises'`・`import { styleText } from 'node:util'` を足すと TS2305 で rc 2。
- 同じ型の段は `AbortSignal.any` を**検出しない**（tsconfig に `lib` 指定が無く、既定の DOM lib が AbortSignal.any を持つため）。
  `--lib ES2022` にすると検出するが、今の src が `fetch` の型で落ちる（@types/node 18.11 は fetch を持たない）ので採らない。

## 失うもの・残す検出力
| 何が壊れたら | 今（18 でテスト） | 案 A |
|---|---|---|
| `node:*` の新しい API を使った | テストが通る経路なら検出 | 型の段で検出（経路によらない） |
| 新しいグローバル（AbortSignal.any 等）| テストが通る経路なら検出 | scan の経路で呼ばれたときだけ検出 |
| 18 で構文・読み込みが壊れる | 検出 | 全 module の import で検出 |
| 18 で挙動だけが違う（実装差）| テストで検出 | **検出しない**（受け入れる） |

## なぜこの形か
- 「テストは今サポートされている版で、最低版は配布物を直接たたく」は、devDependencies を最低版に縛らない普通の分け方。
- 1 job 内で setup-node を 2 回呼ぶのは artifact の受け渡しが要らず、job 間の依存も増えない。
- 型の段は依存を増やさず（`--no-save`）、ローカルで赤→緑を確認できた。

## リスク
- `npm install --no-save` は lockfile 外の解決になる（@types/node は型だけなので配布物には影響しない）。
- setup-node の cache が 2 回目の呼び出しで混ざらないよう、2 回目は `cache` を付けない。
- Node 22 の所要時間に 1 job 分が上乗せ（ローカル実測で build ~数秒、scan ~1 秒）。
