# launchd コネクタ（#10）— 1 ページ spec

## 要は
Mac の launchd ジョブ（`~/Library/LaunchAgents/com.wharfe.*.plist`）を cronscope が読み、
失敗（rc≠0）は即、止まっている状態は粗く（最大間隔 + 24h）既存の Slack 通知に乗せる。
スリープ・DarkWake・再起動・中断で誤通知しない。

## 既にある仕組み（Step 1）
- healthchecks: 4 本（trend-news / ETL / obsidian-url-clipper / morning-metrics-check）のみ。残り 3 本は無監視
- `local-schedules/scripts/launchd-run.sh`: ログに `start` / `finish rc=N` 行を書くだけで通知しない
- cronscope 以外に launchd を読むものは無い。判定・通知の重複抑止は cronscope 既存のものを使う

## 決定（grilling + Gate2 2 周。遅延を粗く見る形はユーザー確認済み 2026-09-26）
1. 対象: `$CRONSCOPE_LAUNCHAGENTS_DIR`（既定 `<homedir>/Library/LaunchAgents`）の `com.wharfe.*.plist` のうち
   `StartCalendarInterval` か `StartInterval` を持つもの。列挙は `ctx.run(['ls', dir])`（runtime の glob は既知パターン以外 `[]`）。
   plist は `plutil -convert json -o - <file>` で読む。1 本の解析失敗・ログ無しはそのジョブだけの問題にし、discover を投げない
2. 前提確認: `launchctl print gui/<uid>` が失敗したら `degraded`（全ジョブを disabled に見せない）。`launchctl` が無ければ `unavailable`。
   bootout 済みの判定はジョブごとの `launchctl print gui/<uid>/<label>` が **rc=113 かつ `Could not find service`** のときだけ
   `state:'disabled_manually'`（ログより優先）。それ以外の読み取り失敗は何の証拠にもせず active のまま。
   （`gui/<uid>` のサービス一覧を解析する案は Gate3 2〜3 周目で「解析のずれが全ジョブの失敗を黙らせる」同根の critical を
   2 回出したので捨てた。plist が壊れたジョブは label が分からないので、停止中でも解析失敗として通知する）
3. ログ（`--job <名前>` を持つ plist のみ。場所は `StandardOutPath`）: `tail -c 262144` で末尾だけ読む。
   `launchd-run: <job> start (\S+)$` / `launchd-run: <job> finish rc=(\d+) (\S+)$` を**行頭に固定せず**拾う（job はエスケープ）。
   時刻の `+0900` は `+09:00` に直してから読む。前後は**行の順序**で決める（同じ秒がある）。ログ本文は reason に入れない
4. 最後の結果: ログの最後の finish が最後の start より後ならその rc。start の後に finish が無ければ「実行中」で、前回の finish を使う。
   ログに finish が無いとき（ログが無い・tail 失敗も「行ゼロ」として同じ扱い。undeterminedReason は付けない）だけ
   `launchctl print gui/<uid>/<label>` の `last exit code` の先頭の整数（`78: EX_CONFIG` → 78）。`(never exited)` → never。
   `last terminating signal` は HUP/INT/TERM なら中断（failure にしない）、それ以外は failure。
   cronscope-check 自身は label 末尾 `.cronscope-check` か `XPC_SERVICE_NAME` 一致で見分ける。
   plist の解析失敗・処理中の例外は捨てずに解析失敗として残す。job id はファイル名から作る。
   undeterminedReason を付けるのは plist の解析失敗だけで、文言は `could not be read or parsed`（classifyReason の parse-error）。
   launchd は STATUS_KNOWABLE に入れる（解析失敗は 24h ごとに知らせてよい）
5. failure にしない rc: 75（ロック競合）・129/130/143（HUP/INT/TERM による中断。再インストール・ログアウト・再起動で起きる）。
   `exitCode` には残し、scan には出す。cronscope-check 自身の label も failure にしない
6. 遅延（stale）: 対象は `--job` あり**かつ** `StartCalendarInterval` のキーが Minute/Hour/Weekday だけのジョブ（Day/Month を含む・`StartInterval` は対象外）。
   最大間隔 = 1 週間分の発火時刻を列挙した**巡回の**隣接差の最大（最後→最初 + 7 日も含む。発火が 1 つなら 7 日）。
   dict の配列、欠けた Minute = 毎分、欠けた Hour = 毎時、欠けた Weekday = 毎日、Weekday 0/7 = 日曜。
   起点 = 最後の start、無ければ最後の finish。**どちらも無ければ stale にしない**（scan で `never` と見えるだけ）。
   起点 + 最大間隔 + 24h < now で overdue。evaluate.ts の既存経路（cronPrev・boot・grace）には通さない
7. job id は `launchd|<label>`（スケジュールを含めない）。ID_PREFIX に `launchd`

## 不変条件
- I1 最後の実行が rc≠0（決定 5 の除外を除く）なら failure として通知される
- I2 rc=0・never・実行中・中断（75/129/130/143）・bootout 済み・cronscope-check 自身は failure にならない
- I3 stale は決定 6 の条件のときだけ。スリープ・DarkWake・長時間実行・導入直後・5 分ごと型・`--job` 無しでは出ない
  （電源断で発火枠を丸ごと逃した場合は、最大間隔 + 24h 後に出る — 既知の限界）
- I4 1 本の plist・ログの異常で他のジョブの判定が消えない（コネクタごと unavailable にならない）
- I5 Linux では黙って抜ける（Slack に何も出ない）。既存コネクタの判定は変わらない
- I6 notify-state.json の既存の行が落ちたり誤ラベルされたりしない。plist のスケジュールを直しても id が変わらない

## 非ゴール・既知の限界
- `com.wharfe.*` 以外、LaunchDaemons、`KeepAlive` 常駐、`StartInterval` 型の遅延
- SIGKILL などで finish 行が欠けた回の失敗は**検知しない**（次の start で上書きされる）
- 一度も走っていないジョブの遅延は検知しない。`--window` 外の skip は時刻が無いので数えない（毎晩その時間に眠る運用なら 48h ごとに stale）
- 5 分ごと型の一時的な失敗の抑制（失敗→回復→失敗のたびに通知。頻発したら「連続 N 回」を検討）
- Webhook なしの実行が未送信キーを記録する既存の不具合（notify-state.ts:76）。受け入れで HOME を差し替えて避ける
- local-schedules `schedules.yaml:469` の WSL パス残り（PR 本文に 1 行）

## 受け入れコマンド
- `npm test` 緑。I1〜I6 に赤→緑のテスト。素材は実機の plist 8 本（`plutil -convert json`）と実ログ（ETL の `rc=1`→`rc=0`、同秒の start/finish）
- 本番 cronscope-check を `launchctl bootout` → `npm run build`
- `HOME=<tmp> CRONSCOPE_LAUNCHAGENTS_DIR=/Users/wharfe/Library/LaunchAgents env -u CRONSCOPE_SLACK_WEBHOOK_URL node dist/cli.js scan`:
  launchd 8 本が出て、kind・最大間隔・最後の start・rc が `plutil -p` とログ末尾に 1 本ずつ一致
- 同じ環境で `check` → 何も出ない（現状は全ジョブ rc=0 か never）。launchd 8 本を列挙できていることを scan と同時に確認
- `launchctl bootstrap` で戻し、次の :17 のログが `finish rc=0`

## 入口表（不変条件が壊れうる箇所）
| 不変条件 | 箇所 |
|---|---|
| I1/I2 | `src/types.ts:1` JobSource / `src/core/sources.ts:5` ALARMABLE / `:17` STATUS_KNOWABLE / `src/cli.ts:21` CONNECTORS / `src/core/evaluate.ts:41` failure |
| I2 | `src/core/sources.ts:25` / `src/core/evaluate.ts:35` disabled_manually / `src/store/notify-state.ts:33-46` classifyReason / 新規: `isNotLoaded`（rc=113 + 文言の両方） |
| I2/I5 | `src/store/notify-state.ts:49-53` noticeKeys（undeterminedReason が Slack の notice になる経路） |
| I3 | 新規: 最大間隔の計算（巡回の差・発火 1 つ = 7 日。週次 2 本の実素材でテスト） |
| I3 | `src/core/evaluate.ts:12` scheduledInstant / `:52-60` crontab の守りと `lastAt = ... : 0`（launchd は専用分岐） / `src/types.ts:10-16` LastRun に start 時刻・`:24-27` schedule に最大間隔の欄が要る |
| I4 | `src/pipeline.ts:13` discover の例外でコネクタごと unavailable / `src/runtime.ts:42-43` glob は `[]` |
| I5 | `src/pipeline.ts:11` / `src/cli.ts:81` / `src/runtime.ts:37` ENOENT で code が文字列（launchctl の not found は rc=113・stderr） |
| I6 | `src/store/notify-state.ts:26` ID_PREFIX / `:127-128` / `:106-107` connectorDown |
| 受け入れ | `src/cli.ts:44-47` scan の表示項目 / `src/cli.ts:22` CFG_DIR は homedir 由来 |
