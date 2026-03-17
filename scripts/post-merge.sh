#!/bin/bash
set -e

echo "[post-merge] Installing backend dependencies..."
npm install --no-audit --no-fund

echo "[post-merge] Installing frontend dependencies..."
cd client && npm install --no-audit --no-fund && cd ..

echo "[post-merge] Done."
