#!/bin/bash
# 「ローカル / GitHub / 本番サイト / Worker」が全部そろっているかを一発で確認する。
# 使い方: bash scripts/check_release.sh
# 全部 OK なら本番反映済み。NG が出た行の指示に従う。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

WORKER_URL="https://enmacho-world.aji42074567.workers.dev"
SITE="https://enmacho.com"
UA="Mozilla/5.0 (release-check)"

echo "======================================"
echo " 閻魔庁ONLINE 本番そろってるかチェック"
echo "======================================"

echo ""
echo "■ 1) ローカル と GitHub(origin/main)"
git fetch origin -q
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$LOCAL" = "$REMOTE" ] && [ "$DIRTY" = "0" ]; then
  echo "  OK: ローカルmain = GitHub main ($(git rev-parse --short main))、未コミットなし"
else
  [ "$DIRTY" != "0" ] && { echo "  NG: 未コミットの変更があります:"; git status --short | sed 's/^/      /'; }
  if [ "$LOCAL" != "$REMOTE" ]; then
    echo "  NG: ローカルとGitHubがずれています"
    git log --oneline origin/main..main | sed 's/^/      push待ち: /'
    git log --oneline main..origin/main | sed 's/^/      pull待ち: /'
  fi
fi

echo ""
echo "■ 2) 本番サイト($SITE)が GitHub main と同じか"
for f in play.html index.html online/account.js online/world.js online/presence.js online/config.js; do
  L=$(git show "origin/main:$f" 2>/dev/null | md5 -q)
  P=$(curl -sL --compressed -A "$UA" "$SITE/$f?nocache=$(date +%s)" | md5 -q)
  if [ "$L" = "$P" ]; then
    echo "  OK: $f"
  else
    echo "  NG: $f が本番で古い → 数分待って再実行。直らなければ:"
    echo "      npx wrangler pages deployment list --project-name=enmacho-online で最新デプロイのSourceを確認"
  fi
done

echo ""
echo "■ 3) Worker(共有ワールド)がどのコミットか"
HJ=$(curl -s "$WORKER_URL/health")
WSHA=$(echo "$HJ" | python3 -c "import json,sys; print(json.load(sys.stdin).get('build','?'))" 2>/dev/null || echo "?")
GSHA=$(git rev-parse --short origin/main)
echo "  Worker build=$WSHA / GitHub main=$GSHA"
if [ "$WSHA" = "unknown" ] || [ "$WSHA" = "?" ]; then
  echo "  注意: buildが記録されていません → scripts/deploy_worker.sh でデプロイし直してください"
elif git cat-file -e "$WSHA" 2>/dev/null; then
  if git diff --quiet "$WSHA" origin/main -- worker/ wrangler.jsonc; then
    echo "  OK: Workerはmainと同じworker/コードで動いています"
  else
    echo "  NG: Worker(${WSHA})以降に worker/ が変更されています → scripts/deploy_worker.sh を実行"
  fi
else
  echo "  注意: build=$WSHA がローカル履歴に見つかりません(git fetch後に再実行)"
fi

echo ""
echo "■ 4) ボス3種の生存確認"
for z in cave3 muen3 dg5; do
  curl -s "$WORKER_URL/health?zone=$z" | python3 -c "
import json,sys
d=json.load(sys.stdin)
z=d.get('zone','$z'); b=d.get('boss')
names={'oni_king':'鬼王オニオウ','gashao':'骨王ガシャオウ','drake':'業龍ゴウリュウ'}
if not d.get('initialized'):
    print(f'  {z}: 部屋は未生成(誰かが入った瞬間にボスが自動出現する正常な状態)')
elif b and b.get('alive'):
    print(f\"  OK {z}: {names.get(b['type'],b['type'])} 生存 HP {b['hp']}/{b['maxHp']}\")
elif b:
    print(f\"  {z}: {names.get(b['type'],b['type'])} は討伐済み(あと{b['respawnSeconds']}秒で復活)\")
else:
    print(f'  NG {z}: 部屋はあるのにボス情報なし → 要調査')
" 2>/dev/null || echo "  NG $z: Workerに接続できません"
done

echo ""
echo "チェック完了。NGゼロなら「本番に反映済み」と言い切ってOK。"
