#!/bin/bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

echo "=== Command Comms — Deploy ==="
echo "App directory: $APP_DIR"
echo ""

cd "$APP_DIR"

echo "[1/6] Pulling latest code from '$DEPLOY_BRANCH'..."
git fetch origin "$DEPLOY_BRANCH"
git reset --hard "origin/$DEPLOY_BRANCH"
git clean -fd

echo "[2/6] Verifying app directory and ownership..."
if [ ! -f "$APP_DIR/package.json" ]; then
  echo "ERROR: APP_DIR ($APP_DIR) does not look like the project root. Aborting."
  exit 1
fi
chown -R "$(whoami):$(whoami)" "$APP_DIR" 2>/dev/null || echo "(chown skipped — files already correctly owned, no action needed)"

echo "[3/6] Installing backend dependencies..."
npm install --production

echo "[4/6] Installing client dependencies..."
cd client
npm install

echo "[5/6] Building frontend..."
npm run build
cd ..

echo "[6/6] Restarting application..."
# This VM has developed a corrupted/stale PM2 process table where even
# `restart`/`delete command-comms` can crash while looking up process id 0.
# Reset the PM2 daemon itself, then start the single Command Comms app fresh.
pm2 kill 2>/dev/null || true
sleep 2
pm2 start deploy/ecosystem.config.cjs --only command-comms --update-env
pm2 save

echo ""
echo "=== Deploy Complete ==="
pm2 status
