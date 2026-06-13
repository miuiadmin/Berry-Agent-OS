/**
 * 对话内联 Block 契约 —— 工具调用 / MCP / 委派嵌入对话流的核心类型。
 *
 * 设计目标（见 设计文档/22-对话内联统一.md）：对齐 Claude Code 的 content[] 与 OpenCode 的 parts[]，
 * 把"一条消息 = 有序 Block 数组"作为前端 / 事件 / 存储 / 渲染共同的事实契约。工具调用、MCP 调用、
 * 子智能体委派都是消息内的 Block，不再作为独立表 / 独立事件 / 独立面板存在。
 *
 * 分层关系（不要混淆）：
 *   - 本文件的 `Block`       = 对话模型层（存储 / 渲染 / 事件）。ToolBlock 是 4 态机，call+result 同一 block。
 *   - `ModelContentBlock`（model.ts）= LLM 线协议层（Anthropic 的 tool_use + 独立 tool_result）。
 *   两层之间由序列化适配器转换（Block → ModelContentBlock），仅序列化关注点，不互相污染。
 *
 * 持久化：Block[] 以规范化形态存于 messages + message_blocks 表（每行一个 block），
 * payload_json 字段即下方 BlockSchema 序列化后的 JSON（落盘前经 redactSecrets 清洗）。
 */

import { z } from 'zod';
import type { ReviewVerdict } from './review.js';

// ─── Block 类型判别字面量 ───

/** Block 的 type 判别值（与 message_blocks.block_type CHECK 约束一致） */
export type BlockType = 'text' | 'thinking' | 'tool' | 'delegation' | 'review';

// ─── ToolBlock 状态机（OpenCode 式：call + result 同一 block 的生命周期阶段） ───

/**
 * ToolBlock 状态机。覆盖普通工具与 MCP 工具（MCP 仅 name 形如 mcp__server__tool，机制同源）。
 * 推进路径：pending → running → completed | failed。
 * 与 src/kernel/runtime/drivers/external-driver.ts 的 AgentEventKind（tool_running/completed/failed）一一对应。
 */
export type ToolBlockState = 'pending' | 'running' | 'completed' | 'failed';

/** DelegationBlock 状态机（Brain→Code 等子智能体委派） */
export type DelegationBlockState = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

// ─── 各 Block 类型定义 ───

/** 纯文本块（消息正文 markdown） */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 推理过程块（可折叠，对应模型 thinking / reasoning） */
export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}

/**
 * 工具调用块。MCP 工具与普通工具同源，仅 name 形如 `mcp__<server>__<tool>`。
 * id 即 callId，跨 stream.block 事件幂等定位同一个 block；state 推进时只 UPDATE 该行 / 该 block。
 */
export interface ToolBlock {
  type: 'tool';
  /** callId，跨事件幂等键（message_blocks.id 也用此值） */
  id: string;
  /** 工具名（MCP 形如 mcp__server__tool） */
  name: string;
  /** 调用入参（已 redact） */
  input: unknown;
  /** 状态机当前态 */
  state: ToolBlockState;
  /** completed 态的结果（已 redact） */
  output?: unknown;
  /** failed 态的错误信息 */
  error?: string;
  /** 执行耗时（毫秒） */
  durationMs?: number;
}

/**
 * 子智能体委派块。内联在父对话里；子 agent 内部对话是可展开的嵌套会话（childSessionId）。
 * 对齐 Claude Code 的 task 工具：主线程看到委派 + 摘要，子工作可展开。
 */
export interface DelegationBlock {
  type: 'delegation';
  /** taskId / delegationId（幂等键） */
  id: string;
  /** 目标 agent 名 */
  targetAgent: string;
  /** 状态机当前态 */
  state: DelegationBlockState;
  /** 委派摘要 / 最终产出（已 redact） */
  summary?: string;
  /** 子会话 id（展开时拉嵌套 timeline 渲染子 agent 内部对话） */
  childSessionId?: string;
}

/** Brain 审核裁决块（保留 15.0 审核徽章能力） */
export interface ReviewBlock {
  type: 'review';
  verdict: ReviewVerdict;
  reason?: string;
  /** modify 时的初稿（用于 diff / 一键还原） */
  originalDraft?: string;
}

/**
 * 对话内容 Block 判别联合。一条消息由若干有序 Block 组成（对齐 Claude Code content[] / OpenCode parts[]）。
 * 渲染时 blocks.map(block => <BlockRenderer/>)；事件流以 stream.block 单事件族承载。
 */
export type Block = TextBlock | ThinkingBlock | ToolBlock | DelegationBlock | ReviewBlock;

// ─── Zod schema 镜像（WS 校验 / message_blocks.payload_json 序列化） ───

const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
});

const ToolBlockSchema = z.object({
  type: z.literal('tool'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  state: z.enum(['pending', 'running', 'completed', 'failed']),
  output: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
});

const DelegationBlockSchema = z.object({
  type: z.literal('delegation'),
  id: z.string(),
  targetAgent: z.string(),
  state: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted']),
  summary: z.string().optional(),
  childSessionId: z.string().optional(),
});

const ReviewBlockSchema = z.object({
  type: z.literal('review'),
  verdict: z.enum(['approve', 'modify', 'reject']),
  reason: z.string().optional(),
  originalDraft: z.string().optional(),
});

/** Block 判别联合 schema（按 type 判别） */
export const BlockSchema: z.ZodType<Block> = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolBlockSchema,
  DelegationBlockSchema,
  ReviewBlockSchema,
]);

// ─── stream.block 事件 payload ───

/**
 * stream.block 事件族的 payload。收敛旧的 stream.text_delta / stream.tool_call /
 * stream.tool_result / stream.reasoning_delta / agent.dialogue 到这一个事件。
 *
 * 前端按 blockId 幂等定位 block，按事件字段分支处理：
 *   - block 非空 → 块创建：在该 blockId 处建立完整 Block（tool 的 name/input、delegation 的
 *     targetAgent 等创建即定字段只在创建事件携带一次）
 *   - delta 非空 → 追加到 text/thinking block 的内容（流式增量；前端首次 delta 时惰性建块）
 *   - patch 非空 → 合并 state/output/error/summary 等可变字段（状态机推进 / 结果回填）
 *   - state 非空 → 推进 tool/delegation block 的状态机（patch.state 的简写）
 */
export interface StreamBlockPayload {
  /** 会话 id */
  sessionId: string;
  /** 该 block 所属消息 id（前端定位到 message 后在其 blocks 内查找） */
  messageId: string;
  /** block 幂等键（ToolBlock 即 callId）；同一 blockId 的多次事件按 ts 推进 */
  blockId: string;
  /** Block 类型，前端按此分支渲染 */
  blockType: BlockType;
  /**
   * 块创建事件携带的完整初始 Block。tool 的 name/input、delegation 的 targetAgent 等
   * "创建即定"字段只在创建事件里出现一次；后续事件用 patch/delta 推进。
   * text/thinking 无需创建事件（首次 delta 时前端惰性建块）。
   */
  block?: Block;
  /** tool/delegation 状态机推进的目标态（text/thinking 不用） */
  state?: ToolBlockState | DelegationBlockState;
  /** text/thinking 流式增量（按 blockId 追加，不替换） */
  delta?: string;
  /**
   * 状态推进 / 结果回填的局部 patch。前端浅合并到对应 block。
   * 用 Record 而非具体 Partial<Block>：跨判别分支的字段集合并，强类型化反而损失灵活性。
   */
  patch?: BlockPatch;
  /** 事件时间戳（毫秒） */
  ts: number;
  /** 关联任务 id（兼容现有 telemetry 追踪） */
  taskId?: string;
  /** 关联 correlation id（兼容现有 telemetry 追踪） */
  correlationId?: string;
}

/**
 * block 局部 patch：可推进的字段集合（状态 / 结果 / 错误 / 摘要 / 文本替换）。
 * 前端按需浅合并；后端只在状态推进或终态回填时携带相应字段。
 */
export interface BlockPatch {
  state?: ToolBlockState | DelegationBlockState;
  output?: unknown;
  error?: string;
  summary?: string;
  /** text/thinking 的整体替换（用于终态定稿，区别于增量 delta） */
  text?: string;
  durationMs?: number;
  targetAgent?: string;
  childSessionId?: string;
}

// ─── 辅助：block 生命周期判定 ───

/** tool/delegation block 是否处于终态（前端据此停止流式动画 / 心跳扫描） */
export function isBlockTerminal(block: Block): boolean {
  if (block.type === 'tool') return block.state === 'completed' || block.state === 'failed';
  if (block.type === 'delegation')
    return (
      block.state === 'completed' ||
      block.state === 'failed' ||
      block.state === 'interrupted'
    );
  // text/thinking/review 无状态机，视为即终态
  return true;
}

// ─── 辅助：ToolBlock → 字符串投影（审核/审计链路统一入口） ───

/**
 * unknown → 稳定字符串（{@link toolInputString} / {@link toolResultString} 共用）。
 * string 直通（避免对已字符串化入参二次 JSON.stringify 产生双重引号）；对象 JSON.stringify；
 * null/undefined → ''。**不 redact**（redact 是落库边界 `redactSecrets` 的单一职责）、**不截断**（调用方按需 slice）。
 */
function stringifyToolPayload(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

/**
 * ToolBlock 入参 → 字符串。ToolBlock.input 是 unknown（对象 / 字符串 / null），此处归一为字符串，
 * 供审核 prompt 拼装、审计落库前 redact、进化提取等下游消费。
 */
export function toolInputString(b: ToolBlock): string {
  return stringifyToolPayload(b.input);
}

/**
 * ToolBlock 结果 → 字符串：failed 态取 error，否则取 output（同 {@link stringifyToolPayload} 规则）。
 * 与 {@link toolInputString} 配对，覆盖审核/审计链路对「工具结果」的消费。
 */
export function toolResultString(b: ToolBlock): string {
  if (b.state === 'failed') return b.error ?? '';
  return stringifyToolPayload(b.output);
}
