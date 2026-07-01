#!/bin/bash
# web/autostart-uninstall.sh — fully remove the ENGLESY auto-start.
# Stops + unloads the LaunchAgent, deletes the plist and the ENGLESY.app.
set -u

LABEL="com.englesy.launcher"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/ENGLESY.app"
RUNTIME="$HOME/Library/Application Support/ENGLESY"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$APP"
rm -rf "$RUNTIME"

# Free the port in case a launcher instance is still lingering.
pkill -f "web/launcher.js" 2>/dev/null || true

echo "✅ Removed the LaunchAgent, plist, ENGLESY.app and the runtime copy."
echo "   (Logs kept at ~/Library/Logs/englesy-launcher.log — delete manually if you want.)"
echo "   Your learning progress lives in Chrome (localStorage) and is untouched."
