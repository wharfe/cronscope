# GitHub Actions run 鮮度（#4 の部分対応）— 実装契約

Status: 実装契約（2026-10-04）。設計の経緯は handoff `2026-10-03-cronscope-run-freshness-design-revision/result.md`、
承認と追加の受入条件は `2026-10-04-cronscope-run-freshness-implementation/request.md`。
数値はすべて**暫定の既定値**（実証していない。後日の通常ログで見直す）。

## 守るもの

前に check が確かめた run（基準）より古い一覧を受け取ったとき:
- 古い success を正常扱いしない／古い failure を新規 FAILURE にしない → status は `unknown`、過去の証拠は `lastObserved`。
- 鮮度の異常は**独立した check が 2 回続けて**確かめられなかった job だけ、**job ごとのキー**で Slack に出す。

解決しないもの: 基準が無い回（初回・破損からの作り直し・人が解放した直後）の古い一覧。GitHub 内部の原因。#4 は閉じない。

## 書き手と排他

- 専用 state `~/.config/cronscope/gha-freshness.json`（0600）。**書くのは check と release コマンドだけ**。scan / serve は読むだけで、
  追加取得も回数の更新もしない。表示用 snapshot（`state.json`）は今どおり誰でも書く（制御には使わない）。
- 保存は同じディレクトリの一時ファイル → fsync → rename。これは読み手に完全なファイルを見せるためで、RMW 排他ではない。
- 排他は `~/.config/cronscope/check.lock`。一時ファイルに `{pid, acquiredAt, nonce}` を書き切り `link()` で作る（EEXIST なら取得失敗）。
  範囲は check の最初（config・state の読込より前）から notify-state 保存の後まで。release コマンドも同じ lock。
- **取得失敗**: 何も読まず何も書かない（snapshot・専用 state・notify-state・Slack すべて不変）。
  - 既定: 固定の 1 行を stdout、rc 75。
  - 持ち主の `acquiredAt`（読めなければ lock の mtime）から 2 時間超: 固定の 1 行、rc 1（D2: ログだけ。Slack は無い）。
  - 持ち主の pid の生死はログの手がかりとして `alive=yes|no|unknown` で出すだけで、**判定には使わない**。
- **stale lock の自動回収はしない**（時間でも pid でも奪わない）。残った lock は人が持ち主の停止を確かめてから手で消す（README）。
- **解放**: `finally` で、**自分の await がすべて終わった後**に、中身の nonce が自分のものなら消す。
- **止め方（期限 600 秒・SIGINT・SIGTERM で共通）**: 中断 → 自分の処理が settle したのを確かめる → 解放、の順。
  1. check 専用の AbortController を中断する。ctx の fetch（全 connector と Slack）と `ctx.run` の子プロセスはこの信号を受ける
     （Node 18 のため `AbortSignal.any` は使わず手で合成）。2 段目は次の段を始めない。
  2. 中断より後には、新しい保存も送信も始めない（壊れたファイルの退避を含む）。中断の時点で始まっていた書き込みは完了を待つ。
     専用 state の保存が中断より前に終わっていれば、その回は数えられている（Slack と notify-state は次の回へ回る）。
  3. `runCheck` の promise が settle したら lock を外し、rc 1（期限）/ 130 / 143。
  4. 15 秒（暫定）以内に settle しなければ、**lock を残したまま** rc 1。以後の check は取得失敗になり、人の対処を待つ。
  - 「settle」で保証できるのは、プロセス内の await と直接の子プロセスまで（`ctx.run` は中断で子を kill し、子の close を待ってから返す）。孫プロセスは残りうるが、
    今の子コマンド（git・gh auth token）は読み取りだけなので排他は破れない。不変条件: check の中で待たない promise を作らない。
  - signal のハンドラ（SIGINT・SIGTERM・SIGHUP）は lock を取る前に登録し、lock を外した後に外す。
  - release コマンドには止め方を入れていない。Ctrl-C などで止まると lock が残り、人の対処になる（README）。
  - macOS は sleep 中に単調時計とタイマーが止まるので、600 秒は壁時計では延びうる。2 時間の判定は壁時計（acquiredAt）なので、時計が戻ると rc 75 が長く続きうる。
  launchd が SIGKILL まで進めた場合も lock が残り、人の対処になる。

## state の内容

`{ schemaVersion: 1, lastCheckAt, entries: { [jobId]: Entry } }`
`Entry = { identity: {repo, workflowId, path, query}, baseline?: {runId, createdAt, judgedStatus, conclusion, judgedAttempt, latestAttempt, confirmedAt}, streak, lastOutcome?, notFound?, lastRecheckAt?, lastSeenAt }`

- identity は repo（owner/repo）・workflow id・workflow path・query 版（`q1:event=schedule,status=completed`）。job id はキー。どれか違えば別の対象（作り直し）。
- 基準に採用するのは、一覧の newest の `workflow_id` が identity と一致し `event === 'schedule'` のときだけ。
- 読込: 無い（ENOENT）→ 空（初回）。それ以外の理由で読めない（EACCES・EISDIR など）→ 未知の版と同じ扱い（上書きしない）。JSON 不正・形が不正 → check は `.corrupt` に退避（1 つだけ）して空から、固定キー `store/gha-freshness/corrupt`。
  退避できなければ、そのファイルは上書きせず、その回は鮮度判定なし（同じキー）。release コマンドは、壊れた entry を 1 つでも含むファイルを変更しない（rc 1）。ファイルが無ければ rc 2。
  一部の entry だけ不正 → その entry だけ捨てて同じキー。schemaVersion が 1 以外 → 鮮度判定をしない・**上書きしない**・`store/gha-freshness/unsupported`。
  読み手は退避もキーもせず、空として扱う。
- 掃除: その check の scan に出なかった entry のうち `lastSeenAt` から 30 日を超えたものだけ。出ている job の基準は時間では消さない。
  github-actions connector が available / degraded でなかった check（例外で job が消えた回）は掃除しない。

## 1 回の check の判定

1 段目（今の処理）: 各 job の初回の一覧を取る（財布の外）。基準と比べる:
- 基準なし／identity 不一致 → 通常判定、newest を基準に（採用条件つき）、回数 0。
- newest の created ≥ 基準の created → 通常判定、基準を更新、回数 0。
- newest が古い、または 0 件で基準あり → **後退**。2 段目の候補。
- 一覧取得の失敗（workflow 一覧の失敗を含む） → 今の判定不能のまま、回数**維持**。

2 段目（check だけ。読み手は飛ばす）: 候補を `lastRecheckAt` の古い順（未設定が先、同じなら job id）に最大 3 つ、
共有の財布 30 秒（2 段目の開始から単調時計で計る。待ち・HTTP・attempt 1 の取得をすべて含む）で処理する。
1 job の手順: 待ち 1 秒 → R1 → （まだ古ければ）待ち 3 秒 → R2 → （まだ古ければ）基準 GET（V）。
- 各段は「残額 − 待ち ≥ 2 秒」「呼び出し時に残額 ≥ 2 秒」を満たすときだけ始め、HTTP の timeout は min(10 秒, 残額)。満たさなければその job は `deferred`。
- R で newest ≥ 基準 → `recovered`。attempt > 1 の attempt 1 取得も財布から払い、払えなければ判定は既存の `first attempt … unavailable`（鮮度は解消、基準は更新、回数 0）。
- 2 段目で 401 / 403 / 429 を受けたら、その check の 2 段目を**全部止める**（1 段目で 429 を受けた job が別にあっても、2 段目は最初の呼び出しまで進む。無駄な呼び出しが 1 回出うる。限界）。残りの候補は `deferred`。403 を rate limit とは書かない。Retry-After は待たない・読まない。
- V: 200 で id・workflow_id・event・created が一致し completed → `behind`、completed 以外 → `rerunning`。
  404 / 410・401 / 403 / 429・5xx・network・timeout・形の異常・不一致 → `unverified`（404 / 410 は `notFound` を記録）。どれも**基準は保持**。
- **公平性（一意の規則）**: その job の最初の待ちを始めた（＝財布を使い始めた）ら `lastRecheckAt = now`。途中で財布切れになって `deferred` でも更新する。
  1 段も始めなかった `deferred`（財布不足・停止・4 つ目以降）は更新しない。だから途中まで試した job は次の回に後ろへ回り、未着手の job が先に来る。

- R で解消したが attempt 1 を財布不足で取れなかった: 固定の reason `run freshness: listing is fresh again; first attempt not fetched in this check`
  （`run-freshness` に分類され共有キーに乗らない。回数は 0 なので鮮度キーも立たない。次の回の 1 段目で通常どおり判定される）。
- newest が基準より新しい（以上）が採用条件（workflow_id・event）を満たさない: 通常判定、基準は**保持**（更新しない）、回数 0。
  鮮度の守りは古い基準のまま続く（新しいほうへは追随しない）。

未解消（behind / rerunning / unverified / deferred）の job: status `unknown`、`at` と `run` なし、固定の `undeterminedReason`、
`lastObserved`（基準）、`freshness`（状態・取り直し回数など固定の項目）。observed（間隔の統計）は付けない。

## 連続回数

- 数えるのは**専用 state の保存に成功した check だけ**。同じ check の中の R / V、scan、serve、lock を取れなかった check、保存前の異常終了は数えない。
- その回の操作: 後退なし・解消 → 0。未解消（`deferred` を含む） → +1。一覧取得の失敗・job が出ない → 維持。identity 変化・release → 0。
- 保存に失敗した check は**飛ばす**（数えない）。その回の通知は保存済みの回数（前の check が残した値）だけで判定し、
  その回の観測（回数・新しい基準・解消）は失われる。その回が見た「解消」でも、立っているキーは消さない（再送の時計を保つ）。固定キー `store/gha-freshness/unsaved` を立てる。
  - 失われた新しい基準より古い一覧が次に来ても、古い基準より新しければ受け入れる → 後続の古い failure が FAILURE になりうる。
  - 失われた「解消」をまたいで、保存済みの回数が続く → 鮮度の知らせが本来より早く出うる（FAILURE ではない固定文面）。
  - 保存が失敗し続けると回数は進まず、鮮度の知らせは出ない（`unsaved` の 24 時間再送だけ）。
  - どれも限界として README に書く。両 state や Slack の失敗をまたいで「ちょうど 1 回だけ送る」は保証しない。

## 保存の順番（1 回の check）

notify-state を読む → 専用 state を読む → scan（1 段目・2 段目）→ snapshot を保存 → **専用 state を保存**（結果を記録）
→ 判定・キー（保存できたかどうかで使う回数を決める）→ Slack → notify-state を保存 → lock を外す。
Slack が例外で落ちても専用 state は保存済みのまま（回数は届けたかではなく観測を数える）。
release コマンドは `lastCheckAt` を変えない。

## 通知

- キー `github-actions/run-freshness/<job id>`。立つ条件: その check の scan に job があり、`disabled_manually` でなく、
  通知に使う回数 ≥ 2 で、その回の操作が 0 に戻すものではない。
- 送る・再送・消える・再発は既存の `noticesToSend` / `nextNoticeState`（job ごとの 24 時間時計）。
- 本文は job 1 つにつき固定の 1 行（job name・回数・固定の分類語。`notFound` なら人の解放の案内を 1 文）。reason 文字列・status・run id・本文・ヘッダは載せない。
- 既存の共有キー（`noticeKeys` / `jobsForKeys`）は `run-freshness` の分類を飛ばす。carryOver は今どおり（unknown は既存 failure を保持する）。
- `store/gha-freshness/{unsaved,corrupt,unsupported}` は固定の 1 行で、既存の再送規則に乗る。`corrupt` と、単発の `unsaved` は
  その回にしか立たないので、その回の Slack が失敗すると二度と届かない（stdout には残る。限界）。

## 読み手（scan / serve）

- 専用 state を lock なしで読む（rename なので書きかけは見えない）。無い・壊れている → 基準なし扱い（退避しない）。未知の版 → 鮮度判定なし。
- 初回の一覧だけ取る。newest が基準より古い → status `unknown`、固定 reason
  `run freshness: listing is older than the last check record (not rechecked here)`、`lastObserved` を付ける。2 段目・attempt 1 の追加取得はしない。
- newest が基準以上 → 通常の判定。**基準は更新しない**。回数・state・notify-state は書かない。snapshot は今どおり書く。

## 監視の盲点（D2。README に書く）

- lock を取れない check は rc 75 で、launchd connector も cronscope-check 自身も failure として扱わない。持ち主が居座る最初の 2 時間は、ログ以外どこにも出ない。
- 2 時間を超えても rc 1 と固定のログだけで、Slack には何も出ない。ログに残ることと通知されることは別。

## 設計（handoff 改訂版 §8 ほか）から置き換えた期待値

| 設計の箇所 | 設計の期待 | この契約 |
|---|---|---|
| §3.2 stale 判定・退避・回収、ケース 30 / 31 / 33 | pid・bootAt で stale と判定し退避して取得 | 回収しない。取得失敗は rc 75、2 時間超は rc 1。人が持ち主の停止を確かめて手で消す |
| §3.2 期限で自分の lock を外す | 期限で即解放 | 中断 → settle を確認 → 解放。15 秒で settle しなければ lock を残す |
| §3.2 SIGINT / SIGTERM | 解放してから終わる | 期限と同じ止め方 |
| §3.4 / ケース 34 保存失敗の回 | その回の値で通知を決める | 保存済みの回数で決める（その回は数えない） |
| §3.4 / §4.2 保存失敗の次の回 | 全 job の回数を 0 に戻す | 戻さない（失敗した回を飛ばすだけ） |
| §7.2 「kill -9 なら次の check が stale と判定して外す」 | 自動で外す | 人の対処 |
| §6.4 公平性 | 「手をつけた job」の定義が曖昧 | 最初の待ちを始めたら更新、未着手は更新しない |
| ケース 17（解消したが attempt 1 が財布切れ） | 既存の `http` 系分類で共有キー | `run-freshness` の固定 reason。無通知（自分で切った財布のため）。次の回の 1 段目で通常どおり判定 |
| §3.5 読み手が壊れたファイルを読んだ | stdout に 1 行 | 何も出さず、基準なしとして扱う |
| §3.1 書き手 | check だけ | check と、同じ lock の下の release コマンド（D1） |
| §3.4 両方の保存が失敗 | 「1 回早く出うる」 | 失敗した回は飛ばす。解消を見ても立っているキーは消さない |

## README に書くもの

D1 の注意（解放は復旧の確認ではない／次は初回扱い／古い failure が採用・通知されうる）、D2 の盲点（rc 75 は無音、2 時間超もログと rc 1 だけ）、
残った lock を人が消す手順（pid のプロセスがいないこと・ほかに check が走っていないことを確かめる）、保存失敗と破損の限界、
基準なしの回の限界、暫定値であること、30 日の掃除の意味。

## 人の解放（D1）

`cronscope gha-freshness release <job id> --repo <owner/repo> --workflow-id <id> --run <run id> [--yes]`
- `--yes` が無ければ説明だけ出して何も変えない（一致する基準があれば rc 0、無ければ rc 2）。照合するのは job id・repo・workflow id・基準 run id
  （path は job id の hash に含まれる。query 版は照合しない）。説明: 解放は復旧の確認ではない／次の check はその job を初回として扱う／古い failure が基準に採用され通知されうる。
- `--yes`: check と同じ lock（取れなければ何もしない rc 75 / rc 1）→ state を読む（壊れている・未知の版なら変更せず rc 1）
  → entry があり identity の repo・workflow id と基準 run id がすべて一致したときだけ、その entry を消して保存 → rc 0。
  不在・不一致は変更せず rc 2。全件解除への fallback は無い。notify-state には触らない。check は自動で解放しない。

## ログ

`# gha` 行は今のまま。後退を見つけた job だけ `# gha-freshness job=… outcome=… streak=… retries=… probe=… stop=… mark_run=… mark_created=… pages=<n>/<newest>/<oldest>/<total>,… name=…`（数値・時刻・固定語だけ）。
