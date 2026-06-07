import type { Database } from 'better-sqlite3';
import type { ModelTier } from '../contracts/model.js';
import type { MemoryContextFrame } from '../contracts/memory.js';
import type { MemoryRuntime } from '../memory/index.js';
import { getDb } from '../memory/index.js';
import { saveMessage } from '../memory/conversations.js';
import type { EvolutionEngine } from '../evolution/index.js';
import type { ISkillLoader } from '../skills/contract.js';
import type { IPluginRuntimeV2, PromptInjectionContext } from '../contracts/plugins-v2.js';
import type { AppConfig } from '../config/schema.js';
import { buildSystemPrompt } from '../llm/prompt-builder.js';
import { getLogger } from '../utils/logger.js';
import { getEventBus } from './event-bus.js';

const logger = getLogger('session-manager');

export interface PendingRequest {
  /** 对话 sessionId（来自消息体，标识当前对话） */
  sessionId: string;
  /** 客户端标识（用于重连时按客户端查找 pending request） */
  clientId?: string;
  userMessage: string;
  taskId?: string;
  /** 委托任务 ID（delegation 创建的子 task）。flusher 注册用此 key。 */
  delegationTaskId?: string;
  level?: string;
  reasoning?: string;
  draftResponse?: string;
  toolCalls?: Array<{ name: string; input: string; result: string }>;
  streaming?: boolean;
  resolve: (response: string) => void;
  /** 12.0: Brain 路由时产出的用户意图锚点（漂移检测基准） */
  intentAnchor?: import('../contracts/intent.js').IntentAnchor;
}

export interface PendingAskState {
  sessionId: string;
  taskId: string;
  agentName: string;
  question: string;
  correlationId: string;
}

export class SessionManager {
  private pendingRequests = new Map<string, PendingRequest>();
  private requestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionPromptCache = new Map<string, string>();
  private sessionModelOverrides = new Map<string, ModelTier>();
  private pendingAsks = new Map<string, PendingAskState>();
  private sessionLastActivity = new Map<string, number>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  private memoryRuntime: MemoryRuntime;
  private skillLoader: ISkillLoader | null;
  private evolutionEngine: EvolutionEngine | null;
  private pluginRuntimeV2: IPluginRuntimeV2 | null;
  private config: AppConfig;

  constructor(deps: {
    memoryRuntime: MemoryRuntime;
    skillLoader: ISkillLoader | null;
    evolutionEngine: EvolutionEngine | null;
    pluginRuntimeV2?: IPluginRuntimeV2 | null;
    config: AppConfig;
  }) {
    this.memoryRuntime = deps.memoryRuntime;
    this.skillLoader = deps.skillLoader;
    this.evolutionEngine = deps.evolutionEngine;
    this.pluginRuntimeV2 = deps.pluginRuntimeV2 ?? null;
    this.config = deps.config;
  }

  createPending(msgId: string, entry: PendingRequest): void {
    this.pendingRequests.set(msgId, entry);
    this.touchSession(entry.sessionId);
    const timeoutMs = this.config.requestTimeoutMs * 4;
    const timer = setTimeout(() => {
      const pending = this.pendingRequests.get(msgId);
      // 调试日志：pending 请求超时，定位对话中断
      logger.info({
        msgId,
        sessionId: entry.sessionId,
        timeoutMs,
        hasDraft: !!(pending?.draftResponse),
        draftLen: pending?.draftResponse?.length ?? 0,
        hasTaskId: !!pending?.taskId,
        streamingActive: !!pending?.streaming,
      }, 'pending 请求超时（120s）');
      if (pending) {
        // 11.0 修复：超时时保存已有的部分内容到对话历史，防止刷新后空白气泡
        const partialContent = pending.draftResponse ?? '';
        if (partialContent && pending.userMessage) {
          this.saveConversationTurn(
            entry.sessionId,
            pending.userMessage,
            partialContent + '\n\n*[回复超时，内容可能不完整]*',
            pending.reasoning,
          );
          logger.info({ msgId, sessionId: entry.sessionId, partialLen: partialContent.length }, '请求超时，已保存部分内容');
        } else {
          logger.warn({ msgId, sessionId: entry.sessionId }, '请求超时，无部分内容可保存');
        }
        // 通知前端请求超时（与其他错误路径保持一致，前端 WS 客户端可实时感知）
        getEventBus().emit('conversation.no_response', {
          sessionId: entry.sessionId,
          reason: 'request_timeout',
          taskId: pending.taskId,
          correlationId: msgId,
        });
        this.deletePending(msgId);
        pending.resolve('[超时] 请求处理超时，请重试');
      }
    }, timeoutMs);
    this.requestTimers.set(msgId, timer);
  }

  getPending(msgId: string): PendingRequest | undefined {
    return this.pendingRequests.get(msgId);
  }

  /**
   * R14-1：任务终结统一入口
   *
   * 之前 8 个失败源（agent.crashed / Runtime exception / foreground fail /
   * task.timeout / interrupt / unavailable / cancelled / no_output）各自
   * 拼错误文案 + saveConversationTurn + deletePending + resolvePending +
   * emit no_response。R13 审计标记为 5 个"补丁式重复"——同一根本缺陷
   * （任务不再产出更多内容）的多个表现。
   *
   * finalizeTask 把这 5 步统一到 1 个 helper，调用方只传 outcome：
   *   - crash: agent 进程崩溃（agent.crashed 路径）
   *   - failed: agent 任务失败返回 !result.ok
   *   - timeout: task 达到 timeout
   *   - cancelled: user/cancel 中断
   *   - terminated: user interruptSession
   *   - unavailable: primary agent 不可用
   *
   * 错误文案模板：[${outcomeLabel}] ${errorContext}
   * - crash: [错误] 智能体 {name} 崩溃
   * - failed: [{agentName}] 任务失败
   * - timeout: [任务执行超时]
   * - cancelled: [{agentName}] 执行已取消
   * - terminated: [已停止]
   * - unavailable: [系统错误] 对话智能体不可用
   *
   * 持久化策略：
   * - partial draftResponse 存在 → contentOverride = `${partial}\n\n${errorLabel}`
   * - 无 partial → errorLabel 单独入库
   * - saveConversationTurn 失败 silent log（runtime 内部已 try/catch）
   * - emit conversation.no_response 让前端感知
   */
  finalizeTask(
    correlationId: string,
    outcome: {
      kind: 'crash' | 'failed' | 'timeout' | 'cancelled' | 'terminated' | 'unavailable' | 'runtime_error';
      agentName?: string;
      error?: string;
    },
  ): void {
    const pending = this.pendingRequests.get(correlationId);
    if (!pending) return;

    const label = (() => {
      switch (outcome.kind) {
        case 'crash': return `[错误] 智能体 ${outcome.agentName ?? '?'} 崩溃`;
        case 'failed': return `[${outcome.agentName ?? '系统'}] 任务失败: ${outcome.error ?? '未知错误'}`;
        case 'timeout': return `[任务执行超时] ${outcome.error ?? ''}`.trim();
        case 'cancelled': return `[${outcome.agentName ?? '系统'}] 执行已取消`;
        case 'terminated': return '[已停止]';
        case 'unavailable': return '[系统错误] 对话智能体不可用';
        case 'runtime_error': return `[${outcome.agentName ?? '系统'}] 执行异常: ${outcome.error ?? '未知错误'}`;
      }
    })();

    const partial = pending.draftResponse ?? '';
    const response = partial ? partial : label;
    const persistContent = partial ? `${partial}\n\n${label}` : label;

    this.resolvePending(correlationId, response, { contentOverride: persistContent });
  }

  deletePending(msgId: string): void {
    const timer = this.requestTimers.get(msgId);
    if (timer) { clearTimeout(timer); this.requestTimers.delete(msgId); }
    this.pendingRequests.delete(msgId);
  }

  /**
   * 统一收尾 pending request：保存对话轮次 → 删除 pending → resolve 闭包。
   * 消除 delegation-orchestrator 等处重复的
   * try/saveTurn/catch + deletePending + resolve 三步补丁。
   *
   * @param msgId pending request 的 ID
   * @param response 传给 resolve() 的回复文本
   * @param options.saveTurn 是否保存对话轮次，默认 true
   * @param options.contentOverride 入库时覆盖 response 的内容
   *   （如追加 [已停止] 等标记），不影响 resolve 传给前端的原始文本
   * @returns true=找到并处理了 pending，false=无此 pending
   */
  resolvePending(msgId: string, response: string, options?: {
    saveTurn?: boolean;
    contentOverride?: string;
  }): boolean {
    const pending = this.pendingRequests.get(msgId);
    if (!pending) return false;

    // 默认保存对话轮次
    if (options?.saveTurn !== false && pending.userMessage) {
      try {
        const persistContent = options?.contentOverride ?? response;
        this.saveConversationTurn(
          pending.sessionId,
          pending.userMessage,
          persistContent,
          pending.reasoning,
        );
      } catch (err) {
        logger.error({ err, msgId, sessionId: pending.sessionId }, 'resolvePending saveConversationTurn 失败');
      }
    }

    this.deletePending(msgId);
    pending.resolve(response);
    return true;
  }

  /**
   * 半收尾 pending request：保存对话轮次 → 删除 pending → 返回 pending 快照。
   * 不调用 resolve，留由调用方执行额外操作（如 evolution、audit、task complete）
   * 后再手动 pending.resolve(response)。
   *
   * 适用于正常完成路径（final.response / handleTaskReviewResult），
   * 这些路径在 resolve 前后还有 evolution/audit 等需要 pending 数据的操作。
   *
   * @param msgId pending request 的 ID
   * @param response 入库的回复文本
   * @returns pending 快照（含 resolve 闭包），或 null（无此 pending）
   */
  finalizePending(msgId: string, response: string): PendingRequest | null {
    const pending = this.pendingRequests.get(msgId);
    if (!pending) return null;

    // 保存对话轮次
    if (pending.userMessage) {
      try {
        this.saveConversationTurn(
          pending.sessionId,
          pending.userMessage,
          response,
          pending.reasoning,
        );
      } catch (err) {
        logger.error({ err, msgId, sessionId: pending.sessionId }, 'finalizePending saveConversationTurn 失败');
      }
    }

    // 删除 pending（含 clearTimeout），但保留引用供调用方 resolve
    this.deletePending(msgId);
    return pending;
  }

  entries(): IterableIterator<[string, PendingRequest]> {
    return this.pendingRequests.entries();
  }

  findPendingByTaskId(taskId: string): PendingRequest | undefined {
    return [...this.pendingRequests.values()].find((p) => p.taskId === taskId);
  }

  findAnyPendingWithTaskId(): PendingRequest | undefined {
    return [...this.pendingRequests.values()].find((p) => p.taskId);
  }

  /**
   * 检查指定 session 是否有活跃的 pending request。
   * 用于防止同一会话并发消息投递（多标签页 / outbox 重放防护）。
   */
  hasActivePendingForSession(sessionId: string): boolean {
    for (const pending of this.pendingRequests.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  getModelOverride(sessionId: string): ModelTier | undefined {
    return this.sessionModelOverrides.get(sessionId);
  }

  setModelOverride(sessionId: string, tier: ModelTier): void {
    this.sessionModelOverrides.set(sessionId, tier);
  }

  clearPromptCache(): void {
    this.sessionPromptCache.clear();
  }

  getModelOverridesMap(): Map<string, ModelTier> {
    return this.sessionModelOverrides;
  }

  buildPrompt(sessionId: string): string {
    const cached = this.sessionPromptCache.get(sessionId);
    if (cached) return cached;

    let skillBlock = '';

    if (this.pluginRuntimeV2 && this.config.plugins.unified) {
      const context: PromptInjectionContext = {
        agentId: sessionId,
        workspaceId: '',
        userId: '',
        tokenBudget: Math.floor(this.config.skills.maxPromptChars / 3.5),
      };
      skillBlock = this.pluginRuntimeV2.buildPromptBlock(context);
    } else {
      skillBlock = this.skillLoader?.buildPromptBlock(
        this.config.skills.promptMode,
        this.config.skills.maxPromptChars,
      ) ?? '';
    }

    const prompt = buildSystemPrompt({ skillBlock: skillBlock || undefined });
    this.sessionPromptCache.set(sessionId, prompt);
    return prompt;
  }

  buildMemoryContext(sessionId: string, userMessage: string): MemoryContextFrame | undefined {
    return this.memoryRuntime.buildContextFrame(sessionId, userMessage, 'auto_recall');
  }

  queueEvolution(sessionId: string, userMessage: string, response: string): void {
    if (this.config.llm.mode !== 'takeover') {
      this.memoryRuntime.queueEvolution(sessionId, userMessage, response);
    }
  }

  queueCapabilityEvolution(sessionId: string, userMessage: string, assistantResponse: string): void {
    if (!this.config.memory.evolutionEnabled || !this.evolutionEngine) return;

    if (this.evolutionEngine.hasExtractor() && this.config.llm.mode !== 'takeover') {
      this.evolutionEngine.runAfterConversationAsync({ sessionId, userMessage, assistantResponse })
        .then((result) => {
          if (result.proposals.length > 0) {
            this.skillLoader?.refresh();
            logger.info({
              sessionId,
              proposals: result.proposals.map((proposal) => ({
                id: proposal.id,
                type: proposal.type,
                status: proposal.status,
              })),
            }, '能力自进化检查完成（LLM 驱动）');
          }
        })
        .catch((err) => {
          logger.error({ err, sessionId }, '能力自进化 LLM 提取失败');
        });
      return;
    }

    try {
      const result = this.evolutionEngine.runAfterConversation({ sessionId, userMessage, assistantResponse });
      if (result.proposals.length > 0) {
        this.skillLoader?.refresh();
        logger.info({
          sessionId,
          proposals: result.proposals.map((proposal) => ({
            id: proposal.id,
            type: proposal.type,
            status: proposal.status,
          })),
        }, '能力自进化检查完成');
      }
    } catch (err) {
      logger.error({ err, sessionId }, '能力自进化检查失败');
    }
  }

  saveConversationTurn(sessionId: string, userMessage: string, response: string, reasoning?: string): void {
    this.memoryRuntime.saveConversationTurn(sessionId, userMessage, response, reasoning);
  }

  /**
   * 在 kernel 入口（handleMessage）创建 pending 之后立即落 user 行。
   * 这是修复「user 消息从不持久化」双层漏洞的关键。
   *
   * 失败时仅记 warn，不阻塞后续路由（fail-open：路由优先，
   * user 消息至少经过一次尝试；中断场景下仍能在 conversation agent
   * 内部二次尝试时落盘）。
   */
  saveUserMessage(sessionId: string, content: string, options: { clientMsgId?: string } = {}): { id: string; deduplicated: boolean } {
    try {
      return this.memoryRuntime.saveUserMessage(sessionId, content, options);
    } catch (err) {
      logger.warn({ err, sessionId, clientMsgId: options.clientMsgId }, 'user 消息入口入库失败，将依赖下游 conversation agent 兜底');
      return { id: '', deduplicated: false };
    }
  }

  async waitForEvolutionIdle(timeoutMs: number): Promise<boolean> {
    return this.memoryRuntime.waitForEvolutionIdle(timeoutMs);
  }

  // --- Pending Ask (multi-turn agent-user interaction) ---

  setPendingAsk(sessionId: string, state: PendingAskState): void {
    this.pendingAsks.set(sessionId, state);
    // 持久化到 SQLite（进程崩溃后可通过 recoverPendingAsks 恢复）
    this.persistAskToDb(state);
  }

  getPendingAsk(sessionId: string): PendingAskState | undefined {
    return this.pendingAsks.get(sessionId);
  }

  clearPendingAsk(sessionId: string): void {
    this.pendingAsks.delete(sessionId);
    // 从 SQLite 删除
    this.deleteAskFromDb(sessionId);
  }

  hasPendingAsk(sessionId: string): boolean {
    return this.pendingAsks.has(sessionId);
  }

  /**
   * 获取所有 pendingAsks 条目（WS 重连重放用）。
   * 返回快照数组，避免调用方遍历期间 map 被修改的风险。
   */
  getAllPendingAsks(): ReadonlyArray<PendingAskState> {
    return [...this.pendingAsks.values()];
  }

  /**
   * 从 SQLite 直接查询所有 pending asks（WS 重连重放用）。
   * 与 getAllPendingAsks（内存 Map）不同，此方法直接查 SQLite，
   * 与 replayPendingRequests 的其他两类（delegation/permissions 直接查 DB）保持一致。
   * 进程内状态和 DB 始终同步（setPendingAsk 写入后立即 persistAskToDb），
   * 所以两者结果等价，但此方法更严格地遵循"replay 从 DB 读"原则。
   */
  getAllPendingAsksFromDb(): ReadonlyArray<PendingAskState> {
    try {
      const db = getDb();
      const rows = db.prepare(
        'SELECT session_id, task_id, agent_name, question, correlation_id FROM pending_asks',
      ).all() as Array<{ session_id: string; task_id: string; agent_name: string; question: string; correlation_id: string }>;
      return rows.map((row) => ({
        sessionId: row.session_id,
        taskId: row.task_id,
        agentName: row.agent_name,
        question: row.question,
        correlationId: row.correlation_id,
      }));
    } catch (err) {
      logger.error({ err }, 'getAllPendingAsksFromDb 查询失败，回退到内存');
      return [...this.pendingAsks.values()];
    }
  }

  /**
   * 从 SQLite 恢复 pending asks（服务启动时调用）。
   * 与 recoverSessions 类似，在 start() 阶段调用。
   * 进程崩溃后 pending asks 仍然有效——用户重连后可以继续回答。
   */
  recoverPendingAsks(db: Database): { recovered: number } {
    const rows = db.prepare(
      'SELECT session_id, task_id, agent_name, question, correlation_id FROM pending_asks',
    ).all() as Array<{ session_id: string; task_id: string; agent_name: string; question: string; correlation_id: string }>;
    for (const row of rows) {
      // 仅恢复不在内存中的（避免覆盖已有的）
      if (!this.pendingAsks.has(row.session_id)) {
        this.pendingAsks.set(row.session_id, {
          sessionId: row.session_id,
          taskId: row.task_id,
          agentName: row.agent_name,
          question: row.question,
          correlationId: row.correlation_id,
        });
      }
    }
    return { recovered: rows.length };
  }

  /** 持久化单个 pending ask 到 SQLite（upsert） */
  private persistAskToDb(state: PendingAskState): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO pending_asks (session_id, task_id, agent_name, question, correlation_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          task_id = excluded.task_id,
          agent_name = excluded.agent_name,
          question = excluded.question,
          correlation_id = excluded.correlation_id
      `).run(state.sessionId, state.taskId, state.agentName, state.question, state.correlationId);
    } catch (err) {
      logger.error({ err, sessionId: state.sessionId }, 'persistAskToDb 失败');
    }
  }

  /** 从 SQLite 删除单个 pending ask */
  private deleteAskFromDb(sessionId: string): void {
    try {
      const db = getDb();
      db.prepare('DELETE FROM pending_asks WHERE session_id = ?').run(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, 'deleteAskFromDb 失败');
    }
  }

  // --- Session Context (for Brain routing) ---

  getSessionContext(sessionId: string, maxTurns = 5): string | undefined {
    try {
      const turns = this.memoryRuntime.getRecentTurns(sessionId, maxTurns);
      if (!turns || turns.length === 0) return undefined;
      return turns.map(t => `用户: ${t.userMessage.slice(0, 100)}\n助手: ${t.response.slice(0, 100)}`).join('\n---\n');
    } catch (err) {
      logger.debug({ err, sessionId }, '会话上下文获取失败');
      return undefined;
    }
  }

  recoverSessions(db: Database): { timedOut: number; denied: number } {
    let timedOut = 0;
    let denied = 0;

    // R14-2：原 SQL 漏取 session_id，导致 stale task 标记后无法定位 conversations 表的 user 行。
    // 现在需要：标记 stale task + 写 [系统] 行到对应 session 的 conversations 表
    // （替代 OrphanReconciler 后台扫表的兜底职责）
    const staleTasks = db.prepare(`
      SELECT id, status, target_agent, session_id FROM agent_tasks
      WHERE status IN ('running', 'dispatched', 'acknowledged', 'waiting_approval')
    `).all() as Array<{ id: string; status: string; target_agent: string; session_id: string }>;

    if (staleTasks.length === 0) return { timedOut, denied };

    const now = Date.now();
    for (const task of staleTasks) {
      if (task.status === 'waiting_approval') {
        db.prepare(`UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
          .run('权限请求因服务重启被自动拒绝', now, task.id);
        // R14-2：直接在写入点兜底写 [系统] 行，消解 OrphanReconciler 周期性扫表
        try {
          saveMessage(task.session_id, 'assistant', '[系统] 上次权限请求因服务重启被自动拒绝，请重新发起');
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'recoverSessions 写 [系统] 行失败（不影响任务状态）');
        }
        denied++;
      } else {
        db.prepare(`UPDATE agent_tasks SET status = 'timeout', error = ?, finished_at = ? WHERE id = ?`)
          .run('任务因服务重启被标记为超时', now, task.id);
        // R14-2：写入点兜底——标记 stale task 同时 [系统] 行落 conversations
        try {
          saveMessage(task.session_id, 'assistant', '[系统] 上次回复因服务重启未完成，请重新提问');
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'recoverSessions 写 [系统] 行失败（不影响任务状态）');
        }
        timedOut++;
      }
    }

    logger.info({ timedOut, denied, total: staleTasks.length }, '会话恢复: 清理残留任务 + 写 [系统] 行');
    return { timedOut, denied };
  }

  touchSession(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  startGc(intervalMs = 300000, maxInactiveMs = 1800000): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      this.runGc(maxInactiveMs);
    }, intervalMs);
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /**
   * 服务关闭时收尾所有未完成的 pending requests。
   * 清理 timer、resolve 一个服务关闭提示，防止 setTimeout 回调
   * 在 DB 关闭后触发 saveConversationTurn 失败。
   *
   * @param reason resolve 传给前端的关闭原因
   */
  disposeAllPending(reason: string): void {
    for (const [msgId, pending] of this.pendingRequests) {
      // 清理 timer
      const timer = this.requestTimers.get(msgId);
      if (timer) { clearTimeout(timer); this.requestTimers.delete(msgId); }
      // 不保存对话轮次（服务关闭，DB 可能即将关闭）
      // 直接 resolve 让前端知道
      try { pending.resolve(reason); } catch { /* 忽略 resolve 失败 */ }
    }
    this.pendingRequests.clear();
    this.requestTimers.clear();
  }

  runGc(maxInactiveMs = 1800000): { cleaned: number } {
    const now = Date.now();
    let cleaned = 0;

    // 收集有活跃 pending request 的 session，GC 时跳过这些 session
    // 防止长任务的 promptCache/modelOverrides 被误清理导致重建
    const activeSessions = new Set<string>();
    for (const pending of this.pendingRequests.values()) {
      activeSessions.add(pending.sessionId);
    }

    for (const [sessionId, lastActive] of this.sessionLastActivity) {
      if (now - lastActive > maxInactiveMs) {
        // 跳过有活跃 pending request 的 session，并刷新其活跃时间
        if (activeSessions.has(sessionId)) {
          this.touchSession(sessionId);
          continue;
        }
        this.sessionPromptCache.delete(sessionId);
        this.sessionModelOverrides.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
        if (this.pendingAsks.has(sessionId)) {
          this.clearPendingAsk(sessionId); // 同时删除 SQLite 行
        }
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Session GC completed');
    }
    return { cleaned };
  }

  getSessionStats(): { activeSessions: number; promptCacheSize: number; pendingAsks: number } {
    return {
      activeSessions: this.sessionLastActivity.size,
      promptCacheSize: this.sessionPromptCache.size,
      pendingAsks: this.pendingAsks.size,
    };
  }
}
