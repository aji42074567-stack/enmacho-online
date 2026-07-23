# アクセス解析・検索計測の設定

## 構成

- Google Search Console: 検索流入、インデックス状況、サイトマップ
- Google Analytics 4: ページ閲覧、流入元、端末、登録導線、ゲーム開始
- Microsoft Clarity: ヒートマップ、匿名化したセッション記録

解析タグはページ表示時に自動で読み込む。広告向けの保存領域とパーソナライズは常に無効にする。
ゲーム画面には `data-clarity-mask="true"` を指定し、名前・チャット・アカウント画面を含む内容を
Clarityへ送らない。

## 1. Search Console

1. Search Consoleで「プロパティを追加」を開く
2. `enmacho.com` をドメインプロパティとして追加する
3. 表示された `google-site-verification=...` のTXTレコードをCloudflare DNSへ追加する
4. 所有権を確認する
5. サイトマップに `https://enmacho.com/sitemap.xml` を送信する

DNS確認を使うことで、HTTPS/HTTPとwwwを含むドメイン全体を一つのプロパティで管理できる。
TXTレコードは確認後も削除しない。

## 2. Google Analytics 4

1. Google Analyticsにプロパティ「閻魔庁ONLINE」を作る
2. タイムゾーンを日本、通貨を日本円にする
3. ウェブデータストリーム `https://enmacho.com/` を作る
4. `G-` から始まる測定IDを `online/analytics-config.js` の `googleAnalyticsId` に設定する
5. 公開後、リアルタイムレポートとGoogle Tag Assistantで受信を確認する

自動ページビューのほか、次のイベントを送信する。

- `registration_cta_click`: 魂籍登録の導線クリック
- `guest_play_click`: 登録せず入庁する導線クリック
- `game_start`: ゲーム開始（既存記録の有無だけを付加）

序盤ファネル計測用のイベント（docs/retention-plan.md C層、2026-07-24追加）:

| イベント名 | 発火タイミング | パラメータ |
|---|---|---|
| `first_kill` | 初めて敵を成仏させた時（セーブの`story.firstKillDone`で1回のみ） | `mob`（敵の種類ID） |
| `quest_accept` | 高札でクエストを受注した時 | `quest_id` |
| `quest_complete` | クエストを達成した時 | `quest_id` |
| `level_up` | 徳位が上がった時 | `level` |
| `player_death` | 死亡した時 | `zone`, `level` |
| `zone_enter` | ゲーム開始後にゾーンを移動した時（起動時の初期配置は除く） | `zone` |
| `stat_allocate` | 魂の資質を初めて割り振った時（セーブの`story.statAllocated`で1回のみ） | なし |
| `account_register` | 魂籍の登録（signUp）に成功した時 | なし |
| `cloud_save` | クラウド自動保存が成功した時（1ページ表示につき初回のみ） | なし |

`tutorial_step`（着任チェックリストの各ステップ）は、チェックリスト本体（retention-plan.md A-1）の実装時に追加する。

ゲーム内の名前、メールアドレス、チャット本文など、個人を識別できる値をイベントへ追加しない。

## 3. Microsoft Clarity

1. Clarityに `https://enmacho.com/` のプロジェクトを作る
2. プロジェクトIDを `online/analytics-config.js` の `clarityProjectId` に設定する
3. 公開後、Clarityのセットアップ確認でタグ受信を確認する
4. 公開サイトのトップ・冥職名鑑でヒートマップを確認する

ClarityはCanvas内部を記録できないため、ゲーム本体のキャラクターや魔物に対する操作分析には向かない。
最初はトップページと冥職名鑑の導線改善を主目的にする。

## 4. 自動計測とプライバシー

- GA4とClarityはページ表示時に自動で読み込む
- 同意確認のポップアップは表示しない
- 広告向けの保存領域、Googleシグナル、広告パーソナライズは無効にする
- ゲーム画面はClarityで全面マスクし、名前・チャット・メールアドレス等を解析へ送らない

解析サービスや取得項目を変えた場合は、実態に合わせて `privacy.html` も更新する。
