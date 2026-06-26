#!/bin/bash
# Robustly locate node (launchd has no nvm in PATH) and run the ENGLESY auto-popup daemon.
set -e
cd "$(cd "$(dirname "$0")/.." && pwd)"   # repo root (this script lives in web/)

# Try nvm, then PATH, then the newest nvm node, then common install locations.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls -t "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1 || true)"
if [ -z "$NODE_BIN" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && NODE_BIN="$p" && break
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "[ENGLESY] node not found — install Node.js or fix PATH" >&2
  exit 127
fi

exec "$NODE_BIN" web/launcher.js "$@"
