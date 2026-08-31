<p align="center">
  <strong>Berry</strong><br>
  跑 AI 应用的操作系统
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berryagent"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.en.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a>
</p>

---

Berry Agent OS 的固定内核只司**装、跑、守、存**四职能，其余一切以应用形态装在组合树上。模型和工具月月换代，你的凭证、记忆、信任史、预算、账本只积累一次——这五样操作者状态由 Berry 持有，装上的每个应用长在同一份状态上，下一个接着用。

应用按类型轴分三形：**应用型（被启动）/ 扩展型（被调用）/ 服务型（被依赖）**——连首启进入的体验也不住内核：出厂默认应用是 **coder 代码智能体应用**（纯清单组装，能力面全走组件声明），官方对话应用 `chat` 为回落锚点。双重自进化（使用进化 + 技能进化）走涌现路径：不设中枢调度器，内核只提供原语。

**下限目标：出厂默认层（官方全家桶）达到 Codex / Claude Code 的可日用水准。**

## 目录

- [为什么是 Berry](#为什么是-berry)
- [快速开始](#快速开始)
- [特性一览](#特性一览)
- [一切皆应用](#一切皆应用)
- [安全模型](#安全模型)
- [文档](#文档)
- [项目状态](#项目状态)
- [遥测](#遥测)
- [参与开发](#参与开发)
- [许可证](#许可证)

---

## 为什么是 Berry

AI 应用的真正资产不是模型——模型月月换代——而是**操作者状态**：凭证、记忆、信任史、预算、账本。今天用对话应用，明天换代码智能体，后天装一个数据整理应用，它们应该长在同一份状态上，而不是各自从零开始。

Berry 用操作系统的方式回答这个问题：

- **极小内核**：固定内核只做四件事——装（应用与上下文装载）、跑（代理循环）、守（安全与审批）、存（会话与凭证）。25 模块单向依赖 DAG，拓扑由机器门禁钉死，内核不可卸、职责不膨胀。
- **一切皆应用**：对话是应用，代码智能体是应用，记忆库是应用，连 MCP 桥和 Web 通道都是应用。应用可装可卸可替换，卸掉任何一个，核心循环不断。
- **事件溯源会话**：对话即 append-only 事件日志（SQLite WAL），模型历史是日志的投影。遮蔽、分叉、恢复、回放全部由日志语义承载——你的历史就是你的数据。

## 快速开始

```bash
# 要求 Node.js >= 22.19
git clone <本仓库> && cd berry
npm install
npm run build
npm link          # 装上 berry 命令

berry             # TUI 交互（缺省进入 coder 应用，续接当前目录最新会话）
berry run "hi"    # 单次执行（退出码即结果）
berry dump-config # 生效组合诊断（模型/组合树/应用装载状态，不落库）
```

首次启动会在 `~/.berry/` 建数据目录。模型缺省 `anthropic/claude-sonnet-5`，可用 `APP_MODEL` 覆盖；provider 凭证走 pi-ai 凭证链（环境变量或凭证表）。

## 特性一览

- **极小内核（Ring 0）**：25 模块单向 DAG 全部有码，`npm run lint:topology` 机器执法——装/跑/守/存四职能之外不设中枢。
- **事件溯源会话**：append-only 事件日志 + 投影派生；长会话压缩（`compaction`）、工作区快照回退（`checkpoint` /rewind）、会话分叉与收养全部由日志承载。
- **官方全家桶（Ring 2，件件可卸）**：`coder`（默认代码智能体应用）、`chat`（对话应用）、`memory`（记忆库：提取/合并/双路注入/跨会话检索/效用进化/TTL/版本链）、`subagent`（子代理委派）、`goal`（长目标状态机 + 预算刹车 + 挂钟唤醒）、`scheduler`（`/tick` 定时任务——launchd/crontab 注册器，进程不常驻）、`mcp`（MCP 客户端桥）、`lsp`（语言服务器桥：诊断/符号/定义/引用）、`web`（fetch 工具 + SSRF 卫生件）、`obs`（观测面：小时聚合 rollup + `obs_query` 查询 + `/obs` 速览 + 告警面）、`admin`（平台管理面工具）、`webui`（回环 Web 通道，`--port` 一次性开面）。
- **安全栈内建**：工具三段管道（schema 校验 → 守门 → 执行）、沙箱三档（read-only / workspace-write / danger-full-access，macOS seatbelt / Linux bwrap）、可写根推导与 carve-out、审批对、allowlist 免问（命中免审批但落审计账）。
- **技能系统**：SKILL.md 双层结构 + 渐进披露，放一个目录即生效；应用可随包携带技能。
- **组合树装载**：默认层 + `overlay.yaml` 字段级覆写；应用中心装载面——装机/挂载两态（`install` 入仓零生效、`mount` 写行生效）、作用域两档（全局 / 应用）、`/reload --app` 单区热重载、第三方件缺省 external 进程域（应用生而沙箱）。

## 一切皆应用

装载关系走**应用中心模型**：应用是独立安装物（npm 三源即市场——registry 包名 / git 源 / 本地目录，不自建商店）；装载件**独立不生效**——装机只入仓库，挂载写组合行才生效。官方件挂全局作用域服务所有应用（记忆等操作者状态长在同一份上），第三方件挂应用作用域（授权与爆炸半径随宿主应用收拢）。

给 Berry 写一个应用只需要一个 `index.ts`：默认导出 `apply(ctx, config)`，声明式元数据（inject 依赖、config schema、events 词汇），一切注册走 `ctx.effect`——作用域回卷即自动注销。35 个生命周期钩子横跨会话/代理/轮次/消息/工具管道/provider 六层，观测与治理面全套开放。详见[应用开发指南](docs/应用开发指南.md)。

## 安全模型

- **工具三段管道**：schema 校验 → 守门（审批/沙箱/allowlist 决议）→ 执行——工具执行的唯一合法路径，durable 落账不旁路。
- **沙箱三档**：`read-only` / `workspace-write` / `danger-full-access`；第三方应用缺省 external 进程域（per-行 fork 进程 + PM 中层 + OS 沙箱层），间接子进程按行白名单收窄。
- **审批对**：每个 write 级动作落 `approval/asked` / `approval/decided` 审计账；「始终允许」走 allowlist（可枚举可撤销）。
- **词汇执法**：事件词汇注册表机器对照——拼错名响亮失败，内核词第三方不可伪造。

## 文档

| 文档                                         | 内容                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| [docs/架构总览.md](docs/架构总览.md)         | 三环模型、模块 DAG、事件系统、装配序、应用装载         |
| [docs/使用指南.md](docs/使用指南.md)         | CLI / TUI 命令面、数据目录、环境变量、技能             |
| [docs/应用开发指南.md](docs/应用开发指南.md) | entry.ts 形态、inject 服务面、扩展点词汇、组合树、调试 |
| [docs/开发指南.md](docs/开发指南.md)         | 四门禁、测试纪律、模块边界、注释与命名规范             |
| [docs/运维手册.md](docs/运维手册.md)         | 数据目录结构、备份、清库、双开护栏、故障排查           |

> 文档目前以中文为准，英文版随 1.0 正式发布推进。

## 项目状态

`1.0.0-alpha` —— pre-release 窗口：API / 词汇 / 类型面自由演进，破坏性变更一笔原子化。检索、命令执行、联网、MCP、LSP、观测面（聚合 + 告警）已落码；多租户服务器形态挂账，落码等真实需求拉动。

## 遥测

**默认零遥测**——本工具不发任何网络包：无使用统计、无崩溃上报、无版本检查（升级与否完全由你决定）。你配置的模型调用是唯一的出网流量。

若未来引入任何回传，承诺四件：公告先行（Why this exists / How it works / What data is collected / How to disable it 四段俱全才发版）、默认关闭（默认值反转视为 Breaking Change）、关闭通道机器可验证（不是一句「可以关」）、数据面最小化（能离线的绝不回传）。

## 参与开发

```bash
npm run dev               # TUI（tsx 直跑，日志缺省 debug）
npm test                  # 全部测试
npm run typecheck         # tsc --noEmit 双段
npm run lint:topology     # 模块 DAG + 事件词汇双向门禁
npm run format:check      # Prettier
```

四门禁全绿是提交的前提。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)——官方件随包分发，第三方应用与技能件各自持照。
