#!/bin/bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

echo "=== Command Comms — Deploy ==="
echo "App directory: $APP_DIR"
echo ""

cd "$APP_DIR"

echo "[1/5] Pulling latest code from '$DEPLOY_BRANCH'..."
git fetch origin "$DEPLOY_BRANCH"
git reset --hard "origin/$DEPLOY_BRANCH"
git clean -fd

echo "[2/5] Installing backend dependencies..."
npm install --production

echo "[3/5] Installing client dependencies..."
cd client
npm install

echo "[4/5] Building frontend..."
npm run build
cd ..

echo "[5/5] Restarting application..."
if pm2 describe command-comms &>/dev/null; then
  pm2 restart deploy/ecosystem.config.cjs
else
  pm2 start deploy/ecosystem.config.cjs
fi
pm2 save

echo ""
echo "=== Deploy Complete ==="
pm2 status
