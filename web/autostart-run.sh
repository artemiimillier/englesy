#!/bin/bash
# web/autostart-run.sh — the command launchd runs on login/boot.
#
# launchd does NOT load your login shell (~/.zshrc, nvm, Homebrew shims), so we
# resolve a Node binary ourselves and set a minimal PATH (Node dir + system dirs
# so the launcher's `open -a "Google Chrome"` works). Then we exec the ENGLESY
# browser-first launcher, which serves the app on :8000 and auto-pops the trainer
# per the schedule in config.json.
set -u

# Repo root = parent of this script's directory (portable, no hardcoded path).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pick a Node: newest nvm install → Homebrew → system. First one that exists wins.
pick_node() {
  local c
  c="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  if [ -n "$c" ] && [ -x "$c" ]; then echo "$c"; return; fi
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
}

NODE_BIN="$(pick_node)"
if [ -z "${NODE_BIN:-}" ]; then
  echo "[ENGLESY] $(date '+%F %T') Node.js not found — cannot start launcher." >&2
  exit 78   # EX_CONFIG — launchd will retry (throttled) once Node is available.
fi

export PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
cd "$REPO" || exit 1

echo "[ENGLESY] $(date '+%F %T') starting launcher (node: $NODE_BIN)"
exec "$NODE_BIN" "$REPO/web/launcher.js"
