# 閻魔庁ONLINE リポジトリ確認ガイド

## 最初に確認すること

- 同名の古いローカル複製が存在する可能性がある。調査前に `git rev-parse --show-toplevel`、`git remote get-url origin`、`git log -1 --oneline` を確認する。
- 正本は GitHub `aji42074567-stack/enmacho-online` の `main` ブランチ。許可された環境では `git fetch origin` 後に `origin/main` と比較する。
- 古いコミットだけを見て、現在の機能が存在しないと断定しない。

## ページ構成

- `index.html`: TOPページ(公式サイト)。ゲーム本体ではない
- `play.html`: ゲーム本体(旧index.html)。`#soul`付きで開くと魂籍パネルを自動表示
- 旧メール確認・パスワード再設定リンクがTOPに着地した場合は `play.html` へ転送される

## キャッシュの注意(重要)

- enmacho.com はCloudflareゾーン設定の「ブラウザキャッシュTTL(4時間)」が効いており、
  `_headers` の max-age=0 を上書きする(pages.dev側では `_headers` が有効)。
- そのため **`online/*.js` を変更したら、`play.html` のscriptタグと
  `online/account.js` のimportにある `?v=バージョン` を必ず上げること**。
  上げ忘れると、最大4時間、古いJSと新しいHTMLが混ざって不具合になる
  (例: 2026-07-21 ログイン済みでもチャット入力欄が無効のままになった)。
- 恒久対応はCloudflareダッシュボードで enmacho.com ゾーンの
  Caching → Browser Cache TTL を「Respect Existing Headers」へ変更(ユーザー操作が必要)。

## オンライン連携の配置

- Supabase公開設定: `online/config.js`
- Supabase Auth・クラウドセーブ・Resend同期呼び出し: `online/account.js`
- Supabase Realtimeのプレイヤー同期: `online/presence.js`
- Supabase DB/RLS: `supabase/migrations/`
- Resend Contacts同期Edge Function: `supabase/functions/sync-resend-contact/`
- Cloudflare Durable Objectsの魔物同期: `worker/index.js` と `wrangler.jsonc`
- 正式公開URL: `https://enmacho.com/`
- Cloudflare Pages予備URL: `https://enmacho-online.pages.dev/`

秘密鍵やResend APIキーはリポジトリへ保存しない。`.env` がないことは、連携が未実装という意味ではない。秘密情報はSupabaseおよびCloudflare側のSecretsで管理する。
