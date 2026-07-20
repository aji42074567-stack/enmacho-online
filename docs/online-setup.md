# 魂籍オンライン機能の設定

閻魔庁ONLINEの公開ページには、公開可能なSupabase情報だけを置く。
Secret key、service role key、Resend API keyはGitHubへ保存しない。

## 現在の接続状態

- Supabaseプロジェクト: `enmacho-online`
- リージョン: Northeast Asia (Tokyo)
- 魂籍DB・RLS・Auth URL: 設定済み
- Edge Function `sync-resend-contact`: デプロイ済み
- Resend Segment `閻魔庁ONLINE 更新情報`: 作成・接続済み
- Resendの送信ドメインとSupabase Custom SMTP: 閻魔庁用ドメイン決定後に設定

送信ドメイン決定までは、魂籍の確認メールにSupabase標準メールを使用する。

## 1. Supabaseプロジェクト

1. Supabaseで東京リージョンのプロジェクトを作成する。
2. SQL Editorで
   `supabase/migrations/202607200001_soul_accounts.sql` を実行する。
3. AuthenticationのURL設定へ以下を追加する。
   - Site URL: `https://aji42074567-stack.github.io/enmacho-online/`
   - Redirect URL: `https://aji42074567-stack.github.io/enmacho-online/**`
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
2. Supabase IntegrationsからResendを接続し、AuthのCustom SMTPを有効にする。
3. Resendで「閻魔庁ONLINE 更新情報」用Segmentを作る。
4. Edge Functionの秘密情報を設定する。

```sh
supabase secrets set RESEND_API_KEY=re_xxx
supabase secrets set RESEND_SEGMENT_ID=segment_xxx
supabase functions deploy sync-resend-contact
```

ResendのAPIキーはEdge Functionだけで使用する。

## 3. 登録者の確認

- 全アカウント: Supabase Dashboard → Authentication → Users
- ゲーム用一覧: Table Editor → `profiles`
- 更新情報の希望者: Resend Dashboard → Contacts / Segments

`profiles.soul_code`がユーザーへ見せる魂籍番号。
内部の認証・所有権判定には`auth.users.id`のUUIDを使う。

## 4. 現在用意されるテーブル

- `profiles`: 魂籍番号、魂名、亡者／転生状態
- `account_preferences`: 本人だけが読めるメール配信設定
- `game_saves`: アカウント単位のクラウドセーブ
- `friendships`: フレンド申請と承認状態
- `blocks`: ブロック関係
- `nearby_chat_messages`: 画面内吹き出しチャットの履歴

吹き出しチャットは1通50文字、1秒1通、1分20通まで。
履歴の保存期間は7日を想定し、定期処理から
`select public.delete_expired_nearby_chat();` を実行する。
