# アクセス解析・検索計測の設定

## 構成

- Google Search Console: 検索流入、インデックス状況、サイトマップ
- Google Analytics 4: ページ閲覧、流入元、端末、登録導線、ゲーム開始
- Microsoft Clarity: ヒートマップ、匿名化したセッション記録

解析タグは利用者が同意するまで読み込まない。広告向けの保存領域とパーソナライズは常に無効にする。
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

ゲーム内の名前、メールアドレス、チャット本文など、個人を識別できる値をイベントへ追加しない。

## 3. Microsoft Clarity

1. Clarityに `https://enmacho.com/` のプロジェクトを作る
2. プロジェクトIDを `online/analytics-config.js` の `clarityProjectId` に設定する
3. 公開後、Clarityのセットアップ確認でタグ受信を確認する
4. 公開サイトのトップ・冥職名鑑でヒートマップを確認する

ClarityはCanvas内部を記録できないため、ゲーム本体のキャラクターや魔物に対する操作分析には向かない。
最初はトップページと冥職名鑑の導線改善を主目的にする。

## 4. 同意と設定変更

- 初回訪問時に「許可する」「拒否する」を表示する
- 拒否中はGA4とClarityのスクリプトを読み込まない
- 選択はローカルストレージへ保存する
- Global Privacy ControlまたはDo Not Trackが有効なら解析を読み込まない
- プライバシーポリシーの「アクセス解析の設定を変更」から後で変更できる

解析サービスや取得項目を変えた場合は、`privacy.html` と `consentVersion` を更新して再同意を求める。
