#!/bin/zsh
# Builds a double-clickable ENGLESY.app launcher (and its icon) in the project root.
# Re-run any time. Requires only macOS built-ins (osacompile, sips, iconutil).
set -e
ROOT="/Users/artemiimiller/Documents/ENGLESY"
APP="$ROOT/ENGLESY.app"

# 1) icon
node "$ROOT/bin/make-icon.js" /tmp/englesy-icon.png
rm -rf /tmp/ENGLESY.iconset && mkdir -p /tmp/ENGLESY.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s /tmp/englesy-icon.png --out /tmp/ENGLESY.iconset/icon_${s}x${s}.png >/dev/null
  d=$((s*2)); sips -z $d $d /tmp/englesy-icon.png --out /tmp/ENGLESY.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns /tmp/ENGLESY.iconset -o /tmp/ENGLESY.icns

# 2) app bundle: double-click → launches ENGLESY in the background, then exits
rm -rf "$APP"
osacompile -o "$APP" -e 'do shell script "nohup /Users/artemiimiller/Documents/ENGLESY/bin/start-englesy.sh >/tmp/englesy.gui.log 2>&1 &"'

# 3) brand it
cp /tmp/ENGLESY.icns "$APP/Contents/Resources/applet.icns"
touch "$APP"
echo "Built $APP"
