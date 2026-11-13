#!/usr/bin/env bash
# Ensure source control does not contain generated frontend build output.
# Production deployment and cloud tests run the Vite build from source.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
tracked="$(git ls-files -- client/dist/)"
if [[ -n "$tracked" ]]; then
  echo "FAIL: generated client/dist files are still tracked; remove with git rm -r --cached client/dist" >&2
  exit 1
fi
git check-ignore -q client/dist/index.html || {
  echo "FAIL: client/dist build artifacts are not ignored" >&2
  exit 1
}
echo "PASS: generated client/dist files are excluded from source control"
