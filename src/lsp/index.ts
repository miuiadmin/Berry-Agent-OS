/**
 * L3 lsp — 桶导出（LSP 客户端桥第一刀，契约篇 §6.7）。
 */

/* 配置面与协议类型 */
export type {
  LspServerConfig,
  PublishDiagnosticsParams,
  LspDiagnostic,
  LspDocumentSymbol,
  LspLocation,
} from './types.js';
export {
  LSP_SERVER_NAME_PATTERN,
  LSP_SERVER_CONFIG_SCHEMA,
  LSP_APP_CONFIG_SCHEMA,
  LANGUAGE_ID_BY_EXT,
  languageIdOf,
} from './types.js';

/* Content-Length 头帧编解码（纯函数层——流式分块安全） */
export { encodeFrame, createFrameDecoder } from './framing.js';

/* 单服务器连接生命周期（握手 → 文档同步 → 诊断/符号请求 → 关停） */
export {
  connectLspServer,
  uriOf,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
  DISPOSE_GRACE_MS,
} from './client.js';
export type {
  LspConnectDeps,
  LspServerConnection,
  SpawnedProcess,
  JsonRpcLike,
  JsonRpcConnectionFactory,
} from './client.js';

/* 官方件 builtin:lsp */
export { createLspApp, CIRCUIT_BREAK_THRESHOLD, POST_WAIT_CAP_MS } from './app.js';
export type { LspAppDeps, ChildRegistryLike } from './app.js';
