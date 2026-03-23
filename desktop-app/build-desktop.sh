#!/bin/bash
set -e

echo "============================================"
echo "  Command Communications Desktop Build"
echo "============================================"
echo ""

cd "$(dirname "$0")"

echo "[1/3] Installing dependencies..."
npm install

echo ""
echo "[2/3] Building..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    npm run dist:mac
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
    npm run dist:win
else
    npm run dist:linux
fi

echo ""
echo "[3/3] Done!"
echo ""
echo "Installer is in: dist/"
ls -la dist/*.{exe,dmg,AppImage} 2>/dev/null || echo "(check dist/ folder)"
