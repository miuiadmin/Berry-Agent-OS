/**
 * subagent 模块 — 桶出口（Job 注册表 + 子代理委派；地基篇模块表 #10）。
 *
 * 模块边界（拓扑白名单）：依赖 contracts + context + agent + session。
 * - 纵切一：Job 注册表（ctx.jobs）
 * - 纵切二：ctx.subagents 服务 + in-process provider（能力协商/Job 映射/预算帽/深度执法）
 */
export { createJobsService } from './jobs.js';
export { createSubagentsService } from './service.js';
export {
  createInProcessProvider,
  type InProcessChild,
  type InProcessChildFactory,
  type InProcessChildFactoryOptions,
  type InProcessProviderOptions,
} from './inprocess.js';
