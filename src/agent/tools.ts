/**
 * L1 agent — 工具族类型（loop 的工具执行面，骨架篇 §2.2）。
 *
 * 注意分工：本文件只是「loop 能执行什么工具」的类型收口；参数 schema 校验、
 * 守门（approval × sandbox）、超时与后处理在 tools 模块三段 waterfall
 * （tools_pre_execute / tools_execute / tools_post_execute）——loop 侧
 * toolExecution 回调的默认实现即调用三段管道。AgentTool.execute 的实现方
 * （tools 模块）负责参数校验后的执行；loop 只做查找 / prepareArguments /
 * 批级拦截（beforeToolCall）与结果合成。
 */

import type { ImageContent, TextContent, ToolCallBlock, Usage } from '../contracts/llm.js';

/**
 * 工具批执行策略（骨架篇 §2.2 toolExecution 回调的取值）。
 * - sequential：逐个「准备 → 执行 → 收尾」后下一个才开始（默认，拍板值）；
 * - parallel：全部先顺序预检，允许并行的工具并发执行，end 事件按完成序、
 *   结果消息按 assistant 源序。
 */
export type ToolExecutionMode = 'sequential' | 'parallel';

/** assistant 消息内的工具调用块（contracts/llm 的别名收口） */
export type AgentToolCall = ToolCallBlock;

/**
 * 工具执行结果（最终或部分）。
 * terminate 是早停提示：整批全部 finalize 结果都为 true 才触发批级早停（骨架篇 §2.2）。
 */
export interface AgentToolResult<TDetails = unknown> {
  /** 回给模型的文本/图片内容 */
  content: (TextContent | ImageContent)[];
  /** 供日志/UI 的结构化明细（不进主上下文） */
  details?: TDetails;
  /** 工具执行自身的用量（若可得上报） */
  usage?: Usage;
  /** 本结果引入且自此可用的工具名 */
  addedToolNames?: string[];
  /** 批级早停提示（整批一致才生效） */
  terminate?: boolean;
}

/** 工具进度回调（partial 结果流式上报；promise 结算后的调用被忽略） */
export type ToolUpdateCallback = (partialResult: AgentToolResult) => void;

/**
 * loop 可执行的工具定义。
 * execute 抛错 = 工具失败（loop 编码为 isError 结果，错误是数据）；
 * 参数 schema 校验由 tools 模块守门段承担（见文件头分工注）。
 */
export interface AgentTool {
  name: string;
  description: string;
  /** UI 展示标签（缺省用 name） */
  label?: string;
  /** JSON Schema 参数描述（TypeBox 产物；loop 不校验，守门段校验） */
  parameters: Record<string, unknown>;
  /** 工具级执行策略覆盖（缺省随 loop 配置；sequential 强制整批串行） */
  executionMode?: ToolExecutionMode;
  /** 原始参数兼容垫片（schema 校验前整形，须返回符合 parameters 的对象） */
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  /** 执行（失败直接 throw；进度经 onUpdate 上报；应对齐 signal 取消） */
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<AgentToolResult>;
}
