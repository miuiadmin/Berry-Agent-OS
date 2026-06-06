import { join } from 'node:path';
import type { AgentManager } from './agent-manager.js';
import type { AgentRegistry } from './agent-registry.js';
import type { TaskManager } from './task-manager.js';
import type { AgentProgress } from './agent-progress.js';
import type { TaskRouter } from './task-router.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { AuditRecorder } from './audit-recorder.js';
import type { SessionManager, PendingRequest } from './session-manager.js';
import type { TakeoverController } from '../testing/model-takeover.js';
import type { CapabilityService } from '../evolution/index.js';
import type { DaemonBridge } from './daemon-bridge.js';
import type { MemoryRuntime } from '../memory/index.js';
import { getDb } from '../memory/index.js';
import type { IPluginRuntimeV2 } from '../contracts/plugins-v2.js';
import type { WorkspaceRouter } from './workspace-router.js';
import type { RuntimeRegistry } from './runtime/runtime-registry.js';
import type { AgentRuntime, AgentEvent, ExecutionTask } from '../contracts/agent-runtime.js';
import type { RuntimeExecutor } from './runtime/runtime-executor.js';
import { DelegationManager } from './delegation-manager.js';
import { DialogueRouter } from './dialogue-router.js';
import { FallbackRouter } from './fallback-router.js';
import { CorrectionFlow } from './flows/correction-flow.js';
import { SuperiorReviewFlow } from './flows/superior-review-flow.js';
import { PermissionFlow } from './flows/permission-flow.js';
import { StreamingFlusher } from './streaming-flusher.js';
import {
  setupTaskProgressHandler,
  setupTaskAcknowledgeHandlers,
  setupTaskTelemetryHandler,
  setupModuleTaskResultHandler,
  type TaskFlowDeps,
} from './flows/task-flow.js';
import {
  setupAuditHandler,
  setupMemoryHandlers,
  setupCapabilityHandler,
  setupModelOverrideHandler,
  setupTakeoverRouting,
  setupBusHandlers,
  type ProxyHandlersDeps,
} from './flows/proxy-handlers.js';
import { closeTaskWorkspace } from './task-workspace.js';
import { getAgentHomePath } from './agent-home.js';
import { classifyLevel } from '../contracts/review.js';
import { buildAvailableAgentsList } from './agent-registry.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import { getTracer } from '../observability/tracer.js';
import { getEventBus } from './event-bus.js';
import { withTrace, getCurrentTrace } from '../observability/trace-context.js';
import { BrainDecisionRecorder } from './brain-decision-recorder.js';
import type { IpcMessageType, IpcMessage } from './types.js';
import type { SocketProgressEvent } from '../contracts/socket-protocol.js';
import type { RouteDecision, RouteResultPayload, RouteRequestPayload } from '../contracts/routing.js';
import type { PermissionJudgeResultPayload, AgentAskUserPayload, AgentUserReplyPayload } from '../contracts/routing.js';
import type { DraftResponsePayload, FinalResponsePayload } from '../contracts/messaging.js';
import type { ReviewResult, TurnRecord } from '../contracts/review.js';
import type { PermissionRequestPayload, PermissionValidatePayload, PermissionConsumePayload, PermissionAcquirePayload } from '../contracts/permissions.js';
import type { AgentTaskPayload, AgentTaskResultPayload, TaskAcknowledgePayload, TaskStartedPayload, TaskProgressPayload, TaskTelemetryPayload } from '../contracts/tasks.js';
import type { CorrectionConstraints } from '../contracts/delegation.js';
import type { DangerLevel } from '../utils/types.js';
import type { ICapabilityBus } from '../bus/contract.js';
import type { WorldModelRuntime } from './world-model.js';
import type { SuggestionQueue } from './suggestion-queue.js';

const logger = getLogger('orchestrator');

const DISPATCH_RETRY_MS = 3000;

type ReviewOrigin = 'conversation' | 'task' | 'superior_chain';

interface AgentIpc {
  onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

// ─── CorrectionFlow dependency interface ───────────────
export interface CorrectionFlowDeps {
  readonly agentManager: AgentManager;
  readonly registry: AgentRegistry;
  readonly delegationManager: DelegationManager;
  readonly sessionManager: SessionManager;
  readonly daemonBridge: DaemonBridge | null;
  sendRouteRequest(payload: RouteRequestPayload, correlationId: string): void;
}

// ═══════════════════════════════════════════════════════
// DelegationOrchestrator
// ═══════════════════════════════════════════════════════

export class DelegationOrchestrator implements CorrectionFlowDeps {
  // ─── Dependencies ─────────────────────────────────
  readonly agentManager: AgentManager;
  readonly registry: AgentRegistry;
  private taskManager: TaskManager;
  private taskRouter: TaskRouter;
  private permissionCoordinator: PermissionCoordinator;
  private auditRecorder: AuditRecorder;
  readonly sessionManager: SessionManager;
  private agentProgress: AgentProgress | null;
  private capabilityService: CapabilityService | null;
  private takeoverController: TakeoverController | null;
  private memoryRuntime: MemoryRuntime;

  // ─── Internal state ───────────────────────────────
  private setupAgentIpcs = new WeakSet<object>();
  private pendingReviewOrigins = new Map<string, ReviewOrigin>();
  readonly delegationManager: DelegationManager;
  private correctionFlow: CorrectionFlow;
  private fallbackRouter = new FallbackRouter();
  daemonBridge: DaemonBridge | null = null;
  pluginRuntimeV2: IPluginRuntimeV2 | null = null;
  workspaceRouter: WorkspaceRouter | null = null;
  private superiorReviewFlow: SuperiorReviewFlow | null = null;
  private runtimeRegistry: RuntimeRegistry | null = null;
  private runtimeExecutor: RuntimeExecutor | null = null;
  private brainDecisionRecorder: BrainDecisionRecorder | null = null;
  private capabilityBusRef: ICapabilityBus | null = null;
  private worldModelRef: WorldModelRuntime | null = null;
  private suggestionQueueRef: SuggestionQueue | null = null;
  /** 智能体间对话路由器（11.0） */
  dialogueRouter: DialogueRouter | null = null;
  /** 12.0 漂移检测器 */
  driftDetector: import('./drift-detector.js').DriftDetector | null = null;

  // Permission judge state
  private permissionFlow: PermissionFlow;
  /** 流式内容定时刷写器（将 text_delta 累积内容持久化到 SQLite 供断连恢复） */
  private streamingFlusher: StreamingFlusher;

  constructor(deps: {
    agentManager: AgentManager;
    registry: AgentRegistry;
    taskManager: TaskManager;
    taskRouter: TaskRouter;
    permissionCoordinator: PermissionCoordinator;
    auditRecorder: AuditRecorder;
    sessionManager: SessionManager;
    agentProgress: AgentProgress | null;
    capabilityService: CapabilityService | null;
    takeoverController: TakeoverController | null;
    memoryRuntime: MemoryRuntime;
  }) {
    this.agentManager = deps.agentManager;
    this.registry = deps.registry;
    this.taskManager = deps.taskManager;
    this.taskRouter = deps.taskRouter;
    this.permissionCoordinator = deps.permissionCoordinator;
    this.auditRecorder = deps.auditRecorder;
    this.sessionManager = deps.sessionManager;
    this.agentProgress = deps.agentProgress;
    this.capabilityService = deps.capabilityService;
    this.takeoverController = deps.takeoverController;
    this.memoryRuntime = deps.memoryRuntime;
    this.delegationManager = new DelegationManager(deps.taskManager);
    this.correctionFlow = new CorrectionFlow(this);
    this.brainDecisionRecorder = new BrainDecisionRecorder(getDb());
    this.permissionFlow = new PermissionFlow({
      permissionCoordinator: deps.permissionCoordinator,
      registry: deps.registry,
      agentManager: deps.agentManager,
      sessionManager: deps.sessionManager,
      brainDecisionRecorder: this.brainDecisionRecorder,
    });
    this.streamingFlusher = new StreamingFlusher(deps.taskManager);
  }

  get delegation(): DelegationManager { return this.delegationManager; }
  get fallback(): FallbackRouter { return this.fallbackRouter; }

  setSuperiorReviewFlow(flow: SuperiorReviewFlow): void {
    this.superiorReviewFlow = flow;
  }

  setRuntimeRegistry(registry: RuntimeRegistry): void {
    this.runtimeRegistry = registry;
  }

  setRuntimeExecutor(executor: RuntimeExecutor): void {
    this.runtimeExecutor = executor;
  }

  setCapabilityBus(bus: ICapabilityBus): void {
    this.capabilityBusRef = bus;
    // Wire Bus handlers to primary agent
    const primaryAgent = this.registry.requireRole('primary');
    const primary = this.agentManager.getAgent(primaryAgent.manifest.name);
    if (primary) {
      setupBusHandlers(primary.ipc, primaryAgent.manifest.name, bus);
    }
  }

  setWorldModel(worldModel: WorldModelRuntime): void {
    this.worldModelRef = worldModel;
  }

  setSuggestionQueue(queue: SuggestionQueue): void {
    this.suggestionQueueRef = queue;
  }

  /**
   * 关闭清理：同步刷写未持久化的流式内容到 SQLite，防止进程退出丢失数据。
   * 必须在 taskManager.dispose() 之前调用（flusher 依赖 taskManager.flushStreamingContent）。
   */
  dispose(): void {
    this.streamingFlusher.dispose();
    this.pendingReviewOrigins.clear();
  }

  private get proxyDeps(): ProxyHandlersDeps {
    return {
      auditRecorder: this.auditRecorder,
      sessionManager: this.sessionManager,
      capabilityService: this.capabilityService,
      takeoverController: this.takeoverController,
      memoryRuntime: this.memoryRuntime,
    };
  }

  private get taskFlowDeps(): TaskFlowDeps {
    return {
      taskManager: this.taskManager,
      delegationManager: this.delegationManager,
      sessionManager: this.sessionManager,
      agentProgress: this.agentProgress,
      registry: this.registry,
      agentManager: this.agentManager,
      streamingFlusher: this.streamingFlusher,
    };
  }

  // ═══ LIFECYCLE ════════════════════════════════════

  setup(): void {
    const reviewerAgent = this.registry.requireRole('reviewer');
    const primaryAgent = this.registry.requireRole('primary');
    const reviewerName = reviewerAgent.manifest.name;
    const primaryName = primaryAgent.manifest.name;

    const primary = this.agentManager.getAgent(primaryName);
    const reviewer = this.agentManager.getAgent(reviewerName);

    if (!primary || !reviewer) {
      throw new Error('必要智能体启动失败');
    }

    this.setupReviewFlow(primary.ipc, reviewer.ipc, primaryName, reviewerName);
    this.setupRoutingFlow(reviewer.ipc);
    this.permissionFlow.setupJudgeHandler(reviewer.ipc);
    this.correctionFlow.setup(reviewer.ipc);
    this.superiorReviewFlow?.setup(reviewer.ipc);
    this.superiorReviewFlow?.setCallbacks({
      onCompleted: (correlationId, modifiedResponse) => {
        this.onSuperiorChainCompleted(correlationId, modifiedResponse, reviewer.ipc, reviewerName);
      },
      onRejected: (correlationId, reason) => {
        this.onSuperiorChainRejected(correlationId, reason);
      },
    });
    this.setupAgentAskUserFlow(reviewer.ipc);
    this.permissionFlow.setupHandlers(primary.ipc, primaryName, true);
    setupAuditHandler(primary.ipc, primaryName, this.proxyDeps);
    setupMemoryHandlers(primary.ipc, primaryName, this.proxyDeps);
    setupCapabilityHandler(primary.ipc, primaryName, this.proxyDeps);
    setupModelOverrideHandler(primary.ipc, primaryName, this.proxyDeps);
    this.setupTaskHandlers(primary.ipc, primaryName);
    setupTakeoverRouting(primary.ipc, primaryName, this.proxyDeps);
    setupTakeoverRouting(reviewer.ipc, reviewerName, this.proxyDeps);

    // ─── 11.0 dialogue 路由 ───
    this.dialogueRouter = new DialogueRouter({
      db: getDb(),
      sessionManager: this.sessionManager,
      getAgentIpc: (agentName: string) => {
        const agent = this.agentManager.getAgent(agentName);
        return agent?.ipc ?? undefined;
      },
      getBrainIpc: () => reviewer?.ipc ?? undefined,
    });
    this.dialogueRouter.startSweep();
    this.setupDialogueHandlers(primary.ipc, primaryName);

    // 11.0: Brain 通过 dialogue.observe 监听后可能发 turn.correction 纠偏
    // 转发给 Conversation Agent 处理（Brain → Core → Conversation）
    reviewer.ipc.onMessage('turn.correction', (msg: IpcMessage) => {
      const payload = msg.payload as { delegationId: string; action: string; instruction: string };
      // 对于 dialogue 模式的纠偏，转发给 Conversation Agent
      primary.ipc.send('turn.correction', primaryName, payload, msg.correlationId);
      logger.debug({ dialogueId: payload.delegationId, action: payload.action }, 'dialogue:brain correction forwarded');
    });
  }

  setupDaemonEvents(): void {
    this.setupDaemonTaskResultHandlers();
  }

  /**
   * 11.0: 注册 dialogue.send / dialogue.reply 的 IPC 处理器。
   * - dialogue.send 来自 Conversation Agent，需要路由到目标 Agent
   * - dialogue.reply 来自目标 Agent，需要转发回 Conversation Agent
   */
  private setupDialogueHandlers(primaryIpc: AgentIpc, primaryName: string): void {
    if (!this.dialogueRouter) return;
    const router = this.dialogueRouter;

    // Conversation 发来 dialogue.send → 确保目标 agent 已启动 → 路由
    primaryIpc.onMessage('dialogue.send', async (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueMessagePayload;

      // 首次对话：在 DialogueRouter 中注册对话状态
      let state = router.getDialogue(payload.dialogueId);
      if (!state) {
        // 通过 correlationId 找到当前请求的 pending（精确匹配，非 O(n) 遍历）
        const correlationId = msg.correlationId ?? msg.id;
        const pending = this.sessionManager.getPending(correlationId);
        state = router.registerDialogue(payload.dialogueId, {
          sessionId: pending?.sessionId ?? 'unknown',
          correlationId,
          initiator: payload.from,
          target: payload.to,
        });
      }

      // 确保目标 agent 已启动（on-demand agents 需要 ensureAgent）
      await this.agentManager.ensureAgent(payload.to);
      // 11.0 关键：注册 kernel 侧的 IPC handler（dialogue.reply、permission 等）
      // 否则目标 Agent 的 reply 无人接收，导致 60s 超时
      this.setupModuleAgent(payload.to);

      // 获取 pending（仅用于从 correlationId 读 sessionId；不再用于 socket 直写）
      const pending = this.sessionManager.getPending(state!.correlationId);

      // 推送前端事件：对话开始/新一轮
      // H1/H2: 改为 emit，由 WsEventBridge 订阅 EventBus 并转发到 WS 客户端
      getEventBus().emit('dialogue.status', {
        dialogueId: payload.dialogueId,
        sessionId: pending?.sessionId ?? state!.sessionId,
        status: state!.currentRound === 0 ? 'started' : 'round_complete',
        from: payload.from,
        to: payload.to,
        round: state!.currentRound,
      });

      try {
        // sendMessage：H1/H2 后不再接受 socket 参数；流式推送走 EventBus → WsEventBridge
        const reply = await router.sendMessage(payload);
        // 转发 reply 给 Conversation
        primaryIpc.send('dialogue.reply', primaryName, reply, payload.dialogueId);
      } catch (err) {
        // 超时或错误 → 构造错误 reply 返回给 Conversation
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: payload.to,
          to: payload.from,
          content: `[对话错误] ${(err as Error).message}`,
          metadata: { isFinal: true },
        };
        primaryIpc.send('dialogue.reply', primaryName, errorReply, payload.dialogueId);

        // 推送前端：对话结束（错误）— 同样走 EventBus
        getEventBus().emit('dialogue.status', {
          dialogueId: payload.dialogueId,
          sessionId: pending?.sessionId ?? state!.sessionId,
          status: 'ended',
          from: payload.from,
          to: payload.to,
          round: state!.currentRound,
        });
      }
    });

    // Conversation 主动结束对话
    primaryIpc.onMessage('dialogue.end', (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueEndPayload;
      if (this.dialogueRouter) {
        this.dialogueRouter.closeDialogue(payload.dialogueId, payload.reason ?? 'completed');
      }
    });

    // 权限确认期间暂停 dialogue 超时（防止用户决策期间误超时）
    // 不需要显式恢复：dialogue.reply 到达时 handleReply 会 clearReplyTimer，
    // 权限拒绝/超时后 Code Agent 也会立即发回 reply
    if (this.dialogueRouter) {
      const router = this.dialogueRouter;
      getEventBus().on('permission.user_confirm_needed', ({ sessionId }) => {
        for (const d of router.getActiveDialoguesForSession(sessionId)) {
          router.pauseTimeout(d.dialogueId);
        }
      });
    }

    // dialogue.reply 的接收在 setupModuleAgent 中注册（每个 on-demand agent 启动时）
  }

  setupModuleAgent(agentName: string): void {
    const agent = this.agentManager.getAgent(agentName);
    if (!agent) return;
    if (this.setupAgentIpcs.has(agent.ipc)) return;
    this.setupAgentIpcs.add(agent.ipc);

    this.setupTaskResultHandlers(agent.ipc, agentName);
    this.permissionFlow.setupHandlers(agent.ipc, agentName, false);
    setupAuditHandler(agent.ipc, agentName, this.proxyDeps);
    setupTakeoverRouting(agent.ipc, agentName, this.proxyDeps);
    if (this.capabilityBusRef) {
      setupBusHandlers(agent.ipc, agentName, this.capabilityBusRef);
    }
    // 11.0: 注册 dialogue.reply handler（module agent 回复对话消息时触发）
    if (this.dialogueRouter) {
      const router = this.dialogueRouter;
      agent.ipc.onMessage('dialogue.reply', (msg: IpcMessage) => {
        const payload = msg.payload as import('../contracts/dialogue.js').DialogueMessagePayload;
        router.handleReply(payload);
      });
    }
  }

  // ═══ PUBLIC API ═══════════════════════════════════

  // Track speculative execution state (conversation started before Brain routing confirms)
  private speculativeCorrelations = new Set<string>();
  private pendingHandoffs = new Map<string, RouteDecision>();

  sendRouteRequest(payload: RouteRequestPayload, correlationId: string): void {
    withTrace('router.sendRouteRequest', () => {
      // In test/takeover mode, use synchronous Brain routing (preserves test expectations)
      if (this.takeoverController) {
        this.sendRouteRequestSync(payload, correlationId);
        return;
      }

      // §9.0 Rule-first routing: try FallbackRouter before Brain LLM
      const ruleDecision = this.fallbackRouter.route(payload.message);
      if (ruleDecision.intent !== 'chat') {
        // High confidence rule match (code/skill/plugin) → dispatch directly, skip Brain
        logger.info({ intent: ruleDecision.intent, target: ruleDecision.targetAgent }, '规则路由命中，跳过 Brain');
        const pending = this.sessionManager.getPending(correlationId);
        if (pending) {
          this.brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, { ...ruleDecision, source: 'rule' } as unknown as Record<string, unknown>);
          getEventBus().emit('message.routed', { sessionId: pending.sessionId, taskId: pending.taskId ?? correlationId, targetAgent: ruleDecision.targetAgent, intent: ruleDecision.intent });
        }
        this.handleRouteDecision(ruleDecision, correlationId);
        return;
      }

      // No rule match → speculative execution: start conversation immediately
      const pending = this.sessionManager.getPending(correlationId);
      if (pending) {
        this.speculativeCorrelations.add(correlationId);
        const chatDecision: RouteDecision = { intent: 'chat', targetAgent: 'conversation', priority: 'normal', reason: 'speculative: conversation started while Brain routing' };
        this.handleChatRoute(chatDecision, correlationId, pending);
      }

      // Send Brain routing in parallel (for learning + possible handoff)
      const orchestratorAgent = this.registry.requireRole('orchestrator');
      const orchestratorName = orchestratorAgent.manifest.name;
      const brain = this.agentManager.getAgent(orchestratorName);
      if (!brain) {
        // Brain not available → speculative execution continues as-is
        this.speculativeCorrelations.delete(correlationId);
        return;
      }

      // Enrich context for Brain (memory, world model, suggestions, capabilities)
      let enrichedPayload = { ...payload };

      const memoryFrame = this.sessionManager.buildMemoryContext(enrichedPayload.sessionId, enrichedPayload.message);
      if (memoryFrame?.records && memoryFrame.records.length > 0) {
        const memoryHints = memoryFrame.records.slice(0, 5).map((r: any) => r.summary ?? r.content).join('; ');
        enrichedPayload = { ...enrichedPayload, sessionContext: (enrichedPayload.sessionContext ?? '') + `\n\n[用户记忆] ${memoryHints}` };
      }

      if (this.worldModelRef) {
        const worldSummary = this.worldModelRef.getSummary();
        if (worldSummary) {
          enrichedPayload = { ...enrichedPayload, sessionContext: enrichedPayload.sessionContext ? `${enrichedPayload.sessionContext}\n\n[世界模型] ${worldSummary}` : `[世界模型] ${worldSummary}` };
        }
      }

      if (this.suggestionQueueRef) {
        const suggestionsBlock = this.suggestionQueueRef.buildPromptBlock(enrichedPayload.sessionId);
        if (suggestionsBlock) {
          enrichedPayload = { ...enrichedPayload, sessionContext: (enrichedPayload.sessionContext ?? '') + suggestionsBlock };
        }
      }

      if (this.capabilityBusRef) {
        const capabilities = this.capabilityBusRef.discover();
        if (capabilities.length > 0) {
          const capList = capabilities.slice(0, 30).map(c => `${c.name} (${c.dangerLevel})`).join(', ');
          enrichedPayload = { ...enrichedPayload, sessionContext: (enrichedPayload.sessionContext ?? '') + `\n\n[可用能力] ${capList}` };
        }
      }

      brain.ipc.send('route.request', orchestratorName, enrichedPayload, correlationId);
    });
  }

  private sendRouteRequestSync(payload: RouteRequestPayload, correlationId: string): void {
    const orchestratorAgent = this.registry.requireRole('orchestrator');
    const orchestratorName = orchestratorAgent.manifest.name;
    const brain = this.agentManager.getAgent(orchestratorName);
    if (!brain) {
      this.handleRouteFallback(correlationId);
      return;
    }
    brain.ipc.send('route.request', orchestratorName, payload, correlationId);
  }

  sendUserReply(payload: AgentUserReplyPayload, correlationId: string): void {
    const askState = this.sessionManager.getPendingAsk(payload.sessionId);
    if (!askState) return;

    const agent = this.agentManager.getAgent(askState.agentName);
    if (!agent) return;

    this.delegationManager.resumeFromUserReply(askState.taskId);
    this.sessionManager.clearPendingAsk(payload.sessionId);
    agent.ipc.send('agent.user_reply', askState.agentName, payload, correlationId);
  }

  requestPermissionJudge(input: {
    sessionId: string;
    agentName: string;
    toolName: string;
    toolInput: string;
    dangerLevel: DangerLevel;
    taskContext?: string;
  }): Promise<PermissionJudgeResultPayload> {
    return withTrace('router.requestPermissionJudge', () => this.permissionFlow.requestJudge(input));
  }

  resolveUserPermissionConfirm(requestId: string, approved: boolean, reason?: string): boolean {
    const resolved = this.permissionFlow.resolveUserConfirm(requestId, approved, reason);
    if (!resolved) return false;

    this.permissionCoordinator.resolve(requestId, {
      verdict: approved ? 'approved' : 'denied',
      source: 'user',
      reason: reason ?? (approved ? '用户确认' : '用户拒绝'),
    });

    if (!approved && reason) {
      this.brainDecisionRecorder?.record({
        sessionId: 'user_permission',
        decisionType: 'permission',
        inputSummary: `user denied permission`,
        outputJson: { denied: true, userReason: reason },
      });
      this.brainDecisionRecorder?.updateLesson(requestId, reason);
    }

    return true;
  }

  async dispatchModuleTask(input: {
    sessionId: string;
    taskType: string;
    requester: string;
    inputPayload: Record<string, unknown>;
    foreground?: boolean;
    correlationId?: string;
  }): Promise<{ taskId: string; targetAgent: string }> {
    return withTrace('router.dispatchModuleTask', () => this.dispatchModuleTaskInternal(input));
  }

  interruptSession(sessionId: string, reason?: string): { interrupted: boolean; taskId?: string; partialResponse?: string } {
    const activeEntries = this.delegationManager.getActiveForSession(sessionId);
    if (activeEntries.length === 0) return { interrupted: false };

    for (const entry of activeEntries) {
      this.delegationManager.interrupt(entry.id, reason ?? 'user interrupt');
    }

    const primary = activeEntries[0];
    const pending = this.sessionManager.getPending(primary.correlationId);
    if (pending) {
      this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
      const partialResponse = pending.draftResponse ?? primary.finalResponse;
      // R4-P1：中断场景下 partial text 入库，避免用户刷新丢失 partial
      // 标记 [已停止] 让用户知道回复未完成
      const stopMarker = '[已停止]';
      const resolvedResponse = partialResponse ?? stopMarker;
      const persistContent = partialResponse
        ? `${partialResponse}\n\n${stopMarker}`
        : stopMarker;
      this.sessionManager.resolvePending(primary.correlationId, resolvedResponse, { contentOverride: persistContent });
    }

    // 清理投机执行状态，防止 memory leak 和 stale handoff
    this.speculativeCorrelations.delete(primary.correlationId);
    this.pendingHandoffs.delete(primary.correlationId);

    return {
      interrupted: true,
      taskId: primary.id,
      partialResponse: primary.finalResponse,
    };
  }

  sweepStaleTasks(maxAgeMs: number = 600_000): number {
    return this.delegationManager.sweepStale(maxAgeMs);
  }

  failDelegationsByAgent(agentName: string, error: string): number {
    return this.delegationManager.failByAgent(agentName, error);
  }

  // ═══ ROUTING ══════════════════════════════════════

  private setupRoutingFlow(reviewerIpc: AgentIpc): void {
    reviewerIpc.onMessage('route.result', (msg: IpcMessage) => {
      const { decision } = msg.payload as RouteResultPayload;
      const correlationId = msg.correlationId!;
      logger.info({ correlationId, intent: decision.intent, target: decision.targetAgent }, '路由决策到达');

      const pending = this.sessionManager.getPending(correlationId);
      if (pending) {
        this.fallbackRouter.recordBrainDecision(pending.userMessage, decision);
        this.brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, decision as unknown as Record<string, unknown>);
        // 12.0: 填充意图锚点到 pending（漂移检测基准）并持久化
        if (decision.intentAnchor) {
          pending.intentAnchor = decision.intentAnchor;
          this.driftDetector?.recordAnchor(
            decision.intentAnchor, pending.userMessage,
            pending.sessionId, correlationId, decision.reason,
          );
        }
        if (decision.reason) {
          this.reportProgress(pending, 'routing', `brain → ${decision.targetAgent}: ${decision.reason}`);
        }
        getEventBus().emit('message.routed', {
          sessionId: pending.sessionId,
          taskId: pending.taskId ?? correlationId,
          targetAgent: decision.targetAgent,
          intent: decision.intent,
        });
      }

      // §9.0 Speculative execution: conversation already started
      if (this.speculativeCorrelations.has(correlationId)) {
        this.speculativeCorrelations.delete(correlationId);
        if (decision.intent === 'chat' || decision.targetAgent === 'conversation') {
          logger.debug({ correlationId }, 'speculative execution confirmed: conversation');
          return;
        }
        // Brain says different agent → store handoff for when conversation finishes
        this.pendingHandoffs.set(correlationId, decision);
        logger.info({ correlationId, handoffTo: decision.targetAgent }, 'speculative handoff queued');
        return;
      }

      // If pending is gone and no speculative marker, the conversation already finished
      // (late Brain response) — ignore to avoid stale routing
      if (!pending) {
        logger.debug({ correlationId, intent: decision.intent }, 'late route.result after conversation finished, ignored');
        return;
      }

      this.handleRouteDecision(decision, correlationId);
    });
  }

  private handleRouteDecision(decision: RouteDecision, correlationId: string): void {
    const span = getTracer().startTrace('routing.decision', {
      intent: decision.intent,
      targetAgent: decision.targetAgent,
      correlationId,
    });

    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) {
      logger.warn({ correlationId }, '路由决策找不到对应的 pending request');
      span.setStatus('error', 'pending not found');
      span.end();
      return;
    }

    // §2.2 Execute setup pre-actions before routing
    if (decision.setup && decision.setup.length > 0) {
      for (const action of decision.setup) {
        try {
          this.executeSetupAction(action);
        } catch (err) {
          logger.error({ err, action: action.action }, 'Setup action failed');
        }
      }
    }

    // §2.8 Apply PermissionScope if provided
    if (decision.scope && this.capabilityBusRef) {
      const gate = this.capabilityBusRef.getPermissionGate();
      if (gate?.setScope) {
        gate.setScope(pending.sessionId, { ...decision.scope, issuedAt: Date.now() });
      }
    }

    switch (decision.intent) {
      case 'chat':
        this.handleChatRoute(decision, correlationId, pending);
        break;
      case 'code':
      case 'skill_test':
      case 'learning':
      case 'plugin':
        this.handleTaskRoute(decision, correlationId, pending);
        break;
      case 'external':
        this.handleExternalRoute(decision, correlationId, pending);
        break;
      case 'multi':
        this.handleMultiRoute(decision, correlationId, pending);
        break;
      case 'workspace':
        this.handleWorkspaceRoute(decision, correlationId, pending);
        break;
      default:
        this.handleChatRoute(decision, correlationId, pending);
    }

    span.end();
  }

  private handleRouteFallback(correlationId: string, userMessage?: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    const message = userMessage ?? pending.userMessage;
    const decision = this.fallbackRouter.route(message);
    logger.info({ correlationId, intent: decision.intent }, '降级路由生效');
    this.handleRouteDecision(decision, correlationId);
  }

  private executeSetupAction(action: { action: string; params: unknown }): void {
    switch (action.action) {
      case 'create_agent':
        logger.info({ params: action.params }, 'Setup: creating dynamic agent');
        break;
      case 'activate_skill':
        logger.info({ params: action.params }, 'Setup: activating skill');
        break;
      case 'enable_plugin':
        logger.info({ params: action.params }, 'Setup: enabling plugin');
        break;
      default:
        logger.warn({ action: action.action }, 'Unknown setup action');
    }
  }

  private loadActiveSkills(skillNames: string[]): string | null {
    try {
      const { SkillsRegistry } = require('../skills/index.js');
      const { scanContextFile } = require('../safety/context-file-scanner.js');
      const registry = new SkillsRegistry(getDb());
      const parts: string[] = [];
      for (const name of skillNames.slice(0, 5)) {
        const skill = registry.get(name);
        if (skill?.content) {
          const scan = scanContextFile(skill.content);
          if (!scan.safe) {
            logger.warn({ skill: name, threats: scan.threats }, 'Skill content blocked: injection detected');
            continue;
          }
          parts.push(`--- Skill: ${name} ---\n${skill.content}`);
        }
      }
      return parts.length > 0 ? parts.join('\n\n') : null;
    } catch {
      return null;
    }
  }

  private handleChatRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): void {
    const primaryAgent = this.registry.requireRole('primary');
    const primaryName = primaryAgent.manifest.name;
    const primary = this.agentManager.getAgent(primaryName);
    if (!primary) {
      this.sessionManager.resolvePending(correlationId, '[系统错误] 对话智能体不可用');
      return;
    }

    this.pendingReviewOrigins.set(correlationId, 'conversation');
    this.reportProgress(pending, 'thinking', '正在思考...');

    let systemPrompt = this.sessionManager.buildPrompt(pending.sessionId);
    const memoryContext = this.sessionManager.buildMemoryContext(pending.sessionId, pending.userMessage);

    // 崩溃恢复：注入未完成对话的摘要（Conversation 重启后不丢失上下文）
    if (this.dialogueRouter) {
      const recovery = this.dialogueRouter.getRecentUnfinishedSummary(pending.sessionId);
      if (recovery) {
        systemPrompt += `\n\n## 上次未完成的智能体对话\n\n${recovery}\n\n如果用户希望继续，可以通过 dialogue 工具恢复协作。`;
      }
    }

    // §8.9 Skill activation: inject active Skills into system prompt
    if (decision.activeSkills && decision.activeSkills.length > 0) {
      const skillContent = this.loadActiveSkills(decision.activeSkills);
      if (skillContent) {
        systemPrompt += `\n\n${skillContent}`;
      }
    }

    primary.ipc.send('user.message', primaryName, {
      sessionId: pending.sessionId,
      message: pending.userMessage,
      taskId: pending.taskId,
      systemPrompt,
      memoryContext,
      instruction: decision.instruction,
      intent: decision.intent,
      modelTierOverride: decision.modelTier,
    }, correlationId);
  }

  private async handleTaskRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    const taskTypeMap: Record<string, string> = {
      code: 'code_task',
      skill_test: 'skill_test',
      learning: 'learning_review',
      plugin: 'plugin_task',
    };
    const taskType = taskTypeMap[decision.intent] ?? 'conversation_turn';

    this.reportProgress(pending, 'dispatching', `正在分发给 ${decision.targetAgent}...`);

    try {
      const { getLastCwd } = await import('../tools/shell.js');
      const { taskId } = await this.dispatchModuleTaskInternal({
        sessionId: pending.sessionId,
        taskType,
        requester: 'brain-route',
        inputPayload: {
          message: pending.userMessage,
          instruction: decision.instruction,
          contextHints: decision.contextHints,
          workingDir: getLastCwd(),
        },
        foreground: true,
        correlationId,
      });
      // 关联新 taskId 到 pending（供 flusher/rebind 使用）
      pending.delegationTaskId = taskId;
      if (pending.taskId) {
        this.taskManager.complete(pending.taskId, { delegatedTo: taskId });
      }
    } catch (err) {
      logger.error({ err, decision }, '任务路由分发失败，fallback 到对话');
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
    }
  }

  private async handleExternalRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    // New path: try RuntimeRegistry first
    if (this.runtimeRegistry) {
      const runtime = this.resolveRuntimeForTarget(decision.targetAgent);
      if (runtime) {
        return this.executeViaRuntime(runtime, decision, correlationId, pending);
      }
    }

    // Legacy path: direct daemon bridge dispatch
    if (!this.daemonBridge?.isAvailable) {
      logger.warn({ correlationId }, 'External route requested but daemon not available, fallback to chat');
      this.reportProgress(pending, 'routing', '外部智能体不可用，转为对话处理...');
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
      return;
    }

    this.reportProgress(pending, 'dispatching', `正在分发给外部智能体 ${decision.targetAgent}...`);

    const taskId = this.delegationManager.create({
      sessionId: pending.sessionId,
      correlationId,
      targetAgent: '__daemon__',
      targetKind: 'daemon',
      userMessage: pending.userMessage,
      taskType: 'external_code_task',
      requester: 'brain-route',
      inputPayload: {
        message: pending.userMessage,
        instruction: decision.instruction,
        contextHints: decision.contextHints,
      },
      foreground: true,
    });

    // 记录委托 task ID，供 flusher 清理使用
    pending.delegationTaskId = taskId;

    const dispatched = await this.daemonBridge.dispatch(taskId, {
      prompt: pending.userMessage,
      systemPrompt: decision.instruction,
    }, decision.targetAgent);

    if (!dispatched) {
      this.delegationManager.fail(taskId, 'Daemon dispatch failed');
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
      return;
    }

    if (pending.taskId) {
      this.taskManager.complete(pending.taskId, { delegatedTo: taskId });
    }
  }

  private resolveRuntimeForTarget(targetAgent: string): AgentRuntime | null {
    if (!this.runtimeRegistry) return null;

    const providerMap: Record<string, string> = {
      'claude-code': 'claude_code',
      'opencode': 'opencode',
    };
    const provider = providerMap[targetAgent];
    if (provider) {
      return this.runtimeRegistry.get(provider as import('../contracts/agent-runtime.js').RuntimeProvider) ?? null;
    }
    return null;
  }

  private async executeViaRuntime(
    runtime: AgentRuntime,
    decision: RouteDecision,
    correlationId: string,
    pending: PendingRequest,
  ): Promise<void> {
    this.reportProgress(pending, 'dispatching', `正在通过 ${runtime.name} 执行...`);

    const executionId = genId('exec');

    // Resolve per-agent config (workspace reuse + thinking level)
    let workspacePath: string | undefined;
    let thinkingLevel: string | undefined;
    const workspaceId = decision.targetWorkspaceId;
    if (workspaceId) {
      const agentConfig = getDb().prepare(
        'SELECT prior_work_dir, thinking_level FROM workspace_agents WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1',
      ).get(workspaceId, decision.targetAgent) as { prior_work_dir: string | null; thinking_level: string } | undefined;
      if (agentConfig) {
        workspacePath = agentConfig.prior_work_dir ?? undefined;
        thinkingLevel = agentConfig.thinking_level;
      }
    }

    const task: ExecutionTask = {
      executionId,
      prompt: pending.userMessage,
      systemPrompt: decision.instruction,
      sessionId: pending.sessionId,
      traceId: getCurrentTrace()?.traceId,
      workspacePath,
      thinkingLevel,
    };

    const delegationId = this.delegationManager.create({
      sessionId: pending.sessionId,
      correlationId,
      targetAgent: runtime.name,
      targetKind: 'daemon',
      userMessage: pending.userMessage,
      taskType: 'runtime_execution',
      requester: 'brain-route',
      inputPayload: { message: pending.userMessage, instruction: decision.instruction },
      foreground: true,
    });

    // 记录委托 task ID 到 pending，供后续所有清理路径使用
    pending.delegationTaskId = delegationId;
    let textAccumulator = '';

    try {
      const eventSource = this.runtimeExecutor
        ? this.runtimeExecutor.executeWithCheckpoint(runtime, task)
        : runtime.execute(task);

      for await (const event of eventSource) {
        switch (event.kind) {
          case 'text_delta': {
            const text = event.data.text as string;
            textAccumulator += text;
            // 实时同步到 pending，重连时可从中恢复已积累的文本
            pending.draftResponse = textAccumulator;
            // 定期持久化到 SQLite，前端断连/刷新后可恢复
            this.streamingFlusher.onTextAccumulated(delegationId, textAccumulator, pending.reasoning);
            // H1 修复：业务路径不再直写 socket，改为 emit，由 WsEventBridge 桥接
            getEventBus().emit('stream.text_delta', {
              taskId: delegationId,
              sessionId: pending.sessionId,
              text,
              correlationId,
            });
            break;
          }
          case 'execution_completed': {
            const finalText = textAccumulator || (event.data.content as string) || '';
            pending.draftResponse = finalText;
            this.streamingFlusher.remove(delegationId);
            if (workspaceId && task.workspacePath) {
              getDb().prepare(
                'UPDATE workspace_agents SET prior_work_dir = ?, prior_session_id = ? WHERE workspace_id = ? AND agent_name = ?',
              ).run(task.workspacePath, task.sessionId ?? null, workspaceId, decision.targetAgent);
            }
            this.sendTaskResultForReview(
              { correlationId, sessionId: pending.sessionId },
              pending,
              finalText,
            );
            return;
          }
          case 'execution_failed': {
            const error = (event.data.error as string) || '执行失败';
            const resumable = event.data.resumable as boolean | undefined;
            this.streamingFlusher.remove(delegationId);
            if (resumable) {
              logger.info({ correlationId, error }, 'Execution failed but resumable');
              this.delegationManager.fail(delegationId, `[resumable] ${error}`);
              this.sessionManager.resolvePending(correlationId, `[${runtime.name}] 执行中断（可恢复）: ${error}`);
            } else {
              this.delegationManager.fail(delegationId, error);
              this.sessionManager.resolvePending(correlationId, `[${runtime.name}] 执行失败: ${error}`);
            }
            return;
          }
          case 'execution_cancelled': {
            this.streamingFlusher.remove(delegationId);
            this.delegationManager.fail(delegationId, 'Cancelled');
            this.sessionManager.resolvePending(correlationId, `[${runtime.name}] 执行已取消`);
            return;
          }
          default:
            break;
        }
      }

      // Generator completed without explicit execution_completed event
      if (textAccumulator) {
        pending.draftResponse = textAccumulator;
        this.sendTaskResultForReview(
          { correlationId, sessionId: pending.sessionId },
          pending,
          textAccumulator,
        );
      } else {
        this.streamingFlusher.remove(delegationId);
        this.delegationManager.fail(delegationId, 'No output produced');
        this.sessionManager.resolvePending(correlationId, `[${runtime.name}] 未产出任何输出`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ correlationId, err }, 'Runtime execution error');
      this.streamingFlusher.remove(delegationId);
      this.delegationManager.fail(delegationId, message);
      // R4-P0-1：Runtime exception 兜底：partial draftResponse + error 入库，避免 user 消息孤儿
      const errorResponse = `抱歉，处理过程中发生错误: ${message}`;
      const partialContent = pending.draftResponse
        ? `${pending.draftResponse}\n\n[错误: ${message}]`
        : errorResponse;
      // P1-4: 通知前端 user 消息没有回复
      getEventBus().emit('conversation.no_response', {
        sessionId: pending.sessionId,
        taskId: pending.taskId,
        reason: `runtime_error: ${message}`,
        correlationId,
      });
      this.sessionManager.resolvePending(correlationId, `[${runtime.name}] 执行异常: ${message}`, { contentOverride: partialContent });
    }
  }

  private async handleMultiRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    if (!decision.subDispatches || decision.subDispatches.length === 0) {
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
      return;
    }

    this.reportProgress(pending, 'dispatching', `正在并行分发 ${decision.subDispatches.length} 个子任务...`);

    this.delegationManager.createGroup('multi-' + correlationId, correlationId, pending.sessionId);
    let hasAny = false;

    for (const sub of decision.subDispatches) {
      try {
        const { taskId } = await this.dispatchModuleTaskInternal({
          sessionId: pending.sessionId,
          taskType: sub.taskType,
          requester: 'brain-route-multi',
          inputPayload: sub.inputPayload,
          foreground: true,
          correlationId: genId('sub'),
        });
        this.delegationManager.addChildToGroup(correlationId, taskId);
        hasAny = true;
      } catch (err) {
        logger.warn({ err, sub }, '多意图子任务分发失败');
      }
    }

    if (!hasAny) {
      this.delegationManager.removeGroup(correlationId);
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
    }
  }

  private async handleWorkspaceRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    if (!this.workspaceRouter || !decision.targetWorkspaceId) {
      logger.warn({ correlationId }, '工作区路由不可用或缺少 targetWorkspaceId，降级到对话');
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
      return;
    }

    const lead = this.workspaceRouter.getTeamLead(decision.targetWorkspaceId);
    if (!lead) {
      logger.warn({ correlationId, workspaceId: decision.targetWorkspaceId }, '工作区没有 lead agent，降级到对话');
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
      return;
    }

    this.reportProgress(pending, 'dispatching', `正在委托给工作区团队 ${lead}...`);

    try {
      const { taskId } = await this.dispatchModuleTaskInternal({
        sessionId: pending.sessionId,
        taskType: 'conversation_turn',
        requester: 'workspace-route',
        inputPayload: {
          message: pending.userMessage,
          instruction: decision.instruction,
          workspaceId: decision.targetWorkspaceId,
          delegationType: 'workspace',
        },
        foreground: true,
        correlationId,
      });

      this.workspaceRouter.recordSuccess(pending.userMessage, decision.targetWorkspaceId, decision.intent);

      if (pending.taskId) {
        this.taskManager.complete(pending.taskId, { delegatedTo: taskId });
      }
    } catch (err) {
      logger.error({ err, decision }, '工作区路由分发失败，降级到对话');
      this.workspaceRouter.recordFailure(pending.userMessage, decision.targetWorkspaceId, decision.intent);
      this.handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending);
    }
  }

  private async dispatchModuleTaskInternal(input: {
    sessionId: string;
    taskType: string;
    requester: string;
    inputPayload: Record<string, unknown>;
    foreground?: boolean;
    correlationId?: string;
  }): Promise<{ taskId: string; targetAgent: string }> {
    const route = this.taskRouter.route({ taskType: input.taskType, requester: input.requester });
    const correlationId = input.correlationId ?? genId('corr');

    const span = getTracer().startTrace('task.dispatch', {
      taskType: input.taskType,
      targetAgent: route.targetAgent,
      correlationId,
    });

    const taskId = this.delegationManager.create({
      sessionId: input.sessionId,
      correlationId,
      targetAgent: route.targetAgent,
      targetKind: 'internal',
      userMessage: (input.inputPayload.message as string) ?? '',
      taskType: input.taskType,
      requester: input.requester,
      inputPayload: { ...input.inputPayload, routeReason: route.reason },
      foreground: input.foreground ?? false,
    });

    let agent = await this.agentManager.ensureAgent(route.targetAgent);
    this.setupModuleAgent(route.targetAgent);
    const taskPayload = {
      taskId,
      sessionId: input.sessionId,
      taskType: input.taskType,
      inputPayload: input.inputPayload,
    } satisfies AgentTaskPayload;

    const sent = agent.ipc.send('agent.task', route.targetAgent, taskPayload);
    if (!sent) {
      agent = await this.agentManager.ensureAgent(route.targetAgent);
      this.setupModuleAgent(route.targetAgent);
      agent.ipc.send('agent.task', route.targetAgent, taskPayload);
    }

    const retryTarget = route.targetAgent;
    setTimeout(() => {
      const task = this.taskManager?.getTask(taskId);
      if (task?.status === 'dispatched') {
        const current = this.agentManager?.getAgent(retryTarget);
        if (current?.status === 'ready') {
          current.ipc.send('agent.task', retryTarget, taskPayload);
        }
      }
    }, DISPATCH_RETRY_MS);

    span.setAttributes({ taskId });
    span.end();
    return { taskId, targetAgent: route.targetAgent };
  }

  // ═══ REVIEW ═══════════════════════════════════════

  private setupReviewFlow(primaryIpc: AgentIpc, reviewerIpc: AgentIpc, primaryName: string, reviewerName: string): void {
    primaryIpc.onMessage('draft.response', (msg: IpcMessage) => {
      const { sessionId, draft, reasoning, toolCalls } = msg.payload as DraftResponsePayload;
      const correlationId = msg.correlationId!;
      const pending = this.sessionManager.getPending(correlationId);
      if (!pending) return;

      logger.debug({ correlationId, draftLen: draft.length, toolCalls: (toolCalls ?? []).length, sessionId }, 'orchestrator:draft');

      const calls = toolCalls ?? [];
      const turn: TurnRecord = {
        sessionId,
        userMessage: pending.userMessage,
        draftResponse: draft,
        toolCalls: calls,
        level: classifyLevel({
          sessionId,
          userMessage: pending.userMessage,
          draftResponse: draft,
          toolCalls: calls,
          level: 'A',
        }),
      };

      pending.level = turn.level;
      pending.draftResponse = draft;
      pending.reasoning = reasoning;
      pending.toolCalls = calls;

      // §9.0 M15.3 + §12.0: 生产模式分级审核
      if (!this.takeoverController) {
        // A 级简短回复 / 无 intent_anchor：直接 auto-approve（不做漂移检测）
        // 12.0 审计修复：auto-approve 也必须显式落库，避免 review_requests 表 99% 缺失。
        // audit-before-approve 顺序：先写审计行，再发 verdict，确保审计行先于 verdict 落库。
        // 失败处理：audit 失败不阻塞 verdict（fail-open）— recordAutoApprove 内部 try/catch
        // 只 log.error 不会抛，所以这里不需要 try/catch 包裹。
        if (turn.level === 'A' || !pending.intentAnchor) {
          this.auditRecorder.recordAutoApprove({
            sessionId,
            level: turn.level === 'A' ? 'A' : 'no_intent_anchor',
            draft,
            userMessage: pending.userMessage,
            toolCalls: calls,
            taskId: pending.taskId,
          });
          primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
          this.dispatchModuleTask({
            sessionId,
            taskType: 'extract_feedback',
            requester: 'post_review',
            inputPayload: { taskType: 'extract_feedback', userMessage: pending.userMessage, assistantResponse: draft },
          }).catch(() => {});
          return;
        }

        // B/C 级回复 + 有 intentAnchor：异步漂移检测后再决定
        this.performDriftCheckAndApprove(
          pending, primaryIpc, primaryName, reviewerIpc, reviewerName,
          correlationId, sessionId, draft, turn,
        );
        return;
      }

      // Test/takeover mode: preserve sync Brain review
      const entry = this.delegationManager.getByCorrelation(correlationId);
      const wsId = entry?.workspaceId;
      if (this.superiorReviewFlow?.interceptForSuperiorReview(correlationId, entry?.targetAgent ?? '', wsId, turn, entry?.id)) {
        this.pendingReviewOrigins.set(correlationId, 'superior_chain');
        this.reportProgress(pending, 'reviewing', '正在上级审核...');
        return;
      }

      this.pendingReviewOrigins.set(correlationId, 'conversation');
      this.reportProgress(pending, 'reviewing', '正在审核...');

      const sent = reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
      if (!sent) {
        // IPC 发送失败 → 自动 approve
        logger.warn({ correlationId }, 'review.request (conversation) IPC 发送失败，自动 approve');
        this.pendingReviewOrigins.delete(correlationId);
        const dEntry = this.delegationManager.getByCorrelation(correlationId);
        if (dEntry) this.delegationManager.complete(dEntry.id, draft);
        // P0 兜底：审核失败路径必须把 assistant 回复入库，否则刷新后只看到 user 消息
        this.sessionManager.resolvePending(correlationId, draft);
        return;
      }

      // 审核超时保护（防止 Brain LLM 挂死）
      setTimeout(() => {
        const stillPending = this.sessionManager.getPending(correlationId);
        if (!stillPending) return;
        logger.warn({ correlationId }, '对话审核超时，自动 approve');
        this.pendingReviewOrigins.delete(correlationId);
        const dEntry = this.delegationManager.getByCorrelation(correlationId);
        if (dEntry) this.delegationManager.complete(dEntry.id, draft);
        // P0 兜底：审核超时路径必须把 assistant 回复入库，否则刷新后只看到 user 消息
        this.sessionManager.resolvePending(correlationId, draft);
      }, 30_000);
    });

    reviewerIpc.onMessage('review.result', (msg: IpcMessage) => {
      const review = msg.payload as ReviewResult;
      const correlationId = msg.correlationId!;
      logger.info({ correlationId, verdict: review.verdict }, '大脑审核完成');

      const pending = this.sessionManager.getPending(correlationId);
      if (pending) {
        this.brainDecisionRecorder?.recordReviewDecision(
          pending.sessionId,
          (pending.draftResponse ?? pending.userMessage).slice(0, 200),
          review as unknown as Record<string, unknown>,
        );
      }

      const origin = this.pendingReviewOrigins.get(correlationId);
      this.pendingReviewOrigins.delete(correlationId);

      if (review.verdict === 'reject' && review.reRoute) {
        this.handleRouteDecision(review.reRoute, correlationId);
        return;
      }

      if (origin === 'task') {
        this.handleTaskReviewResult(review, correlationId);
      } else {
        primaryIpc.send('review.result', primaryName, review, correlationId);
      }
    });

    primaryIpc.onMessage('final.response', (msg: IpcMessage) => {
      const { sessionId, response, reviewVerdict } = msg.payload as FinalResponsePayload;
      const correlationId = msg.correlationId!;
      logger.debug({ correlationId, responseLen: response.length, verdict: reviewVerdict, sessionId }, 'orchestrator:final');
      const pending = this.sessionManager.getPending(correlationId);
      if (!pending) return;

      // §10.0 Stream Merge: 检查是否有待执行的 handoff（Brain 判定需要另一个 agent）
      const handoff = this.pendingHandoffs.get(correlationId);
      if (handoff) {
        this.pendingHandoffs.delete(correlationId);

        // 11.0: 如果 Conversation 在本回合已通过 dialogue 与目标 agent 交互过，
        // 跳过 handoff（dialogue 已完成协作，handoff 是冗余的）
        const hadDialogue = this.dialogueRouter
          ? this.dialogueRouter.hasDialogueForTarget(correlationId, handoff.targetAgent)
          : false;
        if (hadDialogue) {
          logger.info({ correlationId, handoffTo: handoff.targetAgent }, 'handoff 跳过：dialogue 已覆盖目标 agent');
          // 不执行 handoff，直接走正常关闭路径
        } else {
          logger.info({ correlationId, handoffTo: handoff.targetAgent, intent: handoff.intent }, '投机执行完成，流式追加委派');

          // 结束 conversation 的 flusher，但保持 pending 存活
          this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');

          // 完成 conversation 任务（它的部分已做完）
          if (pending.taskId) {
            this.taskManager.complete(pending.taskId, { response, reviewVerdict, handoffTo: handoff.targetAgent });
          }

          // 保存 conversation 的回复到对话历史
          this.sessionManager.saveConversationTurn(sessionId, pending.userMessage, response, pending.reasoning);

          // 向前端发送 handoff 分隔事件（同一个气泡内）
          // P0-B 修复：业务路径不再直写 socket，改为 emit
          getEventBus().emit('conversation.handoff', {
            sessionId: pending.sessionId,
            from: 'conversation',
            to: handoff.targetAgent,
            intent: handoff.intent,
            correlationId,
          });

          // 清除旧 taskId，handoff agent 会分配新的
          pending.taskId = undefined;
          pending.delegationTaskId = undefined;
          pending.draftResponse = '';
          pending.reasoning = undefined;
          pending.toolCalls = undefined;

          // 直接用现有 pending 分发 handoff（不重建 pending）
          this.handleRouteDecision(handoff, correlationId);
          return;
        }
      }

      // 无 handoff — 正常关闭路径
      this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
      this.sessionManager.deletePending(correlationId);

      if (pending.taskId) {
        this.taskManager.complete(pending.taskId, { response, reviewVerdict });
        const agentHome = getAgentHomePath(primaryName);
        closeTaskWorkspace(
          join(agentHome, 'tasks', pending.taskId),
          { response, reviewVerdict, completedAt: Date.now() },
        );
      }

      this.auditRecorder.recordReview({
        sessionId,
        level: pending.level ?? 'A',
        draft: pending.draftResponse ?? response,
        userMessage: pending.userMessage,
        toolCalls: pending.toolCalls ?? [],
        verdict: reviewVerdict,
        finalResponse: response,
      });

      this.sessionManager.saveConversationTurn(sessionId, pending.userMessage, response, pending.reasoning);
      this.sessionManager.queueEvolution(sessionId, pending.userMessage, response);
      this.sessionManager.queueCapabilityEvolution(sessionId, pending.userMessage, response);
      this.dispatchModuleTask({
        sessionId,
        taskType: 'extract_feedback',
        requester: 'brain_learning',
        inputPayload: { taskType: 'extract_feedback', userMessage: pending.userMessage, assistantResponse: response },
      }).catch((err) => {
        logger.debug({ err, sessionId }, 'Feedback extraction dispatch failed');
      });
      this.worldModelRef?.updateFromConversation({
        userMessage: pending.userMessage,
        assistantResponse: response,
        sessionId,
      });

      getEventBus().emit('message.responded', {
        sessionId,
        taskId: pending.taskId ?? '',
        response,
        verdict: reviewVerdict,
      });

      pending.resolve(response);

      // §9.0 Cleanup speculative state for this correlation
      this.speculativeCorrelations.delete(correlationId);
    });
  }

  private handleTaskReviewResult(review: ReviewResult, correlationId: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    if (pending.taskId) this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId);

    const response = review.verdict === 'modify' && review.finalResponse
      ? review.finalResponse
      : pending.draftResponse ?? '';

    const entry = this.delegationManager.getByCorrelation(correlationId);
    if (entry) {
      this.delegationManager.complete(entry.id, response);
    }

    this.sessionManager.deletePending(correlationId);
    this.sessionManager.saveConversationTurn(pending.sessionId, pending.userMessage, response, pending.reasoning);
    this.sessionManager.queueEvolution(pending.sessionId, pending.userMessage, response);
    this.sessionManager.queueCapabilityEvolution(pending.sessionId, pending.userMessage, response);
    this.dispatchModuleTask({
      sessionId: pending.sessionId,
      taskType: 'extract_feedback',
      requester: 'brain_learning',
      inputPayload: { taskType: 'extract_feedback', userMessage: pending.userMessage, assistantResponse: response },
    }).catch((err) => {
      logger.debug({ err, sessionId: pending.sessionId }, 'Feedback extraction dispatch failed');
    });
    this.worldModelRef?.updateFromConversation({
      userMessage: pending.userMessage,
      assistantResponse: response,
      sessionId: pending.sessionId,
    });
    pending.resolve(response);
  }

  private onSuperiorChainCompleted(correlationId: string, modifiedResponse: string | undefined, reviewerIpc: AgentIpc, reviewerName: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    if (modifiedResponse) {
      pending.draftResponse = modifiedResponse;
    }

    const origin = this.pendingReviewOrigins.get(correlationId);
    this.pendingReviewOrigins.set(correlationId, origin === 'superior_chain' ? (pending.taskId ? 'task' : 'conversation') : origin ?? 'conversation');
    this.reportProgress(pending, 'reviewing', '上级审核通过，正在 Brain 审核...');

    const turn: TurnRecord = {
      sessionId: pending.sessionId,
      userMessage: pending.userMessage,
      draftResponse: pending.draftResponse ?? '',
      toolCalls: pending.toolCalls ?? [],
      level: pending.level as 'A' | 'B' | 'C' ?? 'A',
    };

    reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
  }

  private onSuperiorChainRejected(correlationId: string, reason: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    if (pending.taskId) this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId);
    this.pendingReviewOrigins.delete(correlationId);
    const entry = this.delegationManager.getByCorrelation(correlationId);
    if (entry) {
      this.delegationManager.fail(entry.id, `Superior rejected: ${reason}`);
    }

    this.sessionManager.resolvePending(correlationId, `[上级审核退回] ${reason}`);
  }

  private sendTaskResultForReview(fgEntry: { correlationId: string; sessionId: string }, pending: PendingRequest, draftResponse: string): void {
    // 流式阶段结束，清理 flusher（complete() 会写最终 output_payload）
    this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
    const entry = this.delegationManager.getByCorrelation(fgEntry.correlationId);
    if (entry) {
      this.delegationManager.submitForReview(entry.id, { delegationId: entry.id, response: draftResponse });
    }

    const reviewerAgent = this.registry.requireRole('reviewer');
    const reviewerName = reviewerAgent.manifest.name;
    const reviewer = this.agentManager.getAgent(reviewerName);

    // reviewer 不可用（进程崩溃/未启动）→ 直接 approve，不挂死
    if (!reviewer || !reviewer.child.connected) {
      logger.warn({ correlationId: fgEntry.correlationId }, 'Reviewer 不可用，自动 approve');
      if (entry) this.delegationManager.complete(entry.id, draftResponse);
      this.sessionManager.resolvePending(fgEntry.correlationId, draftResponse);
      return;
    }

    const turn: TurnRecord = {
      sessionId: fgEntry.sessionId,
      userMessage: pending.userMessage,
      draftResponse,
      toolCalls: [],
      level: 'A',
    };

    const wsId = entry?.workspaceId;
    if (this.superiorReviewFlow?.interceptForSuperiorReview(fgEntry.correlationId, entry?.targetAgent ?? '', wsId, turn, entry?.id)) {
      this.pendingReviewOrigins.set(fgEntry.correlationId, 'superior_chain');
      this.reportProgress(pending, 'reviewing', '正在上级审核任务结果...');
      return;
    }

    this.pendingReviewOrigins.set(fgEntry.correlationId, 'task');
    this.reportProgress(pending, 'reviewing', '正在审核...');

    // 发送审核请求，检查返回值
    const sent = reviewer.ipc.send('review.request', reviewerName, { turn }, fgEntry.correlationId);
    if (!sent) {
      // IPC 发送失败（进程已断连）→ 自动 approve
      logger.warn({ correlationId: fgEntry.correlationId }, 'review.request IPC 发送失败，自动 approve');
      this.pendingReviewOrigins.delete(fgEntry.correlationId);
      if (entry) this.delegationManager.complete(entry.id, draftResponse);
      this.sessionManager.resolvePending(fgEntry.correlationId, draftResponse);
      return;
    }

    // 审核阶段超时保护：30 秒无响应则自动 approve（防止 Brain LLM 调用挂死）
    const reviewTimeoutMs = 30_000;
    setTimeout(() => {
      // 如果 pending 仍存在（说明 review.result 没有回来），自动放行
      const stillPending = this.sessionManager.getPending(fgEntry.correlationId);
      if (!stillPending) return;
      logger.warn({ correlationId: fgEntry.correlationId, timeoutMs: reviewTimeoutMs }, '审核超时，自动 approve');
      this.pendingReviewOrigins.delete(fgEntry.correlationId);
      if (entry) this.delegationManager.complete(entry.id, draftResponse);
      this.sessionManager.resolvePending(fgEntry.correlationId, draftResponse);
    }, reviewTimeoutMs);
  }

  private setupAgentAskUserFlow(reviewerIpc: AgentIpc): void {
    reviewerIpc.onMessage('agent.ask_user', (msg: IpcMessage) => {
      const payload = msg.payload as AgentAskUserPayload & { _brainReview?: { approved: boolean; rewrittenQuestion?: string; autoAnswer?: string } };
      const correlationId = msg.correlationId!;

      const brainReview = payload._brainReview;
      if (brainReview && !brainReview.approved && brainReview.autoAnswer) {
        const agent = this.agentManager.getAgent(msg.from);
        if (agent) {
          agent.ipc.send('agent.user_reply', msg.from, {
            sessionId: payload.sessionId,
            taskId: payload.taskId,
            reply: brainReview.autoAnswer,
          } satisfies AgentUserReplyPayload, correlationId);
        }
        return;
      }

      const question = brainReview?.rewrittenQuestion ?? payload.question;

      this.sessionManager.setPendingAsk(payload.sessionId, {
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        agentName: msg.from,
        question,
        correlationId,
      });

      const entry = this.delegationManager.get(payload.taskId);
      if (entry) {
        this.delegationManager.markAskingUser(payload.taskId, question);
        // P0-B 修复：业务路径不再直写 socket，改为 emit
        getEventBus().emit('conversation.ask_user', {
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          agent: msg.from,
          question,
          options: payload.options,
          correlationId,
        });
      }
    });
  }

  // ═══ TASK HANDLERS ════════════════════════════════

  private setupTaskHandlers(agentIpc: AgentIpc, agentName: string): void {
    setupTaskAcknowledgeHandlers(agentIpc, this.taskFlowDeps);
    setupTaskTelemetryHandler(agentIpc, this.taskFlowDeps);
    setupTaskProgressHandler(agentIpc, agentName, this.taskFlowDeps);
  }

  private setupTaskResultHandlers(agentIpc: AgentIpc, agentName: string): void {
    setupTaskAcknowledgeHandlers(agentIpc, this.taskFlowDeps);
    setupTaskTelemetryHandler(agentIpc, this.taskFlowDeps);
    setupModuleTaskResultHandler(agentIpc, agentName, this.taskFlowDeps, (result, entry, agent) => {
      this.handleForegroundTaskResult(result, entry, agent);
    });
  }

  private handleForegroundTaskResult(
    result: AgentTaskResultPayload,
    fgEntry: { correlationId: string; sessionId: string },
    agentName: string,
  ): void {
    // 调试日志：定位对话中断原因
    logger.info({
      taskId: result.taskId,
      correlationId: fgEntry.correlationId,
      sessionId: fgEntry.sessionId,
      agent: agentName,
      ok: result.ok,
      error: result.error,
      hasPending: !!this.sessionManager.getPending(fgEntry.correlationId),
    }, 'handleForegroundTaskResult: 任务结果到达');
    const groupInfo = this.delegationManager.getGroupByChild(result.taskId);
    if (groupInfo) {
      const responseText = result.ok ? this.formatAgentResult(agentName, result.outputPayload ?? {}) : '';
      const allDone = this.delegationManager.completeChild(groupInfo.correlationId, result.taskId, agentName, responseText);
      if (allDone) {
        const completedGroup = this.delegationManager.removeGroup(groupInfo.correlationId);
        if (completedGroup) {
          this.resolveMultiTaskResult(completedGroup, groupInfo.correlationId, groupInfo.group.sessionId);
        }
      }
      return;
    }

    const pending = this.sessionManager.getPending(fgEntry.correlationId);
    if (!pending) return;

    if (!result.ok) {
      this.streamingFlusher.remove(result.taskId);
      this.delegationManager.fail(result.taskId, result.error ?? '任务失败');
      const errorResponse = `[${agentName}] 任务失败: ${result.error ?? '未知错误'}`;
      // R4-P0-1：foreground 任务失败路径必须把错误回复入库，避免 user 消息孤儿
      this.sessionManager.resolvePending(fgEntry.correlationId, errorResponse);
      return;
    }

    const draftResponse = this.formatAgentResult(agentName, result.outputPayload ?? {});
    pending.draftResponse = draftResponse;

    this.sendTaskResultForReview(fgEntry, pending, draftResponse);
  }

  private resolveMultiTaskResult(
    group: import('../contracts/delegation.js').DelegationGroup,
    correlationId: string,
    sessionId: string,
  ): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    const parts: string[] = [];
    for (const [, r] of group.completedResults) {
      if (r.response) parts.push(r.response);
    }
    const draftResponse = parts.join('\n\n---\n\n');
    pending.draftResponse = draftResponse;

    this.sendTaskResultForReview({ correlationId, sessionId }, pending, draftResponse);
  }

  private setupDaemonTaskResultHandlers(): void {
    const eventBus = getEventBus();
    eventBus.on('daemon.task.progress', ({ taskId, event }) => {
      const entry = this.delegationManager.get(taskId);
      if (!entry) return;
      const pending = this.sessionManager.getPending(entry.correlationId);
      if (!pending?.streaming) return;

      if (event.kind === 'text' && event.data.kind === 'text') {
        // 无条件积累文本（业务与传输层解耦，daemon 后端任务独立于前端连接）
        pending.draftResponse = (pending.draftResponse ?? '') + event.data.text;
        // 定时持久化到 SQLite（断连/刷新恢复用）
        this.streamingFlusher.onTextAccumulated(taskId, pending.draftResponse, pending.reasoning);
        // P0-B 修复：业务路径不再直写 socket，改为 emit
        getEventBus().emit('stream.text_delta', {
          taskId,
          sessionId: pending.sessionId,
          text: event.data.text,
          correlationId: entry.correlationId,
        });
      }
    });

    eventBus.on('daemon.task.completed', ({ taskId }) => {
      const entry = this.delegationManager.get(taskId);
      if (!entry) return;

      const task = this.taskManager.getTask(taskId);
      let outputPayload: Record<string, unknown> = {};
      if (task?.output_payload) {
        try { outputPayload = JSON.parse(task.output_payload); } catch { /* use empty */ }
      }

      const result: AgentTaskResultPayload = { taskId, ok: true, outputPayload };
      this.handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__');
    });

    eventBus.on('daemon.task.failed', ({ taskId, error }) => {
      const entry = this.delegationManager.get(taskId);
      if (!entry) return;

      const result: AgentTaskResultPayload = { taskId, ok: false, error };
      this.handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__');
    });

    eventBus.on('task.timeout', ({ taskId, targetAgent }) => {
      if (targetAgent === '__daemon__') {
        // daemon 外部智能体超时走 foreground 路径
        const entry = this.delegationManager.get(taskId);
        if (!entry) return;
        const result: AgentTaskResultPayload = { taskId, ok: false, error: '外部智能体执行超时' };
        this.handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__');
        return;
      }

      // R4-P0-3：普通 task.timeout（无 final.response 到达）兜底：partial draftResponse + timeout 提示入库
      const entry = this.delegationManager.get(taskId);
      if (!entry) return;
      const pending = this.sessionManager.getPending(entry.correlationId);
      if (!pending) return;
      const timeoutResponse = `任务执行超时（${targetAgent}）`;
      const partialContent = pending.draftResponse
        ? `${pending.draftResponse}\n\n[${timeoutResponse}]`
        : timeoutResponse;
      // emit no_response 事件让前端感知
      getEventBus().emit('conversation.no_response', {
        sessionId: pending.sessionId,
        taskId: pending.taskId,
        reason: `task_timeout: ${targetAgent}`,
        correlationId: entry.correlationId,
      });
      this.streamingFlusher.remove(taskId);
      this.sessionManager.resolvePending(entry.correlationId, timeoutResponse, { contentOverride: partialContent });
    });
  }

  // ═══ UTILITY ══════════════════════════════════════

  private reportProgress(pending: PendingRequest, status: SocketProgressEvent['status'], summary: string): void {
    // P0-B 修复：业务路径不再直写 socket，改为 emit
    if (pending.sessionId) {
      getEventBus().emit('conversation.progress', {
        sessionId: pending.sessionId,
        taskId: pending.taskId,
        status,
        summary,
      });
    }

    if (pending.taskId && pending.sessionId && this.agentProgress) {
      this.agentProgress.report({
        taskId: pending.taskId,
        sessionId: pending.sessionId,
        source: 'core',
        message: summary,
        payload: { status },
      });
    }
  }

  // ═══ 12.0 DRIFT DETECTION ═════════════════════════════

  /**
   * B/C 级回复的漂移检测：通过 Brain IPC 做轻量检测，根据结果决定：
   * - 正常：auto-approve
   * - 中偏离（correct）：触发 CorrectionFlow
   * - 高偏离（verify）：走同步 Brain review
   */
  private performDriftCheckAndApprove(
    pending: PendingRequest,
    primaryIpc: AgentIpc,
    primaryName: string,
    reviewerIpc: AgentIpc,
    reviewerName: string,
    correlationId: string,
    sessionId: string,
    draft: string,
    turn: import('../contracts/review.js').TurnRecord,
  ): void {
    const brainAgent = this.agentManager.getAgent(this.registry.requireRole('reviewer').manifest.name);
    if (!brainAgent || !pending.intentAnchor) {
      // Brain 不可用或无 anchor → 降级为直接 approve
      primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
      return;
    }

    // 发 drift.check.request 给 Brain
    const driftCorrelationId = genId('drift');
    brainAgent.ipc.send('drift.check.request', 'brain', {
      anchor: pending.intentAnchor,
      content: draft.slice(0, 3000),
      checkpointType: 'final_response',
    }, driftCorrelationId);

    // 设置超时：2s 内未收到结果 → 降级 approve
    const timeoutId = setTimeout(() => {
      cleanup();
      logger.debug({ correlationId }, 'drift check timeout, auto-approve');
      primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
      this.dispatchModuleTask({
        sessionId,
        taskType: 'extract_feedback',
        requester: 'post_review',
        inputPayload: { taskType: 'extract_feedback', userMessage: pending.userMessage, assistantResponse: draft },
      }).catch(() => {});
    }, 2000);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    const handler = (msg: IpcMessage) => {
      if (msg.correlationId !== driftCorrelationId) return;
      cleanup();

      const { signal } = msg.payload as { signal: import('../contracts/intent.js').DriftSignal };
      const evaluated = this.driftDetector?.evaluate(signal) ?? signal;

      // 记录漂移信号
      this.driftDetector?.recordSignal(evaluated, sessionId, correlationId);

      if (evaluated.suggestedAction === 'verify') {
        // 高偏离 → 走同步 Brain review（现有 review 流程）
        logger.info({ correlationId, score: evaluated.alignmentScore }, 'drift:high → sync review');
        this.pendingReviewOrigins.set(correlationId, 'conversation');
        this.reportProgress(pending, 'reviewing', '检测到可能偏离，正在深度审核...');
        reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
        return;
      }

      if (evaluated.suggestedAction === 'correct') {
        // 中偏离 → 触发 CorrectionFlow
        logger.info({ correlationId, score: evaluated.alignmentScore }, 'drift:medium → correction');
        const entry = this.delegationManager.getByCorrelation(correlationId);
        if (entry) {
          getEventBus().emit('delegation.checkpoint_needed', {
            delegationId: entry.id,
            trigger: 'semantic_drift' as import('../contracts/delegation.js').CheckpointTrigger,
          });
        } else {
          // 无 delegation entry → 降级 approve
          primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
        }
        return;
      }

      // 正常对齐 → approve
      primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
      this.dispatchModuleTask({
        sessionId,
        taskType: 'extract_feedback',
        requester: 'post_review',
        inputPayload: { taskType: 'extract_feedback', userMessage: pending.userMessage, assistantResponse: draft },
      }).catch(() => {});
    };

    brainAgent.ipc.onMessage('drift.check.result', handler);
  }

  private formatAgentResult(agentName: string, outputPayload: Record<string, unknown>): string {
    if (typeof outputPayload.response === 'string') return outputPayload.response;
    if (typeof outputPayload.result === 'string') return outputPayload.result;
    return `[${agentName}] 任务完成:\n${JSON.stringify(outputPayload, null, 2)}`;
  }
}
