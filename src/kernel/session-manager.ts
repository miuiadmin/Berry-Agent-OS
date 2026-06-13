import type { Database } from 'better-sqlite3';
import { safeSlice } from '../utils/safe-slice.js';
import type { ModelTier } from '../contracts/model.js';
import type { MemoryContextFrame } from '../contracts/memory.js';
import type { MemoryRuntime } from '../memory/index.js';
import { getDb } from '../memory/index.js';
import type { EvolutionEngine } from '../evolution/index.js';
import type { ISkillLoader } from '../skills/contract.js';
import type { IPluginRuntimeV2, PromptInjectionContext } from '../contracts/plugins-v2.js';
import type { AppConfig } from '../config/schema.js';
import { buildSystemPrompt } from '../llm/prompt-builder.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import { getEventBus } from './event-bus.js';
import { disposeBlockCollector } from './block-collector.js';
// 对话内联（doc 22）：消灭持久化双轨制——assistant / user 唯一落库漏斗都走 messages + message_blocks。
// recoverSessions 的「[系统] 兜底行」也改走 persistAssistantTurn（旧 conversations 写路径已停用）。
import { persistAssistantTurn, persistUserMessage } from '../memory/message-blocks-repo.js';

const logger = getLogger('session-manager');

export interface PendingRequest {
  /** 对话 sessionId（来自消息体，标识当前对话） */
  sessionId: string;
  /**
   * 客户端标识（预留字段，当前所有路径均传 undefined）
   * R15 审计：此字段设计用于 WS 重连时按客户端索引 pending request，
   * 但目前尚未实现。如未来不需要此功能可移除。
   */
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
  resolve: (response: string, review?: { verdict: import('../contracts/review.js').ReviewVerdict; reason?: string; originalDraft?: string }) => void;
  /** 12.0: Brain 路由时产出的用户意图锚点（漂移检测基准） */
  intentAnchor?: import('../contracts/intent.js').IntentAnchor;
  /** 13.0 §12.6: 关联的 mission ID（Brain 创建 mission 后注入，审核时传给 Brain） */
  missionId?: string;
  /** 13.0 §12.6: 关联的 plan 任务 ID（审核后由 Brain 自动 mark done/failed） */
  planTaskId?: string;
  /** 13.0 §12.6: 分配给 agent 的任务描述（审核时判断目标是否达成） */
  taskDescription?: string;
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
  /**
   * 15.0 R2-4：session 被 GC 回收时的回调（由 core-service 接线，调 PermissionCoordinator.clearSessionMode）。
   * 用回调而非直接注入 coordinator，避免低层 SessionManager 反向依赖 kernel 权限组件。
   * 不传则仅清理 SessionManager 自身 per-session 状态（向后兼容）。
   */
  private onSessionGc: ((sessionId: string) => void) | null = null;

  constructor(deps: {
    memoryRuntime: MemoryRuntime;
    skillLoader: ISkillLoader | null;
    evolutionEngine: EvolutionEngine | null;
    pluginRuntimeV2?: IPluginRuntimeV2 | null;
    config: AppConfig;
    /** 15.0 R2-4：session GC 回调（清理外部 per-session 状态，如 PermissionCoordinator.sessionModes） */
    onSessionGc?: (sessionId: string) => void;
  }) {
    this.memoryRuntime = deps.memoryRuntime;
    this.skillLoader = deps.skillLoader;
    this.evolutionEngine = deps.evolutionEngine;
    this.pluginRuntimeV2 = deps.pluginRuntimeV2 ?? null;
    this.config = deps.config;
    this.onSessionGc = deps.onSessionGc ?? null;
  }

  createPending(msgId: string, entry: PendingRequest): void {
    this.pendingRequests.set(msgId, entry);
    this.touchSession(entry.sessionId);
    // M2: 持久化关键字段到 SQLite（Kernel 重启后可恢复 intent_anchor 等状态）
    this.persistRequestState(msgId, entry);
    // 超时计时器：基础值 requestTimeoutMs * 4（默认 120s）
    // 如果 streaming 仍然活跃（有 text_delta 持续到达），自动续期一次，
    // 避免长耗时 code_task（LLM 慢 + 多步工具调用）在干活中被误杀
    const baseTimeoutMs = this.config.requestTimeoutMs * 4;
    let timeoutExtensions = 1; // 最多续期 1 次（额外 120s）
    let lastDraftLen = 0;
    // scheduleTimeout 返回定时器引用，供 requestTimers 管理
    const scheduleTimeout = (): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(msgId);
        // 续期条件：streaming 活跃 + draft 内容有增长 + 还有续期次数
        const currentDraftLen = pending?.draftResponse?.length ?? 0;
        const isStreaming = !!pending?.streaming;
        const hasProgress = currentDraftLen > lastDraftLen;
        lastDraftLen = currentDraftLen;
        if (isStreaming && hasProgress && timeoutExtensions > 0) {
          timeoutExtensions--;
          logger.info({
            msgId,
            sessionId: entry.sessionId,
            draftLen: currentDraftLen,
            extensionsLeft: timeoutExtensions,
          }, 'pending 请求超时续期（streaming 仍在活跃）');
          this.requestTimers.set(msgId, scheduleTimeout());
          return;
        }
        // 调试日志：pending 请求超时，定位对话中断
        logger.info({
          msgId,
          sessionId: entry.sessionId,
          timeoutMs: baseTimeoutMs,
          hasDraft: !!(pending?.draftResponse),
          draftLen: pending?.draftResponse?.length ?? 0,
          hasTaskId: !!pending?.taskId,
          streamingActive: !!pending?.streaming,
        }, 'pending 请求超时');
        if (pending) {
        // 11.0 修复：超时时保存已有的部分内容到对话历史，防止刷新后空白气泡。
        // 对话内联（doc 22）：改走 complete() 统一收尾——persistInlineBlocks 必然落本轮 blocks
        // （有 partial 落 partial+超时标签；无 partial 落纯超时标签），conversations 不再双写。
        const partialContent = pending.draftResponse ?? '';
        const hasPartial = !!(partialContent && pending.userMessage);
        // 通知前端请求超时（与其他错误路径保持一致，前端 WS 客户端可实时感知）
        getEventBus().emit('conversation.no_response', {
          sessionId: entry.sessionId,
          reason: 'request_timeout',
          taskId: pending.taskId,
          correlationId: msgId,
        });
        // complete 内部：persistInlineBlocks 落 blocks + deletePending + resolve
        this.complete(msgId, '[超时] 请求处理超时，请重试', {
          contentOverride: hasPartial ? partialContent + '\n\n*[回复超时，内容可能不完整]*' : undefined,
        });
        logger.info({ msgId, sessionId: entry.sessionId, partialLen: partialContent.length, hasPartial }, '请求超时，已走 complete 收尾');
      }
    }, baseTimeoutMs);
    // 记录 timer 以便 complete 时清理
    this.requestTimers.set(msgId, timer);
    return timer;
  };
  }

  getPending(msgId: string): PendingRequest | undefined {
    return this.pendingRequests.get(msgId);
  }

  /**
   * 任务失败统一入口
   *
   * R14-1 + R15：之前 8 个失败源各自拼错误文案 + saveConversationTurn + resolvePending。
   * R14-1 统一为 finalizeTask，R15 重命名 fail 使语义更清晰。
   *
   * 调用方只传 outcome：
   *   - crash: agent 进程崩溃
   *   - failed: agent 任务失败返回 !result.ok
   *   - timeout: task 达到 timeout
   *   - cancelled: user/cancel 中断
   *   - terminated: user interruptSession
   *   - unavailable: primary agent 不可用
   *   - runtime_error: Runtime 执行异常
   *
   * 持久化策略：partial draftResponse 存在 → 追加错误标签；否则仅入库错误标签。
   * 前端通知：emit conversation.no_response。
   */
  fail(
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

    // 通知前端任务终结（所有走 fail 的路径都应有前端通知）
    getEventBus().emit('conversation.no_response', {
      sessionId: pending.sessionId,
      reason: outcome.kind,
      taskId: pending.taskId,
      correlationId,
    });

    this.complete(correlationId, response, { contentOverride: persistContent });
  }

  deletePending(msgId: string): void {
    const timer = this.requestTimers.get(msgId);
    if (timer) { clearTimeout(timer); this.requestTimers.delete(msgId); }
    this.pendingRequests.delete(msgId);
    // M2: 同时从 SQLite 删除持久化状态
    this.deleteRequestState(msgId);
  }

  /**
   * 统一收尾 pending request：保存对话轮次 → 删除 pending → resolve 闭包。
   *
   * R15 重命名：resolvePending → complete，语义更清晰。
   * 覆盖 finalizePending 场景：设置 skipResolve=true 时不调 resolve，
   * 返回 pending 引用供调用方后续手动 resolve。
   *
   * @param msgId pending request 的 ID
   * @param response 传给 resolve() 的回复文本
   * @param options.saveTurn 是否保存对话轮次，默认 true
   * @param options.contentOverride 入库时覆盖 response 的内容
   * @param options.skipResolve 不调 resolve，返回 pending 引用。默认 false
   * @returns true=找到并处理了 pending（skipResolve 时返回 pending 引用），false=无此 pending
   */
  complete(msgId: string, response: string, options?: {
    contentOverride?: string;
    skipResolve?: boolean;
  }): boolean | PendingRequest {
    const pending = this.pendingRequests.get(msgId);
    if (!pending) return false;

    // 对话内联（doc 22）：assistant 唯一落库漏斗——persistInlineBlocks 内部 dispose 本轮 collector +
    // buildBlocks + persistAssistantTurn（无 collector 时降级单 text block，保证气泡必然落库）。
    // 覆盖内置 agent / 委派 / daemon 所有 turn 终态（成功/失败/超时）。conversations 不再双写。
    const persistContent = options?.contentOverride ?? response;
    this.persistInlineBlocks(pending, persistContent);

    this.deletePending(msgId);

    if (options?.skipResolve) {
      // 半收尾模式：返回 pending 引用，由调用方手动 resolve
      return pending;
    }

    pending.resolve(response);
    return true;
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

  /**
   * 落本轮 assistant 消息的内联 blocks（tool / thinking / text）到 message_blocks 表（doc 22）。
   *
   * 收敛点：把「turn 终态落 blocks」统一到这里——按 pending.delegationTaskId ?? pending.taskId
   * dispose 本轮 BlockCollector，buildBlocks 后 persistAssistantTurn。所有 turn 终态（complete / fail /
   * 超时 / handoff 投机）共用，消除此前分散在 task-flow / 委派 finally / 缺失的三套写入逻辑。
   *
   * collector 不存在（纯文本对话 / daemon 旧协议 / 已落库）则 no-op。失败仅 log，不阻塞对话收尾
   * （best-effort 持久化语义——落库失败不回滚已 resolve 的对话）。
   *
   * @param pending       本轮 pending request（含 sessionId/taskId/delegationTaskId/reasoning）
   * @param persistContent 入库文本（含可能的错误标签），同时作为 text block 的 draftResponse
   */
  persistInlineBlocks(pending: PendingRequest, persistContent: string): void {
    // collector key：委派/daemon/runtime 用 delegationTaskId（delegation-orchestrator:1690 赋值），
    // 纯 conversation agent（内置）用 taskId（task-flow telemetry 按 payload.taskId 建 collector）
    const key = pending.delegationTaskId ?? pending.taskId;
    try {
      // 有 collector（本轮有 telemetry：流式文本 / 工具 / 思考）→ dispose 取完整 Block[]（thinking→tool→text）
      let blocks: import('../contracts/message-blocks.js').Block[] | undefined;
      let messageId: string | undefined;
      if (key) {
        const collector = disposeBlockCollector(key);
        if (collector) {
          blocks = collector.buildBlocks({
            reasoning: pending.reasoning,
            draftResponse: persistContent,
          });
          messageId = collector.messageId;
        }
      }
      // 无 collector 或空 blocks（无 taskId / 立即返回未流式 / 错误路径 / 已落库）→ 降级单 text block。
      // 消灭双轨制后 conversations 不再兜底，此处是 assistant 唯一真相源——必须保证气泡必然落库。
      // persistContent 真空（不该发生）才跳过，避免空气泡。
      if ((!blocks || blocks.length === 0) && persistContent) {
        blocks = [{ type: 'text', text: persistContent }];
        messageId = genId('msg');
      }
      if (blocks && blocks.length > 0 && messageId) {
        persistAssistantTurn({
          messageId,
          sessionId: pending.sessionId,
          taskId: key,
          blocks,
        });
      }
    } catch (err) {
      logger.error({ err, sessionId: pending.sessionId, key }, 'persistInlineBlocks 落 blocks 失败（不阻塞对话收尾）');
    }
  }

  /**
   * 在 kernel 入口（handleMessage）创建 pending 之后立即落 user 行到 messages 表（doc 22）。
   *
   * 消灭双轨制：user 消息的唯一落库漏斗——经 persistUserMessage 写 messages(role:'user') + 一个 text block，
   * redact 走 appendBlock→serializeBlock 单漏斗（闭合双轨制遗留的 user 文本 secret 未脱敏点）。
   * 幂等由 clientMsgId 触发，与下游 conversation agent 的二次兜底去重。
   *
   * 失败时仅记 warn，不阻塞后续路由（fail-open：路由优先，
   * user 消息至少经过一次尝试；中断场景下仍能在 conversation agent 内部二次尝试时落盘）。
   */
  saveUserMessage(sessionId: string, content: string, options: { clientMsgId?: string } = {}): { id: string; deduplicated: boolean } {
    try {
      return persistUserMessage({ sessionId, content, clientMsgId: options.clientMsgId });
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

  // ─────────────────────────────────────────────────────────────
  // M2: PendingRequest 关键字段持久化（Kernel 重启后状态恢复）
  // ─────────────────────────────────────────────────────────────

  /** 持久化 pending request 关键字段到 SQLite */
  private persistRequestState(msgId: string, entry: PendingRequest): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO pending_request_state
          (msg_id, session_id, task_id, intent_anchor_json, level, reasoning, draft_preview, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msgId,
        entry.sessionId,
        entry.taskId ?? null,
        entry.intentAnchor ? JSON.stringify(entry.intentAnchor) : null,
        entry.level ?? null,
        entry.reasoning ?? null,
        entry.draftResponse ? safeSlice(entry.draftResponse, 500) : null,
        Date.now(),
      );
    } catch (err) {
      // 表可能还未迁移（兼容旧版）—— 静默失败，不影响主流程
      logger.debug({ err, msgId }, 'persistRequestState 失败（表可能不存在）');
    }
  }

  /** 从 SQLite 删除 pending request 状态 */
  private deleteRequestState(msgId: string): void {
    try {
      const db = getDb();
      db.prepare('DELETE FROM pending_request_state WHERE msg_id = ?').run(msgId);
    } catch (err) {
      logger.debug({ err, msgId }, 'deleteRequestState 失败（表可能不存在）');
    }
  }

  /**
   * M2: 启动时恢复 pending request 关键状态。
   * 仅恢复 intent_anchor 和 task_id 等持久化字段，不恢复闭包（resolve）。
   * 调用方应根据恢复的 metadata 决定是否重新触发对话。
   */
  recoverRequestStates(db: Database): { recovered: number } {
    try {
      const rows = db.prepare(
        'SELECT msg_id, session_id, task_id, intent_anchor_json, level, reasoning FROM pending_request_state',
      ).all() as Array<{
        msg_id: string; session_id: string; task_id: string | null;
        intent_anchor_json: string | null; level: string | null; reasoning: string | null;
      }>;
      let recovered = 0;
      for (const row of rows) {
        // 仅记录恢复日志（闭包无法恢复，留待调用方处理）
        logger.info({
          msgId: row.msg_id,
          sessionId: row.session_id,
          taskId: row.task_id,
          hasAnchor: !!row.intent_anchor_json,
        }, 'M2: 恢复 pending request 状态（仅 metadata）');
        recovered++;
      }
      return { recovered };
    } catch (err) {
      // 表不存在时静默返回
      logger.debug({ err }, 'recoverRequestStates 失败（表可能不存在）');
      return { recovered: 0 };
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

    // R14-2：原 SQL 漏取 session_id，导致 stale task 标记后无法定位对应会话的 user 行。
    // 现在需要：标记 stale task + 写 [系统] 兜底行到对应 session 的 messages 表
    // （消灭双轨制后 conversations 退役，[系统] 行经 persistAssistantTurn 落 messages+message_blocks；
    //  替代 OrphanReconciler 后台扫表的兜底职责）
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
        // 对话内联（doc 22）：[系统] 兜底行落 messages 表（消灭双轨制后 conversations 不再是读取源）
        try {
          persistAssistantTurn({
            messageId: genId('msg'),
            sessionId: task.session_id,
            blocks: [{ type: 'text', text: '[系统] 上次权限请求因服务重启被自动拒绝，请重新发起' }],
          });
        } catch (err) {
          logger.warn({ err, taskId: task.id }, 'recoverSessions 写 [系统] 行失败（不影响任务状态）');
        }
        denied++;
      } else {
        db.prepare(`UPDATE agent_tasks SET status = 'timeout', error = ?, finished_at = ? WHERE id = ?`)
          .run('任务因服务重启被标记为超时', now, task.id);
        // R14-2：写入点兜底——标记 stale task 同时 [系统] 行落 messages（conversations 已退役）
        try {
          persistAssistantTurn({
            messageId: genId('msg'),
            sessionId: task.session_id,
            blocks: [{ type: 'text', text: '[系统] 上次回复因服务重启未完成，请重新提问' }],
          });
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
   * 在 DB 关闭后触发持久化（persistAssistantTurn）失败。
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
        // 15.0 R2-4：通知外部清理 per-session 状态（PermissionCoordinator.clearSessionMode），
        // 防止 sessionModes 随 session 累积无界增长。
        this.onSessionGc?.(sessionId);
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
