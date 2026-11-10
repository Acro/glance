#!/bin/bash
# Optional: run glance at login via launchd. Usage: launchagent.sh install | uninstall
set -euo pipefail
LABEL=local.glance
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
# GLANCE_* settings and CLAUDE_CONFIG_DIR set in this shell now are copied into the login item.
# glance also reads .env next to glance.mjs at every start (shell values win), so .env needs no reinstall.
ENVXML=""
while IFS='=' read -r k v; do
  v=${v//&/&amp;}; v=${v//</&lt;}; v=${v//>/&gt;}
  ENVXML+="<key>$k</key><string>$v</string>"
done < <(env | grep -E '^(GLANCE_[A-Z_]+|CLAUDE_CONFIG_DIR)=' || true)
case "${1:-}" in
  install)
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--max-old-space-size=96</string><string>$DIR/glance.mjs</string></array>
  <key>EnvironmentVariables</key><dict>$ENVXML</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$DIR/glance.err.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "glance running at login → http://127.0.0.1:${GLANCE_PORT:-7357}" ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "removed" ;;
  *) echo "usage: $0 install|uninstall"; exit 2 ;;
esac
