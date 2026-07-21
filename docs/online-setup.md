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
- 賽の森の魔物同期: Cloudflare Durable Objectsで実装済み
- 魔物同期Worker: `https://enmacho-world.aji42074567.workers.dev`
- Cloudflare Pages: GitHub連携・自動デプロイ設定済み
- 正式公開URL: `https://enmacho.com/`
- Cloudflare Pages予備URL: `https://enmacho-online.pages.dev/`
- 暫定送信元: `閻魔庁ONLINE <noreply@notify.mkrainbowshiva.com>`

閻魔庁専用ドメイン決定後は、Resendで送信ドメインを認証し、
Custom SMTPの送信元とSMTP用APIキーの対象ドメインを差し替える。

## 1. Supabaseプロジェクト

1. Supabaseで東京リージョンのプロジェクトを作成する。
2. SQL Editorで
   `supabase/migrations/202607200001_soul_accounts.sql` を実行する。
   続けて `supabase/migrations/202607210001_realtime_presence.sql` を実行する。
3. AuthenticationのURL設定へ以下を追加する。
   - Site URL: `https://enmacho.com/`
   - Redirect URL: `https://enmacho.com/**`
   - Cloudflare Pages予備URL: `https://enmacho-online.pages.dev/**`
   - GitHub Pages予備URL: `https://aji42074567-stack.github.io/enmacho-online/**`
   - ローカル確認用: `http://127.0.0.1:8765/**`
4. `online/config.js`へProject URLとPublishable keyを設定する。

```js
window.ENMA_ONLINE_CONFIG = {
  supabaseUrl: 'https://PROJECT_REF.supabase.co',
  supabasePublishableKey: 'sb_publishable_...',
  resendSyncFunction: 'sync-resend-contact',
  worldServerUrl: 'https://enmacho-world.SUBDOMAIN.workers.dev',
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

## 6. 魔物の共有ワールド

賽の森ではCloudflare Worker `enmacho-world`が、魔物25体の位置・標的・HP・
死亡・20秒後の復活を管理する。1マップにつき1つのDurable Objectを使い、
ログイン中のプレイヤーとはWebSocketで同期する。

- クライアントは移動位置と攻撃命令だけを送る。
- 魔物AI、ダメージ確定、死亡、復活はDurable Objectが決める。
- 他サイトからの接続を拒否し、Supabaseのアクセストークンを接続時に検証する。
- 誰もいない時は更新ループを止め、最後の魔物状態をSQLite-backed storageへ保存する。
- 未ログイン、同期障害、洞窟内では従来の端末内AIへ自動的に戻る。

デプロイ:

```sh
npx wrangler deploy
```

`wrangler.jsonc`のSupabase値は公開可能なProject URLとPublishable keyだけを置く。
`service_role`やSecret keyは置かない。
