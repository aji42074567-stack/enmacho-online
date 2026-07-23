# 閻魔庁ONLINE リポジトリ確認ガイド

## 最初に確認すること

- 同名の古いローカル複製が存在する可能性がある。調査前に `git rev-parse --show-toplevel`、`git remote get-url origin`、`git log -1 --oneline` を確認する。
- 正本は GitHub `aji42074567-stack/enmacho-online` の `main` ブランチ。許可された環境では `git fetch origin` 後に `origin/main` と比較する。
- 古いコミットだけを見て、現在の機能が存在しないと断定しない。

## 作業の基本手順(Claude/Codex共通・厳守)

1. このリポジトリのみ使う。複製や別リポジトリを作らない
2. 作業開始前に必ず `git fetch origin && git status`。作業ツリーが綺麗なら `git pull --ff-only`
3. 未コミットの変更を勝手に reset / stash / 削除しない(別エージェントの作業中かもしれない)
4. **修正は必ず最新の origin/main から直接行う。古いブランチ上での作業や cherry-pick 運用は禁止**
   (2026-07-23、古いベースのブランチで修正→cherry-pick→rebase で差分が縮んで見え、
   「修正が消えた」と誤認して空コミットを作る事故が起きた)
5. force push 禁止。**差分0行の空コミットで「反映した」と報告するのも禁止**
   (コミット前に `git diff --cached --stat` で差分があることを確認する)
6. 複数マシン+複数エージェントが同じ作業ツリーを触ることがある。コミット時は
   `git diff --cached` で自分の変更だけが入っているか確認する
7. 完了時は変更内容・確認結果・コミットSHAを報告する

## 「修正完了」の定義(これを満たすまで「できた」と言わない)

閻魔庁ONLINEの本番は**2系統**あり、git push だけでは半分しか反映されない:

| 変更したもの | 反映方法 |
|---|---|
| play.html / index.html / online/*.js など | main へ push(Cloudflare Pages が自動デプロイ、1〜2分) |
| worker/index.js(共有ワールド=ボス出現・魔物同期) | push に加えて **`bash scripts/deploy_worker.sh` が必須** |
| supabase/migrations/ | ユーザーが Supabase の SQL Editor で適用(適用依頼を明示する) |

完了報告の前に必ず:

1. `git push` 済みであること(ローカルコミットだけでは本番に出ない)
2. worker/ を変えたなら `bash scripts/deploy_worker.sh` を実行したこと
3. online/*.js を変えたなら `?v=` を上げたこと(下記キャッシュの注意)
4. **`bash scripts/check_release.sh` を実行して全項目OKであること**
   (ローカル=GitHub=本番サイト=Worker の一致とボス3種の状態を一発確認できる)

動作確認は必ず **https://enmacho.com/** で行う。pages.dev や旧URLで確認しない。
Cloudflare Pages のダッシュボードから古いデプロイを手動リトライしない
(古いコミットが「最新デプロイ」扱いになり、本番が本当に巻き戻る)。

## ボス3種の仕様(消えたと誤認しないための知識)

- 鬼王オニオウ=cave3 / 骨王ガシャオウ=muen3 / 業龍ゴウリュウ=dg5。
  出現はWorker側 `CANONICAL_ZONE_BOSSES` がサーバー側で強制生成する(2026-07-23、6b1d336)
- 部屋(Durable Object)は誰かが入室して初めて生成される。`/health?zone=cave3` が
  `initialized:false` を返すのは「ボス消滅」ではなく「誰も入っていないだけ」
- ゴウリュウの「偶数時0分出現」は**廃止済み**(08369a5)。現仕様=入室時に即出現+討伐30分後に無条件復活
- 状態確認: `curl 'https://enmacho-world.aji42074567.workers.dev/health?zone=cave3'`(muen3/dg5も同様)。
  `build` フィールドでどのコミットのWorkerが動いているか分かる

## ページ構成

- `index.html`: TOPページ(公式サイト)。ゲーム本体ではない
- `play.html`: ゲーム本体(旧index.html)。`#soul`付きで開くと魂籍パネルを自動表示
- 旧メール確認・パスワード再設定リンクがTOPに着地した場合は `play.html` へ転送される

## キャッシュの注意(重要)

- **2026-07-23解決済み**: enmacho.com ゾーンの Browser Cache TTL を「既存のヘッダーを尊重する
  (Respect Existing Headers)」に変更済み。`_headers` の max-age=0 が本番でも効くようになった
  (curlで cache-control: max-age=0 を確認済み。以前は4時間キャッシュが上書きしていて
  「直したのに古いのが見える」の原因だった)。
- それでも **`online/*.js` を変更したら `play.html` のscriptタグと
  `online/account.js` のimportの `?v=バージョン` を上げる**運用は継続する
  (すでに古いJSを4時間キャッシュで抱えている訪問者への保険+変更の追跡が楽になるため)。

## オンライン連携の配置

- Supabase公開設定: `online/config.js`
- Supabase Auth・クラウドセーブ・Resend同期呼び出し: `online/account.js`
- Supabase Realtimeのプレイヤー同期: `online/presence.js`
- Supabase DB/RLS: `supabase/migrations/`
- Resend Contacts同期Edge Function: `supabase/functions/sync-resend-contact/`
- Cloudflare Durable Objectsの魔物同期: `worker/index.js`(設定は**リポジトリルート**の `wrangler.jsonc`。worker/ 内にwrangler設定は無い)
  - workerは**pushでは反映されない**。変更したら `bash scripts/deploy_worker.sh` を実行(このMacはwrangler認証済み)。
    素の `npx wrangler deploy` は使わない(/healthのbuildが'unknown'になり、どのコミットが動いているか分からなくなる)
  - `ALLOWED_ORIGINS` に公開ドメインを必ず入れる。2026-07-21、enmacho.com が漏れていて
    独自ドメイン移行後の魔物同期が黙って切れていた(各端末で別々の敵が見えた)
  - 魔物同期は全戦闘ゾーン対応(field/cave1-3/dg1-5/muen1-3)。ゾーンを増やしたら
    workerの `VALID_ZONE` と、play.html・online/world.js の `SHARED_ZONES` の3箇所に追加し、
    `npx wrangler deploy` を忘れない
- 正式公開URL: `https://enmacho.com/`
- Cloudflare Pages予備URL: `https://enmacho-online.pages.dev/`
- 旧URL `https://aji42074567-stack.github.io/enmacho-online/` は**転送専用**(2026-07-23切替)。
  `gh-pages` ブランチが enmacho.com への転送ページのみを配信している。
  **gh-pagesブランチは編集禁止・ゲーム本体を置かない**。GitHub Pagesのソースをmainに戻さない

秘密鍵やResend APIキーはリポジトリへ保存しない。`.env` がないことは、連携が未実装という意味ではない。秘密情報はSupabaseおよびCloudflare側のSecretsで管理する。

## 画像素材の原本

- `_wip_src/` はgitignore対象の素材置き場(このMacのローカルにのみ存在)。
  第二章の職「羅刹」`rasetsu_*.png`・「影法師」`kagebo_*.png`・「呪禁師」`jugon_*.png`・
  「護法僧」`goho_*.png`(いずれも組込済み=四職コンプリート)の男女一式が保管済み。
  内訳と組込仕様は `docs/art-guide.md` の各職の項を参照。
- 素材生成で `codex exec` を使うときは必ずリポジトリ直下で実行する。cwdがずれると相対パスの
  `-i 参照画像` が黙って外れ、別デザインで生成される。
