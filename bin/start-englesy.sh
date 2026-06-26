#!/bin/zsh
# ENGLESY launcher — used by the clickable app icon and the login auto-start agent.
# We unset ELECTRON_RUN_AS_NODE so Electron always boots its GUI (some shells set it).
unset ELECTRON_RUN_AS_NODE
cd "/Users/artemiimiller/Documents/ENGLESY" || exit 1
exec ./node_modules/.bin/electron .
