/**
 * DialogueRouter — 智能体间对话的中转层。
 *
 * 职责：
 * 1. 创建/关闭对话，维护对话状态（内存）
 * 2. 路由 dialogue.send → 目标 Agent，dialogue.reply → 发起方
 * 3. 所有消息镜像持久化到 dialogue_messages 表
 * 4. 异步推送 dialogue.observe 给 Brain
 * 5. 超时守护（单轮 replyTimeoutMs 内未收到回复 → 超时信号）
 * 6. 为 streaming 注册 ephemeral taskId 到 SessionManager
 */

import type { Database } from 'better-sqlite3';
import type {
  DialogueMessagePayload,
  DialogueEndPayload,
  DialogueObservePayload,
  DialogueState,
  CreateDialogueParams,
} from '../contracts/dialogue.js';
import { DIALOGUE_DEFAULTS } from '../contracts/dialogue.js';
import type { SessionManager } from './session-manager.js';
import type { IpcChannel } from './ipc.js';
import type { ObservationRecorder } from './observation-recorder.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { getEventBus } from './event-bus.js';
import { AgentTimeoutError, AgentCrashError, AgentUnavailableError } from './errors.js';
import { safeSlice } from '../utils/safe-slice.js';

const logger = getLogger('dialogue-router');

export interface DialogueRouterDeps {
  db: Database;
  sessionManager: SessionManager;
  /** 获取目标 agent 的 IPC 通道 */
  getAgentIpc: (agentName: string) => IpcChannel | undefined;
  /** 获取 Brain agent 的 IPC 通道 */
  getBrainIpc: () => IpcChannel | undefined;
  /** 13.0 观察队列记录器（可选；提供时 dialogue.send/reply 会持久化到 brain_observations） */
  observationRecorder?: ObservationRecorder;
}

export class DialogueRouter {
  /** 活跃对话状态 */
  private dialogues = new Map<string, DialogueState>();
  /** dialogueId → 超时 timer */
  private replyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** dialogueId → 等待 reply 的 resolve/reject */
  private pendingReplies = new Map<string, {
    resolve: (msg: DialogueMessagePayload) => void;
    reject: (err: Error) => void;
  }>();
  /** 权限确认期间暂停的对话 */
  private pausedTimeouts = new Set<string>();
  /** correlationId → 该请求已开启的对话数（预算守护） */
  private dialogueCountByCorrelation = new Map<string, number>();
  /** 13.0 §13.3: target agent → 活跃 dialogueId 集合（per-target 并发上限） */
  private activeDialoguesByTarget = new Map<string, Set<string>>();

  private deps: DialogueRouterDeps;
  private insertStmt: import('better-sqlite3').Statement;

  constructor(deps: DialogueRouterDeps) {
    this.deps = deps;
    // INSERT OR REPLACE：retry 场景（同 dialogueId + 同 sequenceNumber）时覆盖旧记录
    this.insertStmt = deps.db.prepare(`
      INSERT OR REPLACE INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, context_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // 启动 sweepStale 定时器
    this.startSweep();
  }

  // ─────────────────────────────────────────────────────────────
  // 对话生命周期
  // ─────────────────────────────────────────────────────────────

  /** 获取对话状态 */
  getDialogue(dialogueId: string): DialogueState | undefined {
    return this.dialogues.get(dialogueId);
  }

  /** 注册外部已生成 dialogueId 的对话状态（Conversation 侧已生成 ID 时使用） */
  registerDialogue(dialogueId: string, params: CreateDialogueParams): DialogueState {
    // 预算守护：单次请求内对话数量限制
    const count = this.dialogueCountByCorrelation.get(params.correlationId) ?? 0;
    if (count >= DIALOGUE_DEFAULTS.maxDialoguesPerRequest) {
      throw new Error(`exceeded max dialogues per request (${DIALOGUE_DEFAULTS.maxDialoguesPerRequest})`);
    }
    this.dialogueCountByCorrelation.set(params.correlationId, count + 1);

    // 13.0 §13.3: per-target agent 并发上限（避免一个 agent 被多 worker 同时轰炸）
    const targetSet = this.activeDialoguesByTarget.get(params.target) ?? new Set<string>();
    if (targetSet.size >= DIALOGUE_DEFAULTS.maxDialoguesPerTarget) {
      throw new Error(
        `exceeded max dialogues per target agent (${params.target}: ${targetSet.size}/${DIALOGUE_DEFAULTS.maxDialoguesPerTarget})`,
      );
    }
    targetSet.add(dialogueId);
    this.activeDialoguesByTarget.set(params.target, targetSet);

    const state: DialogueState = {
      dialogueId,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      initiator: params.initiator,
      target: params.target,
      currentRound: 0,
      createdAt: Date.now(),
      status: 'active',
      totalChars: 0,
    };
    this.dialogues.set(dialogueId, state);
    logger.info({
      dialogueId,
      initiator: params.initiator,
      target: params.target,
      dialogueCount: count + 1,
      targetActiveCount: targetSet.size,
    }, 'dialogue:registered');
    return state;
  }

  /** 关闭对话，根据原因 reject pending request 并使用类型化错误 */
  closeDialogue(dialogueId: string, reason: DialogueEndPayload['reason']): void {
    const state = this.dialogues.get(dialogueId);
    if (!state) return;
    state.status = reason === 'completed' ? 'completed' : reason === 'timeout' ? 'timeout' : 'interrupted';
    this.clearReplyTimer(dialogueId);

    // 13.0 §13.3: 释放 per-target 并发槽位
    const targetSet = this.activeDialoguesByTarget.get(state.target);
    if (targetSet) {
      targetSet.delete(dialogueId);
      if (targetSet.size === 0) this.activeDialoguesByTarget.delete(state.target);
    }

    const pending = this.pendingReplies.get(dialogueId);
    if (pending) {
      this.pendingReplies.delete(dialogueId);
      // 根据关闭原因使用不同的错误类型，让调用方的 LLM 能做出合理决策
      if (reason === 'timeout') {
        pending.reject(new AgentTimeoutError(
          `dialogue timeout: ${state.target} did not reply within ${DIALOGUE_DEFAULTS.replyTimeoutMs}ms`,
          state.target,
          DIALOGUE_DEFAULTS.replyTimeoutMs,
        ));
      } else if (reason === 'agent_crashed') {
        pending.reject(new AgentCrashError(
          `dialogue aborted: ${state.target} process terminated`,
          state.target,
        ));
      } else {
        // 其他原因（interrupted / completed / budget_exceeded）用通用错误
        pending.reject(new Error(`dialogue closed: ${reason}`));
      }
    }
    // 通知 Brain 对话已结束
    const brainIpc = this.deps.getBrainIpc();
    if (brainIpc) {
      const endPayload: DialogueEndPayload = { dialogueId, reason };
      brainIpc.send('dialogue.end', 'brain', endPayload, dialogueId);
    }
    logger.info({ dialogueId, reason, rounds: state.currentRound }, 'dialogue:closed');
  }

  /** 获取 session 下所有活跃对话 */
  getActiveDialoguesForSession(sessionId: string): DialogueState[] {
    return [...this.dialogues.values()].filter(d => d.sessionId === sessionId && d.status === 'active');
  }

  /**
   * Agent 崩溃时拒绝所有等待该 Agent 回复的 pending request。
   *
   * 关键行为：不等 60s 超时，立即通知所有发起方该 Agent 已崩溃。
   * 发起方的 LLM 看到 AgentCrashError 后能做出合理决策（不重试，换路径）。
   *
   * @param agentName 崩溃的 Agent 名称
   * @returns 被拒绝的对话数量
   */
  rejectAllForAgent(agentName: string): number {
    let count = 0;
    for (const [dialogueId, state] of this.dialogues) {
      // 只处理该 agent 作为 target 且仍在活跃状态的对话
      if (state.target !== agentName || state.status !== 'active') continue;

      const pending = this.pendingReplies.get(dialogueId);
      if (pending) {
        this.pendingReplies.delete(dialogueId);
        this.clearReplyTimer(dialogueId);
        pending.reject(new AgentCrashError(
          `dialogue aborted: ${agentName} process terminated`,
          agentName,
        ));
        count++;
      }
      // 标记对话为 terminated 状态（不触发二次 reject）
      state.status = 'interrupted';

      logger.info({ dialogueId, target: agentName }, 'dialogue:rejected due to agent crash');
    }
    return count;
  }

  /** 检查指定 correlationId 是否存在与目标 agent 的对话（包括已完成/超时的） */
  hasDialogueForTarget(correlationId: string, targetAgent: string): boolean {
    return [...this.dialogues.values()].some(
      d => d.correlationId === correlationId && d.target === targetAgent,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 消息路由
  // ─────────────────────────────────────────────────────────────

  /**
   * 发送对话消息到目标 Agent（Conversation → Target）。
   * 返回一个 Promise，resolve 时收到 dialogue.reply。
   *
   * H1/H2: 不再接受 socket 参数。流式推送由 kernel 业务路径 emit 到 EventBus，
   * 由 WsEventBridge（src/web/）订阅 EventBus 并转发到 WS 客户端。
   */
  async sendMessage(msg: DialogueMessagePayload): Promise<DialogueMessagePayload> {
    const state = this.dialogues.get(msg.dialogueId);
    if (!state) throw new Error(`dialogue not found: ${msg.dialogueId}`);
    if (state.status !== 'active') throw new Error(`dialogue not active: ${msg.dialogueId} (${state.status})`);

    // 重入保护：同一 dialogue 不允许并发 send（上一轮 reply 到达前不能发下一轮）
    if (this.pendingReplies.has(msg.dialogueId)) {
      throw new Error(`dialogue ${msg.dialogueId} has pending reply, concurrent send not allowed`);
    }

    // 检查轮次限制
    if (state.currentRound >= DIALOGUE_DEFAULTS.maxRounds) {
      this.closeDialogue(msg.dialogueId, 'budget_exceeded');
      throw new Error(`dialogue exceeded max rounds (${DIALOGUE_DEFAULTS.maxRounds})`);
    }

    // 检查总字符数预算
    if (state.totalChars >= DIALOGUE_DEFAULTS.maxTotalChars) {
      this.closeDialogue(msg.dialogueId, 'budget_exceeded');
      throw new Error(`dialogue exceeded max total chars (${DIALOGUE_DEFAULTS.maxTotalChars})`);
    }

    // 累计 send 消息的字符数
    state.totalChars += msg.content.length;

    // 修正 sequenceNumber：Conversation 侧不维护精确序号，由 Kernel 统一分配
    msg.sequenceNumber = state.currentRound * 2;

    // 生成 ephemeral taskId 用于 streaming
    const ephemeralTaskId = genId('dtask');
    state.ephemeralTaskId = ephemeralTaskId;
    // H1/H2: 不再注册 taskSocket 映射。流式推送由 WsEventBridge 订阅 EventBus 转发。

    // 注入 context（ephemeralTaskId + sessionId 供 Code Agent 用）
    msg.context = {
      ...msg.context,
      _taskId: ephemeralTaskId,
      _sessionId: state.sessionId,
    };

    // 持久化 send 消息
    this.persistMessage(msg, state.sessionId, state.correlationId);

    // 推送 Brain 监听（异步，不等待）
    this.notifyBrain(msg, state);

    // 路由到目标 Agent
    const targetIpc = this.deps.getAgentIpc(state.target);
    if (!targetIpc) {
      throw new AgentUnavailableError(`target agent not available: ${state.target}`, state.target);
    }
    targetIpc.send('dialogue.send', state.target, msg, msg.dialogueId);

    // 等待 reply（带超时）
    return new Promise<DialogueMessagePayload>((resolve, reject) => {
      this.pendingReplies.set(msg.dialogueId, { resolve, reject });
      this.startReplyTimer(msg.dialogueId);
    });
  }

  /**
   * 处理目标 Agent 的回复（Target → Conversation）。
   * 由 Orchestrator 在收到 dialogue.reply IPC 时调用。
   */
  handleReply(msg: DialogueMessagePayload): void {
    const state = this.dialogues.get(msg.dialogueId);
    if (!state) {
      logger.warn({ dialogueId: msg.dialogueId }, 'dialogue:reply for unknown dialogue');
      return;
    }

    // 修正 sequenceNumber：reply 序号 = 当前轮次 * 2 + 1（send 是偶数，reply 是奇数）
    msg.sequenceNumber = state.currentRound * 2 + 1;

    // 持久化 reply
    this.persistMessage(msg, state.sessionId, state.correlationId);

    // 推送 Brain
    this.notifyBrain(msg, state);

    // 累计 reply 消息的字符数
    state.totalChars += msg.content.length;

    // 递增轮次
    state.currentRound++;

    // 清除超时 timer
    this.clearReplyTimer(msg.dialogueId);

    // resolve pending
    const pending = this.pendingReplies.get(msg.dialogueId);
    if (pending) {
      this.pendingReplies.delete(msg.dialogueId);
      pending.resolve(msg);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 超时管理
  // ─────────────────────────────────────────────────────────────

  /** 暂停超时计时（权限确认等待期间） */
  pauseTimeout(dialogueId: string): void {
    this.pausedTimeouts.add(dialogueId);
    this.clearReplyTimer(dialogueId);
  }

  /** 恢复超时计时 */
  resumeTimeout(dialogueId: string): void {
    this.pausedTimeouts.delete(dialogueId);
    if (this.pendingReplies.has(dialogueId)) {
      this.startReplyTimer(dialogueId);
    }
  }

  private startReplyTimer(dialogueId: string): void {
    if (this.pausedTimeouts.has(dialogueId)) return;
    this.clearReplyTimer(dialogueId);
    const timer = setTimeout(() => {
      logger.warn({ dialogueId }, 'dialogue:reply timeout');
      this.closeDialogue(dialogueId, 'timeout');
    }, DIALOGUE_DEFAULTS.replyTimeoutMs);
    timer.unref();
    this.replyTimers.set(dialogueId, timer);
  }

  private clearReplyTimer(dialogueId: string): void {
    const timer = this.replyTimers.get(dialogueId);
    if (timer) {
      clearTimeout(timer);
      this.replyTimers.delete(dialogueId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 持久化 & 监听
  // ─────────────────────────────────────────────────────────────

  private persistMessage(msg: DialogueMessagePayload, sessionId: string, correlationId: string): void {
    try {
      this.insertStmt.run(
        genId('dmsg'),
        msg.dialogueId,
        sessionId,
        correlationId,
        msg.sequenceNumber,
        msg.from,
        msg.to,
        msg.content,
        msg.context ? JSON.stringify(msg.context) : null,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
        Date.now(),
      );

      // 13.0 §5.1.2: 并行写入 agent_chat_messages 审计表
      // 该表供前端 agent-chat 面板展示 Agent 间对话记录，与 dialogue_messages 不同维度
      // direction 判断：sequenceNumber 偶数 = request（send），奇数 = response（reply）
      this.persistAgentChatMessage(msg, sessionId, correlationId);
    } catch (err) {
      logger.error({ err, dialogueId: msg.dialogueId }, 'dialogue:persist failed');
    }
  }

  /**
   * 13.0 §5.1.2: 写入 agent_chat_messages 审计表。
   *
   * 专门记录 Agent 间的对话内容（request/response），供 Brain 审核和前端 agent-chat 面板使用。
   * 与 dialogue_messages 表的区别：该表关注"谁和谁说了什么"，dialogue_messages 关注完整对话状态。
   *
   * @param msg - 对话消息 payload
   * @param sessionId - session ID
   * @param correlationId - 关联 ID
   */
  private persistAgentChatMessage(msg: DialogueMessagePayload, sessionId: string, correlationId: string): void {
    try {
      // sequenceNumber 偶数 = send（request），奇数 = reply（response）
      const direction = msg.sequenceNumber % 2 === 0 ? 'request' : 'response';
      const msgType = msg.context?.type as string ?? (direction === 'request' ? 'agent.question' : 'agent.answer');

      this.deps.db.prepare(`
        INSERT INTO agent_chat_messages (id, session_id, task_id, from_agent, to_agent, direction, message_type, content, correlation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('acm'),
        sessionId,
        msg.context?._taskId as string ?? '',
        msg.from,
        msg.to,
        direction,
        msgType,
        typeof msg.content === 'string' ? msg.content.slice(0, 5000) : JSON.stringify(msg.content).slice(0, 5000),
        correlationId,
        Date.now(),
      );
    } catch (err) {
      // 表可能不存在（迁移未执行）— 静默忽略，不影响主流程
      logger.debug({ err, dialogueId: msg.dialogueId }, 'agent_chat_messages 写入跳过（表不存在或非关键）');
    }
  }

  /**
   * M4: 将观察记录、EventBus 事件、Brain IPC 推送完全解耦。
   *
   * 三个独立的 fire-and-forget 操作，任何一个失败都不影响其他。
   * 观察记录直接写 SQLite，不经过 deliver / IPC 路径。
   */
  private notifyBrain(msg: DialogueMessagePayload, state: DialogueState): void {
    // ── 1. 持久化到观察队列（直接写 SQLite，完全独立） ──
    this.recordObservation(msg, state);

    // ── 2. 推送前端事件（EventBus，独立） ──
    this.emitDialogueEvent(msg, state);

    // ── 3. Brain IPC 实时推送（保留现有路径） ──
    this.pushToBrainIpc(msg, state);
  }

  /**
   * M4: 观察记录 — 直接写 SQLite，失败不影响消息投递。
   * 与 deliver / IPC 完全无关，纯数据库 INSERT。
   */
  private recordObservation(msg: DialogueMessagePayload, state: DialogueState): void {
    if (!this.deps.observationRecorder) return;
    try {
      this.deps.observationRecorder.record({
        sessionId: state.sessionId,
        taskId: state.correlationId,
        observationType: state.currentRound === 0 ? 'dialogue_send' : 'dialogue_reply',
        fromAgent: msg.from,
        toAgent: msg.to,
        content: safeSlice(msg.content, 2000), // 截断以控制存储（grapheme-safe）
        priority: msg.metadata?.confidence !== undefined && msg.metadata.confidence < 0.5 ? 2 : 1,
        metadata: { round: state.currentRound, dialogueId: msg.dialogueId, sequenceNumber: msg.sequenceNumber },
      });
    } catch (err) {
      // M4: 观察写入失败仅记录，绝不向上抛出（不污染发送方）
      logger.warn({ err, dialogueId: msg.dialogueId }, 'dialogue:observation record failed (isolated)');
    }
  }

  /**
   * M4: 推送 agent.dialogue 事件至 EventBus（前端对话面板）。
   */
  private emitDialogueEvent(msg: DialogueMessagePayload, state: DialogueState): void {
    try {
      getEventBus().emit('agent.dialogue', {
        dialogueId: msg.dialogueId,
        sessionId: state.sessionId,
        taskId: state.correlationId,
        from: msg.from,
        to: msg.to,
        content: safeSlice(msg.content, 2000),
        round: state.currentRound,
        phase: state.currentRound === 0 ? 'send' : 'reply',
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn({ err, dialogueId: msg.dialogueId }, 'dialogue:agent.dialogue emit failed (isolated)');
    }
  }

  /**
   * M4: Brain IPC 实时推送（dialogue.observe）。
   * Brain 离线时静默跳过。
   *
   * L1: 同时携带 taskId 让 Brain 按 (sessionId, taskId) 隔离 IntentAnchor。
   */
  private pushToBrainIpc(msg: DialogueMessagePayload, state: DialogueState): void {
    const brainIpc = this.deps.getBrainIpc();
    if (!brainIpc) return;
    // 12.0: 从 pending 中获取 intentAnchor 供 Brain 做语义漂移检测
    const pending = this.deps.sessionManager.getPending(state.correlationId);
    const observe: DialogueObservePayload = {
      message: msg,
      currentRound: state.currentRound,
      sessionId: state.sessionId,
      taskId: state.correlationId, // L1: 携带 taskId 供 Brain 按任务隔离 anchor
      intentAnchor: pending?.intentAnchor,
    };
    try {
      brainIpc.send('dialogue.observe', 'brain', observe, msg.dialogueId);
    } catch (err) {
      logger.warn({ err, dialogueId: msg.dialogueId }, 'dialogue:brain IPC push failed (isolated)');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 恢复 & 查询
  // ─────────────────────────────────────────────────────────────

  /** 获取对话历史（用于崩溃恢复） */
  getHistory(dialogueId: string): DialogueMessagePayload[] {
    const rows = this.deps.db.prepare(
      'SELECT content, from_agent, to_agent, sequence_number, context_json, metadata_json FROM dialogue_messages WHERE dialogue_id = ? ORDER BY sequence_number',
    ).all(dialogueId) as Array<{
      content: string;
      from_agent: string;
      to_agent: string;
      sequence_number: number;
      context_json: string | null;
      metadata_json: string | null;
    }>;
    return rows.map(row => ({
      dialogueId,
      sequenceNumber: row.sequence_number,
      from: row.from_agent,
      to: row.to_agent,
      content: row.content,
      context: row.context_json ? JSON.parse(row.context_json) : undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));
  }

  /**
   * 获取 session 下最近未完成的对话摘要（崩溃恢复用）。
   * "未完成" = 最后一条消息在 5 分钟内且序列号为偶数（send 后没有 reply）。
   */
  getRecentUnfinishedSummary(sessionId: string): string | null {
    const cutoff = Date.now() - 5 * 60_000;
    const rows = this.deps.db.prepare(`
      SELECT dialogue_id, from_agent, to_agent, content, sequence_number
      FROM dialogue_messages
      WHERE session_id = ? AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(sessionId, cutoff) as Array<{
      dialogue_id: string;
      from_agent: string;
      to_agent: string;
      content: string;
      sequence_number: number;
    }>;

    if (rows.length === 0) return null;

    // 按 dialogue 分组，取最新的一个
    const latestDialogueId = rows[0].dialogue_id;
    const dialogueRows = rows.filter(r => r.dialogue_id === latestDialogueId).reverse();

    // 如果最后一条是 reply（奇数序号），对话已正常结束
    const lastSeq = dialogueRows[dialogueRows.length - 1].sequence_number;
    if (lastSeq % 2 === 1) return null;

    // 构造摘要
    const lines = dialogueRows.map(r => {
      const role = r.from_agent === 'conversation' ? '你' : r.to_agent;
      return `[${role}] ${safeSlice(r.content, 200)}`;
    });
    return `[未完成的对话 (target: ${dialogueRows[0].to_agent})]\n${lines.join('\n')}`;
  }

  /** 清理过期对话（7 天保留） */
  sweepStale(): number {
    const threshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // 清理内存中已终态的对话及关联的计数器
    for (const [id, state] of this.dialogues) {
      if (state.status !== 'active' && state.createdAt < threshold) {
        this.dialogues.delete(id);
      }
    }
    // 清理不再有活跃对话的 correlation 计数器
    const activeCorrelations = new Set([...this.dialogues.values()].filter(d => d.status === 'active').map(d => d.correlationId));
    for (const corrId of this.dialogueCountByCorrelation.keys()) {
      if (!activeCorrelations.has(corrId)) {
        this.dialogueCountByCorrelation.delete(corrId);
      }
    }
    // 清理数据库
    const result = this.deps.db.prepare('DELETE FROM dialogue_messages WHERE created_at < ?').run(threshold);
    return result.changes;
  }

  // ─────────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────────

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** 启动定时清理（每小时执行一次 sweepStale） */
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const deleted = this.sweepStale();
      if (deleted > 0) logger.debug({ deleted }, 'dialogue:sweep');
    }, 60 * 60 * 1000);
    this.sweepTimer.unref();
  }

  /** 停止定时清理（进程退出时调用） */
  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** 销毁：停止清理 + 清除所有超时 timer */
  dispose(): void {
    this.stopSweep();
    for (const timer of this.replyTimers.values()) clearTimeout(timer);
    this.replyTimers.clear();
    this.pendingReplies.clear();
  }
}
