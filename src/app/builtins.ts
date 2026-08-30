/**
 * L5 app — 官方件注册表（契约篇 §6.1 `builtin:` 前缀命名空间的宿主半边）。
 *
 * 组合根装配期构造：官方随包件（Ring 2 官方全家桶）的模块引用按 `builtin:<name>`
 * 收纳，交 loadComposition 作 `builtin:` 行的唯一解析面。注册表只此一处——
 * overlay 不可能借该前缀伪装官方件身份（查不到即 unresolved 响亮）。
 *
 * 依赖注入走闭包（官方件 = 宿主装配特权）：Store 公共读脸等宿主资源在
 * 构造期传入，不新开 ctx 服务名。
 *
 * 迁移聚合（会话篇 §6 静态声明面，tick 第一刀兑现第十六批题十五目标态）：
 * 本文件 = 带表件的唯一注册点——行注册与 `migrations` 标准名 import 同文件
 * 追加，`collectBuiltinMigrations()` 供 assembly 拼业务链（此后每加带表件
 * assembly 零改动）。
 */

import { createMemoryApp, type MemoryAppStoreFace, migrations as memoryMigrations } from '../memory/index.js';
import { createGoalApp, migrations as goalMigrations } from '../goal/index.js';
import type { GoalChannel } from '../goal/index.js';
import { createSchedulerApp, migrations as schedulerMigrations } from '../scheduler/index.js';
import type { SchedulerAppDeps } from '../scheduler/index.js';
import { createMcpApp } from '../mcp/index.js';
import type { McpAppDeps } from '../mcp/index.js';
import { createLspApp } from '../lsp/index.js';
import type { LspAppDeps } from '../lsp/index.js';
import { createWebApp } from '../web/index.js';
import type { WebAppOverrides } from '../web/index.js';
import { createCompactionApp } from '../compaction/index.js';
import { createAdminApp } from '../admin/index.js';
import { createCheckpointApp, type CheckpointAppDeps } from '../checkpoint/index.js';
import { createToolsApp, type ToolsAppDeps } from '../tools/index.js';
import { createChannelsApp, type ChannelsAppDeps } from '../channels/index.js';
import { createWebuiApp, type WebuiAppDeps } from '../webui/index.js';
import { createSubagentApp } from './subagent-app.js';
import type { AgentLocation } from './agents-md.js';
import type { InProcessChildFactory } from '../subagent/inprocess.js';
import type { DatabaseConnection, MigrationSpec } from '../persist/index.js';
import type { Session } from '../session/session.js';
import type { BuiltinAppModule } from '../contracts/app.js';
import type { BuiltinAppRegistry } from './composition.js';

/** 官方件构造参数（装配期可得的宿主资源；store 缺省 = persist:false 降级空转） */
export interface BuiltinRegistryOptions {
  /** Store 公共读脸（memory 官方件闭包注入）；无持久层时不传 */
  readonly store?: MemoryAppStoreFace;
  /** SQLite 连接（goal/scheduler 官方件闭包注入——goals/jobs 表物理载体）；无持久层时不传 */
  readonly goalConnection?: DatabaseConnection;
  /**
   * goal↔chat↔lsp 组合根通道（第三十九批 goal 循环批刀二，冷读 CR-11）：
   * 组合根创建单件、闭包注入三件（goal 段查询注册侧 + todo fold/诊断查询
   * 消费侧）。缺省不传（纯测试形态）= 通道面缺席，各消费方诚实降级
   */
  readonly goalChannel?: GoalChannel;
  /** scheduler 件闭包依赖束（gate 判据 + runner——组合根活资源，席 13 第一刀；connection 由 goalConnection 同源注入不在此列） */
  readonly schedulerDeps?: Omit<SchedulerAppDeps, 'connection'>;
  /** mcp 件闭包依赖束（spawnServer 组装 = app/mcp-spawn.ts 产物 + exec killTree + 数据目录——契约篇 §6.6 冷读 #1 上提组合根） */
  readonly mcpDeps: McpAppDeps;
  /**
   * lsp 件闭包依赖束（默认层第十二行，契约篇 §6.7 冷读同款上提）：spawnServer
   * = 复用 mcp-spawner 工厂另建实例（workspace 腿传 rootUri 物理根）+ killTree
   * + 登记簿（<dataDir>/lsp/children.json）+ rootPhysicalRoot/resolvePath 锚 +
   * 桥核工厂——lsp 结构上不见 mcp/exec（组合根装配）
   */
  readonly lspDeps: LspAppDeps;
  /** web 件依赖覆盖缝（可选——生产零依赖不传；组合根全栈测试注入 fetchImpl/lookup，mock 停在外部边界） */
  readonly webOverrides?: WebAppOverrides;
  /** tools 件闭包依赖束（Ring 1 行树化批——管道 gate 落点/可写根推导器〔safety 同源产物，宿主构造〕/工作区活取值） */
  readonly toolsDeps: ToolsAppDeps;
  /**
   * 可写根活取值（memory 官方件文件命令面——/memory-export|import 落盘判定源；
   * assembly rootsProvider 同源产物，第三十二批）。缺省不传 = 文件命令面不注册
   */
  readonly writableRoots?: () => readonly string[];
  /** 工作区根（项目归属键活取值） */
  readonly workspace: () => string;
  /** in-process 真工厂（subagent 官方件闭包注入——app/subagent-factory.ts 产物） */
  readonly subagentFactory?: InProcessChildFactory;
  /**
   * 声明式子代理发现位置（缺省 defaultAgentLocations——assembly 以 workspace
   * 同源 + homeDir 测试缝注入，镜像 skills 装配形态；组合根全栈测试传 fixture 目录）
   */
  readonly agentLocations?: readonly AgentLocation[];
  /** 父会话活引用（委派工具 start 时取 ownerSessionId——结算通知路由键；goal 取当前会话 id） */
  readonly getSession: () => Session | undefined;
  /**
   * chat 对话应用件模块（组合根 createChatApp 产物——默认层首行）：会话
   * 选择/驱动构造/ctx.agent provide 全在件内；无持久层时件自降级空转（装载
   * 面完好——诊断树不断链）。恒传入（件可卸靠 overlay 禁用行，不靠缺注）
   */
  readonly chat: BuiltinAppModule;
  /**
   * checkpoint 件闭包依赖束（默认层第十一行，会话篇 §5.3）：activeSessions =
   * 驱动注册表在册会话活集合（prune 下界判据——组合根闭包晚绑）。缺省不传 =
   * 诊断档退化空集（真装配恒传；dump-config 合成树 apply 永不跑，空集不触达）
   */
  readonly checkpointDeps?: CheckpointAppDeps;
  /**
   * channels 件闭包依赖束（Ring 1 第十三行树化，契约篇 §6.8）：onUiError =
   * UI 广播异常诊断 + rowApp = D1 命令拒载探针。**缺省不传 = D1 执法静默
   * 回归**（真装配恒传——冷读 M2 勘正；纯测试形态才可省）
   */
  readonly channelsDeps: ChannelsAppDeps;
  /**
   * webui 件闭包依赖束（默认层第十四行，契约篇 §6.8）：宿主面全闭包注入
   * （addDisplay/submitTo/historyFor/sessionsFor/openSession/todoFor/ui/version）。
   * 行缺省 enabled:false 惰性零监听——deps 恒传不随 enabled 变
   */
  readonly webuiDeps: WebuiAppDeps;
}

/**
 * 构造官方件注册表（loadComposition 第二参——`builtin:` 行的唯一解析面）。
 * 时序上后于 Persistence.open（store 是其产物）；迁移链另出（本文件
 * collectBuiltinMigrations——assembly 聚合）。
 */
export function createBuiltinRegistry(opts: BuiltinRegistryOptions): BuiltinAppRegistry {
  return {
    // chat 对话应用件（官方默认层首行——应用面第一纵切）
    'builtin:chat': opts.chat,
    'builtin:memory': createMemoryApp({
      ...(opts.store ? { store: opts.store } : {}),
      workspace: opts.workspace,
      // 文件命令面（§3 持有面）：可写根闭包注入——缺省不传即命令面降级不注册
      ...(opts.writableRoots ? { writableRoots: opts.writableRoots } : {}),
    }),
    // subagent 官方件（官方默认层第三行）：工厂缺省不注册（诊断面可省装配），
    // 默认装配恒传——组合根 createSubagentChildFactory 闭包活资源
    ...(opts.subagentFactory
      ? {
          'builtin:subagent': createSubagentApp({
            factory: opts.subagentFactory,
            getSession: opts.getSession,
            ...(opts.agentLocations ? { agentLocations: opts.agentLocations } : {}),
          }),
        }
      : {}),
    // goal 官方件（官方默认层第四行，Ring 2 编排域）：连接随 persist 走（缺省
    // 降级 warn 空转）；boot 续接降级走 session_start 补播事件面（二十九批
    // 增补 8①——wasResumed 装配旁路退役），'agent' 走 optionalInject（chat 件
    // 未装载时缺供降级，不阻激活）
    'builtin:goal': createGoalApp({
      ...(opts.goalConnection ? { connection: opts.goalConnection } : {}),
      getSessionId: () => opts.getSession()?.header.sessionId,
      // 通道注入（刀二计划态跨轮）：goal 段查询注册侧 + todo fold 消费侧
      ...(opts.goalChannel ? { channel: opts.goalChannel } : {}),
    }),
    // scheduler 官方件（官方默认层第五行，tick 第一刀——内核边界篇 §4.1 席 13）：
    // 连接与 gate 判据/runner 全闭包注入（spawn 组装在 app/scheduler-runner.ts）；
    // 无持久层时空转，无 runner（诊断装配）时 /tick run 报不可用、表面照常
    ...(opts.schedulerDeps
      ? {
          'builtin:scheduler': createSchedulerApp({
            ...(opts.goalConnection ? { connection: opts.goalConnection } : {}),
            ...opts.schedulerDeps,
          }),
        }
      : {}),
    // mcp 官方件（官方默认层第六行，stdio-only 客户端桥第一刀——契约篇 §6.6）：
    // spawn/kill 经闭包注入（组合根 app/mcp-spawn.ts——mcp 结构上不见 exec）；
    // servers 空时件惰性无害零 spawn——恒注册（卸行靠 overlay 禁用）
    'builtin:mcp': createMcpApp(opts.mcpDeps),
    // lsp 官方件（官方默认层第十二行，LSP 服务器桥第一刀——契约篇 §6.7）：惰性
    // spawn + 3 连败熔断 + 四工具 + write/edit 后诊断注入 post 行。servers 空
    // 时件惰性无害零 spawn——恒注册（卸行靠 overlay 禁用）。诊断查询面挂通道
    //（goal 循环批刀二 gates 条，冷读 CR-12 迟到注入）：lsp 行装载即回填、
    // 行卸载随锚回卷摘面——chat 侧 diagnostics gate fail-closed
    'builtin:lsp': createLspApp({
      ...opts.lspDeps,
      ...(opts.goalChannel ? { mountDiagnostics: (face) => opts.goalChannel!.registerDiagnostics(face) } : {}),
    }),
    // web 官方件（第八行，契约篇 §1.5.2 web 刀）：fetch 工具 + ctx.fetch 服务 +
    // SSRF 五卫生件一批三件——零宿主资源闭包（最简官方件形态）；恒注册
    //（config.fetch:false 只关模型面工具，服务面恒在——「有但省」变体二）
    'builtin:web': createWebApp(opts.webOverrides),
    // compaction 官方件（第九行，内核边界篇席 20——会话篇 §2 增补七条）：长会话
    // 压缩 durable 五步 + 两段式触发（onRunSettled 判阈 / reseedTimeline 重播种）。
    // 零宿主资源闭包（服务全经 ctx 取——web 同款最简形态）；恒注册（卸行靠
    // overlay 禁用——件停用后旧压缩日志仍可读，词汇宿主面注册不随行漂移）
    'builtin:compaction': createCompactionApp(),
    // admin 官方件（第十行，契约篇 §3.4 平台管理面第一刀，2026-08-27）：只读面
    // 两工具（apps_list/events_query）+ 管理 Skill 同件携带（packageRoot 自述
    // 锚）。零宿主资源闭包（tools/sessions/apps 三键全经 ctx 取）；恒注册
    //（卸行靠 overlay 禁用——写类动词随第二刀导线）
    'builtin:admin': createAdminApp(),
    // checkpoint 官方件（第十一行，内核边界篇席 23——会话篇 §5.3 工作台三件
    // 第二刀）：工作区快照（sha256 blob 仓 + per-run manifest）+ /rewind 两段
    // 回退。唯一闭包 = activeSessions（prune 下界判据——诊断档退化空集）；
    // 恒注册（卸行靠 overlay 禁用——曾回退过的旧日志可读性不随行装载漂移，
    // 词汇宿主面注册）
    'builtin:checkpoint': createCheckpointApp(opts.checkpointDeps ?? { activeSessions: () => new Set<string>() }),
    // tools 官方件（第七行 = Ring 1 行树化起算行，契约篇 §5.1 节奏表——**必备行**
    // 非 Ring 2 可卸：overlay 禁用即启动断言拒启；可换实现引用不可禁用）：
    // 三段管道 + ctx.tools 服务 + fs/检索工具族。恒注册（缺注即 unresolved——
    // Ring 1 必备行断言拒启，诊断树也须见到此行）
    'builtin:tools': createToolsApp(opts.toolsDeps),
    // channels 官方件（第十三行 = Ring 1 第二行树化，契约篇 §6.8 Web 通道
    // 第一刀——tools 先例同构）：ctx.ui / ctx.channels 两服务的构造入列行
    // apply（TUI 后端本体不入行——宿主入口持终端与进程生命周期）。恒注册
    //（Ring 1 必备行——overlay 禁用即启动断言拒启）
    'builtin:channels': createChannelsApp(opts.channelsDeps),
    // webui 官方件（第十四行，契约篇 §6.8——Ring 2 真·可卸）：单机回环
    // Web 通道后端。行缺省 enabled:false 惰性零监听；恒注册（卸行/关面走
    // overlay 禁用或 config.enabled:false，unresolved 不属于本件的形态）
    'builtin:webui': createWebuiApp(opts.webuiDeps),
  };
}

/** 全部带表官方件的迁移链（assembly 拼业务链的唯一来源——新带表件在本函数追加一项） */
export function collectBuiltinMigrations(): MigrationSpec[] {
  return [...memoryMigrations, ...goalMigrations, ...schedulerMigrations];
}
