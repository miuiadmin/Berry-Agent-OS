#!/bin/bash
# BerryAgent 一键启动脚本
# 前台启动后端 API (3888) + 前端 Dashboard (3889)
# 关闭终端即停止所有服务

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_PORT="${APP_PORT:-3888}"
FRONTEND_PORT="${APP_WEB_PORT:-3889}"

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

# 清理旧进程
for PORT in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  OLD_PIDS=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$OLD_PIDS" ]; then
    echo "⚠️  端口 $PORT 被占用，正在清理旧进程..."
    echo "$OLD_PIDS" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
done

# 检查是否需要构建后端
NEED_BUILD=0
if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  NEED_BUILD=1
elif [ -n "$(find "$PROJECT_DIR/src" -newer "$PROJECT_DIR/dist/index.js" -name '*.ts' 2>/dev/null | head -1)" ]; then
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" -eq 1 ]; then
  echo "⚙️  正在构建后端（源码有更新）..."
  cd "$PROJECT_DIR"
  npm install --silent
  npm run build
  echo ""
fi

# 确保前端依赖已安装
if [ ! -d "$PROJECT_DIR/web/node_modules" ]; then
  echo "⚙️  安装前端依赖..."
  cd "$PROJECT_DIR/web"
  npm install --silent
  echo ""
fi

BERRY="$PROJECT_DIR/dist/index.js"

echo "🚀 Starting BerryAgent..."
echo "   Backend API:  http://127.0.0.1:$BACKEND_PORT"
echo "   Dashboard:    http://127.0.0.1:$FRONTEND_PORT"
echo ""

cleanup() {
  echo ""
  echo "⏹  正在停止服务..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
  echo "✅ 已停止"
  exit 0
}
trap cleanup SIGINT SIGTERM

# 启动后端
node "$BERRY" service start --foreground &
BACKEND_PID=$!

# 等待后端就绪
sleep 2

# 启动前端（Vite 开发服务器）
cd "$PROJECT_DIR/web"
npx vite --port "$FRONTEND_PORT" --host &
FRONTEND_PID=$!

# 等待任意进程退出
wait -n $BACKEND_PID $FRONTEND_PID 2>/dev/null || true

# 如果有一个进程退出了，清理另一个
cleanup
