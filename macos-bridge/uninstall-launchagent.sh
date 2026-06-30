#!/usr/bin/env bash
# 卸载桥接服务 LaunchAgent。
set -uo pipefail
LABEL="com.h0ypothesis.bilibili.bridge"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "已卸载: ${LABEL}"
