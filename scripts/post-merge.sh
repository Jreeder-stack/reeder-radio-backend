#!/bin/bash
set -e

echo "[post-merge] Installing backend dependencies..."
npm install --no-audit --no-fund --legacy-peer-deps

echo "[post-merge] Installing frontend dependencies..."
cd client && npm install --no-audit --no-fund --legacy-peer-deps && cd ..

echo "[post-merge] Done."
