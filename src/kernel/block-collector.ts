/**
 * 对话内联 Block 收集器（设计文档/22）—— 把一轮对话的 telemetry 实时归一为 Block 模型，
 * emit stream.block 事件供前端内联渲染。
 *
 * 收敛点（核心价值）：Berry 有两套工具词表——
 *   - task.telemetry 的 tool_call / tool_result（内置 agent：conversation / module / code）
 *   - AgentEvent 的 tool_running / tool_completed / tool_failed（外部 driver：claude-code / opencode）
 * 两者都经 BlockCollector 归一为 ToolBlock 4 态机（pending→running→completed|failed）。
 * 这是对 AgentEventKind 已有语义的规范化，零新概念。
 *
 * 生命周期：一条 assistant 消息 = 一个 BlockCollector 实例（按 taskId 缓存于模块级 registry）。
 *   - 期3a（本文件）：纯 emit，不落库、不积累全文（前端按 delta 自行积累）。
 *   - 期3b：加 flush() 落库到 message_blocks（届时保留 toolBlocks 供持久化，并在 turn 结束 dispose）。
 *
 * 幂等键设计：
 *   - messageId：每轮 assistant 消息生成一次（genId），前端据此把同轮 block 聚到一个气泡。
 *   - text/thinking blockId：由 messageId 派生（#text / #thinking），前端首次 delta 惰性建块。
 *   - tool blockId：`${messageId}#tool#${toolName}#${seq}`（task.telemetry 无 callId，用出现序号合成稳定 id）。
 */

import { getEventBus } from './event-bus.js';
import { genId } from '../utils/id.js';
import type { StreamBlockPayload, ToolBlock, Block } from '../contracts/message-blocks.js';
/** stream.block emit 函数类型（默认走全局 EventBus；测试可注入捕获函数） */
export type BlockEmitter = (payload: StreamBlockPayload) => void;

/** 默认 emit：走全局 EventBus（与 task-flow 既有 stream.* emit 风格一致） */
const defaultEmit: BlockEmitter = (payload) => {
  getEventBus().emit('stream.block', payload);
};

/**
 * 把 task.telemetry 的 string 形 input/result 规整为 Block 的 unknown 载荷：
 * 尝试 JSON.parse（结构化），失败则原样返回字符串。空串返回 undefined（不写该字段）。
 */
function coercePayload(s: string | undefined | null): unknown {
  if (s == null || s === '') return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s; // 非结构化文本：保留原串
  }
}

/**
 * 单轮对话的 Block 收集器。按 taskId 创建，emit stream.block。
 * 期3a 为纯 emit（不积累全文 / 不落库）；内存占用 = O(toolName 种类) 的计数器。
 */
export class BlockCollector {
  /** 本轮 assistant 消息 id（前端聚合同轮 block 的 key） */
  readonly messageId: string;
  /** 每个工具名的出现序号（合成稳定 tool blockId；task.telemetry 无 callId） */
  private toolSeq = new Map<string, number>();
  /**
   * 本轮 tool block（落库用）。text/thinking 不在此保留——它们由调用方在 flush 时
   * 从 pending.draftResponse / pending.reasoning（单一事实源）注入，避免双份内存。
   */
  private toolBlocks: ToolBlock[] = [];

  constructor(
    private readonly sessionId: string,
    private readonly taskId: string,
    private readonly correlationId: string | undefined,
    private readonly emit: BlockEmitter = defaultEmit,
  ) {
    this.messageId = genId('msg');
  }

  /** text 增量：emit delta（前端首次 delta 在 blockId 惰性建 text 块） */
  onTextDelta(text: string): void {
    if (!text) return;
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId: `${this.messageId}#text`,
      blockType: 'text',
      delta: text,
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /** reasoning 增量：emit delta（前端惰性建 thinking 块） */
  onReasoningDelta(text: string): void {
    if (!text) return;
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId: `${this.messageId}#thinking`,
      blockType: 'thinking',
      delta: text,
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /**
   * 工具调用（task.telemetry 路径：call+result 一次性上报，块出生即终态）。
   * 合成稳定 blockId，emit 携带完整初始 Block 的创建事件（name/input/output 一次性给全）。
   */
  onToolCall(opts: {
    toolName: string;
    input?: string;
    result?: string;
    isError: boolean;
    durationMs?: number;
  }): void {
    const seq = (this.toolSeq.get(opts.toolName) ?? 0) + 1;
    this.toolSeq.set(opts.toolName, seq);
    const blockId = `${this.messageId}#tool#${opts.toolName}#${seq}`;

    // 组装 ToolBlock：出生即终态（completed / failed）
    const block: ToolBlock = {
      type: 'tool',
      id: blockId,
      name: opts.toolName,
      input: coercePayload(opts.input) ?? {},
      state: opts.isError ? 'failed' : 'completed',
    };
    const output = coercePayload(opts.result);
    if (output !== undefined) block.output = output;
    if (opts.isError && opts.result) block.error = opts.result;
    if (opts.durationMs != null) block.durationMs = opts.durationMs;

    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'tool',
      block,
      state: block.state,
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
    // 保留供 flush 落库（tool 的 input/output 不在 draftResponse，必须由 collector 持有）
    this.toolBlocks.push(block);
  }

  /**
   * 构建本轮完整 Block[]（顺序：thinking → tools → text），供调用方落库到 message_blocks。
   * text/thinking 从外部事实源（pending.draftResponse / reasoning）注入，避免 collector 重复持有全文。
   * 无任何内容时返回空数组（调用方据此跳过建空消息）。
   */
  buildBlocks(opts: { reasoning?: string; draftResponse?: string }): Block[] {
    const blocks: Block[] = [];
    if (opts.reasoning) blocks.push({ type: 'thinking', text: opts.reasoning });
    blocks.push(...this.toolBlocks);
    if (opts.draftResponse) blocks.push({ type: 'text', text: opts.draftResponse });
    return blocks;
  }
}

// ─── 模块级 registry（按 taskId 缓存，一轮对话一个 collector） ───

const activeCollectors = new Map<string, BlockCollector>();

/**
 * 取或创建 taskId 对应的 collector。同一 taskId 多次调用返回同一实例（保证 messageId 稳定）。
 * @param emit 测试注入用；生产路径用默认 EventBus emit
 */
export function getOrCreateBlockCollector(
  taskId: string,
  sessionId: string,
  correlationId: string | undefined,
  emit?: BlockEmitter,
): BlockCollector {
  let c = activeCollectors.get(taskId);
  if (!c) {
    c = new BlockCollector(sessionId, taskId, correlationId, emit);
    activeCollectors.set(taskId, c);
  }
  return c;
}

/**
 * 释放 taskId 的 collector（turn 结束调用）。期3a 仅从 map 移除（collector 无资源）；
 * 期3b 在此触发 flush 落库。
 */
export function disposeBlockCollector(taskId: string): BlockCollector | undefined {
  const c = activeCollectors.get(taskId);
  activeCollectors.delete(taskId);
  return c;
}

/** 测试辅助：清空 registry（生产路径不需要） */
export function _clearBlockCollectorsForTest(): void {
  activeCollectors.clear();
}

/** 仅供类型完整性再导出（方便调用方 import） */
export type { Block };
