# cronscope

> **cronscope** discovers and monitors your scheduled jobs across surfaces —
> local **crontab** & **systemd** timers, **GitHub Actions**, **Cloudflare**
> Workers cron, and **Hermes Agent** cron — from a single CLI. Zero-config for
> local; opt-in token for Cloudflare. `npx cronscope` and see everything that's
> scheduled, what's overdue, and what failed. Get Slack alerts when a job breaks.

ローカル(crontab / systemd)と各種サービス(GitHub Actions, Cloudflare, Hermes Agent)の
定時実行を**横断的に発見・可視化**し、fail / overdue を Slack 通知する CLI。
AI 開発時代に「自分の環境で何が定時実行されていて、何が落ちているか」を
把握しきれなくなる問題を、pull 型の状態取得で解く。AI エージェント（Hermes Agent）の
cron も監視対象に含む。

![cronscope dashboard](docs/dashboard.png)

## インストール / 使い方

```sh
npx cronscope scan          # 発見して一覧表示（ゼロ設定）
npx cronscope serve [port]  # localhost ダッシュボード
npx cronscope check         # fail/overdue を Slack 通知（systemd timer で定期実行推奨）
```

## コネクタ（段差 tier 型）

| tier | コネクタ | 取得 | 認証 |
|---|---|---|---|
| 0 | crontab | `crontab -l` をパース。cron ログ(journalctl/syslog)から last-fired を best-effort 取得し overdue 検知 | 不要 |
| 0 | systemd | user timer/service を `systemctl --user show` | 不要 |
| 0 | github-actions | `~/dev` 配下の `.github/workflows/*.yml` を走査 | 不要 |
| 0 | hermes | [Hermes Agent](https://github.com/NousResearch/hermes-agent) の `~/.hermes/cron/jobs.json` を読み、last-run 成否・次回実行を取得 | 不要 |
| 1 | cloudflare | API で Workers cron triggers を列挙（BYOK） | API token |

hermes / systemd は last-run 成否が取れるため fail / overdue アラートの対象になる（hermes は権威 `next_run_at` を使い、スケジューラ停止で発火が止まると overdue として検知する）。

crontab は exit code を残さないため status は `unknown`（成否は取れない）。ただし cron ログが読めれば last-fired と「鳴っていない（overdue）」を best-effort 検知する。誤検知を避けるため overdue は「観測窓内で実際に発火を観測したジョブが、その後の発火を落とした」場合に限定する（追加直後で未発火のジョブは対象外）。ログが読めない環境では last-run なしに degrade する。

## 設定

`~/.config/cronscope/config.json`（任意）:
- `scanRoots`: GHA 走査対象（既定 `~/dev`）
- `overdue.graceMinutes`: overdue 猶予（既定 60）

トークン類は **env 優先**（config に生値を置かない）:
- `CRONSCOPE_CF_API_TOKEN` / `CRONSCOPE_CF_ACCOUNT_ID` — Cloudflare（任意）
- `CRONSCOPE_SLACK_WEBHOOK_URL` — Slack 通知

## secret / プライバシー方針

- discovery snapshot・Web 表示は正規化済み allowlist フィールドのみ。元データ(`raw`)は永続化しない。
- `target` / `location` は表示前に redaction（token・URL 内資格情報をマスク）。
- token は env から読み、config / repo / snapshot に生値を残さない。

## ライセンス

MIT © 2026 wharfe
