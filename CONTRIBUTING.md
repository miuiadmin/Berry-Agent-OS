# 贡献指南

感谢你对 Berry 的关注。本文帮你快速上手；开发纪律的全量说明在 [docs/开发指南.md](docs/开发指南.md)。

## 环境

- Node.js ≥ 22.19，npm
- `npm install` 即可（无前端子项目）

```bash
npm install
npm run dev               # TUI 直跑（tsx，日志缺省 debug）
npm test                  # 全量测试
npm run typecheck         # tsc --noEmit
npm run lint:topology     # 模块 DAG + 事件词汇门禁
npm run format:check      # Prettier
```

## 项目结构

```
berry/
├── src/               # 22 模块单向 DAG（lint:topology 门禁钉死；内核=最小装载器托纯机制代理）
│   ├── contracts/     # L0 公共契约（错误码/事件/工具/应用契约/typebox 再导出）
│   ├── context/       # L1 运行时基座（作用域/事件总线/服务注册表/logger）+ 应用加载器
│   ├── session/       # 会话事件日志（append-only + 投影）
│   ├── persist/       # SQLite 物理层（迁移框架/write-behind/凭证）
│   ├── agent/         # loop 骨架（AgentEvent/steering/消息角色）
│   ├── llm/           # pi-ai 适配（唯一允许裸导入 pi-ai 的模块）
│   ├── tools/         # 三段管道 + 三层注册表 + fs 工具族 + 检索族（find/grep）
│   ├── safety/        # 沙箱/审批/可写根/allowlist 免问
│   ├── skills/        # SKILL.md 注册表 + 渐进披露
│   ├── channels/      # TUI 通道 + 命令面
│   ├── exec/          # Ring 1 官方件·件聚落：spawn 管道 + bash 工具 + ctx.exec
│   ├── chat/          # 官方件·件聚落：对话应用（ConversationDriver/durable/resume）
│   ├── memory/        # Ring 2 官方件：记忆库（含持有面五件）
│   ├── subagent/      # Ring 2 官方件底座：Job + SubagentProvider
│   ├── goal/          # Ring 2 官方件：长目标状态机
│   ├── scheduler/     # Ring 2 官方件：定时任务（/tick）
│   ├── mcp/           # Ring 2 官方件：MCP 客户端桥
│   ├── web/           # Ring 2 官方件：fetch + SSRF 卫生件
│   ├── compaction/    # Ring 2 官方件：长会话压缩
│   ├── admin/         # Ring 2 官方件：平台管理面工具
│   ├── app/           # 组合根（装配序/CLI/组合树/官方件注册表——纯「装」）
│   └── bridge/        # 官方件：worker 域舰队（进程隔离）
├── docs/              # 公开文档（架构/使用/应用开发/开发指南/运维）
└── tools/             # check-topology / check-events / smoke-real / golden
```

## 四门禁（提交前提）

`npm run typecheck` / `npm test` / `npm run lint:topology` / `npm run format:check` 全绿才提交。

## 核心纪律速览

细节与理由见 [docs/开发指南.md](docs/开发指南.md)：

- **模块边界**：22 模块单向 DAG（全部有码），跨模块只 import 公共面（contract/types/index）；新模块 contract-first。
- **测试**：分层（单元 → 组合根全栈）；mock 只停在模型层；禁断言 AI 生成文本；修 bug 带回归锁（修复前必红）。
- **注释**：新写代码必须充分中文注释（JSDoc + 关键分支行内）。
- **命名去品牌化**：代码标识符禁用品牌词；仅 package.json name / bin 命令 / UI 文案允许。
- **事件词汇**：显式注册 + check-events 双向校验；读侧未知类型宁拒绝不静默丢。
- **日志红线**：只在 debug 出现的分支必须同时是 durable 事件或运行时断言。
- **架构纪律**：已有机制优先于新概念；补丁过多即重构。

## 提交规范

- 一个逻辑完整的变更 = 一次 commit；不相关改动不混。
- 消息格式 `<type>(<范围>): <描述>`——type 用 feat / fix / refactor / docs / test / chore。
- 逐文件点名 `git add`，慎用 `git add -A`。

## PR 流程

1. 从主分支拉分支：`feat-<描述>` / `fix-<描述>` / `docs-<描述>`。
2. 保持每个 commit 逻辑完整、四门禁全绿。
3. PR 描述写清：改了什么 / 为什么 / 如何验证。

## 扩展点

- **加工具**：模块内实现 `ToolDefinition`，经注册表或应用 ctx 面 `ctx.get('tools').register(def)` 注册（三段管道自动生效）。
- **加技能**：任一发现目录放 `<名字>/SKILL.md`（YAML 前置 + Markdown 指令体）——项目 `.agents/skills/` 或 `~/.berry/skills/` 等，放好即生效。
- **加应用**：见 [docs/应用开发指南.md](docs/应用开发指南.md)——entry.ts 单形状 + inject 服务面 + 组合树行。
