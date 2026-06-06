import type { Socket } from 'node:net';
import type { Database } from 'better-sqlite3';
import type { ModelTier } from '../contracts/model.js';
import type { MemoryContextFrame } from '../contracts/memory.js';
import type { MemoryRuntime } from '../memory/index.js';
import type { EvolutionEngine } from '../evolution/index.js';
import type { ISkillLoader } from '../skills/contract.js';
import type { IPluginRuntimeV2, PromptInjectionContext } from '../contracts/plugins-v2.js';
import type { AppConfig } from '../config/schema.js';
import { buildSystemPrompt } from '../llm/prompt-builder.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('session-manager');

export interface PendingRequest {
  /** 对话 sessionId（来自消息体，标识当前对话） */
  sessionId: string;
  /** WS 客户端标识（来自 WS URL 的 clientId），用于重连时按客户端查找 pending request */
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
  socket?: Socket;
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
  /** taskId → socket mapping for late-arriving text_delta after pending is deleted */
  private taskSocketMap = new Map<string, { socket: Socket; expiresAt: number }>();
  /** clientId → msgId 集合的索引，用于 rebindSocket 按 WS 客户端查找所有 pending request */
  private clientPendingIndex = new Map<string, Set<string>>();
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
    // 维护 clientId → msgId 索引，用于 rebindSocket 按客户端查找
    if (entry.clientId) {
      const set = this.clientPendingIndex.get(entry.clientId);
      if (set) { set.add(msgId); }
      else { this.clientPendingIndex.set(entry.clientId, new Set([msgId])); }
    }
    // Register taskId → socket for late-arriving text_delta after pending is deleted
    if (entry.taskId && entry.socket) {
      this.taskSocketMap.set(entry.taskId, { socket: entry.socket, expiresAt: Date.now() + 30_000 });
    }
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
        this.deletePending(msgId);
        pending.resolve('[超时] 请求处理超时，请重试');
      }
    }, timeoutMs);
    this.requestTimers.set(msgId, timer);
  }

  getPending(msgId: string): PendingRequest | undefined {
    return this.pendingRequests.get(msgId);
  }

  deletePending(msgId: string): void {
    const pending = this.pendingRequests.get(msgId);
    if (pending) {
      // 清理 clientId 索引
      if (pending.clientId) {
        const set = this.clientPendingIndex.get(pending.clientId);
        if (set) {
          set.delete(msgId);
          if (set.size === 0) this.clientPendingIndex.delete(pending.clientId);
        }
      }
      if (pending.taskId) {
        this.releaseTaskSocket(pending.taskId);
      }
    }
    const timer = this.requestTimers.get(msgId);
    if (timer) { clearTimeout(timer); this.requestTimers.delete(msgId); }
    this.pendingRequests.delete(msgId);
  }

  /**
   * Get socket for a taskId — used as fallback when pending is already deleted
   * by final.response but text_delta IPC hasn't been processed yet.
   */
  getSocketForTask(taskId: string): Socket | undefined {
    const entry = this.taskSocketMap.get(taskId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.taskSocketMap.delete(taskId);
      return undefined;
    }
    return entry.socket;
  }

  /**
   * 注册临时 taskId → socket 映射。
   * 用于 dialogue 模式：Code Agent 执行时推送的 text_delta 需要通过 ephemeral taskId 找到用户 socket。
   * @param taskId 临时任务 ID（不持久化到 agent_tasks 表）
   * @param socket 用户的 WebSocket 连接
   * @param ttlMs 映射存活时间（默认 90s，覆盖一轮 dialogue reply 超时）
   */
  registerTaskSocket(taskId: string, socket: Socket, ttlMs = 90_000): void {
    this.taskSocketMap.set(taskId, { socket, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Delayed cleanup: keep socket available for 2s after final.response
   * to catch any late-arriving text_delta messages.
   */
  private releaseTaskSocket(taskId: string): void {
    if (!taskId) return;
    setTimeout(() => {
      this.taskSocketMap.delete(taskId);
    }, 2000).unref();
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
   * 按 WS 客户端 ID 重绑定 socket：当客户端 WebSocket 重连时，
   * 将新 socket 关联到该客户端所有正在流式输出的 pending request。
   * 返回每个活跃任务的已积累流式文本，用于客户端补显示断连期间的输出。
   */
  rebindSocket(clientId: string, newSocket: Socket): Array<{ accumulated: string; taskId: string; sessionId: string }> {
    const results: Array<{ accumulated: string; taskId: string; sessionId: string }> = [];
    const msgIds = this.clientPendingIndex.get(clientId);
    if (!msgIds) return results;
    for (const msgId of msgIds) {
      const pending = this.pendingRequests.get(msgId);
      if (pending && pending.streaming) {
        pending.socket = newSocket;
        if (pending.taskId) {
          this.taskSocketMap.set(pending.taskId, { socket: newSocket, expiresAt: Date.now() + 300_000 });
        }
        results.push({ accumulated: pending.draftResponse ?? '', taskId: pending.taskId ?? '', sessionId: pending.sessionId });
      }
    }
    return results;
  }

  /**
   * 检查指定客户端是否有正在流式输出的 pending request（用于日志和状态查询）。
   */
  getPendingForClient(clientId: string): boolean {
    const set = this.clientPendingIndex.get(clientId);
    if (!set || set.size === 0) return false;
    for (const msgId of set) {
      const pending = this.pendingRequests.get(msgId);
      if (pending?.streaming) return true;
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
  }

  getPendingAsk(sessionId: string): PendingAskState | undefined {
    return this.pendingAsks.get(sessionId);
  }

  clearPendingAsk(sessionId: string): void {
    this.pendingAsks.delete(sessionId);
  }

  hasPendingAsk(sessionId: string): boolean {
    return this.pendingAsks.has(sessionId);
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

    const staleTasks = db.prepare(`
      SELECT id, status, target_agent FROM agent_tasks
      WHERE status IN ('running', 'dispatched', 'acknowledged', 'waiting_approval')
    `).all() as Array<{ id: string; status: string; target_agent: string }>;

    if (staleTasks.length === 0) return { timedOut, denied };

    const now = Date.now();
    for (const task of staleTasks) {
      if (task.status === 'waiting_approval') {
        db.prepare(`UPDATE agent_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`)
          .run('权限请求因服务重启被自动拒绝', now, task.id);
        denied++;
      } else {
        db.prepare(`UPDATE agent_tasks SET status = 'timeout', error = ?, finished_at = ? WHERE id = ?`)
          .run('任务因服务重启被标记为超时', now, task.id);
        timedOut++;
      }
    }

    logger.info({ timedOut, denied, total: staleTasks.length }, '会话恢复: 清理残留任务');
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

  runGc(maxInactiveMs = 1800000): { cleaned: number } {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, lastActive] of this.sessionLastActivity) {
      if (now - lastActive > maxInactiveMs) {
        this.sessionPromptCache.delete(sessionId);
        this.sessionModelOverrides.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
        if (this.pendingAsks.has(sessionId)) {
          this.pendingAsks.delete(sessionId);
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
