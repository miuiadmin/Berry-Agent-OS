/**
 * L4 chat — 模块公共面（对话应用官方件聚落，契约篇 §5.4）。
 *
 * 件聚落自组合根迁出（2026-08-24 铭牌批）：驱动本体（conversation）+ 件本体
 * （plugin，S1 工厂化：注册表/前台宿主 façade）+ durable 接线（durable）。
 * 组合根与跨模块消费方从本面取用一切——拓扑边：chat → contracts / context /
 * agent / session / persist / tools / safety（不 import llm：StreamFn 经
 * contracts 类型注入；不 import channels：FrontHost 结构兼容 ChannelHost）。
 */

export { ConversationDriver } from './conversation.js';
export type { DeliverOptions, DeliverChannel, ConversationDriverDeps, RunSettled } from './conversation.js';
export { createChatPlugin, CHAT_APP_ID } from './plugin.js';
export type {
  ChatPluginDeps,
  ChatControls,
  AgentServiceFace,
  SendUserMessageOptions,
  DriverEntry,
  DriverRegistry,
  FrontHost,
  ChatRuntime,
} from './plugin.js';
export { createDurableSinks, projectedToAgentMessages } from './durable.js';
export type { DurableSinks } from './durable.js';
