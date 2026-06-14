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
import type { StreamBlockPayload, ToolBlock, TextBlock, ThinkingBlock, DelegationBlock, DelegationBlockState, ReviewBlock, OrchestrationBlock, TaskProgressBlock, Block } from '../contracts/message-blocks.js';
// 合成兜底语 marker 识别（runToolLoop 的 tool-limit/budget/error/abort 产出，需在 buildBlocks 追加而非替换正文）
import { isSyntheticFinalContent, SYNTHETIC_FINAL_CONTENT_MARKER } from '../llm/tool-caller.js';
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
   * 有序时间线（chronological）：按 block 到达顺序累积，buildBlocks 直接返回它（过滤空段/running）。
   * 取代旧的 5-bucket 拼接（delegation→thinking→tools→text→review）——现在委派/思考在前、
   * 文本段与工具按到达序穿插（思考→文字→工具→文字→…）、审核在末。对齐 Claude Code 时间线模型：
   * 整条响应是一个穿插序列，不是按类型堆。timeline API 按 seq 返回同序 → 刷新后穿插保留。
   */
  private timeline: Block[] = [];
  /** 当前 thinking block 引用（在 timeline 中）。onReasoningDelta 累积 text；buildBlocks 算 durationMs */
  private thinkingBlock: ThinkingBlock | null = null;
  /** 当前文本段引用（在 timeline 中）。工具到达时关闭（=null），下段文字开新段 → 文本按工具边界切段穿插 */
  private currentTextBlock: TextBlock | null = null;
  /** 当前文本段序号（live emit blockId = `${messageId}#text#${n}`，每段独立 → 前端 append 即穿插）；0=无当前段 */
  private currentTextSegNum = 0;
  private textSegCounter = 0;
  /** 思考计时（毫秒）：首个 reasoning delta 开始 / 首个文字或工具结束。buildBlocks 算 durationMs */
  private reasoningStartedAt: number | undefined;
  private reasoningEndedAt: number | undefined;
  /**
   * 本轮委派 block 引用（在 timeline 中，unshift 到最前作表头）。onDelegationComplete 原地推进终态。
   */
  private delegationBlock: DelegationBlock | undefined;
  /** 本轮 Brain 审核裁决 block 引用（在 timeline 末尾，turn 终态时 onReview push）。仅 modify/reject 落库。 */
  private reviewBlock: ReviewBlock | undefined;
  /** 已 emit 的 orchestration blockId（live-only 幂等防重，不进 timeline） */
  private emittedOrchestrationIds = new Set<string>();
  /** callId → {block 引用, startedAt}：onToolComplete 原地更新 timeline 中的 running tool（按引用 mutate） */
  private pendingTools = new Map<string, { block: ToolBlock; startedAt: number }>();

  /**
   * 流式 text/thinking delta 合并缓冲（性能优化：逐 token emit → 30ms 窗口合并）。
   * onTextDelta/onReasoningDelta 累积到此，scheduleFlush 定时 flushPendingDeltas emit 合并 delta；
   * disposeBlockCollector / closeTextSegment 强制 flush（turn 终态 / 工具切段时不丢尾部 delta）。
   * buffer 只管 live emit 合批；timeline 里的 text/thinking block 持有全文（落库用），两条链路独立。
   */
  private textBuffer = '';
  private reasoningBuffer = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** delta 合并窗口（毫秒）：吸收 LLM SSE 突发帧，端到端 +30ms 不可感知 */
  private static readonly FLUSH_INTERVAL_MS = 30;

  constructor(
    private readonly sessionId: string,
    private readonly taskId: string,
    private readonly correlationId: string | undefined,
    private readonly emit: BlockEmitter = defaultEmit,
  ) {
    this.messageId = genId('msg');
  }

  /**
   * text 增量：累积到当前文本段（无则开新段，push 进 timeline），并进 30ms 合并缓冲 emit。
   * 首段文字标记思考结束（reasoningEndedAt）。工具到达后 currentTextBlock 已被 closeTextSegment 置空，
   * 故工具后的首段文字会开新段 → 文本按工具边界切段，与工具穿插。
   */
  onTextDelta(text: string): void {
    if (!text) return;
    this.textBuffer += text;
    if (!this.currentTextBlock) {
      this.textSegCounter++;
      this.currentTextSegNum = this.textSegCounter;
      // id = 段 blockId（与 flushPendingDeltas emit 一致），持久化后重连可匹配 → 防 restore 重复建块
      this.currentTextBlock = { type: 'text', id: `${this.messageId}#text#${this.textSegCounter}`, text: '' };
      this.timeline.push(this.currentTextBlock);
    }
    this.currentTextBlock.text += text;
    this.markReasoningEnd();
    this.scheduleFlush();
  }

  /**
   * reasoning 增量：累积到 thinking block（首次创建并记 startedAt，push 进 timeline），并进缓冲 emit。
   * reasoning 通常在文字/工具前到达 → thinking block 落在 timeline 前部（委派之后）。
   */
  onReasoningDelta(text: string): void {
    if (!text) return;
    this.reasoningBuffer += text;
    if (!this.thinkingBlock) {
      if (this.reasoningStartedAt === undefined) this.reasoningStartedAt = Date.now();
      // id = thinking blockId（与 flushPendingDeltas emit 一致），持久化后重连可匹配
      this.thinkingBlock = { type: 'thinking', id: `${this.messageId}#thinking`, text: '' };
      this.timeline.push(this.thinkingBlock);
    }
    this.thinkingBlock.text += text;
    this.scheduleFlush();
  }

  /**
   * 标记思考结束：首个文字或工具到达时记一次 reasoningEndedAt，并 emit 一个 thinking「替换」事件
   * （携带 durationMs）——前端 applyBlockToBlocks 据 blockId 整体替换，使「思考了 Ns」计时在 live
   * 流式结束瞬间即可显示（不必等 buildBlocks 落库 + 刷新）。buildBlocks 落库时算同一 durationMs。
   */
  private markReasoningEnd(): void {
    if (this.thinkingBlock && this.reasoningEndedAt === undefined) {
      this.reasoningEndedAt = Date.now();
      // 先 flush 缓冲：把未 emit 的 reasoning/text 尾部 delta 先发出（前端 append 到位），
      // 再 emit thinking 替换（携带完整 text + durationMs，覆盖 = 同文本 + 加计时，不重复 append）。
      // 若改为清空 buffer 会丢尾部 delta（破坏「不丢字符」）；若不 flush 直接 replace 会与后续 delta 重复。
      this.flushPendingDeltas();
      const durationMs = this.reasoningStartedAt !== undefined
        ? Math.max(0, this.reasoningEndedAt - this.reasoningStartedAt)
        : undefined;
      this.emit({
        sessionId: this.sessionId,
        messageId: this.messageId,
        blockId: `${this.messageId}#thinking`,
        blockType: 'thinking',
        block: { ...this.thinkingBlock, durationMs },
        ts: this.reasoningEndedAt,
        taskId: this.taskId,
        correlationId: this.correlationId,
      });
    }
  }

  /**
   * 关闭当前文本段：先 flushPendingDeltas（把工具前的缓冲文本作为当前段 emit），
   * 再清当前段引用（下段文字开新段）。工具/delegation 到达前调用，确保文本按工具边界切段。
   */
  private closeTextSegment(): void {
    this.flushPendingDeltas();
    this.currentTextBlock = null;
    this.currentTextSegNum = 0;
  }

  /**
   * 幂等调度 flush：timer 在等时不重复调度（参考 streaming-flusher 模式）。
   * 仅在有 delta 到达时启动 timer，无 delta 不空跑。
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPendingDeltas();
    }, BlockCollector.FLUSH_INTERVAL_MS);
  }

  /**
   * 冲刷累积的 text/reasoning delta：双 buffer 快照后立即清空（防回调期间新 delta 丢失），
   * text/reasoning 各 emit 一个合并 delta。开头 clearTimeout 自清理——disposeBlockCollector /
   * closeTextSegment 可直接调用，无需额外清 timer。
   *
   * text blockId 段感知：`${messageId}#text#${currentTextSegNum}`——每段独立 blockId，
   * 前端 applyBlockToBlocks 按首次到达 append → 文本段与工具穿插（不再单一 #text 全文一块）。
   * thinking blockId 固定 `${messageId}#thinking`（一轮一个思考块）。
   */
  flushPendingDeltas(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const text = this.textBuffer;
    const reasoning = this.reasoningBuffer;
    this.textBuffer = '';
    this.reasoningBuffer = '';
    if (!text && !reasoning) return;
    const ts = Date.now();
    if (text) {
      this.emit({ sessionId: this.sessionId, messageId: this.messageId, blockId: `${this.messageId}#text#${this.currentTextSegNum}`, blockType: 'text', delta: text, ts, taskId: this.taskId, correlationId: this.correlationId });
    }
    if (reasoning) {
      this.emit({ sessionId: this.sessionId, messageId: this.messageId, blockId: `${this.messageId}#thinking`, blockType: 'thinking', delta: reasoning, ts, taskId: this.taskId, correlationId: this.correlationId });
    }
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
    // 工具到达：关闭当前文本段（文本按工具边界切段穿插）+ 标记思考结束
    this.closeTextSegment();
    this.markReasoningEnd();
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
    // push 进 timeline（chronological 位——在已关闭的文本段之后）；buildBlocks 过滤终态时保留
    this.timeline.push(block);
  }

  /**
   * 工具启动（daemon / 外部 driver 路径：tool_call / tool_running 事件）。
   *
   * 与 {@link onToolCall}（task.telemetry 一次性 call+result，块出生即终态）互补：本方法处理
   * callId 配对的分离事件流——daemon/外部 agent 先发 call（toolName+input）后发 result（output+success），
   * 两事件按 callId 配对。emit 一个 running 态 tool block（前端可见"运行中"），按 callId 暂存 block 引用，
   * 等 {@link onToolComplete} 原地回填结果推进状态机。
   *
   * running tool push 进 timeline（chronological 位——在已关闭文本段之后）；buildBlocks 过滤掉 running
   * （只持久化终态），故 daemon 崩溃不留永驻 running 幽灵 block，同时位置正确（工具在它出现的时刻切段文本）。
   *
   * @param opts.callId   工具调用 id（跨事件配对的幂等键）
   * @param opts.toolName 工具名（MCP 形如 mcp__server__tool）
   * @param opts.input    调用入参（结构化对象；持久化前由调用方 redact）
   * @param opts.ts       事件时间戳（与 complete 配对算 durationMs；缺省取当前）
   */
  onToolStart(opts: { callId: string; toolName: string; input?: unknown; ts?: number }): void {
    const blockId = `${this.messageId}#tool#${opts.callId}`;
    // 幂等防重：timeline 已有同 blockId 工具（重复 start / 孤儿 complete 先到）→ 不新建，防重复工具块卡 running
    if (this.timeline.some((b) => b.type === 'tool' && b.id === blockId)) return;
    // 工具到达：关闭当前文本段（切段穿插）+ 标记思考结束
    this.closeTextSegment();
    this.markReasoningEnd();
    const startedAt = opts.ts ?? Date.now();
    const block: ToolBlock = {
      type: 'tool',
      id: blockId,
      name: opts.toolName,
      input: opts.input ?? {},
      state: 'running',
    };
    // 暂存 block 引用：onToolComplete 按引用原地更新为终态（timeline 中同位置）
    this.pendingTools.set(opts.callId, { block, startedAt });
    this.timeline.push(block);
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
  }

  /**
   * 工具完成（daemon / 外部 driver 路径：tool_result / tool_completed / tool_failed 事件）。
   *
   * 按 callId 回查 {@link onToolStart} 暂存的 block 引用 + startedAt，原地更新该 block 为终态
   * （completed/failed，回填 output/error，按 start→complete 时间差算 durationMs）。timeline 中该工具
   * 保持在原位（chronological 不变），buildBlocks 过滤后保留此终态块。
   *
   * 容错（fail-open）：若 complete 先于 start 到达（事件乱序 / start 丢失），无 pending 引用——
   * 降级为 toolName='unknown' 的一次性终态块 push 到 timeline 当前位（closeTextSegment 之后），
   * 保住"工具卡片可见"，durationMs 留 undefined（前端 formatDurationMs 兜底"—"）。
   *
   * @param opts.callId  与 onToolStart 同一 callId（配对键）
   * @param opts.output  工具结果文本（结构化 JSON 或原始字符串）
   * @param opts.success 是否成功（false → state=failed，output 同时写入 error）
   * @param opts.ts      事件时间戳（与 startedAt 配对算耗时）
   */
  onToolComplete(opts: { callId: string; output?: string; success: boolean; ts?: number }): void {
    const pending = this.pendingTools.get(opts.callId);
    const isError = !opts.success;
    const endTs = opts.ts ?? Date.now();
    const output = coercePayload(opts.output);

    if (pending) {
      // 原地更新 timeline 中的 running tool → 终态（按引用 mutate，位置不变）
      const b = pending.block;
      const durationMs = Math.max(0, endTs - pending.startedAt);
      b.state = isError ? 'failed' : 'completed';
      if (output !== undefined) b.output = output;
      if (isError && opts.output) b.error = opts.output;
      b.durationMs = durationMs;
      this.pendingTools.delete(opts.callId);
      this.emit({
        sessionId: this.sessionId, messageId: this.messageId, blockId: b.id, blockType: 'tool',
        block: b, state: b.state, ts: endTs, taskId: this.taskId, correlationId: this.correlationId,
      });
      return;
    }

    // 孤儿 complete（无 start）：fail-open 降级为 unknown 终态块，push 到当前位
    this.closeTextSegment();
    const blockId = `${this.messageId}#tool#${opts.callId}`;
    const block: ToolBlock = {
      type: 'tool',
      id: blockId,
      name: 'unknown',
      input: {},
      state: isError ? 'failed' : 'completed',
    };
    if (output !== undefined) block.output = output;
    if (isError && opts.output) block.error = opts.output;
    this.timeline.push(block);
    this.emit({
      sessionId: this.sessionId, messageId: this.messageId, blockId, blockType: 'tool',
      block, state: block.state, ts: endTs, taskId: this.taskId, correlationId: this.correlationId,
    });
  }

  /**
   * 委派启动（runtime / 外部 driver 路径：Brain 委派给子 agent）。
   *
   * 与 {@link onToolStart} 同源——DelegationBlock 也是状态机（running → completed/failed/interrupted）。
   * 创建一个 running 态 delegation block，emit stream.block（前端实时渲染「委派给 X agent」卡），
   * 并存入 {@link delegationBlock} 供 buildBlocks 落库（委派卡刷新后保留）。
   *
   * blockId = `${messageId}#delegation`：一轮一个委派，跨 start/complete 两事件幂等定位同一 block
   * （前端 applyBlockToBlocks 按 blockId 整体替换 running→终态，与 tool 同机制）。
   *
   * @param opts.targetAgent    目标 agent 名（runtime.name / decision.targetAgent）
   * @param opts.childSessionId 子会话 id（嵌套会话展开用；当前 runtime 路径暂无）
   */
  onDelegationStart(opts: { targetAgent: string; childSessionId?: string }): void {
    // 幂等防重：一轮一个委派，已有 delegationBlock（重入/重试）→ 不新建，防 timeline 重复委派块卡 running
    if (this.delegationBlock) return;
    const blockId = `${this.messageId}#delegation`;
    const block: DelegationBlock = {
      type: 'delegation',
      id: blockId,
      targetAgent: opts.targetAgent,
      state: 'running',
    };
    if (opts.childSessionId) block.childSessionId = opts.childSessionId;
    this.delegationBlock = block;
    // delegation = 表头，unshift 到 timeline 最前（委派在 event loop 前创建，天然首块）
    this.timeline.unshift(block);
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'delegation',
      block,
      state: 'running',
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /**
   * 委派终态（runtime / 外部 driver 路径：execution_completed / failed / cancelled）。
   *
   * 推进 delegation block 状态机到终态（completed / failed / interrupted），可选回填 summary。
   * emit 完整终态 block——前端按 blockId 整体替换 running 卡为终态卡（与 onToolComplete 机制一致）。
   *
   * fail-open：无对应 start（理论上不会发生——start 在 collector 创建后立即调用）则 no-op，
   * 不凭空造 block（缺 targetAgent 无法组装有意义的委派卡）。
   *
   * @param opts.state   终态（completed / failed / interrupted）
   * @param opts.summary 委派摘要 / 最终产出（可选；runtime 路径产出已由 text block 承载，通常省略避免重复）
   */
  onDelegationComplete(opts: { state: DelegationBlockState; summary?: string }): void {
    if (!this.delegationBlock) return; // fail-open：无 start 则缺 targetAgent，无法组装
    this.delegationBlock = { ...this.delegationBlock, state: opts.state };
    if (opts.summary !== undefined) this.delegationBlock.summary = opts.summary;
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId: this.delegationBlock.id,
      blockType: 'delegation',
      block: this.delegationBlock,
      state: opts.state,
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /**
   * Brain 审核裁决（conversation agent final.response 路径：modify / reject）。
   *
   * ReviewBlock 出生即终态——无状态机（审核裁决不像工具/委派有 running 中间态），与 onToolCall 同形。
   * 存入 {@link reviewBlock} 供 buildBlocks 落库（审核裁决刷新后保留——前端从 message_blocks 的 review
   * block 投影 reviewVerdict，徽章刷新不丢）。
   *
   * emit stream.block（blockType='review'）——前端 applyBlockToBlocks 暂无 review 分支时为 no-op
   * （实时渲染仍走既有 review_info 事件）；持久化是本方法的核心目的。仅 modify/reject 调用
   * （approve 不显示徽章，且自动批准居多，落库会误导「发生过真实审核」）。
   *
   * @param opts.verdict       审核裁决（modify / reject）
   * @param opts.reason        裁决理由（reject 原因 / modify 说明）
   * @param opts.originalDraft modify 时的初稿（前端 diff / 一键还原用）
   */
  onReview(opts: { verdict: ReviewBlock['verdict']; reason?: string; originalDraft?: string }): void {
    const blockId = `${this.messageId}#review`;
    const block: ReviewBlock = { type: 'review', verdict: opts.verdict };
    if (opts.reason) block.reason = opts.reason;
    if (opts.originalDraft) block.originalDraft = opts.originalDraft;
    this.reviewBlock = block;
    // review = 末尾（turn 终态 onReview 时 push，排在正文之后）
    this.timeline.push(block);
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'review',
      block,
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /**
   * Brain 编排动作（brain.correction 纠偏 / signal_intervention 介入 / checker.dispatch 派审）→ 内联 orchestration block。
   *
   * live-only：出生即终态（无状态机），emit stream.block 供前端实时显示「Brain 对 X agent 做了纠偏/介入」
   * 编排卡（与工具/委派卡同范式穿插）；**不进 timeline**（不落库）→ 刷新后不保留。有意取舍：编排动作是
   * 「正在发生」的瞬时指示，落库需重建 message_blocks 表改 block_type CHECK（核心表风险高），价值不抵风险。
   *
   * 幂等：同 action+createdAt 的重复编排事件不重建（EventBus 多订阅可能重复触发）。
   * 调用方应自行 peek 守卫（mission 路径无 collector 时静默跳过，编排块非强制）。
   *
   * @param opts.action    编排事件类型
   * @param opts.target    目标 agent
   * @param opts.severity  严重度（correction / signal_intervention）
   * @param opts.detail    指令/原因摘要
   * @param opts.createdAt 事件时间戳（幂等键组成 + 排序用）
   */
  onOrchestration(opts: {
    action: 'correction' | 'signal_intervention' | 'checker_dispatch';
    target?: string;
    severity?: 'low' | 'medium' | 'high';
    detail?: string;
    createdAt: number;
  }): void {
    const blockId = `${this.messageId}#orch#${opts.action}_${opts.createdAt}`;
    // 幂等防重：同动作同时间戳的重复编排事件不重建
    if (this.emittedOrchestrationIds.has(blockId)) return;
    this.emittedOrchestrationIds.add(blockId);
    const block: OrchestrationBlock = { type: 'orchestration', id: blockId, action: opts.action };
    if (opts.target) block.target = opts.target;
    if (opts.severity) block.severity = opts.severity;
    if (opts.detail) block.detail = opts.detail;
    // ⚠️ live-only：只 emit，不 push 进 timeline → buildBlocks 落库时不含编排块（避开 block_type CHECK）
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'orchestration',
      block,
      ts: opts.createdAt,
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /**
   * 任务进展卡 block（§14.5 主界面：会自己生长的 block，让用户在对话里感知任务板推进）。
   *
   * live-only：稳定 blockId（`${messageId}#taskprog`），同板多次更新 upsert 同一块（非重复建），
   * 不进 timeline（不落库，避开 block_type CHECK）。由 board-projection 在每次板活动后据
   * getBoardContext 投影调此 emit——collector 知道 messageId，桥接 board（taskId）→ chat 消息块。
   *
   * @param opts  板元数据 + 近期活动摘要（由 board-projection 从 getBoardContext 派生）
   */
  onTaskProgress(opts: {
    goal: string;
    status: string;
    leader?: string;
    members?: string[];
    turnCount?: number;
    maxTurns?: number;
    spawnDepth?: number;
    activitySummary?: string;
  }): void {
    // 稳定 blockId：同板多次活动 upsert 同一块（前端 applyBlockToBlocks 整体替换 → 卡片更新非堆叠）
    const blockId = `${this.messageId}#taskprog`;
    const block: TaskProgressBlock = { type: 'task_progress', id: blockId, goal: opts.goal, status: opts.status };
    if (opts.leader) block.leader = opts.leader;
    if (opts.members) block.members = opts.members;
    if (opts.turnCount != null) block.turnCount = opts.turnCount;
    if (opts.maxTurns != null) block.maxTurns = opts.maxTurns;
    if (opts.spawnDepth != null) block.spawnDepth = opts.spawnDepth;
    if (opts.activitySummary) block.activitySummary = opts.activitySummary;
    // ⚠️ live-only：只 emit，不 push 进 timeline → buildBlocks 落库时不含任务卡（避开 block_type CHECK）
    this.emit({
      sessionId: this.sessionId,
      messageId: this.messageId,
      blockId,
      blockType: 'task_progress',
      block,
      ts: Date.now(),
      taskId: this.taskId,
      correlationId: this.correlationId,
    });
  }

  /**
   * 构建本轮完整 Block[]——返回 timeline（chronological 穿插序），供调用方落库到 message_blocks。
   *
   * 对齐 Claude Code 时间线模型：delegation（表头）→ thinking（带 durationMs）→ 文字段↔工具穿插 → review（末尾），
   * 全部按到达序。timeline API 按 seq 返回同序 → 刷新后穿插保留。
   *
   * 过滤：空文本段（工具间无文字）+ running（非终态）工具（防崩溃幽灵 block）。
   * 兜底：timeline 无文本段但 opts.draftResponse 有内容（非流式直出 finalText，未走 onTextDelta）→ 末尾补 text block；
   * 无 thinking 但 opts.reasoning 有内容 → delegation 后补 thinking block。
   *
   * @param opts.reasoning       非流式 reasoning 兜底（timeline 已有 thinking 时忽略）
   * @param opts.draftResponse   非流式正文兜底（timeline 已有文本段时忽略）
   */
  buildBlocks(opts: { reasoning?: string; draftResponse?: string }): Block[] {
    // 冲刷尾部 delta（turn 终态不丢尾部文字/思考）
    this.flushPendingDeltas();
    // 思考耗时：首个 reasoning delta → 首个文字/工具（或 buildBlocks 时刻，若思考持续到最后）
    if (this.thinkingBlock && this.reasoningStartedAt !== undefined) {
      const end = this.reasoningEndedAt ?? Date.now();
      this.thinkingBlock.durationMs = Math.max(0, end - this.reasoningStartedAt);
    }
    // 过滤空文本段 + running 工具（只持久化终态）
    let result = this.timeline.filter((b) => {
      if (b.type === 'text') return b.text.length > 0;
      if (b.type === 'tool') return b.state === 'completed' || b.state === 'failed';
      return true; // thinking / delegation / review
    });
    // 文本兜底/补全/覆盖：draftResponse = 完整 persistContent（含 fail 标签 / Brain 改写等 turn 终态覆盖）
    if (opts.draftResponse) {
      const textSegs = result.filter((b): b is TextBlock => b.type === 'text');
      const joined = textSegs.map((s) => s.text).join('');
      if (isSyntheticFinalContent(opts.draftResponse)) {
        // 合成兜底语（tool-limit / budget / LLM 失败 / 取消 / 监督停止，由 [tool_loop:synthetic] marker 标识）：
        // 剥 marker 得错误标签，追加到流式正文末段（保留正文 + 显示「为何中断」）；无流式正文则标签作唯一文本块。
        // 集中在此（所有持久化路径都经 buildBlocks）——修「工具超限刷新丢正文」+ 防 marker 落库，
        // 覆盖 draft.response / final.response / handoff / approveReviewDegraded 等全部终态路径，不再依赖每个 handler 记得剥。
        const label = opts.draftResponse.slice(SYNTHETIC_FINAL_CONTENT_MARKER.length).trim();
        if (textSegs.length > 0) {
          textSegs[textSegs.length - 1].text += `\n\n${label}`;
        } else {
          const textBlock: Block = { type: 'text', text: label };
          const reviewIdx = result.findIndex((b) => b.type === 'review');
          if (reviewIdx >= 0) result.splice(reviewIdx, 0, textBlock);
          else result.push(textBlock);
        }
      } else if (textSegs.length === 0) {
        // 无流式文本段（非流式直出 finalText）→ 插 draftResponse 为 text block（review 前）
        const textBlock: Block = { type: 'text', text: opts.draftResponse };
        const reviewIdx = result.findIndex((b) => b.type === 'review');
        if (reviewIdx >= 0) result.splice(reviewIdx, 0, textBlock);
        else result.push(textBlock);
      } else if (opts.draftResponse.length > joined.length && opts.draftResponse.startsWith(joined)) {
        // draftResponse = 流式文本 + 尾部追加（fail 错误标签）→ 追加到末段，保持穿插结构不破坏
        textSegs[textSegs.length - 1].text += opts.draftResponse.slice(joined.length);
      } else if (opts.draftResponse !== joined) {
        // Brain 改写：draftResponse 与流式文本不一致（非前缀追加）→ 用 draftResponse 替换全部文本段
        // （单块置原首文本段位）。修「含工具流式响应 Brain modify 改写被静默吞掉」——徽章显示已改但文字仍是草稿。
        const firstTextIdx = result.findIndex((b) => b.type === 'text');
        const noText: Block[] = result.filter((b) => b.type !== 'text');
        const replaceBlock: Block = { type: 'text', text: opts.draftResponse };
        const insertAt = firstTextIdx >= 0 ? Math.min(firstTextIdx, noText.length) : noText.length;
        noText.splice(insertAt, 0, replaceBlock);
        result = noText;
      }
      // else: draftResponse == joined（正常流式）→ 不动
    }
    // 兜底：非流式 reasoning（无 onReasoningDelta 但 pending.reasoning 有内容）→ delegation 后补 thinking
    if (!result.some((b) => b.type === 'thinking') && opts.reasoning) {
      const insertAt = result.some((b) => b.type === 'delegation') ? 1 : 0;
      result.splice(insertAt, 0, { type: 'thinking', text: opts.reasoning });
    }
    return result;
  }

  /**
   * 取本轮已收集的终态 tool blocks（供审核链路 / 下游需要工具轨迹处取用）。
   *
   * 从 timeline 过滤终态（completed/failed）工具——running 态不返回（与 onToolStart「running 不持久化」一致）。
   * 取代旧 PendingRequest.toolCalls 双真相源；工具调用唯一真相在 collector（完整 ToolBlock）。
   */
  getToolBlocks(): ToolBlock[] {
    return this.timeline.filter(
      (b): b is ToolBlock => b.type === 'tool' && (b.state === 'completed' || b.state === 'failed'),
    );
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
  // turn 终态强制 flush 累积的 text/reasoning delta（尾部不丢）+ 清 timer（防泄漏）
  c?.flushPendingDeltas();
  return c;
}

/** 测试辅助：清空 registry（生产路径不需要） */
export function _clearBlockCollectorsForTest(): void {
  activeCollectors.clear();
}

/** 仅供类型完整性再导出（方便调用方 import） */
export type { Block };
