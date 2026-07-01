#!/bin/bash
# web/autostart-install.sh — make ENGLESY always-on + auto-start after every reboot.
#
# WHY A RUNTIME COPY: this repo lives in ~/Documents, which macOS protects (TCC).
# A background launchd agent is DENIED access to ~/Documents/~/Desktop/~/Downloads,
# so it can neither run nor serve files from here. We therefore install a
# self-contained runtime under ~/Library/Application Support/ENGLESY (not protected)
# and point the LaunchAgent at THAT. Re-run this script anytime to re-sync after you
# change sentences/config in the repo.
#
#   bash web/autostart-install.sh          → sync runtime, install agent, start now
#
# Fully reversible: bash web/autostart-uninstall.sh
set -euo pipefail

LABEL="com.englesy.launcher"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"                       # source (dev checkout)
RUNTIME="$HOME/Library/Application Support/ENGLESY"        # where it actually runs from
WRAP="$RUNTIME/web/autostart-run.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/englesy-launcher.log"
APP="$HOME/Applications/ENGLESY.app"
UID_NUM="$(id -u)"

echo "▸ Source:  $REPO"
echo "▸ Runtime: $RUNTIME"
echo "▸ Agent:   $PLIST"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/Applications" "$RUNTIME"

# Stop any running instance before we overwrite its files.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true

# --- 1) Sync the runtime (web/ + data/ + config.json) out of the protected folder
echo "▸ Syncing runtime (first run copies ~$(du -sh "$REPO/data" 2>/dev/null | cut -f1) of audio; later runs are incremental)…"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$REPO/web/"  "$RUNTIME/web/"
  rsync -a --delete "$REPO/data/" "$RUNTIME/data/"
else
  rm -rf "$RUNTIME/web" "$RUNTIME/data"
  mkdir -p "$RUNTIME/web" "$RUNTIME/data"
  cp -R "$REPO/web/."  "$RUNTIME/web/"
  cp -R "$REPO/data/." "$RUNTIME/data/"
fi
cp "$REPO/config.json" "$RUNTIME/config.json"
chmod +x "$WRAP"

# --- 2) Write the LaunchAgent plist (points at the RUNTIME wrapper) -------------
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$WRAP</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>$RUNTIME</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST

# --- 3) (Re)load it with launchd ------------------------------------------------
if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
fi
launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

# --- 4) Build a clickable ENGLESY.app (opens the trainer on demand) -------------
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<'INFO'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ENGLESY</string>
  <key>CFBundleDisplayName</key><string>ENGLESY</string>
  <key>CFBundleIdentifier</key><string>com.englesy.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>ENGLESY</string>
  <key>CFBundleIconFile</key><string>icon</string>
</dict>
</plist>
INFO

cat > "$APP/Contents/MacOS/ENGLESY" <<'RUN'
#!/bin/bash
# ENGLESY.app — open the trainer. The background LaunchAgent serves it on :8000;
# if it isn't up yet, wait briefly for it.
URL="http://localhost:8000/?lang=en&auto=1"
for i in $(seq 1 30); do
  /usr/bin/curl -s -o /dev/null "http://localhost:8000/" && break
  sleep 0.5
done
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
RUN
chmod +x "$APP/Contents/MacOS/ENGLESY"

# Best-effort icon from the SVG (QuickLook render → iconset → icns). Never fatal.
if command -v qlmanage >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  if qlmanage -t -s 1024 -o "$TMP" "$RUNTIME/web/icons/icon.svg" >/dev/null 2>&1 && \
     [ -f "$TMP/icon.svg.png" ]; then
    ICONSET="$TMP/icon.iconset"; mkdir -p "$ICONSET"
    for s in 16 32 64 128 256 512; do
      sips -z "$s" "$s"         "$TMP/icon.svg.png" --out "$ICONSET/icon_${s}x${s}.png"     >/dev/null 2>&1 || true
      sips -z $((s*2)) $((s*2)) "$TMP/icon.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns" 2>/dev/null || true
  fi
  rm -rf "$TMP"
fi
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" >/dev/null 2>&1 || true

# --- 5) Report ------------------------------------------------------------------
echo
echo "✅ Installed. ENGLESY will auto-start every time you log in and stay running."
echo "   • Server:   http://localhost:8000"
echo "   • App icon: $APP  (in ~/Applications — click to open the trainer)"
echo "   • Status:   launchctl print gui/$UID_NUM/$LABEL | grep -E 'state|pid'"
echo "   • Logs:     tail -f \"$LOG\""
echo "   • Re-sync after repo edits:  bash web/autostart-install.sh"
echo "   • Remove:   bash web/autostart-uninstall.sh"
