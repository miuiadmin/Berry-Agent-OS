#!/bin/bash
# 双击启动 BerryAgent（后端 + 前端）
# 关闭终端窗口即停止所有服务

cd "$(dirname "$0")/.."
exec ./tools/start.sh
