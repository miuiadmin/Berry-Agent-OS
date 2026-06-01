# BerryAgent 贡献指南

感谢你对 BerryAgent 项目的关注！本文档将帮助你快速了解项目规范并顺利参与开发。

## 目录

- [开发环境搭建](#开发环境搭建)
- [项目结构](#项目结构)
- [代码风格](#代码风格)
- [模块边界规则](#模块边界规则)
- [测试要求](#测试要求)
- [提交规范](#提交规范)
- [PR 流程](#pr-流程)
- [新增工具/技能/插件](#新增工具技能插件)
- [常用命令](#常用命令)

---

## 开发环境搭建

### 前置依赖

- **Node.js** >= 20
- **npm**（随 Node.js 安装）

### 安装步骤

```bash
# 1. 克隆仓库
git clone <repo-url>
cd berry

# 2. 安装后端依赖
npm install

# 3. 安装前端依赖
cd web && npm install && cd ..
```

### 启动开发环境

```bash
# 推荐方式：同时启动后端 + 前端
npm run dev:full

# 或分别启动
npm run dev          # 仅后端（CLI + API，端口 3888）
npm run dev:debug    # 后端 + debug 日志（可用 --log-level 调整）
npm run dev:web      # 仅前端（Vite :3889，绑定 0.0.0.0 支持局域网）
```

### 生产构建

```bash
npm run build:full   # 构建后端 + 前端
tools/start.sh       # 一键启动（debug 模式）
start.command        # macOS 双击启动
```

---

## 项目结构

```
berry/
├── src/                    # 后端源码（Node.js + TypeScript）
│   ├── contracts/          # 跨模块公共契约、schema、事件名、错误码
│   ├── kernel/             # 核心服务、AppCore、Agent Manager、IPC、事件总线
│   ├── agents/             # Agent 子进程入口
│   ├── llm/                # LLM API 统一层
│   ├── memory/             # SQLite 记忆系统
│   ├── skills/             # 技能系统（SKILL.md 格式）
│   ├── plugins/            # 独立插件系统
│   ├── tools/              # LLM 可调用的工具
│   ├── cli/                # REPL 界面 + 斜杠命令
│   ├── web/                # HTTP API + WebSocket 服务器
│   └── utils/              # 工具函数
├── web/                    # Web 前端（React 19 + Vite SPA）
├── docs/                   # 说明文档
├── 设计文档/                # 设计文档
└── tools/                  # 脚本工具
```

---

## 代码风格

### TypeScript

- **Strict mode**：全部代码开启 `strict: true`
- **ES Modules**：项目使用 ES Modules，文件使用 `.ts` 扩展名
- 导入路径使用完整扩展名（如 `import { foo } from './bar.js'`）

### 命名去品牌化（硬规则）

**禁止在代码标识符中使用产品名称**（如 `berry`、`berryAgent` 等品牌词），包括：

- 变量名、函数名、类名
- 接口名、类型别名、枚举值
- 常量名
- 文件名 / 目录名

用通用领域语义命名代替：`core`、`service`、`agent`、`app`、`runtime` 等。

品牌名仅允许出现在：`package.json` 的 name 字段、CLI 入口命令名、用户可见的 UI 文案/文档标题。

### 前端组件

- 使用 **Tailwind CSS 4** + **Radix UI** 无头组件（shadcn/ui 风格）
- **不使用 MUI / Ant Design 等重型组件库**

---

## 模块边界规则

### Contract-first 设计

新模块必须按以下顺序创建文件：

1. **`contract.ts`** — 定义模块的公共 API、事件名、错误码
2. **`types.ts`** — 类型定义
3. **`index.ts`** — 公开导出
4. 然后才是实现代码

### 依赖规则

- 模块之间**只能依赖**对方的 `contract.ts`、`types.ts`、`index.ts`
- **禁止**跨边界 import 其他模块的内部实现
- 插件只能依赖 `@berryagent/plugin-sdk`，不能 import `src/kernel/*`

### 边界检查

```bash
npm run lint:boundaries    # 检查模块边界违规
```

---

## 测试要求

### 三层测试架构

| 层级 | 说明 | 说明 |
|------|------|------|
| 单元模块测试 | 纯逻辑，无外部依赖 | 最快，覆盖边界条件 |
| 1-to-1 测试 | 单模块 + 真实依赖，mock 模型 | 验证模块协作 |
| 真实测试 | HTTP CRUD API + 真实模型 | 像前端一样调用 API |

### 前端 E2E 测试

使用 **Playwright** 编写前端端到端测试。

### 禁止模式

- **禁止 mock 中间层测试**：mock 所有依赖后断言高层模块 = 假信心
- **禁止断言 AI 生成的具体文本内容**：LLM 输出不确定，应断言结构/行为而非具体文本

### 运行测试

```bash
npm test              # 运行全部测试
npm run typecheck     # TypeScript 类型检查
```

---

## 提交规范

### 原则

- **一个逻辑完整的变更 = 一次 commit**，不相关的改动不混在一起
- **跨模块修改完成后立即提交**，不要积攒
- 提交前确保 `npm run typecheck` 和 `npm test` 通过

### 提交消息格式

```
<type>: <简要描述>

<可选的详细说明>
```

常用 type：

- `feat` — 新功能
- `fix` — 修复 bug
- `refactor` — 重构（不改变外部行为）
- `docs` — 文档更新
- `test` — 测试相关
- `chore` — 构建/工具/依赖更新

---

## PR 流程

### 1. 创建分支

从 `main` 拉取分支，命名遵循以下约定：

- `feat-<描述>` — 新功能
- `fix-<描述>` — Bug 修复
- `docs-<描述>` — 文档更新

### 2. 开发与提交

按照上述提交规范进行开发，保持每个 commit 逻辑完整。

### 3. 提交 PR

- PR 标题清楚说明改动内容
- PR 描述包含：
  - **改动内容**：做了什么
  - **改动原因**：为什么需要这个改动
  - **测试情况**：如何验证改动的正确性
- 确保 CI 全部通过

---

## 新增工具/技能/插件

### 新增工具（Tool）

1. 在 `src/tools/` 创建文件
2. 实现 `ToolDefinition` 接口：

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: any) => Promise<any>;
}
```

3. 在 `src/tools/index.ts` 注册

### 新增技能（Skill）

1. 在 `src/skills/bundled/` 创建目录
2. 编写 `SKILL.md`，格式为 YAML 前置信息 + Markdown 指令
3. Registry 会自动发现

### 新增插件（Plugin）

1. 在 `src/plugins/bundled/` 创建目录
2. 创建以下文件：
   - `plugin.json` — 插件清单
   - `entry.ts` — 入口文件

---

## 常用命令速查

| 命令 | 说明 |
|------|------|
| `npm install` | 安装后端依赖 |
| `cd web && npm install` | 安装前端依赖 |
| `npm run dev` | 启动后端开发（端口 3888） |
| `npm run dev:debug` | 后端 + debug 日志 |
| `npm run dev:web` | 启动前端开发（端口 3889，绑定 0.0.0.0） |
| `npm run dev:full` | 同时启动后端 + 前端 |
| `npm run build:full` | 构建生产版本 |
| `npm test` | 运行全部测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint:boundaries` | 检查模块边界违规 |

---

如有疑问，请查阅 `docs/` 目录下的详细文档，或在 PR/Issue 中提出讨论。
