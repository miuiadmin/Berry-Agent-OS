/**
 * L2 tools — 工具模块桶导出（ctx.tools 服务 + 三段管道 + fs 工具族 + 观察态 CAS）。
 *
 * 依赖面（内核篇模块表 #7）：contracts, context——不依赖 agent/session/safety；
 * gate/decision durable 事件与 fence 可写根均经注入接线（app 装配层职责）。
 */

export type { ToolPipelineOptions, ToolPipelineExecutor } from './pipeline.js';
export { createToolPipeline } from './pipeline.js';
export type { ToolsService, ToolRegistryOptions } from './registry.js';
export { registerToolsService, defineTool } from './registry.js';
export type { ObservedState, WriteIntent } from './observed.js';
export { ObservedFiles, resolveWriteIntent, requireObservedForEdit, statVersion } from './observed.js';
export type { FsToolsOptions, FsTools } from './fs.js';
export { createFsTools } from './fs.js';
export type { SearchToolsOptions, SearchTools } from './search.js';
export { createSearchTools, globToRegExp } from './search.js';
export type { PatchOperation, PatchLine } from './apply-patch.js';
export { parseApplyPatch, applyUpdateLines, addLinesToContent } from './apply-patch.js';
