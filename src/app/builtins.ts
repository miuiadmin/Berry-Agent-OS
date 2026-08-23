/**
 * L5 app — 内置插件注册表（契约篇 §6.1 `builtin:` 前缀命名空间的宿主半边）。
 *
 * 组合根装配期构造：官方随包件（Ring 2 官方全家桶）的模块引用按 `builtin:<name>`
 * 收纳，交 loadComposition 作 `builtin:` 行的唯一解析面。注册表只此一处——
 * overlay 不可能借该前缀伪装官方件身份（查不到即 unresolved 响亮）。
 *
 * 依赖注入走闭包（官方内置件 = 宿主装配特权）：Store 公共读脸等宿主资源在
 * 构造期传入，不新开 ctx 服务名。
 */

import { createMemoryPlugin, type MemoryPluginStoreFace } from '../memory/index.js';
import { createSubagentPlugin } from './subagent-plugin.js';
import type { InProcessChildFactory } from '../subagent/inprocess.js';
import type { Session } from '../session/session.js';
import type { BuiltinPluginRegistry } from './composition.js';

/** 内置件构造参数（装配期可得的宿主资源；store 缺省 = persist:false 降级空转） */
export interface BuiltinRegistryOptions {
  /** Store 公共读脸（memory 内置件闭包注入）；无持久层时不传 */
  readonly store?: MemoryPluginStoreFace;
  /** 工作区根（项目归属键活取值） */
  readonly workspace: () => string;
  /** in-process 真工厂（subagent 内置件闭包注入——app/subagent-factory.ts 产物） */
  readonly subagentFactory?: InProcessChildFactory;
  /** 父会话活引用（委派工具 start 时取 ownerSessionId——结算通知路由键） */
  readonly getSession: () => Session | undefined;
}

/**
 * 构造内置插件注册表（loadComposition 第二参——`builtin:` 行的唯一解析面）。
 * 时序上后于 Persistence.open（store 是其产物）；迁移链另出（BUILTIN_MIGRATIONS）。
 */
export function createBuiltinRegistry(opts: BuiltinRegistryOptions): BuiltinPluginRegistry {
  return {
    'builtin:memory': createMemoryPlugin({
      ...(opts.store ? { store: opts.store } : {}),
      workspace: opts.workspace,
    }),
    // subagent 内置件（官方默认层第二行）：工厂缺省不注册（诊断面可省装配），
    // 默认装配恒传——组合根 createSubagentChildFactory 闭包活资源
    ...(opts.subagentFactory
      ? {
          'builtin:subagent': createSubagentPlugin({
            factory: opts.subagentFactory,
            getSession: opts.getSession,
          }),
        }
      : {}),
  };
}
