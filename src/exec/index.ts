/**
 * L4 exec — 模块公共面（件聚落，第 18 模块，2026-08-25 exec 纵切）。
 *
 * 三件：spawn 管道（失败二分/进程组纪律/输出预算——两面向下共用）、
 * bash 工具件（模型工具面，窄参数 + 升权词汇首个消费者）、ctx.exec 服务
 * （宿主原语面，宽参数 + 同一条三段管道不旁路）+ environment 披露段
 * （宿主自留地首例）。
 *
 * 拓扑边：exec → contracts / context / safety / tools（tools 不 import exec——
 * bash def 在组合根注册，检索族双装配点先例）。
 */

/* spawn 管道（原语执行——bash 工具件与服务共用） */
export { runArgv, classifyDenials, OUTPUT_BUDGET_BYTES, killTree } from './spawn.js';
export type { RunArgvOptions, RunResult } from './spawn.js';

/* 子进程环境白名单（契约篇 §1.2 E 组执法面②） */
export { buildChildEnv, isEnvNameAllowlisted, isEnvNameForbidden } from './env.js';

/* bash 工具件（模型工具面） */
export { createBashTool } from './tool.js';
export type { BashToolOptions } from './tool.js';

/* ctx.exec 服务（宿主原语面——组合根 provide 'exec'） */
export { registerExecService } from './service.js';
export type { ExecServiceOptions } from './service.js';

/* environment 披露段（宿主自留地——组合根 boot 期注册） */
export { renderEnvironmentSection } from './environment.js';
export type { EnvironmentFacts } from './environment.js';
