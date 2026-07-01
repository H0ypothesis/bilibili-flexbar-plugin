#!/usr/bin/env bash
# ============================================================================
# 生成「哔哩哔哩(调试)」启动器 .app —— 点一下就带 --remote-debugging-port 启动 B站。
#
# 背景：macOS 从 Dock/访达/聚焦 启动 App 不传命令行参数（系统行为），所以原生图标
# 无法带调试端口。这个小 .app 放到 Dock 里代替原图标即可：点它 = open 带端口启动 B站。
# 完全不改 B站 本体，B站 更新也不受影响。
#
# 用法：  bash scripts/make-bilibili-debug-launcher.sh [输出目录]
#         默认输出到 ~/Applications/
# ============================================================================
set -euo pipefail

APP_NAME="${BILIBILI_APP:-哔哩哔哩}"
PORT="${BILIBILI_CDP_PORT:-9222}"
SRC_APP="/Applications/${APP_NAME}.app"
OUT_DIR="${1:-$HOME/Applications}"
LAUNCHER="$OUT_DIR/${APP_NAME} 调试.app"

echo "▶ 生成「${APP_NAME} 调试」启动器"

if [ ! -d "$SRC_APP" ]; then
  echo "✗ 未找到 $SRC_APP —— 请先安装哔哩哔哩 Mac 客户端。"
  exit 1
fi

mkdir -p "$OUT_DIR"
rm -rf "$LAUNCHER"
mkdir -p "$LAUNCHER/Contents/MacOS" "$LAUNCHER/Contents/Resources"

# ---- 1. 启动脚本（真正干活的可执行文件）--------------------------------------
cat > "$LAUNCHER/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
# 防御：从奇怪的父进程启动时剥离会让 Electron 以 Node 模式跑的变量
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS 2>/dev/null || true
APP="${APP_NAME}"
PORT="${PORT}"

port_up() { curl -s --max-time 1 "http://127.0.0.1:\${PORT}/json/version" >/dev/null 2>&1; }

# 1) 已带端口在跑 → 直接切前台
if port_up; then
  open -a "\$APP"
  exit 0
fi

# 2) 在跑但没端口 → 优雅退出，等它真正消失（仍在则强杀），再带端口重开
pid=\$(ps -ax -o pid=,command= | grep -F "\${APP}.app/Contents/MacOS/\${APP}" | grep -v grep | awk '{print \$1}' | head -1)
if [ -n "\$pid" ]; then
  kill "\$pid" 2>/dev/null || true
  for i in \$(seq 1 40); do ps -p "\$pid" >/dev/null 2>&1 || break; sleep 0.25; done
  if ps -p "\$pid" >/dev/null 2>&1; then kill -9 "\$pid" 2>/dev/null || true; sleep 1; fi
fi

# 3) 带调试端口全新启动
open -a "\$APP" --args --remote-debugging-port="\$PORT"
LAUNCH
chmod +x "$LAUNCHER/Contents/MacOS/launch"

# ---- 2. Info.plist ---------------------------------------------------------
cat > "$LAUNCHER/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME} 调试</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.h0ypothesis.bilibili-debug-launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
PLIST

# ---- 3. 套用 B站 图标 -------------------------------------------------------
SRC_RES="$SRC_APP/Contents/Resources"
ICON_SRC=""
icn="$(defaults read "$SRC_APP/Contents/Info" CFBundleIconFile 2>/dev/null || true)"
if [ -n "$icn" ]; then
  case "$icn" in *.icns) : ;; *) icn="$icn.icns" ;; esac
  [ -f "$SRC_RES/$icn" ] && ICON_SRC="$SRC_RES/$icn"
fi
[ -z "$ICON_SRC" ] && ICON_SRC="$(ls "$SRC_RES"/*.icns 2>/dev/null | head -1 || true)"
if [ -n "$ICON_SRC" ] && [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$LAUNCHER/Contents/Resources/app.icns"
  echo "✓ 已套用 B站 图标：$(basename "$ICON_SRC")"
else
  echo "⚠ 未找到 B站 .icns，启动器将使用默认图标（不影响功能）"
fi

# ---- 4. ad-hoc 签名（Apple Silicon 上更顺，locally 生成无 quarantine）-------
codesign --force --deep --sign - "$LAUNCHER" >/dev/null 2>&1 && echo "✓ 已 ad-hoc 签名" || echo "⚠ 签名跳过（不影响本机运行）"

# 让访达刷新图标缓存
touch "$LAUNCHER"

cat <<DONE

✅ 完成：$LAUNCHER

接下来：
  1) 在访达打开该 .app 一次（右键→打开，首次可能要确认），确认能带端口拉起 B站；
  2) 把它拖到 Dock，以后点它开 B站 就自动带调试端口。
     （可把 Dock 里原来的 B站 图标移除，用这个代替。）
DONE
