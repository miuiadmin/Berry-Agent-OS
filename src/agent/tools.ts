/**
 * L1 agent — 工具族类型再出口（真身在 contracts/tools.ts）。
 *
 * 类型原定义于本文件，tools 模块（L2）落码时上移契约层——agent 与 tools
 * 的唯一会合点须住 contracts（内核篇模块表 #7；先例：llm 的 StreamFn
 * 三类型上移 contracts/llm.ts）。
 *
 * 注意分工：本文件只是「loop 能执行什么工具」的类型收口；参数 schema
 * 校验、守门（approval × sandbox）、超时与后处理在 tools 模块三段
 * waterfall（tools_pre_execute / tools_execute / tools_post_execute）。
 */

export type { AgentTool, AgentToolResult, ToolExecutionMode, ToolUpdateCallback } from '../contracts/tools.js';

import type { ToolCallBlock } from '../contracts/llm.js';

/** assistant 消息内的工具调用块（contracts/llm 的别名收口，agent 侧惯例名） */
export type AgentToolCall = ToolCallBlock;
