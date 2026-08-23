/**
 * L1 llm — 桶出口（模型标识解析 + Models 宿主 + StreamFn 适配 + 会话层恢复零件）。
 *
 * 模块边界（地基篇 §4）：依赖 contracts + context；pi-ai 裸导入仅本模块允许
 * （拓扑门禁钉死）。pi-ai 的 Store/Provider 类型在此再出口——app 组合根做
 * persist→pi-ai 适配时从这里取类型，不直接依赖 pi-ai。
 */
export { parseModelSpec, formatModelId, resolveModel, type ModelSpec } from './model-id.js';
export { createLlmRuntime, type LlmRuntime, type LlmRuntimeOptions } from './runtime.js';
export { createStreamFn, type StreamFnDefaults } from './stream-fn.js';
export {
  isContextOverflow,
  isRecoverableLength,
  isRetryableAssistantError,
  retryAssistantCall,
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
