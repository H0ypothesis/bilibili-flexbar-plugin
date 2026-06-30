#!/usr/bin/env bash
# ============================================================================
# 启动哔哩哔哩桥接服务
#   1) 确保依赖已安装
#   2) 确保「哔哩哔哩」以远程调试端口运行（必要时退出并重启它）
#   3) 启动 node 桥接服务（监听 ws://127.0.0.1:35020）
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="${BILIBILI_APP:-哔哩哔哩}"
PORT="${BILIBILI_CDP_PORT:-9222}"

cd "$ROOT" || exit 1

cdp_up() { curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; }
app_running() { pgrep -f "${APP}.app/Contents/MacOS/" >/dev/null 2>&1; }

# 1) 依赖
if [ ! -d "$ROOT/node_modules/ws" ]; then
  echo "[start] 安装依赖 (npm install)…"
  npm install || { echo "[start] npm install 失败"; exit 1; }
fi

# 2) 调试端口
if cdp_up; then
  echo "[start] 调试端口 ${PORT} 已就绪。"
else
  if app_running; then
    echo "[start] 「${APP}」正在运行但未开启调试端口，正在重启它…"
    osascript -e "tell application \"${APP}\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 40); do app_running || break; sleep 0.25; done
    if app_running; then pkill -f "${APP}.app" >/dev/null 2>&1 || true; sleep 1; fi
  fi
  echo "[start] 以调试端口 ${PORT} 启动「${APP}」…"
  open -a "${APP}" --args --remote-debugging-port="${PORT}" --remote-allow-origins='*' \
    || { echo "[start] 无法启动「${APP}」，请确认已安装。"; }
  printf "[start] 等待调试端口就绪"
  for _ in $(seq 1 60); do cdp_up && break; printf "."; sleep 0.5; done
  echo ""
  if cdp_up; then echo "[start] 调试端口已就绪。"; else echo "[start] ⚠️ 仍未就绪，桥接服务会持续重试。"; fi
fi

# 3) 桥接服务
echo "[start] 启动桥接服务 → ws://127.0.0.1:${BILIBILI_WS_PORT:-35020}"
exec node "$HERE/server.js"
