#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_env

LABEL="com.cloud.sdd-host-runner"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/cloud-mcp"
RUNTIME_DIR="$HOME/Library/Application Support/cloud-mcp-host-runner"
SERVICE_TARGET="gui/$(id -u)/$LABEL"

require_command node

mkdir -p "$PLIST_DIR" "$LOG_DIR" "$RUNTIME_DIR"

if [[ ! -f "$PROJECT_DIR/dist/host-runner.js" ]]; then
  echo "Build ausente. Rodando npm run build..."
  npm run build
fi

echo "Preparando runtime local em $RUNTIME_DIR..."
rm -rf "$RUNTIME_DIR/dist" "$RUNTIME_DIR/node_modules"
cp -R "$PROJECT_DIR/dist" "$RUNTIME_DIR/dist"
cp -R "$PROJECT_DIR/node_modules" "$RUNTIME_DIR/node_modules"
cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$PROJECT_DIR/.env" "$RUNTIME_DIR/"

xml_escape() {
  printf "%s" "$1" | sed -e "s/&/\\&amp;/g" -e "s/</\\&lt;/g" -e "s/>/\\&gt;/g"
}

NODE_BIN_XML="$(xml_escape "$(command -v node)")"
RUNTIME_DIR_XML="$(xml_escape "$RUNTIME_DIR")"
HOST_RUNNER_JS_XML="$(xml_escape "$RUNTIME_DIR/dist/host-runner.js")"
STDOUT_XML="$(xml_escape "$LOG_DIR/host-runner.out.log")"
STDERR_XML="$(xml_escape "$LOG_DIR/host-runner.err.log")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN_XML</string>
    <string>$HOST_RUNNER_JS_XML</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$RUNTIME_DIR_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOST_RUNNER_HOST</key>
    <string>0.0.0.0</string>
    <key>HOST_RUNNER_PORT</key>
    <string>37243</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STDOUT_XML</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_XML</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "$SERVICE_TARGET"

echo "Host runner instalado e iniciado via launchd: $LABEL"
echo "Plist: $PLIST"
echo "Logs: $LOG_DIR/host-runner.out.log e $LOG_DIR/host-runner.err.log"
