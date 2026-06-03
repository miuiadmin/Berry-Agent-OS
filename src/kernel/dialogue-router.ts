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
import type { Socket } from 'node:net';
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
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('dialogue-router');

export interface DialogueRouterDeps {
  db: Database;
  sessionManager: SessionManager;
  /** 获取目标 agent 的 IPC 通道 */
  getAgentIpc: (agentName: string) => IpcChannel | undefined;
  /** 获取 Brain agent 的 IPC 通道 */
  getBrainIpc: () => IpcChannel | undefined;
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

  private deps: DialogueRouterDeps;
  private insertStmt: import('better-sqlite3').Statement;

  constructor(deps: DialogueRouterDeps) {
    this.deps = deps;
    // dialogue_messages 表已在 schema.ts 中定义，这里只准备 insert 语句
    this.insertStmt = deps.db.prepare(`
      INSERT INTO dialogue_messages (id, dialogue_id, session_id, correlation_id, sequence_number, from_agent, to_agent, content, context_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // 启动 sweepStale 定时器
    this.startSweep();
  }

  // ─────────────────────────────────────────────────────────────
  // 对话生命周期
  // ─────────────────────────────────────────────────────────────

  /** 创建新对话，返回 dialogueId */
  createDialogue(params: CreateDialogueParams): string {
    const dialogueId = genId('dlg');
    const state: DialogueState = {
      dialogueId,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      initiator: params.initiator,
      target: params.target,
      currentRound: 0,
      createdAt: Date.now(),
      status: 'active',
    };
    this.dialogues.set(dialogueId, state);
    logger.info({ dialogueId, initiator: params.initiator, target: params.target }, 'dialogue:created');
    return dialogueId;
  }

  /** 获取对话状态 */
  getDialogue(dialogueId: string): DialogueState | undefined {
    return this.dialogues.get(dialogueId);
  }

  /** 注册外部已生成 dialogueId 的对话状态（Conversation 侧已生成 ID 时使用） */
  registerDialogue(dialogueId: string, params: CreateDialogueParams): DialogueState {
    const state: DialogueState = {
      dialogueId,
      sessionId: params.sessionId,
      correlationId: params.correlationId,
      initiator: params.initiator,
      target: params.target,
      currentRound: 0,
      createdAt: Date.now(),
      status: 'active',
    };
    this.dialogues.set(dialogueId, state);
    logger.info({ dialogueId, initiator: params.initiator, target: params.target }, 'dialogue:registered');
    return state;
  }

  /** 关闭对话 */
  closeDialogue(dialogueId: string, reason: DialogueEndPayload['reason']): void {
    const state = this.dialogues.get(dialogueId);
    if (!state) return;
    state.status = reason === 'completed' ? 'completed' : reason === 'timeout' ? 'timeout' : 'interrupted';
    this.clearReplyTimer(dialogueId);
    const pending = this.pendingReplies.get(dialogueId);
    if (pending) {
      pending.reject(new Error(`dialogue closed: ${reason}`));
      this.pendingReplies.delete(dialogueId);
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

  // ─────────────────────────────────────────────────────────────
  // 消息路由
  // ─────────────────────────────────────────────────────────────

  /**
   * 发送对话消息到目标 Agent（Conversation → Target）。
   * 返回一个 Promise，resolve 时收到 dialogue.reply。
   */
  async sendMessage(msg: DialogueMessagePayload, socket?: Socket): Promise<DialogueMessagePayload> {
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

    // 修正 sequenceNumber：Conversation 侧不维护精确序号，由 Kernel 统一分配
    msg.sequenceNumber = state.currentRound * 2;

    // 生成 ephemeral taskId 用于 streaming
    const ephemeralTaskId = genId('dtask');
    state.ephemeralTaskId = ephemeralTaskId;
    if (socket) {
      this.deps.sessionManager.registerTaskSocket(ephemeralTaskId, socket);
    }

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
      throw new Error(`target agent not available: ${state.target}`);
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
    } catch (err) {
      logger.error({ err, dialogueId: msg.dialogueId }, 'dialogue:persist failed');
    }
  }

  private notifyBrain(msg: DialogueMessagePayload, state: DialogueState): void {
    const brainIpc = this.deps.getBrainIpc();
    if (!brainIpc) return;
    const observe: DialogueObservePayload = {
      message: msg,
      currentRound: state.currentRound,
      sessionId: state.sessionId,
    };
    brainIpc.send('dialogue.observe', 'brain', observe, msg.dialogueId);
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

  /** 清理过期对话（7 天保留） */
  sweepStale(): number {
    const threshold = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // 清理内存中已终态的对话
    for (const [id, state] of this.dialogues) {
      if (state.status !== 'active' && state.createdAt < threshold) {
        this.dialogues.delete(id);
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
