#!/bin/bash
# Run the ENGLESY menu-bar launcher under launchd (which has no project PATH).
# Uses the project-local Electron binary; no global install needed.
set -e
# Some shells/agents set ELECTRON_RUN_AS_NODE=1, which makes electron boot as plain
# Node (no GUI/tray). Unset it so the menu-bar icon actually appears.
unset ELECTRON_RUN_AS_NODE
cd "$(cd "$(dirname "$0")/.." && pwd)"   # repo root (this script lives in src/)

ELECTRON="./node_modules/.bin/electron"
if [ ! -x "$ELECTRON" ]; then
  # Fallbacks: dist binary, then anything named electron on PATH.
  if [ -x "./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
    ELECTRON="./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  else
    ELECTRON="$(command -v electron || true)"
  fi
fi

if [ -z "$ELECTRON" ] || { [ ! -x "$ELECTRON" ] && ! command -v "$ELECTRON" >/dev/null 2>&1; }; then
  echo "[ENGLESY] electron not found — run 'npm install' first" >&2
  exit 127
fi

exec "$ELECTRON" src/menubar.js
