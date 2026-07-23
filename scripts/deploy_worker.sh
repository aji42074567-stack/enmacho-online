#!/bin/bash
# Worker(共有ワールドサーバー)の本番反映は必ずこのスクリプトで行う。
# git push では Worker は絶対に反映されない。素の `npx wrangler deploy` だと
# /health の build が 'unknown' になり、どのコミットが動いているか分からなくなる。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet -- worker/ || ! git diff --cached --quiet -- worker/; then
  echo "❌ worker/ に未コミットの変更があります。先にコミットしてから実行してください。"
  git status --short -- worker/
  exit 1
fi

SHA=$(git rev-parse --short HEAD)
echo "▶ コミット ${SHA} のWorkerをデプロイします…"
npx wrangler deploy --define BUILD_SHA:"\"${SHA}\""

echo ""
echo "▶ 反映確認(/health の build が ${SHA} なら成功):"
sleep 3
curl -s "https://enmacho-world.aji42074567.workers.dev/health" | python3 -m json.tool
