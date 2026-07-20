# 魂籍オンライン機能の設定

閻魔庁ONLINEの公開ページには、公開可能なSupabase情報だけを置く。
Secret key、service role key、Resend API keyはGitHubへ保存しない。

## 現在の接続状態

- Supabaseプロジェクト: `enmacho-online`
- リージョン: Northeast Asia (Tokyo)
- 魂籍DB・RLS・Auth URL: 設定済み
- Edge Function `sync-resend-contact`: デプロイ済み
- Resend Segment `閻魔庁ONLINE 更新情報`: 作成・接続済み
- Supabase Custom SMTP: Resendへ接続済み
- 登録確認・パスワード再設定メール: 閻魔庁仕様の日本語テンプレートへ変更済み
- 同一マップのプレイヤーPresence・位置同期: 実装済み
- Cloudflare Pages: GitHub連携・自動デプロイ設定済み
- 公開URL: `https://enmacho-online.pages.dev/`
- 暫定送信元: `閻魔庁ONLINE <noreply@notify.mkrainbowshiva.com>`

閻魔庁専用ドメイン決定後は、Resendで送信ドメインを認証し、
Custom SMTPの送信元とSMTP用APIキーの対象ドメインを差し替える。

## 1. Supabaseプロジェクト

1. Supabaseで東京リージョンのプロジェクトを作成する。
2. SQL Editorで
   `supabase/migrations/202607200001_soul_accounts.sql` を実行する。
   続けて `supabase/migrations/202607210001_realtime_presence.sql` を実行する。
3. AuthenticationのURL設定へ以下を追加する。
   - Site URL: `https://enmacho-online.pages.dev/`
   - Redirect URL: `https://enmacho-online.pages.dev/**`
   - 移行中の予備URL: `https://aji42074567-stack.github.io/enmacho-online/**`
   - ローカル確認用: `http://127.0.0.1:8765/**`
4. `online/config.js`へProject URLとPublishable keyを設定する。

```js
window.ENMA_ONLINE_CONFIG = {
  supabaseUrl: 'https://PROJECT_REF.supabase.co',
  supabasePublishableKey: 'sb_publishable_...',
  resendSyncFunction: 'sync-resend-contact',
};
```

## 2. Resend

1. 閻魔庁用の送信ドメインをResendで認証する。
2. 送信専用APIキーを作成し、Supabase AuthのCustom SMTPを有効にする。
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: Resendの送信専用APIキー
3. Resendで「閻魔庁ONLINE 更新情報」用Segmentを作る。
4. Edge Functionの秘密情報を設定する。

```sh
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set RESEND_SEGMENT_ID=segment_xxx
supabase functions deploy sync-resend-contact
```

Edge Function用とSMTP用のAPIキーは分離する。
どちらもリポジトリには保存しない。

## 3. 登録者の確認

- 全アカウント: Supabase Dashboard → Authentication → Users
- ゲーム用一覧: Table Editor → `profiles`
- 更新情報の希望者: Resend Dashboard → Contacts / Segments

`profiles.soul_code`がユーザーへ見せる魂籍番号。
内部の認証・所有権判定には`auth.users.id`のUUIDを使う。

## 4. リアルタイム接続

- ログインしてゲームを開始したプレイヤーだけが接続対象。
- マップごとにPrivate Channelを分け、違う階層のプレイヤーは受信しない。
- Presenceは入退室だけ、移動はBroadcastで5回/秒を上限に送る。
- タブを隠す、ログアウトする、別マップへ移動する場合は現在のChannelを離脱する。
- 未ログインの端末プレイは従来どおり動作し、オンラインには表示されない。

## 5. 現在用意されるテーブル

- `profiles`: 魂籍番号、魂名、亡者／転生状態
- `account_preferences`: 本人だけが読めるメール配信設定
- `game_saves`: アカウント単位のクラウドセーブ
- `friendships`: フレンド申請と承認状態
- `blocks`: ブロック関係
- `nearby_chat_messages`: 画面内吹き出しチャットの履歴

吹き出しチャットは1通50文字、1秒1通、1分20通まで。
履歴の保存期間は7日を想定し、定期処理から
`select public.delete_expired_nearby_chat();` を実行する。
