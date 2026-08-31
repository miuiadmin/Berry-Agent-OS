# Berry

> **Berry Agent OS — 跑 AI 应用的操作系统** · TypeScript + SQLite + pi-ai。
>
> 模型和工具月月换代，你的凭证、记忆、信任史、预算、账本只积累一次——Berry 是这五样操作者状态的持有层，装上的每个应用长在同一份状态上，下一个接着用。

Berry Agent OS 的固定内核只司**装、跑、守、存**四职能，其余一切以应用形态装在组合树上。应用按类型轴分三形：**应用型（被启动）/ 扩展型（被调用）/ 服务型（被依赖）**——连首启进入的应用也不住内核：预装默认应用 = **coder 代码智能体应用**（`default: true` 清单键声明，纯清单组装——能力面全走组件声明；官方对话应用 `builtin:chat` 为回落锚点，`/app chat` 可入）。双重自进化（使用进化 + 技能进化）走涌现路径：不设中枢调度器，内核只提供原语。应用面机制（应用清单声明、启动面、多应用并行、应用级授权与预算）已落码。装载关系走**应用中心模型**（已落码）：应用是独立安装物（npm 三源即市场，不自建商店）；装载件**独立不生效**——装机只入仓库（仓库态零生效），挂载写组合行才生效（`/apps-install` 与 `/apps-mount` 两态动词）；官方件挂全局作用域服务所有应用（记忆等操作者状态长在同一份上），第三方件挂应用作用域（授权与爆炸半径随宿主应用收拢），缺省 external 进程域（应用生而沙箱）。**下限目标：出厂默认层（官方全家桶）达到 Codex / Claude Code 的可日用水准**——检索、命令执行、联网、MCP 四纵切已落，代码智能体应用已上默认入口。

## 特性一览

- **极小内核（Ring 0）**：25 模块的单向依赖 DAG（全部有码），拓扑由 `npm run lint:topology` 门禁钉死——内核不可卸、职责不膨胀。
- **事件溯源会话**：对话即 append-only 事件日志（SQLite WAL），模型历史是日志的投影；遮蔽、分叉、恢复全部由日志语义承载。
- **可卸载增强（Ring 2）**：官方全家桶随包默认装配——`chat`（对话应用——首启对话体验的载体，默认层首行）、`memory`（记忆库：提取/合并/双路注入/跨会话检索/效用进化/持有面——TTL 留存、冻结恒驻、版本链、访问日志、JSONL 导入导出）、`subagent`（进程内子代理委派 + 声明式子代理）、`goal`（长目标状态机 + 预算刹车 + 续跑）、`scheduler`（定时任务 `/tick`——launchd/crontab 注册器，OS 调度器持时、不持常驻进程）、`mcp`（MCP 客户端桥——外部工具生态接入）、`web`（fetch 工具 + SSRF 卫生件）、`compaction`（长会话压缩）、`admin`（平台管理面工具）——每一件都可卸载，卸掉核心循环不断。
- **安全栈内建**：工具三段管道（schema 校验 → 守门 → 执行）、沙箱三档（read-only / workspace-write / danger-full-access，macOS seatbelt / Linux bwrap）、可写根推导与 carve-out、审批对、allowlist 免问（命中免审批但落审计账——`/allowlist` 枚举与撤销）。
- **技能系统**：SKILL.md 双层结构 + 渐进披露，放一个目录即生效。
- **组合树装载**：默认层 + `overlay.yaml` 字段级覆写；应用中心装载面已落码——装机/挂载两态（`install` 入仓零生效、`mount` 写行生效）+ 作用域两档（全局 / 应用）+ `/reload --app` 单区热重载 + `/apps-uninstall` 两段式卸载。

## 快速开始

```bash
# 要求 Node.js >= 22.19
npm install
npm run build
npm link          # 装上 berry 命令（或直接 npx tsx src/app/main.ts）

berry             # TUI 交互（缺省续接当前目录最新会话）
berry run "hi"    # 单次执行（退出码即结果）
berry dump-config # 生效组合诊断（模型/组合树/应用装载状态，不落库）
```

首次启动会在 `~/.berry/` 建数据目录。模型缺省 `anthropic/claude-sonnet-5`，可用 `APP_MODEL` 覆盖；provider 凭证走 pi-ai 凭证链（环境变量或凭证表）。

## 文档

| 文档                                         | 内容                                                   |
| -------------------------------------------- | ------------------------------------------------------ |
| [docs/架构总览.md](docs/架构总览.md)         | 三环模型、模块 DAG、事件系统、装配序、应用装载         |
| [docs/使用指南.md](docs/使用指南.md)         | CLI / TUI 命令面、数据目录、环境变量、技能             |
| [docs/应用开发指南.md](docs/应用开发指南.md) | entry.ts 形态、inject 服务面、扩展点词汇、组合树、调试 |
| [docs/开发指南.md](docs/开发指南.md)         | 四门禁、测试纪律、模块边界、注释与命名规范             |
| [docs/运维手册.md](docs/运维手册.md)         | 数据目录结构、备份、清库、双开护栏、故障排查           |

## 开发

```bash
npm run dev               # TUI（tsx 直跑，日志缺省 debug）
npm test                  # 全部测试
npm run typecheck         # tsc --noEmit
npm run lint:topology     # 模块 DAG + 事件词汇双向门禁
npm run format:check      # Prettier
```

四门禁全绿是提交的前提。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 技术栈

Node.js ≥ 22.19 · TypeScript（ES Modules，tsc 直出）· [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) · [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) · better-sqlite3 · typebox · yaml · ignore · jiti · Vitest · Prettier
