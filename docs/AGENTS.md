# BerryAgent 开发指引

> 双重自进化智能体 — TypeScript + SQLite + Claude-first LLM 架构

## 项目概述

BerryAgent 是一个双重自进化的通用个人助手：
1. **使用进化** — 对话中自动提取用户偏好/知识，越用越懂你
2. **技能进化** — 运行时自主生成 SKILL.md（指令）和独立插件包（plugin.json + entry.ts + fixtures），扩展能力

## 设计文档入口

- 总览入口：`docs/PLAN.md`
- 详细设计索引：`设计文档/index.md`
- 新增或调整架构设计时，优先更新 `设计文档/` 下的拆分文档，不要把 `docs/PLAN.md` 再写成大文件。
- 修改开发约束、控制台输出规范或测试要求时，同步检查本文件和 `CLAUDE.md`。

## Web 前端架构

BerryAgent 采用 React + Vite SPA 嵌入后端的单端口架构：

- **后端**（`src/web/server.ts`）— HTTP API + WebSocket + 前端静态文件，单端口 `3888`
- **Web 前端**（`web/`）— React 19 + Vite SPA，开发时在 `:3889`（Vite 代理，绑定 `0.0.0.0` 支持局域网访问），生产时构建到 `web/dist/` 由后端直接提供

```
生产模式（单端口 3888）:
  用户浏览器 ──HTTP──>  后端 (:3888)
                ├── /api/*      → API 路由
                ├── /ws         → WebSocket（实时聊天/事件推送）
                └── /*          → SPA 静态文件（web/dist/）

开发模式（双端口）:
  用户浏览器 (:3889) ──Vite proxy /api/*──> 后端 API (:3888)
                    ──Vite proxy /ws───> 后端 WebSocket (:3888)
```

### 前端技术栈

- React 19 + Vite + TypeScript
- React Router（客户端路由）
- Tailwind CSS 4 + shadcn/ui 风格组件
- Zustand（WebSocket/聊天状态） + React Query（服务端数据）
- Shiki 代码高亮、react-markdown 富文本渲染
- Lucide 图标、sonner 通知、react-resizable-panels 布局

### 前端目录结构

```
web/
├── src/
│   ├── components/         # UI 组件
│   │   ├── ui/             # 基础组件（button、card、dialog 等）
│   │   ├── chat/           # 聊天相关（输入框、消息列表、Markdown 渲染、代码块）
│   │   ├── layout/         # 布局（侧边栏、Dashboard 框架）
│   │   ├── charts/         # 图表（面积图、柱状图、迷你折线图）
│   │   └── tasks/          # 任务卡片（移动端适配）
│   ├── hooks/              # 自定义 hooks
│   │   ├── use-chat-socket.ts      # 聊天 WebSocket 连接 + 流式消息处理
│   │   ├── use-realtime-events.ts   # 实时事件订阅（任务/Agent 状态变更）
│   │   ├── use-keyboard-shortcuts.ts
│   │   └── use-document-title.ts
│   ├── pages/              # 页面组件（SPA 路由）
│   │   ├── Dashboard.tsx   # Dashboard 首页
│   │   ├── Chat.tsx        # 聊天页面
│   │   ├── Agents.tsx      # Agent 管理
│   │   ├── Tasks.tsx       # 任务看板
│   │   ├── Conversations.tsx # 对话历史
│   │   ├── Settings.tsx    # 设置
│   │   └── Usage.tsx       # Token 用量统计
│   └── lib/                # 工具库
│       ├── api.ts          # API 客户端（apiGet/apiPost/apiPut/apiDelete + React Query 预定义）
│       ├── stores/         # Zustand stores
│       │   ├── ws-store.ts # WebSocket 连接管理（自动重连、事件订阅、消息收发）
│       │   └── chat-store.ts
│       ├── highlighter.ts  # Shiki 代码高亮初始化
│       └── utils.ts
├── index.html              # SPA 入口
├── vite.config.ts          # Vite 配置
└── package.json
```

## 快速启动

```bash
npm install                # 安装后端依赖
cd web && npm install      # 安装前端依赖

# 开发模式（选一）
npm run dev                # 仅启动后端 (CLI + API :3888)
npm run dev:web            # 仅启动前端 (Vite :3889)
npm run dev:full           # 同时启动后端 + 前端（推荐）

# 生产模式（单端口 :3888）
npm run build:full         # 构建后端 + 前端
berry service start        # 后端同时提供 API + 前端静态文件
```

## 架构

```
src/
├── contracts/       # 跨模块公共契约、schema、事件名、错误码
├── kernel/          # Berry Service、AppCore、Agent Manager、IPC、事件总线、配置、循环检测
├── agents/          # brain/conversation/learning/skills/plugin-builder/code 子进程入口
├── llm/             # LLM API（统一模型契约、backend adapter、Claude Agent SDK runner、测试接管）
├── memory/          # SQLite 记忆系统（better-sqlite3 + FTS5）
│   └── evolution.ts # 记忆提取（代码模块，非 Agent）
├── skills/          # 技能系统（SKILL.md 格式）
├── plugins/         # 独立插件系统（manifest + entry.ts + typed SDK）
├── tools/           # LLM 可调用的工具
├── cli/             # REPL 界面 + 斜杠命令
├── observability/   # 日志、控制台 I/O、run artifact、运行时调级
├── channels/        # Message Channel（CLI、未来 Telegram 等）
├── safety/          # 权限 + 安全扫描
└── utils/           # paths、id
```

## 三级智能体架构

- **Level 1 Brain Agent** — 必经同步审核，每轮回复发出前必须通过
- **Level 2 Module Agents** — Learning/Skills/Plugin Builder/Code 按需 Agent；Safety/Permission 是规则模块
- **Level 3 Conversation Agent** — 直接与用户对话

第一版就是多进程后台服务：`brain-agent` 和 `conversation-agent` 常驻，`learning-agent`、`skills-agent`、`plugin-builder-agent` 和 `code-agent` 按需拉起。
`learning-agent` 负责发现应该学习/沉淀什么；`skills-agent` 负责创建和维护 `SKILL.md`；`plugin-builder-agent` 负责生成和修改独立插件包；`code-agent` 负责普通代码库的阅读、修改、测试、重构和补丁说明。
当前设计目标中 Level 2 智能体共 4 个，Level 3 智能体共 1 个。
Berry Service 是对外启动的后台常驻服务；AppCore 是服务内的核心运行时，不是 Agent，负责组合 Agent Manager、IPC 路由、权限 token 和审计落库。
Agent Manager 是 AppCore 内部模块，专门负责 Agent 生命周期：启动、停止、重启、心跳、工作目录和状态查询。
记忆提取暂时是代码模块（`src/memory/evolution.ts`），未来可升级为 Memory Agent。
记忆采用混合存储：长期记忆、对话历史和 episodes 以 SQLite 为事实源；`MEMORY.md`、导出文件和 artifact 只是投影或调试表面。Skills/Plugins 作为能力载体，以文件为事实源，SQLite 只存索引、状态、统计和审计。
AI 主动查阅记忆必须走 AppCore：每轮用户消息前自动召回少量相关记忆并作为动态 context 注入，Conversation Agent 可通过 `memory_query` 显式查询更多；不要让 Agent 直接扫描 `MEMORY.md` 当作事实源。
Safety/Permission 暂时是规则模块，不调用 LLM。Conversation Agent 执行工具前必须向 AppCore 请求 permission token。

## Agent 工作目录

- 每个 Agent 有独立 Agent Home：`~/.berryagent/agents/<agent-name>/`。
- Agent Home 标准文件：`agent.yaml`、`AGENT.md`、`capabilities.json`、`state.db`、`runtime/`、`tasks/`、`cache/`、`logs/`。
- `agent.yaml` 是机器配置，`AGENT.md` 是人类可编辑指令，`capabilities.json` 是 AppCore 路由能力声明。
- `state.db` 只能保存本 Agent 局部状态和缓存，不是全局事实源，其他 Agent 不得读取。
- 每个任务必须有独立 `tasks/<task_id>/`，包含 `task.json`、`context.json`、`plan.md`、`transcript.jsonl`、`decisions.jsonl`、`outputs/`、`artifacts/`、`tmp/`。
- `tasks/<task_id>/task.json` 只能由 AppCore 创建，是 `agent_tasks` 的冻结输入镜像；Agent 不得私自创建任务目录绕过路由。
- Agent 工作目录不能作为跨 Agent 通信通道。需要协作时只能向 AppCore 提交 `AgentTaskRequest`。
- Code Agent 的任务目录必须包含 `patches/`、`test-runs/`、`sdk-runs/`、`diagnostics/`；Claude Agent SDK raw event 只能作为镜像，必须归一化后才能进入 AppCore 状态机。
- Plugin Builder 的任务目录必须包含 `plugin-drafts/` 和 `validator-runs/`；草稿插件不能直接启用，必须经过 validator 和 Brain。

## LLM API 与 SDK 分层

- 所有普通模型调用只能走 `src/llm/` 的 BerryAgent 自有契约：`ModelRequest` / `ModelEvent` / `ModelResponse`。
- 默认 live backend 是 Anthropic 兼容接口；未来 AI SDK backend 只能作为内部 adapter，用来支持 OpenAI / Anthropic / OpenAI-compatible。
- `code-agent` 的编码执行必须通过 `CodeAgentRunner -> Claude Agent SDK runner`，不能改成普通聊天模型循环。
- Claude Agent SDK、Anthropic SDK、AI SDK、OpenAI SDK 都不能被 `agents/`、`skills/`、`plugins/` 直接 import。
- SDK 或 backend 产生的 tool call 必须先归一化为 BerryAgent `tool_call` / `approval_request`，再经 AppCore permission token 执行。
- `mock` / `replay` / `takeover` 模式必须在 LLM API 边界截断真实网络调用，包括 Claude Agent SDK runner。

## 模块化解耦原则

- 全项目按 contract-first 设计：新模块先定义 `contract.ts`、`types.ts`、schema、错误码和测试，再写实现。
- 模块之间禁止跨边界 import 内部实现；只能依赖 `src/contracts/`、对方模块的 `contract.ts`、`types.ts`、`index.ts`。
- AppCore 只做编排、生命周期、权限、审计和路由，不把业务逻辑塞进 kernel。
- Agent 进程通过 IPC 与 AppCore 通信；确定性逻辑优先做代码模块，不要滥用 Agent。
- 插件只能依赖 `@berryagent/plugin-sdk` 和运行时代理 API，不能 import `src/kernel/*` 或直接读真实 env。
- 每个模块必须能独立单测；跨模块测试只能走公开 contract。

## 命名与输出规范

- LLM 接口模块 → **LLM API**（不叫 gateway/provider）
- 通信渠道 → **Message Channel**（不叫 adapter）
- 面向用户和架构总览不要使用 provider；代码内部如需区分供应商实现，用 `backend` / `adapter`。

## 控制台输出语言

- CLI、REPL、日志、错误提示、权限确认、状态展示等面向用户的控制台输出，默认使用中文。
- 优先使用中文名词和中文句子；没有合适中文或属于固定技术名词时，可以保留英文。
- 产品名、模块名、命令、参数、文件名、类型名可以保留英文，例如 Berry Service、AppCore、Agent Manager、LLM API、Message Channel、IPC、SQLite、`permission token`。
- 不要输出整句英文提示。应写“已启动 Berry Service”“权限请求已拒绝”“正在检查 Agent 状态”，不要写“Berry Service started”“Permission denied”“Checking agent status”。
- 机器可读输出（如 `--json`）字段名保持稳定英文，字段值里的用户可见文案优先中文。

## 日志与控制台调试

- 日志固定 4 个等级：`error`、`warn`、`info`、`debug`；测试和 CI 默认 `debug`。
- 普通人类输出走 `stdout`，错误和进度日志走 `stderr`；`--json` 模式下 `stdout` 只能输出合法 JSON。
- 禁止直接 `console.log/error`，必须通过 `ConsoleRenderer` 或 `ObservabilityContract`。
- 每次 `berry run` / `berry test run` / `berry test drive` 都要生成 `run_id` 和 artifact：`stdout.log`、`stderr.log`、`console.jsonl`、`berry.log.jsonl`、`result.json`。
- `berry run --json` 必须返回 `runId` 和 `artifactDir`；控制台回放可用 `berry logs console <run_id> --stream all --json`。
- CI 失败时必须能通过 `berry test artifacts <run_id> --export` 导出完整输出。
- 日志等级必须支持运行时调整：`berry logs level debug`、`berry logs level info --persist`、`berry logs level debug --ttl 10m`。
- 所有日志和 artifact 必须经过脱敏：API key、token、authorization、cookie、password 默认不可明文输出。

## 测试模型配置

开发测试使用 Anthropic 兼容代理，不消耗官方额度：

```yaml
llm:
  base_url: https://token-plan-cn.xiaomimimo.com/anthropic
  api_key: tp-cfsaictrld41h6ece31xn8gca9avvr1rqv22gsgzj6h5d9qk
  model: mimo-v2-pro
```

当前默认 live backend 使用 `@anthropic-ai/sdk`，通过 `baseURL` 切换测试/生产环境。不要把 Anthropic SDK 类型泄露到 Agent/Skill/Plugin；未来 AI SDK backend 也必须只实现 BerryAgent LLM API 契约。

## 添加新工具

1. 在 `src/tools/` 创建文件
2. 实现 `ToolDefinition` 接口（name, description, inputSchema, execute）
3. 在 `src/tools/index.ts` 注册

## 添加内置技能

1. 在 `src/skills/bundled/` 创建目录
2. 写 `SKILL.md`（YAML 前置 + Markdown 指令）
3. Registry 自动发现

## 添加内置插件

1. 在 `src/plugins/bundled/{name}/` 创建插件包
2. 编写 `plugin.json`、`entry.ts` 和至少一个 `tests/*.fixture.json`
3. 在 `entry.ts` 中使用 `definePlugin(...)` 注册工具、受限 Hook 或命令
4. 运行 `berry plugins validate <name> --json`
5. Registry 读取 manifest 后自动发现，启用仍需走验证和 Brain 审核

## 插件系统原则

- 插件是独立扩展包，不是散落的 `.ts` 文件；manifest 是第一契约。
- 插件接口必须对 AI 智能体友好：`berry plugins contract/schema/inspect/validate/test/dry-run` 都要支持 `--json`。
- Conversation Agent 查询插件和技能能力时必须使用 `list_skills`、`list_plugins`、`inspect_plugin`、`validate_plugin`、`dry_run_plugin` 等 IPC 工具，由 AppCore 统一路由到自进化能力服务；工具层不得直接 import `src/plugins/*` 或 `src/skills/*`。
- 插件不得直接调用 LLM API，不得绕过 AppCore permission token，不得直接读取真实环境变量。
- 插件工具必须声明 `inputSchema`、`outputSchema`、权限范围、示例和失败模式。
- 生成插件必须先进入 proposal/validation/review 流程；高风险权限需要用户确认。

## 测试

- 单元测试用 `:memory:` SQLite
- Mock LLM API 用 `vitest.mock()`
- 每个模块必须有 contract test；跨模块测试只能依赖公开 contract，不读取内部实现。
- CI 必须运行 import 边界检查，禁止跨模块 import 内部文件。
- 技能验证测试用 `tests/fixtures/` 中的样本
- E2E 测试必须使用临时 `dataDir` / `socket`，不能读写 `~/.berryagent`
- 测试必须捕获完整 stdout/stderr/console_frames，并在失败时输出 `run_id` 和 artifact 路径
- LLM API 必须支持 `live` / `mock` / `replay` / `takeover` 四种模式；自动化测试默认不调用真实模型 API
- `takeover` 是 LLM 接管模式：外部编码 Agent 或 CI 通过 `berry test requests --json` 获取模型请求，再用 `berry test respond <request_id>` 提供模型响应
- 所有 Agent 的模型调用都必须经过 `src/llm/` 统一 LLM API，禁止在 Agent/Skill/Plugin 模块里直接调用模型 API
- takeover 必须覆盖 Conversation、Brain、Learning、Skills、Plugin Builder、Code 的完整多 Agent 流程
- 自动化测试必须支持 `berry test drive --driver stdio --json`，让外部编码 Agent/CI 自动读取 `model_request` 并写回 `model_response`
- replay/takeover fixture 必须支持 `expect` 校验，覆盖 agent、purpose、promptHash、toolNames、hasToolResultFor 等关键字段
- 测试 harness 必须使用 hermetic environment：临时 `BERRY_HOME`、清理 credential env、固定 TZ/LANG/seed/clock，禁止读取真实用户配置
- `berry test mock-server` 只用于测试 LLM API HTTP/SSE/错误码兼容性，不能替代 takeover 主流程
- E2E 必须断言状态链路：`conversations`、`tool_calls`、`review_requests`、`model_requests`、pending 清空
- 后台任务必须可关闭或等待空闲：`--no-background` / `berry test wait-idle`
- 权限确认必须支持非交互模式：`--non-interactive` / `--permission-mode deny-all|allow-all|ask`
- 自动化测试优先断言 `--json` 输出，不断言人类可读文本
- 运行: `npm test` / `npm test -- --watch`

## 提交规范

- 任何稍大的改动（涉及多个文件、跨模块修改、新功能、重构）完成后必须立即提交代码，不要积攒。
- 一个逻辑完整的变更 = 一次 commit；不要把不相关的改动混在一起。
- 提交前确保 `npm run typecheck` 和 `npm test` 通过。

## 关键设计原则

1. SQLite 是结构化事实源：长期记忆、对话、审核、工具调用、episodes、索引和统计进入 SQLite；技能、插件、配置、完整日志和 artifact 以文件承载
2. 冻结快照模式（system prompt 会话开始时组装一次，保护 prompt cache）
3. 模块边界优先：只能通过 contract/event/IPC/SDK 通信，禁止跨模块依赖内部实现
4. Brain 必经审核（A 级摘要审核；B/C 级看完整工具调用与结果）
5. IPC 负责实时通信，SQLite 负责审计、回放和崩溃恢复
6. 记忆提取 = 代码模块（fire-and-forget），Learning/Skills/Plugin Builder/Code = 按需二级 Agent
7. 技能 = SKILL.md（提示词文档），插件 = 独立插件包（可执行扩展）
8. 安全扫描前置；插件经 Brain 审核后启用，高风险权限还要用户确认
9. 测试模式必须支持全链路 LLM 接管，外部编码 Agent/CI 可提供所有 Agent 的模型响应，但不能绕过 Safety/Permission 和 Brain 审计链路
10. 测试基建分层：unit mock、fixture replay、takeover、mock-server、live smoke；默认 CI 不依赖真实模型 API
