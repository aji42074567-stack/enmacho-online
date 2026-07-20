# 薬・装備 素材台帳

提供素材から切り出した、薬と装備画像の保管台帳。
表示用画像はすべて透過PNG・256×256で `assets/items/` に保存する。

## 薬

| ゲーム内名称 | 色 | ファイル | 用途 |
|---|---|---|---|
| 甘露水 S | 翡翠 | `potion_kanro.png` | HP+65 / 使用後2.5秒 |
| 甘露水 M | 翡翠 | `potion_kanro.png` | HP+180 / 使用後4秒 |
| 甘露水 L | 翡翠 | `potion_kanro.png` | HP+420 / 使用後6秒 |
| 韋駄天の水 | 蒼 | `potion_idaten.png` | 5分 高速化 |
| 修羅の酒 | 朱赤 | `potion_shura.png` | 5分 会心率+25% |

甘露水S/M/Lは同じ回復薬ディレイを共有する。別サイズへ切り替えても待ち時間は回避できない。
Sは普段使い、Mは標準、Lは長いディレイと高価格を伴うボス戦用として扱う。

## 胴装備

画像順は、元素材の胴装備上段左から右、その後に下段左から右。

| 順 | 名称 | 希少度 | ファイル | 状態 |
|---:|---|---|---|---|
| 1 | 経帷子 | 並 | `armor_kyokatabira.png` | 使用中 (`cloth`) |
| 2 | 鬼革の胴着 | 並 | `armor_onigawa_dogi.png` | 使用中 (`leather`) |
| 3 | 六文締めの黒胴 | 上等 | `armor_rokumon_black.png` | 将来用 |
| 4 | 影獄の忍衣 | 上等 | `armor_kagegoku_ninja.png` | 将来用 |
| 5 | 獄卒の綿鎧 | 希少 | `armor_gokusotsu_padded.png` | 使用中 (`gokusotsu`・B2ドロップ) |
| 6 | 青燐の武者衣 | 希少 | `armor_seirin_musha.png` | 将来用 |
| 7 | 冥鉄の段鎧 | 名品 | `armor_meitetsu_dan.png` | 使用中 (`chain`) |
| 8 | 冥府の具足 | 名品 | `armor_meifu_gusoku.png` | 使用中 (`plate`) |
| 9 | 彼岸朱印の斎装束 | 秘宝 | `armor_higan_shuin.png` | 将来用 |
| 10 | 紫怨の喪衣 | 伝説 | `armor_shion_mourning.png` | 将来用 |

現行セーブとの互換性を保つため、ゲーム内で使用中の4点はIDを変更せず、名称と画像だけを更新する。
将来用6点は価格・防御力・入手経路を決めるまで `ITEMS` へ登録しない。

## 頭装備

提供素材「ChatGPT Image 2026年7月19日 13_11_52.png」の上段左から右、その後に下段左から右。

| 順 | 名称 | 希少度 | ファイル | 状態 |
|---:|---|---|---|---|
| 1 | 朽布の覆面 | 並 | `head_kuchinuno_mask.png` | 将来用 |
| 2 | 網代笠 | 並 | `head_ajiro_kasa.png` | 使用中 (`kasa`) |
| 3 | 影縫いの頭巾 | 上等 | `head_kagenui_hood.png` | 使用中 (`kagenui`・B2ドロップ) |
| 4 | 双月の前立兜 | 名品 | `head_sogetsu_kabuto.png` | 将来用 |
| 5 | 骸面の頭巾 | 希少 | `head_gaimen_hood.png` | 将来用 |
| 6 | 黒鉄の馬尾兜 | 希少 | `head_kurogane_babi.png` | 将来用 |
| 7 | 鬼面の兜 | 秘宝 | `head_onimen_kabuto.png` | 使用中 (`oni_helm`) |
| 8 | 封呪の烏帽子 | 名品 | `head_fuju_eboshi.png` | 将来用 |
| 9 | 獣骨の呪冠 | 伝説 | `head_jukotsu_crown.png` | 使用中 (`jukotsu_crown`・オニオウ) |
| 10 | 砂葬の兜巾 | 上等 | `head_saso_kabutozukin.png` | 将来用 |

既存の `kasa` と `oni_helm` はID・価格・防御力を維持し、対応画像だけを追加する。
将来用8点は価格・防御力・入手経路を決めるまで `ITEMS` へ登録しない。

## 腕装備

提供素材「ChatGPT Image 2026年7月19日 13_35_18 (1).png」の上段左から右、その後に下段左から右。

| 順 | 名称 | 希少度 | ファイル | 状態 |
|---:|---|---|---|---|
| 1 | 朽布の巻籠手 | 並 | `arms_kuchinuno_makigote.png` | 将来用 |
| 2 | 革の籠手 | 並 | `arms_kawa_kote.png` | 使用中 (`kote`) |
| 3 | 黒鉄の筒籠手 | 上等 | `arms_kurogane_tsutsugote.png` | 将来用 |
| 4 | 朱縄の大籠手 | 名品 | `arms_shunawa_ogote.png` | 将来用 |
| 5 | 鎖封じの鉄籠手 | 希少 | `arms_kusarifuji_kote.png` | 使用中 (`kusarifuji`・B3ドロップ) |
| 6 | 彼岸朱印の斎手甲 | 希少 | `arms_higan_shuin_tekko.png` | 将来用 |
| 7 | 鬼鉄の籠手 | 秘宝 | `arms_onitetsu_kote.png` | 使用中 (`oni_kote`) |
| 8 | 獣骨の呪籠手 | 名品 | `arms_jukotsu_noroi.png` | 将来用 |
| 9 | 影獄の忍手甲 | 上等 | `arms_kagegoku_nintekko.png` | 将来用 |
| 10 | 紫怨の鬼火籠手 | 伝説 | `arms_shion_onibi.png` | 将来用 |

既存の `kote` と `oni_kote` はID・価格・防御力を維持し、対応画像だけを追加する。
将来用8点は価格・防御力・入手経路を決めるまで `ITEMS` へ登録しない。

## 足装備

提供素材「ChatGPT Image 2026年7月19日 13_36_51.png」の上段左から右、その後に下段左から右。

| 順 | 名称 | 希少度 | ファイル | 状態 |
|---:|---|---|---|---|
| 1 | 白緒の草鞋 | 並 | `feet_shirao_waraji.png` | 使用中 (`waraji`) |
| 2 | 旅人の革長靴 | 並 | `feet_kawa_nagagutsu.png` | 将来用 |
| 3 | 影獄の忍足袋 | 上等 | `feet_kagegoku_nintabi.png` | 将来用 |
| 4 | 冥鉄の脛当て | 名品 | `feet_meitetsu_suneate.png` | 使用中 (`suneate`) |
| 5 | 青燐の武者具足 | 希少 | `feet_seirin_musha.png` | 将来用 |
| 6 | 紫怨の呪足袋 | 希少 | `feet_shion_noroi_tabi.png` | 将来用 |
| 7 | 白金の法具足 | 秘宝 | `feet_hakkin_hougusoku.png` | 将来用 |
| 8 | 雪獣の毛皮靴 | 名品 | `feet_setsuju_kegawa.png` | 将来用 |
| 9 | 鬼焔の大具足 | 伝説 | `feet_kien_ogusoku.png` | 将来用 |
| 10 | 砂葬の数珠足袋 | 上等 | `feet_saso_juzu_tabi.png` | 将来用 |

既存の `waraji` と `suneate` はID・価格・防御力を維持し、対応画像だけを追加する。
将来用8点は価格・防御力・入手経路を決めるまで `ITEMS` へ登録しない。

## 飾り(アクセサリー)

提供素材「ChatGPT Image 2026年7月20日 12_53_33.png」の左から右。

| 順 | 名称 | 希少度 | ファイル | 状態 |
|---:|---|---|---|---|
| 1 | 六道の数珠 | 並 | `acc_rokudo_juzu.png` | 使用中 (`juzu`) |
| 2 | 木札の護符 | 上等 | `acc_kifuda_gofu.png` | 将来用 |
| 3 | 蒼の勾玉 | 並 | `acc_ao_magatama.png` | 使用中 (`magatama`) |
| 4 | 浄めの匂袋 | 希少 | `acc_kiyome_nioibukuro.png` | 将来用 |

既存の `juzu` と `magatama` はID・価格・効果を維持し、対応画像だけを追加する。
将来用2点は効果・入手経路を決めるまで `ITEMS` へ登録しない。

## 巻物

提供素材「ChatGPT Image 2026年7月20日 12_59_07.png」の左から右。

| 名称 | ファイル | 用途 |
|---|---|---|
| 武器強化の巻物 | `scroll_weapon.png` | 装備中の武器を+1(カナヤマで購入・使用) |
| 防具強化の巻物 | `scroll_armor.png` | 装備中の胴を+1(カナヤマで購入・使用) |

## 希少素材

| 名称 | 入手先 | 確率 | 所持形式 | 現在の用途 |
|---|---|---:|---|---|
| 竜の血 | ゴウリュウ | 7% | スタック可能 | 将来の製作・強化・クエスト用 |

「竜の血」はゴウリュウ討伐ごとに独立して抽選する。装備・甘露水と同時に入手でき、道具タブへ所持数を表示する。
