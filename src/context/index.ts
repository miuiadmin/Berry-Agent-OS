/**
 * L1 context — 装载运行时模块出口（内核五件之一）。
 * 对外只暴露类型与工厂：实现类不导出（跨模块只能走 Context/ContextScope 契约面）。
 */
// D3 装载分面分区词汇单源（契约篇 §5.1，2026-08-29）：系统区 id 常量 + 应用区
// id 构造——assembly 锚 fork / loader 跨区行扇出 / fleet 单区 reload 过滤共取
export {
  SYSTEM_ZONE,
  appZoneId,
  createContext,
  eventDispatchStats,
  registerLiveEvent,
  snapshotHandlers,
  appendHandlers,
  tryResolveService,
} from './context.js';
export type { HandlerEntry } from './context.js';
export { loadApps } from './loader.js';
export { createLogger } from './logger.js';
// 令牌桶频率护栏共用件（契约篇 §1.6——emit 侧 per-scope 桶与本文件外 sessions
// 侧 per-session 桶同一机制：assembly 写面 #14 复用，两面包同码不同键可分辨）
export { RateLimiter } from './rate-limit.js';
export type { RateLimitParams } from './rate-limit.js';
// canonical 工作区根（宿主共享原语——memory owner_key / skills 信任判定 /
// 未来 project 域键三处同源；project-aliases 重定向解非 git 回退脆性）
export { canonicalWorkspaceRoot, setProjectAliases } from './workspace.js';
// 文本解码决策树 + 码页探测器（骨架篇 §7.5/§7.6，P1-3 挖矿 B11——tools/
// exec/skills/app 四消费面的公共底座件：fs read/edit 前置读、spawn 两流
// 终段解码、prompt 面读者三处同一棵树）
export { decodeText, peekLocalCodepageLabels, resolveLocalCodepageLabels } from './encoding.js';
export type { DecodedText, DecodeTextOptions, LocalCodepageLabels } from './encoding.js';
// NDJSON 行帧字节帽共享件（契约篇 §1.7 行帧卫生件①；遗漏大扫 20260903 runtime
// D1-1 收口成共享件——bridge port-stdio 与 mcp client 两消费面同源单点，
// 同形修复跨模块未同步的缺陷族结构性消灭；规范条款见契约篇 §6.6 行帧卫生同律）
export { LineByteGuard, DEFAULT_MAX_LINE_BYTES } from './line-guard.js';
export type { LineByteGuardOptions } from './line-guard.js';
// 调用链会话作用域 + 调用方身份链（多应用并行 S1——骨架篇 §9.3 机制定案；chat 驱动边界写 / app 全局绑定面读；
// caller 链 = 会话篇 §5.1 导入者归因——装载器/工具管道边界写，sessions 服务面读）
export { runInSessionChain, chainSessionId, runInCallerChain, chainCaller } from './chain.js';
export type { Logger, LogFields, LogLevel, LogSink } from './logger.js';
export type { Context, ContextOptions, ContextScope, Disposer, EventHandler, OnOptions } from './types.js';
