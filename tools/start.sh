#!/bin/bash
# BerryAgent 一键启动脚本
# 前台启动服务（含 Web 后台）+ 终端交互对话
# 关闭终端即停止所有服务

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${BERRY_PORT:-7860}"

# 检查 Node.js 版本
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装 Node.js >= 20"
  echo "   推荐: brew install node"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js 版本过低 ($(node -v))，需要 >= 20"
  exit 1
fi

# 清理旧进程：杀掉占用端口的进程
OLD_PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "⚠️  端口 $PORT 被占用，正在清理旧进程..."
  echo "$OLD_PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 检查是否需要构建（首次或源码有更新）
NEED_BUILD=0
if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  NEED_BUILD=1
elif [ -n "$(find "$PROJECT_DIR/src" -newer "$PROJECT_DIR/dist/index.js" -name '*.ts' 2>/dev/null | head -1)" ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" -eq 1 ]; then
  echo "⚙️  正在构建（源码有更新）..."
  cd "$PROJECT_DIR"
  npm install --silent
  npm run build
  echo ""
fi

BERRY="$PROJECT_DIR/dist/index.js"

# 前台运行，终端显示所有活动，Ctrl+C / 关闭终端即停止
exec node "$BERRY" service start --foreground
