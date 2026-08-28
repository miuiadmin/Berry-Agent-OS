/**
 * L3 mcp — 配置面与协议类型（契约篇 §6.6 第一刀，2026-08-26）。
 *
 * 服务器身份 = builtin:mcp 单行 config `servers` 的**键名**（键词法
 * `[A-Za-z0-9-]+`，`__` 与空白禁入——防击穿 `mcp__<server>__<tool>` 解析）；
 * 字段集对齐 codex McpServerConfig 经验清单。
 *
 * schema 构建走 contracts 再导出面（typebox 单实例纪律——mcp 不在
 * typebox 直连白名单，与应用同路取用）。
 */

import { Type } from '../contracts/typebox.js';

/** 服务器键词法：字母/数字/连字符（`__` 禁入——工具名分隔符） */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** 单服务器配置 schema（拒绝式——未知字段拒绝，overlay 覆盖整体 config） */
export const MCP_SERVER_CONFIG_SCHEMA = Type.Object({
  /** 服务器可执行文件——v1 只认绝对路径（相对路径在 connect 期拦 MCP_CONNECT_FAILED；npx 解析后置） */
  command: Type.String(),
  /** 命令行参数 */
  args: Type.Optional(Type.Array(Type.String())),
  /** set 显式 env 层（用户声明的键值直传子进程——可含真实凭证值，不经宿主翻译） */
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** 工具白名单（发现后过滤；与 disabled 同给时 enabled 优先收窄） */
  enabled_tools: Type.Optional(Type.Array(Type.String())),
  /** 工具黑名单（发现后过滤） */
  disabled_tools: Type.Optional(Type.Array(Type.String())),
  /** 启动握手超时秒（缺省 10——超时杀进程树，MCP_CONNECT_FAILED） */
  startup_timeout_sec: Type.Optional(Type.Number()),
  /** 逐调用超时秒（缺省 60——复用 TOOL_TIMEOUT，超时后子进程不杀） */
  tool_timeout_sec: Type.Optional(Type.Number()),
});

/** 件级配置 schema（行 config——servers 缺省为空 = 行惰性无害零 spawn） */
export const MCP_APP_CONFIG_SCHEMA = Type.Object({
  servers: Type.Optional(Type.Record(Type.String(), MCP_SERVER_CONFIG_SCHEMA)),
});

/** 单服务器配置（schema 校验后的运行时形态） */
export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly enabled_tools?: readonly string[];
  readonly disabled_tools?: readonly string[];
  readonly startup_timeout_sec?: number;
  readonly tool_timeout_sec?: number;
}

/* ---------------------------------------------------------------------------------- */
/* JSON-RPC / MCP 协议消息类型（stdio 行帧——单行一个 JSON 对象）                       */
/* ---------------------------------------------------------------------------------- */

/** 服务器发现回的单工具描述（MCP Tools/list 项——只取桥要用的字段） */
export interface McpRemoteTool {
  /** 工具名（服务器侧原名——注册为 mcp__<server>__<原名>） */
  readonly name: string;
  /** 给模型看的能力描述（原样透传，过注册面描述扫描） */
  readonly description?: string;
  /** 参数 JSON Schema（原样透传三段管道守门段——typebox 直喂执法） */
  readonly inputSchema?: object;
  /** 服务器注记（只认 readOnlyHint → effect 'read'；缺省 'write' fail-closed） */
  readonly annotations?: { readonly readOnlyHint?: boolean };
}

/** tools/call 返回（MCP CallToolResult——只取桥要用的字段） */
export interface McpCallResult {
  /** 内容块（text 原样进模型上下文；其他类型 v1 丢弃并注记） */
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  /** 服务器自报错误身份（true → 工具结果 isError） */
  readonly isError?: boolean;
}
