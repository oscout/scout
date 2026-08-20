#!/usr/bin/env bash
# Print the launchd janitor configuration. Install only with explicit --apply.
set -euo pipefail

LABEL="com.arach.openscout-derived-state-janitor"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MODE="${1:-}"

render() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_DIR/janitor.sh</string>
    <string>--apply</string>
  </array>
  <key>StartInterval</key><integer>21600</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
EOF
}

if [ "$MODE" != "--apply" ]; then
  echo "DRY-RUN: would install $PLIST"
  render
  echo "Re-run with --apply to install and bootstrap. This installer never runs the janitor immediately."
  exit 0
fi

mkdir -p "$(dirname "$PLIST")"
render > "$PLIST"
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST (first scheduled run is within six hours; no cleanup was run now)."
