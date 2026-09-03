#!/bin/sh
# Berry 安装脚本（技术栈篇 §8.5 第 3 件，第五十一批「升级与上手基建」）
#
# 用法（两段式——先下载再执行：管道直灌形态下连接中段断裂时 sh 会执行半截
# 脚本，落盘后再跑无此险）：
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/miuiadmin/Berry-Agent-OS/main/scripts/install.sh
#   sh install.sh
# 职责三件：Node ≥24 检查（只查不装——缺失指引发官方指引）→ npm 全局装
# berry-agent-os → berry --version 安装验证。失败路径全部带原因与出路口。
# 显示效果：分步状态行（→ 步骤 / ✓ 成功 / ✗ 失败）+ 尾部欢迎横幅与下一步指引。

set -eu

# ---------- 微样式（非 tty 时自动降级为纯文本——管道场景友好） ----------
if [ -t 1 ]; then
  DIM=$(printf '\033[2m')
  BOLD=$(printf '\033[1m')
  GREEN=$(printf '\033[32m')
  RED=$(printf '\033[31m')
  RESET=$(printf '\033[0m')
else
  DIM=''
  BOLD=''
  GREEN=''
  RED=''
  RESET=''
fi
step() { printf '%s→%s %s\n' "$DIM" "$RESET" "$1"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() {
  printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  exit 1
}

printf '%s\n' "${BOLD}Berry 安装器${RESET} ${DIM}——跑 AI 应用的操作系统${RESET}"

# ---------- ① Node 运行时检查（≥24；缺失或过旧 → 指引官方安装路，本脚本不代装） ----------
step '检查 Node.js 运行时（要求 ≥ 24）'
if ! command -v node >/dev/null 2>&1; then
  fail "未找到 Node.js。请先安装 Node.js ≥ 24：
  官方安装器：https://nodejs.org/（或系统包管理器：brew install node / apt 等）
装好后再跑本脚本。"
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
NODE_PATCH=$(node -p 'process.versions.node.split(".")[2]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  fail "Node.js 版本过旧（当前 $NODE_MAJOR.$NODE_MINOR.$NODE_PATCH，要求 ≥ 24）。
请升级：https://nodejs.org/ （或 nvm install 24 && nvm use 24）"
fi
ok "Node.js $(node --version)"

# ---------- ② npm 检查 ----------
step '检查 npm'
command -v npm >/dev/null 2>&1 || fail '未找到 npm——Node.js 安装通常自带，请检查安装完整性。'
ok "npm $(npm --version)"

# ---------- ③ 全局安装 berry-agent-os ----------
step '安装 berry-agent-os（npm i -g）'
# npm 输出直通终端（自带进度即显示面）；-g 权限不足时 npm 会自行报错——常见出路口：
#   · macOS/Linux 推荐 nvm（免 sudo）；系统 Node 用 sudo npm i -g berry-agent-os
if ! npm install -g berry-agent-os; then
  fail "npm 安装失败。常见原因：
  · 权限不足 → nvm 管理 Node（推荐，免 sudo）或 sudo npm i -g berry-agent-os
  · 网络问题 → 检查代理与 registry 配置（npm config get registry 核对当前源是否符合预期）"
fi
ok 'berry-agent-os 已安装'

# ---------- ④ 安装验证 ----------
step '验证安装（berry --version）'
if ! command -v berry >/dev/null 2>&1; then
  fail "berry 命令不可用——npm 全局 bin 目录可能不在 PATH。
  npm bin 目录：$(npm prefix -g)/bin
  把它加入 PATH（如 echo 'export PATH=\"$(npm prefix -g)/bin:\$PATH\"' >> ~/.zshrc）后重开终端。"
fi
ok "berry $(berry --version)"

# ---------- 欢迎横幅 + 下一步 ----------
printf '\n%s\n' "${GREEN}${BOLD}安装完成！${RESET}"
printf '%s\n' "${DIM}下一步：${RESET}
  ${BOLD}berry${RESET}            进入 TUI 对话（首启即用——默认进入 berrycode 代码智能体应用）
  ${BOLD}berry --help${RESET}     全部命令（run 单发 / daemon 常驻 / attach 接上 / upgrade 升级）
  ${BOLD}/guide${RESET}           TUI 内快速上手参考（首启欢迎块也会自动出现）
${DIM}上手：TUI 内 /guide · 升级：berry upgrade · 卸载：npm rm -g berry-agent-os + rm -rf ~/.berry${RESET}
"
