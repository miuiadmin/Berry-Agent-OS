#!/bin/bash
# BerryAgent 一键启动脚本
# 前台启动后端 API + 前端 Dashboard
# 关闭终端即停止所有服务
#
# 所有后端参数直接透传给 CLI，例如：
#   ./start.sh --log-level warn
#   ./start.sh --port 8080 --host 0.0.0.0
#   ./start.sh --test

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 从参数中提取 --port 和 --host（前端和显示都需要）
PARSE_PORT=""
PARSE_HOST=""
for arg in "$@"; do
  case "$arg" in
    --port=*) PARSE_PORT="${arg#*=}" ;;
    --port)   ;;
    --host=*) PARSE_HOST="${arg#*=}" ;;
    --host)   ;;
  esac
done
# 支持 --port VALUE 格式（等号格式已在上面处理）
_prev=""
for arg in "$@"; do
  if [ "$_prev" = "--port" ] && [ -z "$PARSE_PORT" ]; then PARSE_PORT="$arg"; fi
  if [ "$_prev" = "--host" ] && [ -z "$PARSE_HOST" ]; then PARSE_HOST="$arg"; fi
  _prev="$arg"
done
BACKEND_PORT="${PARSE_PORT:-3888}"
BACKEND_HOST="${PARSE_HOST:-127.0.0.1}"

# 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装 Node.js >= 20"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js 版本过低 ($(node -v))，需要 >= 20"
  exit 1
fi

# 自动构建（源码有更新时）
if [ ! -f "$PROJECT_DIR/dist/index.js" ] || [ -n "$(find "$PROJECT_DIR/src" -newer "$PROJECT_DIR/dist/index.js" -name '*.ts' 2>/dev/null | head -1)" ]; then
  echo "⚙️  构建中..."
  cd "$PROJECT_DIR" && npm install --silent && npm run build
  echo ""
fi

# 自动安装前端依赖
if [ ! -d "$PROJECT_DIR/web/node_modules" ]; then
  echo "⚙️  安装前端依赖..."
  cd "$PROJECT_DIR/web" && npm install --silent
  echo ""
fi

# 局域网 IP
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "")

echo "🚀 Starting BerryAgent..."
echo "   Backend:  http://127.0.0.1:$BACKEND_PORT"
echo "   Dashboard:http://127.0.0.1:3889"
[ -n "$LAN_IP" ] && echo "   LAN:      http://$LAN_IP:3889 → http://$LAN_IP:$BACKEND_PORT"
echo ""

cleanup() {
  echo ""
  echo "⏹  停止中..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null
  echo "✅ 已停止"
  exit 0
}
trap cleanup SIGINT SIGTERM

# 后端：CLI 参数透传，默认 debug
# 导出 APP_PORT/APP_HOST 让 vite.config.ts 读取代理目标
export APP_PORT="$BACKEND_PORT"
export APP_HOST="$BACKEND_HOST"
cd "$PROJECT_DIR"
node dist/index.js service start --foreground --debug "$@" &
BACKEND_PID=$!
sleep 2

# 前端：Vite 开发服务器，绑定 0.0.0.0
cd "$PROJECT_DIR/web"
npx vite --host --port 3889 &
FRONTEND_PID=$!

wait -n $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
cleanup
