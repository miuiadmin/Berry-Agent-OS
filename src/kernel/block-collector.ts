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
   * 按 callId 配对的待完成工具（daemon / 外部 driver 路径：call 与 result 分离到达）。
   * key=callId，value=创建事件携带的 toolName/input/起始时间——result 事件无 toolName，
   * 必须回查此表才能组装完整终态 block。complete 时删除条目（配对完成即释放）。
   */
  private pendingTools = new Map<string, { toolName: string; blockId: string; input: unknown; startedAt: number }>();

  /**
   * 工具启动（daemon / 外部 driver 路径：tool_call / tool_running 事件）。
   *
   * 与 {@link onToolCall}（task.telemetry 一次性 call+result，块出生即终态）互补：本方法处理
   * callId 配对的分离事件流——daemon/外部 agent 先发 call（toolName+input）后发 result（output+success），
   * 两事件按 callId 配对。emit 一个 running 态 tool block（前端可见"运行中"），按 callId 暂存，
   * 等 {@link onToolComplete} 回填结果并推进状态机。
   *
   * blockId = `${messageId}#tool#${callId}`：跨 start/complete 两事件幂等定位同一 block，
   * 前端 applyBlockToBlocks 按 blockId upsert（running→completed 原地更新，不重复建块）。
   *
   * @param opts.callId   工具调用 id（跨事件配对的幂等键）
   * @param opts.toolName 工具名（MCP 形如 mcp__server__tool）
   * @param opts.input    调用入参（结构化对象；持久化前由调用方 redact）
   * @param opts.ts       事件时间戳（与 complete 配对算 durationMs；缺省取当前）
   */
  onToolStart(opts: { callId: string; toolName: string; input?: unknown; ts?: number }): void {
    const blockId = `${this.messageId}#tool#${opts.callId}`;
    const startedAt = opts.ts ?? Date.now();
    // 暂存：complete 事件无 toolName/input，必须从此回查才能组装完整终态 block
    this.pendingTools.set(opts.callId, { toolName: opts.toolName, blockId, input: opts.input ?? {}, startedAt });

    const block: ToolBlock = {
      type: 'tool',
      id: blockId,
      name: opts.toolName,
      input: opts.input ?? {},
      state: 'running',
    };
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'tool',
      block,
      state: 'running',
      ts: startedAt,
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
    // 注意：running 态不进 toolBlocks——只持久化终态（与 onToolCall 一致），
    // 避免 daemon 崩溃时留下永驻 running 的幽灵 block。
  }

  /**
   * 工具完成（daemon / 外部 driver 路径：tool_result / tool_completed / tool_failed 事件）。
   *
   * 按 callId 回查 {@link onToolStart} 暂存的 toolName/input（result 事件不带这些字段），
   * 组装完整终态 block 并推进状态机（completed/failed），同时按 start→complete 时间差算 durationMs。
   *
   * 容错（fail-open）：若 complete 先于 start 到达（事件乱序 / start 丢失），降级为
   * toolName='unknown'、input={} 的一次性终态块——保住"工具卡片可见"这一核心目标，
   * 不因配对缺失而整块丢失（durationMs 此时也无法计算，留 undefined，前端 formatDurationMs 兜底"—"）。
   *
   * @param opts.callId  与 onToolStart 同一 callId（配对键）
   * @param opts.output  工具结果文本（结构化 JSON 或原始字符串）
   * @param opts.success 是否成功（false → state=failed，output 同时写入 error）
   * @param opts.ts      事件时间戳（与 startedAt 配对算耗时）
   */
  onToolComplete(opts: { callId: string; output?: string; success: boolean; ts?: number }): void {
    const pending = this.pendingTools.get(opts.callId);
    const toolName = pending?.toolName ?? 'unknown';
    const blockId = pending?.blockId ?? `${this.messageId}#tool#${opts.callId}`;
    const input = pending?.input ?? {};
    if (pending) this.pendingTools.delete(opts.callId);

    const isError = !opts.success;
    const endTs = opts.ts ?? Date.now();
    // 有配对 start 才算耗时（乱序到达的孤儿 complete 无法计时）
    const durationMs = pending ? Math.max(0, endTs - pending.startedAt) : undefined;

    const block: ToolBlock = {
      type: 'tool',
      id: blockId,
      name: toolName,
      input,
      state: isError ? 'failed' : 'completed',
    };
    const output = coercePayload(opts.output);
    if (output !== undefined) block.output = output;
    if (isError && opts.output) block.error = opts.output;
    if (durationMs != null) block.durationMs = durationMs;

    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'tool',
      block,
      state: block.state,
      ts: endTs,
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
    // 保留终态 block 供 buildBlocks 落库（与 onToolCall 一致：只持久化终态）
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

  /**
   * 取本轮已收集的终态 tool blocks（供审核链路 / 下游需要工具轨迹处取用）。
   *
   * 取代旧 PendingRequest.toolCalls（简化的 {name,input,result}[] 双真相源）——
   * 消灭持久化双轨制后，工具调用的唯一真相在 collector（完整 ToolBlock：state/output/durationMs/error）。
   * 注意：仅返回已终态（completed/failed）的工具；running 态不进 toolBlocks（见 onToolStart 注释）。
   */
  getToolBlocks(): ToolBlock[] {
    return this.toolBlocks;
  }
}

// ─── 模块级 registry（按 turn key 缓存，一轮对话一个 collector） ───
//
// key 在消灭双轨制后 = correlationId（turn 的天然标识，贯穿入口→complete/fail）。
// 期1-7 过渡期 key = taskId（task-flow）/ delegationId（委派），消灭双轨制时统一切到 correlationId，
// 使 handoff（conversation→目标 agent）天然共享同一 collector/messageId。

const activeCollectors = new Map<string, BlockCollector>();

/**
 * 取或创建 key 对应的 collector。同一 key 多次调用返回同一实例（保证 messageId 稳定）。
 * @param key      collector 注册键（过渡期=taskId/delegationId；消灭双轨制后=correlationId）
 * @param emit     测试注入用；生产路径用默认 EventBus emit
 */
export function getOrCreateBlockCollector(
  key: string,
  sessionId: string,
  correlationId: string | undefined,
  emit?: BlockEmitter,
): BlockCollector {
  let c = activeCollectors.get(key);
  if (!c) {
    c = new BlockCollector(sessionId, key, correlationId, emit);
    activeCollectors.set(key, c);
  }
  return c;
}

/**
 * 窥取 key 对应的 collector（不从 registry 移除）。供 turn 终态收尾时取 collector 做 buildBlocks 落库。
 *
 * 与 {@link disposeBlockCollector} 的区别：peek 保留注册（handoff 链中途取工具轨迹 / 审核链路查看不销毁）；
 * dispose 才是真正的生命周期终结（turn 终态落库后调用，释放 collector）。消灭双轨制后，落库 = peek + buildBlocks，
 * 真正释放 = 末态 dispose（与 pending 生命周期对齐）。
 */
export function peekBlockCollector(key: string): BlockCollector | undefined {
  return activeCollectors.get(key);
}

/**
 * 释放 key 的 collector（turn 终态调用）：从 registry 移除并返回，调用方负责 buildBlocks 落库。
 * 注意：dispose 返回的 collector 仍持有 toolBlocks（未被销毁），调用方取 toolBlocks/getToolBlocks 后
 * 实例才随引用释放变为 GC 候选——不要丢弃返回值否则 toolBlocks 丢失（委派路径的历史 bug 根因）。
 */
export function disposeBlockCollector(key: string): BlockCollector | undefined {
  const c = activeCollectors.get(key);
  activeCollectors.delete(key);
  return c;
}

/** 测试辅助：清空 registry（生产路径不需要） */
export function _clearBlockCollectorsForTest(): void {
  activeCollectors.clear();
}

/** 仅供类型完整性再导出（方便调用方 import） */
export type { Block };
