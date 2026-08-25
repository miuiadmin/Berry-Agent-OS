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

import { createMemoryPlugin, type MemoryPluginStoreFace, migrations as memoryMigrations } from '../memory/index.js';
import { createGoalPlugin, migrations as goalMigrations } from '../goal/index.js';
import { createSchedulerPlugin, migrations as schedulerMigrations } from '../scheduler/index.js';
import type { SchedulerPluginDeps } from '../scheduler/index.js';
import { createMcpPlugin } from '../mcp/index.js';
import type { McpPluginDeps } from '../mcp/index.js';
import { createWebPlugin } from '../web/index.js';
import type { WebPluginOverrides } from '../web/index.js';
import { createToolsPlugin, type ToolsPluginDeps } from '../tools/index.js';
import { createSubagentPlugin } from './subagent-plugin.js';
import type { InProcessChildFactory } from '../subagent/inprocess.js';
import type { DatabaseConnection, MigrationSpec } from '../persist/index.js';
import type { Session } from '../session/session.js';
import type { BuiltinPluginModule } from '../contracts/plugin.js';
import type { BuiltinPluginRegistry } from './composition.js';

/** 官方件构造参数（装配期可得的宿主资源；store 缺省 = persist:false 降级空转） */
export interface BuiltinRegistryOptions {
  /** Store 公共读脸（memory 官方件闭包注入）；无持久层时不传 */
  readonly store?: MemoryPluginStoreFace;
  /** SQLite 连接（goal/scheduler 官方件闭包注入——goals/jobs 表物理载体）；无持久层时不传 */
  readonly goalConnection?: DatabaseConnection;
  /** scheduler 件闭包依赖束（gate 判据 + runner——组合根活资源，席 13 第一刀；connection 由 goalConnection 同源注入不在此列） */
  readonly schedulerDeps?: Omit<SchedulerPluginDeps, 'connection'>;
  /** mcp 件闭包依赖束（spawnServer 组装 = app/mcp-spawn.ts 产物 + exec killTree + 数据目录——契约篇 §6.6 冷读 #1 上提组合根） */
  readonly mcpDeps: McpPluginDeps;
  /** web 件依赖覆盖缝（可选——生产零依赖不传；组合根全栈测试注入 fetchImpl/lookup，mock 停在外部边界） */
  readonly webOverrides?: WebPluginOverrides;
  /** tools 件闭包依赖束（Ring 1 行树化批——管道 gate 落点/可写根推导器〔safety 同源产物，宿主构造〕/工作区活取值） */
  readonly toolsDeps: ToolsPluginDeps;
  /** 工作区根（项目归属键活取值） */
  readonly workspace: () => string;
  /** in-process 真工厂（subagent 官方件闭包注入——app/subagent-factory.ts 产物） */
  readonly subagentFactory?: InProcessChildFactory;
  /** 父会话活引用（委派工具 start 时取 ownerSessionId——结算通知路由键；goal 取当前会话 id） */
  readonly getSession: () => Session | undefined;
  /** boot 是否续接既有会话（session_start origin=resume——goal active 行降级触发器）。惰性取值：chat 件（首行）装载绑定会话后回写，goal apply 期读必居值 */
  readonly wasResumed: () => boolean;
  /**
   * chat 对话应用件模块（组合根 createChatPlugin 产物——默认层首行）：会话
   * 选择/驱动构造/ctx.agent provide 全在件内；无持久层时件自降级空转（装载
   * 面完好——诊断树不断链）。恒传入（件可卸靠 overlay 禁用行，不靠缺注）
   */
  readonly chat: BuiltinPluginModule;
}

/**
 * 构造官方件注册表（loadComposition 第二参——`builtin:` 行的唯一解析面）。
 * 时序上后于 Persistence.open（store 是其产物）；迁移链另出（本文件
 * collectBuiltinMigrations——assembly 聚合）。
 */
export function createBuiltinRegistry(opts: BuiltinRegistryOptions): BuiltinPluginRegistry {
  return {
    // chat 对话应用件（官方默认层首行——应用面第一纵切）
    'builtin:chat': opts.chat,
    'builtin:memory': createMemoryPlugin({
      ...(opts.store ? { store: opts.store } : {}),
      workspace: opts.workspace,
    }),
    // subagent 官方件（官方默认层第三行）：工厂缺省不注册（诊断面可省装配），
    // 默认装配恒传——组合根 createSubagentChildFactory 闭包活资源
    ...(opts.subagentFactory
      ? {
          'builtin:subagent': createSubagentPlugin({
            factory: opts.subagentFactory,
            getSession: opts.getSession,
          }),
        }
      : {}),
    // goal 官方件（官方默认层第四行，Ring 2 编排域）：连接随 persist 走（缺省
    // 降级 warn 空转）；wasResumed 惰性取值触发 boot 降级（active ⇒ needs-resume），
    // 'agent' 走 optionalInject（chat 件未装载时缺供降级，不阻激活）
    'builtin:goal': createGoalPlugin({
      ...(opts.goalConnection ? { connection: opts.goalConnection } : {}),
      getSessionId: () => opts.getSession()?.header.sessionId,
      wasResumed: opts.wasResumed,
    }),
    // scheduler 官方件（官方默认层第五行，tick 第一刀——内核边界篇 §4.1 席 13）：
    // 连接与 gate 判据/runner 全闭包注入（spawn 组装在 app/scheduler-runner.ts）；
    // 无持久层时空转，无 runner（诊断装配）时 /tick run 报不可用、表面照常
    ...(opts.schedulerDeps
      ? {
          'builtin:scheduler': createSchedulerPlugin({
            ...(opts.goalConnection ? { connection: opts.goalConnection } : {}),
            ...opts.schedulerDeps,
          }),
        }
      : {}),
    // mcp 官方件（官方默认层第六行，stdio-only 客户端桥第一刀——契约篇 §6.6）：
    // spawn/kill 经闭包注入（组合根 app/mcp-spawn.ts——mcp 结构上不见 exec）；
    // servers 空时件惰性无害零 spawn——恒注册（卸行靠 overlay 禁用）
    'builtin:mcp': createMcpPlugin(opts.mcpDeps),
    // web 官方件（第八行，契约篇 §1.5.2 web 刀）：fetch 工具 + ctx.fetch 服务 +
    // SSRF 五卫生件一批三件——零宿主资源闭包（最简官方件形态）；恒注册
    //（config.fetch:false 只关模型面工具，服务面恒在——「有但省」变体二）
    'builtin:web': createWebPlugin(opts.webOverrides),
    // tools 官方件（第七行 = Ring 1 行树化起算行，契约篇 §5.1 节奏表——**必备行**
    // 非 Ring 2 可卸：overlay 禁用即启动断言拒启；可换实现引用不可禁用）：
    // 三段管道 + ctx.tools 服务 + fs/检索工具族。恒注册（缺注即 unresolved——
    // Ring 1 必备行断言拒启，诊断树也须见到此行）
    'builtin:tools': createToolsPlugin(opts.toolsDeps),
  };
}

/** 全部带表官方件的迁移链（assembly 拼业务链的唯一来源——新带表件在本函数追加一项） */
export function collectBuiltinMigrations(): MigrationSpec[] {
  return [...memoryMigrations, ...goalMigrations, ...schedulerMigrations];
}
