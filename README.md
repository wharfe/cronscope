# cronscope

ローカル(crontab/systemd)と各種サービス(GitHub Actions, Cloudflare)の定時実行を横断発見・可視化し、fail/overdue を Slack 通知する CLI。

## 使い方
- `npx cronscope scan` — 発見して一覧表示
- `npx cronscope serve [port]` — localhost ダッシュボード
- `npx cronscope check` — fail/overdue を Slack 通知（systemd timer で定期実行推奨）

## 設定
`~/.config/cronscope/config.json`（任意）:
- `scanRoots`: GHA 走査対象（既定 `~/dev`）
- `overdue.graceMinutes`: overdue 猶予（既定 60）

トークン類は env から:
- `CRONSCOPE_CF_API_TOKEN` / `CRONSCOPE_CF_ACCOUNT_ID`（Cloudflare 連携・任意）
- `CRONSCOPE_SLACK_WEBHOOK_URL`（Slack 通知）
