#!/usr/bin/env bash
# ============================================================================
# 一键安装（新设备）：装依赖 → 构建 → 安装到 FlexDesigner
# 不依赖 flexcli，所以任意 Node 18+ 都能用（含 Node 23/25）。
# 用法：  bash scripts/setup.sh        （在仓库根目录）
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1

echo "▶ 哔哩哔哩 FlexBar 插件 — 一键安装"
echo ""

# ---- 1. 前置检查 ----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 Node.js（需要 18+）。请先安装：https://nodejs.org 或 brew install node"
  exit 1
fi
echo "✓ Node $(node -v)"

if [ ! -d "/Applications/哔哩哔哩.app" ]; then
  echo "⚠ 未发现 /Applications/哔哩哔哩.app —— 请先安装哔哩哔哩 Mac 客户端（App Store 搜「哔哩哔哩」）。"
fi

FD_DATA="$HOME/Library/Application Support/FlexDesigner/data/plugins"
if [ ! -d "$FD_DATA" ]; then
  echo "✗ 未发现 FlexDesigner 插件目录："
  echo "    $FD_DATA"
  echo "  请先安装并至少打开一次 FlexDesigner，然后重跑本脚本。"
  exit 1
fi
echo "✓ FlexDesigner 数据目录就绪"
echo ""

# ---- 2. 依赖 + 构建 -------------------------------------------------------
echo "▶ 安装依赖（npm install）…"
npm install || { echo "✗ npm install 失败"; exit 1; }

echo "▶ 构建插件后端（npm run build）…"
npm run build || { echo "✗ 构建失败"; exit 1; }

# ---- 3. 安装到 FlexDesigner ----------------------------------------------
echo "▶ 安装插件到 FlexDesigner（flexcli-free）…"
npm run plugin:copy || { echo "✗ 安装失败"; exit 1; }

# ---- 4. 完成 + 后续 -------------------------------------------------------
cat <<'DONE'

✅ 安装完成！接下来 3 步：

  1) 重启 FlexDesigner —— Key Library 里会出现「哔哩哔哩」，把按键拖到 FlexBar 上。

  2) 启动桥接服务（需要一直运行，插件靠它控制哔哩哔哩）：
        npm run macos:bridge
     想开机自启、崩溃自动重启：
        bash macos-bridge/install-launchagent.sh

  3) 打开哔哩哔哩播放任意视频，按键即可实时显示并控制。

DONE
