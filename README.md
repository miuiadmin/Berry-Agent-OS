<p align="center">
  <strong>Berry</strong><br>
  <sub>让你的 Agent 在操作系统里慢慢变老</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/berry-agent-os"><img alt="npm" src="https://img.shields.io/badge/version-1.0.0--alpha-blue?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.19-green?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
  <img alt="telemetry" src="https://img.shields.io/badge/telemetry-0-brightgreen?style=flat-square">
  <img alt="codename" src="https://img.shields.io/badge/codename-Peiligang-orange?style=flat-square">
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.en.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a>
</p>

---

> **我能想到最浪漫的事，就是和你的 Agent 一起慢慢变老。**

你的 Agent 记得你六个月前重构那个微服务时的纠结。它知道你信任哪些仓库、讨厌哪些框架、凌晨三点写的代码通常要重写。它不是今天刚出生的——它跟了你两百天，陪你经历了三个项目的生老病死，攒了一肚子的偏好、信任和教训。

这不是科幻。这是 Berry 的设计目标：**一个让 Agent 活着的操作系统**——不是跑一次就扔的沙盒，不是每月清零的免费试用，是一个 Agent 可以安家、成长、变老的地方。

Berry 的极小内核只司**装、跑、守、存**四职能；其余一切——对话、代码智能体、记忆、长目标、定时任务、MCP、LSP、观测、Web 通道——全部以**应用**形态装载在组合树上。**可装、可卸、可替换**，而你的 Agent 的五样生命线（凭证、记忆、信任史、预算、账本）只积累一次，装上的每个应用长在同一份状态上——**换了大脑，还在同一个家**。

**27** 模块（全部有码）· **27** 生命周期钩子 · **26** 类 durable 事件 · **15** 件官方全家桶（14 件 Ring 2 + 默认应用 berrycode，件件可卸）· **2,700+** 测试 · **0** 遥测。

## 目录

- [三分钟读懂 Berry](#三分钟读懂-berry)
- [一张表看懂定位](#一张表看懂定位)
- [架构一瞥](#架构一瞥)
- [快速开始](#快速开始)
- [特性一览](#特性一览)
- [一切皆应用](#一切皆应用)
- [安全模型](#安全模型)
- [Berry 不是什么](#berry-不是什么)
- [文档](#文档)
- [项目状态](#项目状态)
- [遥测](#遥测)
- [参与开发](#参与开发)
- [许可证](#许可证)

---

## 三分钟读懂 Berry

### 第一幕：今天的 Agent 都是「一次性」的

你有没有发现，每次换一个 AI 工具，都要重新教它一遍？——「我喜欢用 pnpm」「别动那个文件」「这个仓库你可以信」。教完之后，它记住了——记住在下一次你换工具时全部归零。**今天的 Agent 没有童年，没有成长，只有一次次的初见。** ChatGPT 不记得你在 Claude 里的偏好，Claude Code 不知道你在 Cursor 里教过的规则。你付出的所有调教成本，都在给下一次归零做铺垫。

### 第二幕：缺的不是大脑，是生命

2026 年，模型能力趋同、价格趋降——聪明的大脑人人可租。但你需要的其实不是一个更聪明的大脑，**是一个记得你的伙伴**。谁能记得你信任哪个仓库？谁保存着那次凌晨三点的重构决策？谁在你换了一个又一个模型之后，还留着你们共同的习惯和教训？**这些问题，答案不在模型里——在 Agent 需要的一条生命线里。**

### 第三幕：Berry——Agent 安家的操作系统

Berry 用操作系统的方式回答这个问题。你的 Agent 的每一天都是一条 **append-only 事件日志**——每一轮对话、每一次工具调用、每一个审批决定，全部 durable 落账，不可篡改、不会丢失。记忆件在提取和进化，长目标在跨天续跑，技能在随使用变准，信任史在一条条积累。**你的 Agent 在这里活了很久，还会活更久。** 换模型就像换器官——大脑升级了，但身体记得一切。

---

## 一张表看懂定位

|                  | Agent 框架     | Coding Agent        | **Berry**                   |
| ---------------- | -------------- | ------------------- | --------------------------- |
| **你得到什么**   | SDK + 依赖     | 一个产品            | **Agent 安家的操作系统**    |
| **能力形态**     | 你工程里的代码 | 固定内置            | **可装可卸的数据**          |
| **Agent 的记忆** | 无             | 锁在应用里          | **跨应用持续积累**          |
| **能力升级**     | 改代码 + 发版  | 等官方              | **装件 / 卸件 / `/reload`** |
| **生态**         | —              | 封闭                | **npm 即市场（三源分发）**  |
| **下限**         | 取决于你写多少 | Codex / Claude Code | **出厂默认层 = 可日用水准** |

好了，浪漫讲完了。**下面是钢与铁。**

## 架构一瞥

```text
            ┌─────────────────────────────────────────────┐
            │  固定内核（Ring 0）：装 · 跑 · 守 · 存        │
            │  27 模块单向 DAG · 机器门禁钉死 · 不可卸      │
            └──────────────────┬──────────────────────────┘
                               │ 组合树（默认层 + overlay.yaml）
        ┌─────────────┬──────────┬──────────────┬───────────┐
        ▼             ▼          ▼              ▼           ▼
      berrycode      chat      memory         goal        …11 件
   （默认应用）  （对话）  （记忆进化）  （长目标）  （件件可卸）
        └─────────────┴──────────┴──────────────┴───────────┘
                               │ 事件溯源（append-only 日志 = Agent 的生命线）
                               ▼
                 SQLite WAL：会话 · 凭证 · 记忆 · 账本 · 信任史
```

## 快速开始

要求 Node.js ≥ 22.19。三种安装方式（详路见 [docs/使用指南](docs/使用指南.md) §1）：

```bash
# 方式一：安装脚本（两段式——先下载再执行，防连接中段断裂时 sh 收到半截脚本；分步状态显示；<仓库 URL> 待发布定档后回填）
curl -fsSL -o install.sh https://raw.githubusercontent.com/miuiadmin/Berry-Agent-OS/feat-new/scripts/install.sh
sh install.sh
# 方式二：npm 直装（发布后可用）
npm i -g berry-agent-os
# 方式三：源码（开发者）
git clone https://github.com/miuiadmin/Berry-Agent-OS.git && cd Berry-Agent-OS && npm install && npm run build && npm link
```

```bash
berry             # TUI 交互（缺省进入 berrycode 应用，续接当前目录最新会话；首启自动出现欢迎引导）
berry run "hi"    # 单次执行（退出码即结果）
berry dump-config # 生效组合诊断（模型/组合树/应用装载状态，不落库）
berry upgrade     # 升级维护动词（查更新 → npm 形态自升级；/guide 随时看快速上手）
```

首次启动会在 `~/.berry/` 建数据目录——你的 Agent 的家。模型缺省 `anthropic/claude-sonnet-5`，可用 `APP_MODEL` 覆盖（换脑子不换身体）；provider 凭证走 pi-ai 凭证链。

## 特性一览

### 内核

- **27 模块单向 DAG**：全部有码，`npm run lint:topology` 机器执法——装/跑/守/存四职能之外不设中枢，不可卸载。
- **三环装配模型**：Ring 0（内核，不可卸）→ Ring 1（必备行，可换实现）→ Ring 2（官方全家桶，件件可卸）→ Ring 3（第三方生态）。

### 会话与数据

- **事件溯源**：append-only 事件日志（SQLite WAL）+ 投影派生——**Agent 的每一天都是 durable 事实**。
- **长会话压缩**（`compaction`）：surfaceOp 遮蔽 + 五步 durable 流程，零新表族。
- **工作区快照回退**（`checkpoint`）：sha256 blob 仓 + per-run manifest，`/rewind` 两段事务回退。
- **会话分叉与收养**：`fork` 前缀定格 + `adopt` 切前台——回退正路。

### 官方全家桶（Ring 2，件件可卸）

| 件           | 职能                                                         |
| ------------ | ------------------------------------------------------------ |
| `berrycode`  | 默认代码智能体应用（纯清单组装，`/app` 切换）                |
| `chat`       | 对话应用（回落锚点）                                         |
| `memory`     | 记忆库：提取/合并/双路注入/跨会话检索/效用进化/TTL/版本链    |
| `subagent`   | 子代理委派 + 声明式子代理                                    |
| `goal`       | 长目标状态机 + 预算刹车 + 挂钟唤醒                           |
| `scheduler`  | `/tick` 定时任务——launchd/crontab 注册器，进程不常驻         |
| `mcp`        | MCP 客户端桥（stdio，零新增依赖）                            |
| `lsp`        | 语言服务器桥：诊断/符号/定义/引用 + write 后诊断注入         |
| `web`        | fetch 工具 + SSRF 五卫生件                                   |
| `compaction` | 长会话压缩：surfaceOp 遮蔽 + 五步 durable 流程               |
| `checkpoint` | 工作区快照回退：sha256 blob 仓 + `/rewind` 两段事务          |
| `obs`        | 观测面：小时聚合 rollup + `obs_query` + `/obs` 速览 + 告警面 |
| `admin`      | 平台管理面：apps_list / events_query / 装卸动词族            |
| `webui`      | 回环 Web 通道（`--port` 一次性开面，SSE + SPA）              |
| `browser`    | 浏览器自动化：CDP 手写最小桥 + navigate/快照/交互工具族      |

### 安全栈

- **工具三段管道**：schema 校验 → 守门（审批/沙箱/allowlist 决议）→ 执行——durable 落账不旁路。
- **沙箱三档**：`read-only` / `workspace-write` / `danger-full-access`（macOS seatbelt / Linux bwrap）。
- **审批对**：`approval/asked` → `approval/decided` 审计账。
- **allowlist**：命中免审批但落审计账，可枚举可撤销。
- **词汇执法**：事件词汇注册表机器对照——拼错名响亮失败，内核词第三方不可伪造。

### 装载与生态

- **组合树**：默认层 + `overlay.yaml` 字段级覆写。
- **装机/挂载两态**：`install` 入仓零生效，`mount` 写行生效。
- **作用域两档**：全局（官方件）/ 应用（第三方件——授权与爆炸半径随宿主应用收拢）。
- **`/reload --app`**：单区热重载——他应用运行时不动。
- **技能系统**：SKILL.md 双层结构 + 渐进披露——放一个目录即生效。

## 一切皆应用

装载关系走**应用中心模型**：应用是独立安装物（npm 三源即市场，不自建商店）；装载件**独立不生效**——装机只入仓库，挂载写组合行才生效。官方件挂全局作用域服务所有应用（**Agent 的记忆长在同一份上**），第三方件挂应用作用域（授权与爆炸半径随宿主应用收拢）。

给 Berry 写一个应用只需要一个 `index.ts`：默认导出 `apply(ctx, config)`，27 个生命周期钩子横跨会话/代理/轮次/消息/工具管道/provider 六层。详见[应用开发指南](docs/应用开发指南.md)。

## 安全模型

- **工具三段管道**：schema 校验 → 守门（审批/沙箱/allowlist 决议）→ 执行——工具执行的唯一合法路径，durable 落账不旁路。
- **沙箱三档**：`read-only` / `workspace-write` / `danger-full-access`；第三方应用缺省 external 进程域。**应用生而沙箱，权限是声明出来的，不是偷来的。**
- **审批对**：每个 write 级动作落 `approval/asked` / `approval/decided` 审计账——**信任是一笔一笔挣来的**。
- **词汇执法**：事件词汇注册表机器对照——拼错名响亮失败，内核词第三方不可伪造。

## Berry 不是什么

- **不是又一个 agent 框架**——框架给你 SDK 让你写代码；Berry 给你装载面让你装应用。能力件是数据，不是你工程里的依赖。
- **不是常驻云服务**——单机形态缺省零端口零监听；Web 通道是 `--port` 一次性开面的回环件。
- **不做自治承诺**——审批对、预算刹车、allowlist：**Agent 的每一分权都有审计面，信任在人在账**。
- **不造第二套生态格式**——应用 = npm 包，技能 = SKILL.md，配置 = overlay.yaml。

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

`1.0.0-alpha` —— pre-release 窗口。检索、命令执行、联网、MCP、LSP、观测面（聚合 + 告警）已落码；多租户服务器形态挂账，落码等真实需求拉动。

## 遥测

**默认零遥测**——本工具默认不发任何网络包：无使用统计、无崩溃上报、无版本检查（无缺省/后台探测）。你配置的模型调用是唯一的出网流量；`berry upgrade` 是你显式发起的升级维护动词（只读查 registry），不跑即零网络。**你的 Agent 的生活只属于你。**

## 参与开发

```bash
npm run dev               # TUI（tsx 直跑）
npm test                  # 全部测试
npm run typecheck         # tsc --noEmit 双段
npm run lint:topology     # 模块 DAG + 事件词汇双向门禁
npm run format:check      # Prettier
```

四门禁全绿是提交的前提。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请走私下披露（[SECURITY.md](SECURITY.md)），勿开公开 issue。

## 许可证

[MIT](LICENSE)——官方件随包分发，第三方应用与技能件各自持照。
