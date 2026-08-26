/**
 * L1 llm — 桶出口（模型标识解析 + Models 宿主 + StreamFn 适配 + 会话层恢复零件）。
 *
 * 模块边界（地基篇 §4）：依赖 contracts + context；pi-ai 裸导入仅本模块允许
 * （拓扑门禁钉死）。pi-ai 的 Store/Provider 类型在此再出口——app 组合根做
 * persist→pi-ai 适配时从这里取类型，不直接依赖 pi-ai。
 */
export { parseModelSpec, formatModelId, resolveModel, type ModelSpec } from './model-id.js';
export { createLlmRuntime, type LlmRuntime, type LlmRuntimeOptions } from './runtime.js';
export {
  createLlmService,
  type CompleteRequest,
  type CompleteResult,
  type LlmService,
  type LlmServiceOptions,
} from './complete.js';
export { createStreamFn, type StreamFnDefaults } from './stream-fn.js';
/** per-provider 在飞计数器（S4 前置债批——装配构造一份、streamFn 与 complete 两出口共享） */
export { InFlightTracker, type InFlightSlot } from './inflight.js';
/** 第五键 berryagent/llm 注入物（pi-ai provider 工厂族背书导出，契约篇 §1.2 注记①） */
export { providerApiFace } from './provider-face.js';
export {
  classifyAssistantError,
  isContextOverflow,
  isRecoverableLength,
  isRetryableAssistantError,
  retryAssistantCall,
  type ErrorBucket,
  type RetryPolicy,
  type RetryCallbacks,
} from './recovery.js';
// pi-ai 注入面类型再出口（app 适配 persist 的两 Store / 插件注册 provider 用）
export type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  Models,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsStore,
  MutableModels,
  Provider,
} from '@earendil-works/pi-ai';
