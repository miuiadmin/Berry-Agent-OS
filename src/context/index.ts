/**
 * L1 context — 插件运行时模块出口（内核五件之一）。
 * 对外只暴露类型与工厂：实现类不导出（跨模块只能走 Context/ContextScope 契约面）。
 */
export { createContext, registerLiveEvent } from './context.js';
export { loadPlugins } from './loader.js';
export { createLogger } from './logger.js';
// canonical 工作区根（宿主共享原语——memory owner_key / skills 信任判定 /
// 未来 project 域键三处同源；project-aliases 重定向解非 git 回退脆性）
export { canonicalWorkspaceRoot, setProjectAliases } from './workspace.js';
// 调用链会话作用域（多应用并行 S1——骨架篇 §9.3 机制定案；chat 驱动边界写 / app 全局绑定面读）
export { runInSessionChain, chainSessionId } from './chain.js';
export type { Logger, LogFields, LogLevel, LogSink } from './logger.js';
export type { Context, ContextOptions, ContextScope, Disposer, EventHandler, OnOptions } from './types.js';
