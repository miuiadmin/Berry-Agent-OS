/**
 * L3 mcp — 桶导出（stdio-only MCP 客户端桥第一刀，契约篇 §6.6）。
 */

/* 配置面与协议类型 */
export type { McpServerConfig, McpRemoteTool, McpCallResult } from './types.js';
export { MCP_SERVER_NAME_PATTERN, MCP_SERVER_CONFIG_SCHEMA, MCP_PLUGIN_CONFIG_SCHEMA } from './types.js';

/* 行帧 JSON-RPC 桥（纯协议层——测试可用流对零子进程覆盖） */
export { JsonRpcConnection } from './jsonrpc.js';
export type { JsonRpcConnectionOptions, JsonRpcTimeoutCode } from './jsonrpc.js';

/* 单服务器连接生命周期（握手 → 发现 → 调用 → 关停） */
export { connectMcpServer, MCP_PROTOCOL_VERSION } from './client.js';
export type { McpConnectDeps, McpServerConnection, SpawnedChild } from './client.js';

/* 子进程登记簿 + 启动期孤儿清扫 */
export { ChildRegistry } from './children.js';
export type { ChildRegistryEntry, SweepProbes, SweepReport } from './children.js';

/* 官方件 builtin:mcp */
export { createMcpPlugin, CATALOG_THRESHOLD } from './plugin.js';
export type { McpPluginDeps } from './plugin.js';
