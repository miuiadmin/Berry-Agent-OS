# Berry

> Berry Agent OS — 跑 AI 应用的个人操作系统 · TypeScript + SQLite + pi-ai。

Berry Agent OS 的固定内核只司**装、跑、守、存**四职能，其余一切以插件形态装在组合树上。装载件分三种产品角色：**被启动的是应用，被调用的是库，被依赖的是后台服务**——连首启进入的对话本身也是一个应用（官方对话应用 `builtin:chat`，默认层首行），不住内核；预装默认应用的终态是**代码智能体应用**（coding 优先，待 exec 工具族纵切后组装）。双重自进化（使用进化 + 技能进化）走涌现路径：不设中枢调度器，内核只提供原语。应用面机制（应用清单、启动面、应用级授权与预算）设计已定稿，第一纵切 `builtin:chat` 已落码，其余随 M2+ 落地。**下限目标：出厂默认层（官方全家桶）达到 Codex / Claude Code 的可日用水准**——检索、命令执行、联网三纵切落齐后兑现。

## 特性一览

- **极小内核（Ring 0）**：17 模块的单向依赖 DAG（15 有码 + scheduler/mcp 两席占位），拓扑由 `npm run lint:topology` 门禁钉死——内核不可卸、职责不膨胀。
- **事件溯源会话**：对话即 append-only 事件日志（SQLite WAL），模型历史是日志的投影；遮蔽、分叉、恢复全部由日志语义承载。
- **插件式增强（Ring 2）**：官方全家桶随包默认装配——`chat`（对话应用——首启对话体验的载体，默认层首行）、`memory`（记忆库：提取/合并/双路注入/跨会话检索/效用进化）、`subagent`（进程内子代理委派）、`goal`（长目标状态机 + 预算刹车 + 续跑）——每一件都可卸载，卸掉核心循环不断。
- **安全栈内建**：工具三段管道（schema 校验 → 守门 → 执行）、沙箱三档（read-only / workspace-write / danger-full-access，macOS seatbelt / Linux bwrap）、可写根推导与 carve-out、审批对。
- **技能系统**：SKILL.md 双层结构 + 渐进披露，放一个目录即生效。
- **组合树装载**：默认层 + `overlay.yaml` 字段级覆写，`/reload` 热重载插件集。

## 快速开始

```bash
# 要求 Node.js >= 22.19
npm install
npm run build
npm link          # 装上 berry 命令（或直接 npx tsx src/app/main.ts）

berry             # TUI 交互（缺省续接当前目录最新会话）
berry run "hi"    # 单次执行（退出码即结果）
berry dump-config # 生效组合诊断（模型/组合树/插件装载状态，不落库）
```

首次启动会在 `~/.berry/` 建数据目录。模型缺省 `anthropic/claude-sonnet-5`，可用 `APP_MODEL` 覆盖；provider 凭证走 pi-ai 凭证链（环境变量或凭证表）。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/架构总览.md](docs/架构总览.md) | 三环模型、模块 DAG、事件系统、装配序、插件装载 |
| [docs/使用指南.md](docs/使用指南.md) | CLI / TUI 命令面、数据目录、环境变量、技能 |
| [docs/插件开发指南.md](docs/插件开发指南.md) | entry.ts 形态、inject 服务面、扩展点词汇、组合树、调试 |
| [docs/开发指南.md](docs/开发指南.md) | 四门禁、测试纪律、模块边界、注释与命名规范 |
| [docs/运维手册.md](docs/运维手册.md) | 数据目录结构、备份、清库、双开护栏、故障排查 |

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

Node.js ≥ 22.19 · TypeScript（ES Modules，tsc 直出）· [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) · [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) · better-sqlite3 · typebox · jiti · Vitest · Prettier
