/**
 * L3 webui — 模块公开面（内核篇模块表 #25，契约篇 §6.8 Web 通道第一刀）。
 *
 * 单机回环 Web 通道后端：node:http 微路由 + SSE 活体流 + SPA 静态分发。
 * 消费面 = 组合根（builtins 注册表 `builtin:webui` 行 + WebuiAppDeps 闭包
 * 注入）；ring1 边 = contracts / context / channels。
 */

export {
  DEFAULT_WEBUI_HOST,
  DEFAULT_WEBUI_PORT,
  WEBUI_APP_CONFIG_SCHEMA,
  WEBUI_BODY_LIMIT_BYTES,
  WEBUI_MAX_CONNECTIONS,
  WEBUI_PING_INTERVAL_MS,
  WEBUI_WRITE_TIMEOUT_MS,
  type WebuiAppConfig,
  type WebuiAppDeps,
  type WebuiDisplayEnvelope,
  type WebuiDisplaySink,
  type WebuiNotifyPayload,
  type WebuiSessionBusPayload,
  type WebuiSessionSummary,
  type WebuiSseEnvelope,
  type WebuiSseKind,
  type WebuiStatusPayload,
} from './types.js';
export { WebuiChannel } from './channel.js';
export { createWebuiApp } from './app.js';
export { createWebuiServer, isLoopbackBindValue, type WebuiServerOptions } from './server.js';
