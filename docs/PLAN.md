# BerryAgent 项目计划文档

> 双重自进化智能体 — TypeScript + SQLite + Claude-first LLM 架构

详细设计已拆分到 [设计文档/index.md](../设计文档/index.md)。本文件只保留总览和阅读入口，避免单文件过大影响阅读和 AI 工具加载。

## 核心目标

BerryAgent 是一个双重自进化的通用个人助手：

1. **使用进化**：随着对话积累，自动提取用户偏好、习惯、知识。
2. **技能进化**：运行时生成 `SKILL.md` 技能，并在 Brain 审核后生成/启用独立插件包。

核心约束：

- TypeScript + SQLite。
- 第一版就是多 Agent 后台服务，不做单进程简化版。
- `brain-agent` 和 `conversation-agent` 常驻。
- `learning-agent`、`skills-agent`、`plugin-builder-agent`、`code-agent`、`evolution-agent`、`memory-agent` 和 `skill-tester-agent` 按需拉起。
- 设计目标中 Level 2 智能体共 7 个，Level 3 智能体共 1 个。
- Berry Service 是对外常驻服务。
- AppCore 是服务内核心运行时，不是 Agent。
- Agent Manager 负责 Agent 生命周期。
- Agent 之间禁止私连；所有跨 Agent 协作必须经过 AppCore 创建任务、落库、路由、审计。
- 每个 Agent 有独立 Agent Home 和每任务 Task Workspace；工作目录不能作为跨 Agent 通信通道。
- Conversation Agent 执行工具前必须向 AppCore 请求 `permission token`。
- Safety/Permission 三级模型（15.0）：L1 确定性规则 → L2 Brain 语义判断 → L3 用户确认；YOLO 模式全交 Brain。
- Brain 每轮最终回复前必经审核。
- 控制台用户可见输出默认中文。
- 测试模式必须支持全链路 LLM 接管。
- LLM API 对外是 BerryAgent 自己的统一契约；第三方 SDK 只能作为内部 backend adapter。
- Code Agent 必须通过 Claude Agent SDK runner 执行编码任务，不能退化成普通聊天模型循环。
- 插件系统是独立插件包体系：`plugin.json + entry.ts + fixtures + SDK`。
- 日志固定 4 级：`error` / `warn` / `info` / `debug`。

## 设计文档索引

完整设计文档索引见 [`设计文档/index.md`](../设计文档/index.md)（按主题拆分，随架构演进同步更新）。

> ⚠️ **2026-07-22：18.0 重置起草中**。`设计文档/` 的设计过程稿（v2 / 17.0 / berryagentOS）已归档至 [`设计文档/废弃/`](../设计文档/废弃/)（逐篇摘要见 `废弃/README.md`）；当前唯一活跃设计 = [`设计文档/28-架构升级-18.0-重置起草.md`](../设计文档/28-架构升级-18.0-重置起草.md)。

**版本现状（诚实陈述）**：
- **当前运行代码 = v2**：15.0（Brain 中心化治理 + 存储加固）+ 22（对话内联统一 Block[]）。下文「核心目标」「当前关键决策」描述的就是这套**仍在运行的代码**，开发规则照常适用；其设计过程稿（21 / 22 等）已迁至 `废弃/`。
- **18.0 = 重置起草**：推翻 v2 / 17.0 / berryagentOS 的设计方向，从白纸重新设计；尚未落码，核心命题待钉死。
- **17.0（滚动计划循环）设计稿已归档**，方向是否被 18.0 继承待重审。

## 当前关键决策

1. **模块化解耦优先**
   模块通过 `contract`、Event Bus、IPC、Plugin SDK 通信，禁止跨模块读取内部实现。

2. **Brain 必经**
   Conversation Agent 的 `draft_response` 必须经过 Brain 审核后才能发给用户。

3. **Agent 通信中心化**
   多 Agent 保留独立进程和工作目录，但跨 Agent 通信只能走 AppCore。`agent_tasks` 是任务事实源，`agent_messages` 是 IPC 审计，`task_events` 是进度时间线。任务必须先落库再派发。

4. **Agent 工作目录隔离**
   每个 Agent 有独立 `~/.berry/agents/<agent-name>/`，长期配置放 Agent Home，每次任务放 `tasks/<task_id>/`。`state.db` 只存本 Agent 局部状态；`task.json` 只能由 AppCore 创建；目录文件只是配置、缓存、镜像和 artifact，不替代 SQLite 全局事实源。

5. **权限硬闸门在 AppCore**
   Brain 可以判断风险和建议确认，但不能绕过 AppCore 的硬规则和 `permission token`。

6. **权限 token 强绑定**
   工具、shell、文件、插件和代码操作的 token 必须绑定 `run/session/task/agent/inputHash/cwd/argv/envHash/fileHash`，输入变化即失效，默认 fail closed。

7. **Skill 与 Plugin 分层**
   Skill 是 `SKILL.md` 指令文档；Plugin 是独立插件包。能用 Skill 解决的，不优先生成 Plugin。插件生成由按需 `plugin-builder-agent` 负责，不塞进 `skills-agent`。
   当前已先落地确定性自进化闭环：对话信号生成 `evolution_proposals`，低风险 Skill 自动生成 `SKILL.md` 并索引，Plugin 先生成草稿包并进入验证/待审核状态；LLM 驱动的二级 Agent 通过统一 LLM API 增强这些模块。
   插件系统已提供第一批 AI 友好接口：`berry plugins contract/schema/scaffold/inspect/validate/test/dry-run/propose/approve --json`，以及 Conversation Agent 可调用的 `list_plugins`、`inspect_plugin`、`validate_plugin`、`dry_run_plugin` 工具。工具请求经 IPC 回到 AppCore，再交给 evolution capability 门面执行，不让 Agent/Tool 直接读插件内部实现。

8. **Code Agent 独立成二级智能体**
   `code-agent` 负责普通代码库的阅读、修改、测试、重构和补丁说明；`plugin-builder-agent` 只负责 BerryAgent 插件包。

9. **记忆采用混合存储**
   长期记忆、对话历史、episodes 的事实源是 SQLite；`MEMORY.md`、Markdown/JSON 导出和 artifact 只是投影或调试表面。Skills/Plugins 作为能力载体仍以文件为事实源。

10. **AI 主动查阅记忆**
   每轮用户消息前由 AppCore 自动召回少量相关记忆并注入动态上下文；Conversation Agent 仍可用 `memory_query` 主动查更多。记忆上下文不写入冻结 system prompt。

11. **AI 自动化测试接管**
   所有 Agent 的 LLM 调用必须经过 `src/llm/`，并支持 `live` / `mock` / `replay` / `takeover`。

12. **LLM API 与 SDK 分层**
   BerryAgent 不把 Anthropic SDK、AI SDK 或 Claude Agent SDK 直接暴露给 Agent/Skill/Plugin。普通模型调用走 `ModelRequest/ModelEvent/ModelResponse`；默认 backend 是 Anthropic 兼容接口，后续可接 AI SDK backend 支持 OpenAI / Anthropic / OpenAI-compatible；编码任务单独走 Claude Agent SDK runner，并把 SDK 原始事件归一化回 BerryAgent 事件。

13. **可观测系统内建**
   每次运行生成 `run_id` 和 artifact，完整保留 `stdout.log`、`stderr.log`、`console.jsonl`、`berry.log.jsonl`、`result.json`。

## 维护规则

- 详细设计写入 `设计文档/` 对应文件。
- 本文件只维护总览、索引和关键决策。
- 修改开发约束时同步检查 `AGENTS.md` 和 `CLAUDE.md`。
