/**
 * subagent 模块 — 桶出口（Job 注册表 + 子代理委派；地基篇模块表 #10）。
 *
 * 模块边界（拓扑白名单）：依赖 contracts + context + agent + session——
 * 本纵切（一）只落 Job 注册表（contracts 类型 + context 服务挂点），
 * SubagentProvider 契约与 in-process provider 随纵切二/三就位。
 */
export { createJobsService } from './jobs.js';
