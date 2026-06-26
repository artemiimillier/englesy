#!/bin/bash
# Double-click to open ENGLESY now. Starts the local server/daemon if it isn't
# already running, then opens the trainer in Chrome. (Manual launch, restored.)
cd "$(dirname "$0")"
URL="http://localhost:8000/?auto=1"

# If nothing is answering on :8000, start the auto-popup daemon in the background.
if ! curl -s -o /dev/null --max-time 1 "http://localhost:8000/"; then
  echo "Запускаю ENGLESY-сервер…"
  nohup /bin/bash web/run-launcher.sh >/tmp/englesy-launcher.log 2>&1 &
  sleep 1.5
fi

# Open in Chrome (voice needs Chrome); fall back to the default browser.
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"
