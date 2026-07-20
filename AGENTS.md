# 閻魔庁ONLINE リポジトリ確認ガイド

## 最初に確認すること

- 同名の古いローカル複製が存在する可能性がある。調査前に `git rev-parse --show-toplevel`、`git remote get-url origin`、`git log -1 --oneline` を確認する。
- 正本は GitHub `aji42074567-stack/enmacho-online` の `main` ブランチ。許可された環境では `git fetch origin` 後に `origin/main` と比較する。
- 古いコミットだけを見て、現在の機能が存在しないと断定しない。

## オンライン連携の配置

- Supabase公開設定: `online/config.js`
- Supabase Auth・クラウドセーブ・Resend同期呼び出し: `online/account.js`
- Supabase Realtimeのプレイヤー同期: `online/presence.js`
- Supabase DB/RLS: `supabase/migrations/`
- Resend Contacts同期Edge Function: `supabase/functions/sync-resend-contact/`
- Cloudflare Durable Objectsの魔物同期: `worker/index.js` と `wrangler.jsonc`
- Cloudflare Pages公開先: `https://enmacho-online.pages.dev/`

秘密鍵やResend APIキーはリポジトリへ保存しない。`.env` がないことは、連携が未実装という意味ではない。秘密情報はSupabaseおよびCloudflare側のSecretsで管理する。
