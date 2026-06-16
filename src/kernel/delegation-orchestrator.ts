import type { AgentManager } from './agent-manager.js';
import type { AgentRegistry } from './agent-registry.js';
import type { TaskManager } from './task-manager.js';
import type { AgentProgress } from './agent-progress.js';
import type { TaskRouter } from './task-router.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import type { AuditRecorder } from './audit-recorder.js';
import type { SessionManager, PendingRequest } from './session-manager.js';
import type { TakeoverController } from '../testing/model-takeover.js';
import { KernelRouter, type AgentIpcLike } from './kernel-router.js';
import { IpcChannel } from './ipc.js';
import type { CapabilityService } from '../evolution/index.js';
import type { DaemonBridge } from './daemon-bridge.js';
import type { MemoryRuntime } from '../memory/index.js';
import { getDb } from '../memory/index.js';
import type { IPluginRuntimeV2 } from '../contracts/plugins-v2.js';
import type { WorkspaceRouter } from './workspace-router.js';
import type { RuntimeRegistry } from './runtime/runtime-registry.js';
import type { AgentRuntime } from '../contracts/agent-runtime.js';
import type { RuntimeExecutor } from './runtime/runtime-executor.js';
import { DelegationManager } from './delegation-manager.js';
import { DialogueRouter } from './dialogue-router.js';
import { FallbackRouter } from './fallback-router.js';
import { CorrectionFlow } from './flows/correction-flow.js';
import { SuperiorReviewFlow } from './flows/superior-review-flow.js';
import { metrics } from '../observability/metrics.js';
import { PermissionFlow } from './flows/permission-flow.js';
import { setupBrainCommandHandler } from './flows/brain-command-handler.js';
import { attachBrainEventRelay } from './flows/brain-relay.js';
import { setupRoutingResultHandler } from './flows/routing-result-handler.js';
import { resolveRuntimeForTarget as resolveRuntimeForTargetImpl, executeViaRuntime as executeViaRuntimeImpl, type RuntimeExecutionDeps } from './flows/runtime-execution.js';
import {
  handleForegroundTaskResult as handleForegroundTaskResultImpl,
  handleTaskReject as handleTaskRejectImpl,
  resolveMultiTaskResult as resolveMultiTaskResultImpl,
  setupDaemonTaskResultHandlers as setupDaemonTaskResultHandlersImpl,
  type ForegroundResultDeps,
} from './flows/foreground-result.js';
import {
  handleChatRoute as handleChatRouteImpl,
  handleTaskRoute as handleTaskRouteImpl,
  handleExternalRoute as handleExternalRouteImpl,
  handleMultiRoute as handleMultiRouteImpl,
  handleWorkspaceRoute as handleWorkspaceRouteImpl,
  handleRouteFallback as handleRouteFallbackImpl,
  executeSetupAction as executeSetupActionImpl,
  loadActiveSkills as loadActiveSkillsImpl,
  type RouteHandlersDeps,
} from './flows/route-handlers.js';
import { setupMissionSubscriptions, type MissionSubscriptionsDeps } from './flows/mission-subscriptions.js';
import { setupAgentAskUserFlow as setupAgentAskUserFlowImpl } from './flows/ask-user-flow.js';
import {
  setupReviewFlow as setupReviewFlowImpl,
  handleTaskReviewResult as handleTaskReviewResultImpl,
  onSuperiorChainCompleted as onSuperiorChainCompletedImpl,
  onSuperiorChainRejected as onSuperiorChainRejectedImpl,
  approveReviewDegraded as approveReviewDegradedImpl,
  sendTaskResultForReview as sendTaskResultForReviewImpl,
  type ReviewFlowDeps,
} from './flows/review-flow.js';
import { performDriftCheckAndApprove as performDriftCheckAndApproveImpl, type DriftFlowDeps } from './flows/drift-flow.js';
import { onConversationCompleted as onConversationCompletedImpl, dispatchFeedbackExtraction as dispatchFeedbackExtractionImpl, type PostCompletionDeps } from './flows/post-completion.js';
import { StreamingFlusher } from './streaming-flusher.js';
import { ObservationRecorder } from './observation-recorder.js';
// 对话内联：审核链工具真相单一源 = BlockCollector（逻辑已提取至 flows/*，主类仅 ToolBlock 类型签名用）。
import type { ToolBlock } from '../contracts/message-blocks.js';
/** 13.0 §13.16: TaskHeartbeatManager — 长任务心跳推送 */
import { getTaskHeartbeatManager } from './task-heartbeat-manager.js';
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
import {
  autoGenerateSquad,
  updatePlanTaskStatus,
  type MissionContextDeps,
} from './flows/mission-context-builder.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';
import { getTracer } from '../observability/tracer.js';
import { getEventBus } from './event-bus.js';
import { withTrace } from '../observability/trace-context.js';
import { BrainDecisionRecorder } from './brain-decision-recorder.js';
import type { IpcMessageType, IpcMessage } from './types.js';
import type { SocketProgressEvent } from '../contracts/socket-protocol.js';
import type { RouteDecision, RouteResultPayload, RouteRequestPayload } from '../contracts/routing.js';
import type { PermissionJudgeResultPayload, AgentAskUserPayload, AgentUserReplyPayload } from '../contracts/routing.js';
import type { ReviewResult, TurnRecord } from '../contracts/review.js';
import type { AgentTaskPayload, AgentTaskResultPayload } from '../contracts/tasks.js';
import type { DangerLevel } from '../utils/types.js';
import type { ICapabilityBus } from '../bus/contract.js';
import type { WorldModelRuntime } from './world-model.js';
import type { SuggestionQueue } from './suggestion-queue.js';
import { MissionManager } from './mission-manager.js';
import { StateCache } from './state-cache.js';
import { AgentRequestQueue } from './agent-request-queue.js';
import { postDelegateEnvelope } from './board-projection.js';
import { resolveLeaderForDelegate, applyBoardStatus } from './board-repo.js';
import { resolveConfig } from '../config/resolver.js';
import { getConfigPath } from '../utils/paths.js';

const logger = getLogger('orchestrator');

const DISPATCH_RETRY_MS = 3000;

/**
 * 13.0 §12.5: plan.json 的 who 字段（agent 名）→ 该 agent 的主 taskType 映射。
 * 用于 task_ready 派发时按 who 路由到真正负责的 agent（而非写死 chat）。
 * 与各 agent manifest 的 taskTypes 声明一致；未命中返回 null（调用方回退 chat）。
 */
const AGENT_TASK_TYPE: Record<string, string> = {
  conversation: 'conversation_turn',
  code: 'code_task',
  skills: 'skill_task',
  'plugin-builder': 'plugin_task',
  'skill-tester': 'skill_test',
  learning: 'learning_review',
  evolution: 'extract_feedback',
  memory: 'memory_judge',
};

/** §12.5: 按 agent 名查主 taskType；未知 agent 返回 null */
function taskTypeForAgent(agentName: string): string | null {
  return AGENT_TASK_TYPE[agentName] ?? null;
}

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
  /** 13.0 §3.8 第二层: 写入 active_scope 用于硬约束拦截 */
  readonly permissionCoordinator?: import('./permission-coordinator.js').PermissionCoordinator | null;
  /** 13.0 §3.9: 统一状态缓存，用于写入 correction/behavior_note 命名空间 */
  readonly stateCache?: StateCache | null;
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
  readonly permissionCoordinator: PermissionCoordinator;
  private auditRecorder: AuditRecorder;
  readonly sessionManager: SessionManager;
  private agentProgress: AgentProgress | null;
  private capabilityService: CapabilityService | null;
  private takeoverController: TakeoverController | null;
  private memoryRuntime: MemoryRuntime;

  // ─── Internal state ───────────────────────────────
  private setupAgentIpcs = new WeakSet<object>();
  /** 去重：已挂载 Brain 事件中继的 IPC 引用（brain 重启后新 IPC 会被重新挂载） */
  private brainRelayIpcs = new WeakSet<object>();
  private pendingReviewOrigins = new Map<string, ReviewOrigin>();
  readonly delegationManager: DelegationManager;
  /** 13.0 灵魂版：KernelRouter 封装 dialogue 路由逻辑 */
  private kernelRouter: KernelRouter;
  private correctionFlow: CorrectionFlow;
  private fallbackRouter = new FallbackRouter();
  /** R15: 后构造依赖——由 init() 统一注入，替代 setter + 公共字段赋值 */
  private _daemonBridge: DaemonBridge | null = null;
  private _pluginRuntimeV2: IPluginRuntimeV2 | null = null;
  private _workspaceRouter: WorkspaceRouter | null = null;
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
  private _driftDetector: import('./drift-detector.js').DriftDetector | null = null;
  /** §17.4: VerifyGate 已搬入 flows/drift-flow.ts（performDriftCheckAndApprove 内部实例化） */

  // Permission judge state
  private permissionFlow: PermissionFlow;
  /** 流式内容定时刷写器（将 text_delta 累积内容持久化到 SQLite 供断连恢复） */
  private streamingFlusher: StreamingFlusher;
  /** 13.0 灵魂版：观察队列记录器（工具调用、对话、用户交互等事件的持久化） */
  private observationRecorder: ObservationRecorder;
  /** 13.0 多智能体协作：Mission 生命周期管理器（plan.json + squad.json） */
  private missionManager: MissionManager | null = null;
  /** 13.0 多智能体协作：统一状态缓存（纠偏、预算、行为笔记等，通过 getter 暴露给 CorrectionFlowDeps） */
  private _stateCache: StateCache | null = null;
  /** 13.0 多智能体协作：Agent 请求队列（per-agent FIFO 并发控制） */
  private agentRequestQueue: AgentRequestQueue | null = null;
  /** 13.0 灵魂版：Brain (reviewer) IPC 通道引用 — setup() 中赋值，供 proxyDeps 转发 brain.observe */
  private _brainIpc: AgentIpc | null = null;

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
    // 13.0 灵魂版：KernelRouter 封装 dialogue 路由，构造时初始化（dialogueRouter 在 init() 注入）
    // §4.4.2: 注入 session 总预算上限，使 inter_agent_budget.totalBudget 真实初始化（修复旧版恒为 0 死代码）
    let sessionBudgetLimit: number | undefined;
    try {
      sessionBudgetLimit = resolveConfig(getConfigPath()).budget.sessionLimit;
    } catch {
      // 配置解析失败时使用 KernelRouter 内置默认值
    }
    this.kernelRouter = new KernelRouter({
      dialogueRouter: null, // init() 中赋值
      agentManager: deps.agentManager,
      sessionManager: deps.sessionManager,
      sessionBudgetLimit,
    });
    this.brainDecisionRecorder = new BrainDecisionRecorder(getDb());
    this.permissionFlow = new PermissionFlow({
      permissionCoordinator: deps.permissionCoordinator,
      registry: deps.registry,
      agentManager: deps.agentManager,
      sessionManager: deps.sessionManager,
      brainDecisionRecorder: this.brainDecisionRecorder,
    });
    this.streamingFlusher = new StreamingFlusher(deps.taskManager);
    // 13.0 灵魂版：观察队列记录器，用同一个 db 实例确保跨模块共享
    this.observationRecorder = new ObservationRecorder(getDb());
  }

  get delegation(): DelegationManager { return this.delegationManager; }
  get fallback(): FallbackRouter { return this.fallbackRouter; }

  // ─── 公共属性访问器（R15: 替代直接字段赋值） ──────

  get daemonBridge(): DaemonBridge | null { return this._daemonBridge; }
  get pluginRuntimeV2(): IPluginRuntimeV2 | null { return this._pluginRuntimeV2; }
  get driftDetector(): import('./drift-detector.js').DriftDetector | null { return this._driftDetector; }
  get workspaceRouter(): WorkspaceRouter | null { return this._workspaceRouter; }

  /**
   * R15: 后构造依赖统一初始化入口
   *
   * 替代 6 个 setXxx 方法和 4 个公共字段直接赋值。
   * 所有运行时创建的依赖集中通过 init() 注入，
   * 消除 setter 补丁模式和公共字段暴露。
   *
   * @param deps 后构造依赖（全部可选，按需传入）
   */
  init(deps: {
    daemonBridge?: DaemonBridge | null;
    pluginRuntimeV2?: IPluginRuntimeV2 | null;
    driftDetector?: import('./drift-detector.js').DriftDetector | null;
    workspaceRouter?: WorkspaceRouter | null;
    superiorReviewFlow?: SuperiorReviewFlow | null;
    runtimeRegistry?: RuntimeRegistry | null;
    runtimeExecutor?: RuntimeExecutor | null;
    capabilityBus?: ICapabilityBus | null;
    worldModel?: WorldModelRuntime | null;
    suggestionQueue?: SuggestionQueue | null;
  }): void {
    if (deps.daemonBridge !== undefined) this._daemonBridge = deps.daemonBridge;
    if (deps.pluginRuntimeV2 !== undefined) this._pluginRuntimeV2 = deps.pluginRuntimeV2;
    if (deps.driftDetector !== undefined) this._driftDetector = deps.driftDetector;
    if (deps.workspaceRouter !== undefined) this._workspaceRouter = deps.workspaceRouter;
    if (deps.superiorReviewFlow !== undefined) this.superiorReviewFlow = deps.superiorReviewFlow;
    if (deps.runtimeRegistry !== undefined) this.runtimeRegistry = deps.runtimeRegistry;
    if (deps.runtimeExecutor !== undefined) this.runtimeExecutor = deps.runtimeExecutor;
    if (deps.capabilityBus !== undefined) {
      this.capabilityBusRef = deps.capabilityBus;
      // Wire Bus handlers to primary agent
      const primaryAgent = this.registry.requireRole('primary');
      const primary = this.agentManager.getAgent(primaryAgent.manifest.name);
      if (primary) {
        setupBusHandlers(primary.ipc, primaryAgent.manifest.name, deps.capabilityBus);
      }
    }
    if (deps.worldModel !== undefined) this.worldModelRef = deps.worldModel;
    if (deps.suggestionQueue !== undefined) this.suggestionQueueRef = deps.suggestionQueue;
  }

  /**
   * 13.0 多智能体协作：初始化 Mission 系统。
   *
   * 单独的初始化方法，在 init() 之后调用。
   * MissionManager 由外部创建并传入（避免循环依赖），
   * 同时初始化 StateCache 和 AgentRequestQueue。
   *
   * @param missionManager - Mission 生命周期管理器实例
   */
  initMissionSystem(missionManager: MissionManager): void {
    this.missionManager = missionManager;
    // 创建 StateCache 实例（纠偏/预算/行为笔记的统一内存存储）
    if (!this._stateCache) {
      this._stateCache = new StateCache();
    }
    this.agentRequestQueue = new AgentRequestQueue();

    // §4.4.2: 将 stateCache 注入 KernelRouter，启用跨 agent 预算检查
    this.kernelRouter.setStateCache(this._stateCache);

    // §4.4.1: 将 AgentRequestQueue 注入 KernelRouter，启用 dialogue 路径的 per-target 串行化
    this.kernelRouter.setAgentRequestQueue(this.agentRequestQueue);

    // §3.8 第二层: 将 stateCache 注入 PermissionCoordinator，启用 active_scope 硬约束拦截
    if (this.permissionCoordinator) {
      this.permissionCoordinator.setStateCache(this._stateCache);
    }


    // §17.4: Mission EventBus 订阅簇 + TaskHeartbeatManager 已提取至 flows/mission-subscriptions.ts
    // （行为保持；标 delete-needs-board 的块——只提取不删除，P5 才删）
    // 副作用逐字保留：active_scope 清理（cleanupTaskState）、HeartbeatSource 适配器、delegation 终态化。
    setupMissionSubscriptions({
      missionManager: this.missionManager,
      delegationManager: this.delegationManager,
      agentManager: this.agentManager,
      permissionCoordinator: this.permissionCoordinator,
      stateCache: this._stateCache,
      dispatchModuleTask: (input) => this.dispatchModuleTask(input),
    } satisfies MissionSubscriptionsDeps);
  }

  /** 获取 MissionManager 实例（13.0 多智能体协作） */
  get mission(): MissionManager | null { return this.missionManager; }
  /** 获取 StateCache 实例（13.0 纠偏/预算/行为笔记；CorrectionFlowDeps 接口要求） */
  get stateCache(): StateCache | null { return this._stateCache; }
  /** 获取 AgentRequestQueue 实例（13.0 per-agent 并发控制） */
  get requestQueue(): AgentRequestQueue | null { return this.agentRequestQueue; }

  /**
   * 关闭清理：同步刷写未持久化的流式内容到 SQLite，防止进程退出丢失数据。
   * 必须在 taskManager.dispose() 之前调用（flusher 依赖 taskManager.flushStreamingContent）。
   */
  dispose(): void {
    this.streamingFlusher.dispose();
    this.pendingReviewOrigins.clear();
    // 13.0 §13.16: 停止 TaskHeartbeatManager
    try {
      // getTaskHeartbeatManager 已在文件顶部 import
      getTaskHeartbeatManager(getEventBus()).stop();
    } catch { /* 首次 dispose 前未初始化则忽略 */ }
    // 13.0: 清理 StateCache 中所有状态
    if (this.stateCache) {
      this.stateCache.clear();
    }
    // 13.0: 清理 AgentRequestQueue 中所有排队请求
    if (this.agentRequestQueue) {
      this.agentRequestQueue.clearAll('orchestrator dispose');
    }
  }

  // ═══ POST-COMPLETION HELPERS ═════════════════════════════════════

  /** §17.4: 后完成学习序列已提取至 flows/post-completion.ts（本 getter 构建 PostCompletionDeps） */
  private get postCompletionDeps(): PostCompletionDeps {
    return {
      sessionManager: this.sessionManager,
      worldModel: this.worldModelRef,
      dispatchModuleTask: (input) => this.dispatchModuleTask(input),
    };
  }

  /**
   * 对话完成后统一的「后完成学习」序列
   *
   * R15 解耦审计：final.response handler 和 handleTaskReviewResult 中
   * queueEvolution + queueCapabilityEvolution + extract_feedback + worldModel
   * 4 步几乎逐行重复。提取为统一 helper，消除补丁式复制粘贴。
   *
   * §17.4: 逻辑已提取至 flows/post-completion.ts（行为保持）
   *
   * @param sessionId 对话 session
   * @param userMessage 用户原始消息
   * @param assistantResponse 最终回复内容
   * @param toolCalls 本轮工具调用（可选）— 传给 World Model 推断 activeGoals
   */
  private onConversationCompleted(
    sessionId: string,
    userMessage: string,
    assistantResponse: string,
    /** 本轮工具调用（ToolBlock[]，来自 BlockCollector —— 审核链单一源）；World Model 仅读 .name 推断 activeGoals */
    toolCalls?: ToolBlock[],
  ): void {
    onConversationCompletedImpl(sessionId, userMessage, assistantResponse, toolCalls, this.postCompletionDeps);
  }

  /**
   * 统一的 feedback extraction dispatch helper
   *
   * R15 解耦审计：extract_feedback 的 dispatchModuleTask 调用在 orchestrator 中
   * 出现 5 处（auto-approve / drift-timeout / drift-approve / final.response /
   * handleTaskReviewResult），参数结构完全相同。提取为一行调用。
   *
   * §17.4: 逻辑已提取至 flows/post-completion.ts（行为保持）
   *
   * @param sessionId 对话 session
   * @param userMessage 用户原始消息
   * @param assistantResponse 助手回复内容
   * @param requester 请求来源（'brain_learning' 或 'post_review'）
   */
  private dispatchFeedbackExtraction(
    sessionId: string,
    userMessage: string,
    assistantResponse: string,
    requester: 'brain_learning' | 'post_review',
  ): void {
    dispatchFeedbackExtractionImpl(sessionId, userMessage, assistantResponse, requester, this.postCompletionDeps);
  }

  private get proxyDeps(): ProxyHandlersDeps {
    return {
      auditRecorder: this.auditRecorder,
      sessionManager: this.sessionManager,
      capabilityService: this.capabilityService,
      takeoverController: this.takeoverController,
      memoryRuntime: this.memoryRuntime,
      // 13.0 灵魂版：将观察队列记录器传给 proxy-handlers，使 tool.audit 同时写入观察队列
      observationRecorder: this.observationRecorder,
      // 13.0 §3.2: Brain IPC — tool.audit 转发 brain.observe 给 Brain 进程
      brainIpc: this._brainIpc ?? undefined,
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

    // 13.0 灵魂版：缓存 Brain IPC 引用，供 proxyDeps 转发 brain.observe IPC
    this._brainIpc = reviewer.ipc;

    this.setupReviewFlow(primary.ipc, reviewer.ipc, primaryName, reviewerName);
    this.setupRoutingFlow(reviewer.ipc);
    this.permissionFlow.setupJudgeHandler(reviewer.ipc);
    // 15.0 机制 D：注册 brain.command 指挥通道 handler（Brain 可向任意 Agent 派 execute/inspect/report）
    setupBrainCommandHandler(reviewer.ipc, {
      agentManager: this.agentManager,
      db: getDb(),
      // execute 真实委派：复用 dispatchModuleTask + targetAgentOverride 定向派发到 Brain 指定的 Agent
      dispatchExecute: (input) => this.dispatchModuleTask(input),
      // 16.0 P3：当前活跃 task 的 id（供 board 信封落板投影）。取最近活跃 pending 的 delegationTaskId。
      getCurrentTaskId: () => {
        for (const pending of this.sessionManager['pendingRequests'].values() as IterableIterator<PendingRequest>) {
          return pending.delegationTaskId ?? pending.taskId;
        }
        return undefined;
      },
    });
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
      // 13.0 灵魂版：将观察队列记录器注入 DialogueRouter，使 dialogue.send/reply 自动写入 brain_observations
      observationRecorder: this.observationRecorder,
    });
    this.dialogueRouter.startSweep();
    // 13.0 灵魂版：委托 KernelRouter 设置 primary agent 的 dialogue 路由
    this.kernelRouter.setDialogueRouter(this.dialogueRouter);
    this.kernelRouter.setupDialogueRouting(primary.ipc as AgentIpcLike, primaryName);

    // 11.0: Brain 通过 dialogue.observe 监听后可能发 turn.correction 纠偏
    // 转发给 Conversation Agent 处理（Brain → Core → Conversation）
    reviewer.ipc.onMessage('turn.correction', (msg: IpcMessage) => {
      const payload = msg.payload as { delegationId: string; action: string; instruction: string };
      // 对于 dialogue 模式的纠偏，转发给 Conversation Agent
      primary.ipc.send('turn.correction', primaryName, payload, msg.correlationId);
      logger.debug({ dialogueId: payload.delegationId, action: payload.action }, 'dialogue:brain correction forwarded');
    });

    // 13.0 §13.8/§11.4/§11.7: Brain 子进程的跨进程事件中继。
    // Brain 是独立子进程，进程内 EventBus 发不到 core；这些事件必须经 IPC 边界中继：
    //   - brain → core（inbound）：brain 用 ipc.send 发来 → core re-emit 到 EventBus，供既有订阅者消费
    //     （delegation-orchestrator 订阅 brain.signal_intervention / brain.checker.dispatch；
    //      ws-event-bridge 订阅 brain.cron_review_flagged 转发给前端）
    //   - core → brain（outbound）：CronScheduler 在 core 发 cron.review → core 转发 IPC 给 brain 审核
    // 用 WeakSet 去重，Brain 崩溃重启后新 IPC 引用会重新挂载（见 onBrainRegistered）。
    this.reattachBrainRelay(reviewer.ipc);
  }

  /**
   * Brain（reviewer）注册成功后由 AgentManager 调用——崩溃重启会创建新 IPC 引用，
   * 需重新挂载中继 handler，否则旧引用失效后 Brain 的事件再也无法到达 core。
   * 仅对 brain/reviewer agent 有效，幂等（同一 IPC 不会重复挂载）。
   */
  onBrainRegistered(): void {
    const reviewer = this.registry.requireRole('reviewer');
    const agent = this.agentManager.getAgent(reviewer.manifest.name);
    if (agent?.ipc) {
      this.reattachBrainRelay(agent.ipc);
    }
  }

  /** 挂载 Brain 子进程 ↔ core EventBus 的双向事件中继（幂等）——逻辑提取至 flows/brain-relay.ts */
  private reattachBrainRelay(brainIpc: IpcChannel): void {
    attachBrainEventRelay(brainIpc, this.brainRelayIpcs, this.registry);
  }

  setupDaemonEvents(): void {
    this.setupDaemonTaskResultHandlers();
  }

  // 13.0 灵魂版：dialogue 路由已抽取至 KernelRouter
  // - setupDialogueRouting：Primary Agent 的 dialogue 路由（由 KernelRouter.setupDialogueRouting 处理）
  // - setupModuleAgent 中 dialogue 部分：已抽取至 KernelRouter.setupDialogueRoutingForAgent
  // 详见 src/kernel/kernel-router.ts

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

    // ─── 13.0 §5.3.14: task.reject 处理 — Agent 拒绝任务的回退路径 ───
    // 当 Agent 判断自己不适合执行某个任务时，可以拒绝并建议其他 Agent。
    // 最多重路由 2 次，超过则降级为 chat 模式。
    agent.ipc.onMessage('task.reject', (msg: IpcMessage) => {
      this.handleTaskReject(agentName, msg);
    });

    // 13.0 灵魂版：dialogue 路由已抽取至 KernelRouter，统一管理所有跨 Agent 消息
    // KernelRouter.setupDialogueRoutingForAgent 内置防重复注册（WeakSet）
    this.kernelRouter.setupDialogueRoutingForAgent(agent.ipc as AgentIpcLike, agentName);
  }

  // ═══ PUBLIC API ═══════════════════════════════════

  // Track speculative execution state (conversation started before Brain routing confirms)
  private speculativeCorrelations = new Set<string>();
  private pendingHandoffs = new Map<string, RouteDecision>();

  // daemon 工具调用不再单独缓冲——期4 已统一走 BlockCollector（onToolStart/onToolComplete，
  // 见 setupDaemonTaskResultHandlers），与委派路径同构。collector key=taskId（==pending.delegationTaskId），
  // 生命周期由 complete()→persistInlineBlocks 据 key dispose 并落 message_blocks（刷新可恢复）。

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
          // 规则路由虽然没有走 Brain LLM，但前端仍需要 progress 事件展示思考过程
          this.reportProgress(pending, 'thinking', '正在分析意图...');
          this.brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, { ...ruleDecision, source: 'rule' } as unknown as Record<string, unknown>, pending.taskId);
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

      // 13.0 VF-2: route.request 超时回退 — Brain LLM 30s 无响应则降级到 FallbackRouter
      // 防止 LLM 全局故障时用户消息无限期挂起
      setTimeout(() => {
        const pending = this.sessionManager.getPending(correlationId);
        if (pending && !this.speculativeCorrelations.has(correlationId)) {
          // pending 还在等 routing → 触发降级
          metrics.counter('routing_llm_fallback_total').inc({ reason: 'timeout' });
          logger.warn({ correlationId, timeoutMs: 30_000, sessionId: pending.sessionId }, 'routing: Brain LLM 30s 无响应，降级到 FallbackRouter');
          this.handleRouteFallback(correlationId);
        }
      }, 30_000).unref();
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

    // 16.0 §6.5.1/D：用户回复 → 板状态 user_resumed（awaiting_user → in_progress，恢复干活）
    if (askState.taskId) applyBoardStatus(askState.taskId, { kind: 'user_resumed' });

    // 13.0 §3.2/§5.3.3: 将用户回复写入 Brain 观察队列（priority=0，critical，永不丢弃）
    // Brain 审核时需要知道用户对 agent 提问的真实回复，以判断 agent 是否正确使用了用户输入。
    // 这补全了观察队列的 user_interaction 类型覆盖（与 tool_call/tool_result 并列）。
    if (payload.sessionId && this.observationRecorder) {
      this.observationRecorder.record({
        sessionId: payload.sessionId,
        taskId: payload.taskId ?? askState.taskId ?? '',
        observationType: 'user_interaction',
        fromAgent: askState.agentName,
        content: JSON.stringify({
          direction: 'user_reply',
          question: askState.question,
          reply: payload.reply?.slice(0, 500),
        }),
        priority: 0, // §5.3.3: user_interaction = priority 0（critical，永不丢弃）
      });
    }

    agent.ipc.send('agent.user_reply', askState.agentName, payload, correlationId);

    // 13.0 §13.5: 发出 user.ask_response 事件 — WS bridge 订阅后转发 user_reply 给前端
    // 前端可据此关闭「等待用户回复」的 UI 状态（§5.3.5 独立超时闭环）
    getEventBus().emit('user.ask_response', {
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      correlationId,
      response: payload.reply,
    });
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
    // 1. 先签发 token（批准时返回 PermissionToken，拒绝时返回 null）。
    //    必须在通知 tool-caller 之前完成：resolveUserConfirm 发给 tool-caller 的 permission.result
    //    需要携带 tokenId，否则 tool-caller 判定"缺少 permission token"拒绝执行（即使已批准）。
    const token = this.permissionCoordinator.resolve(requestId, {
      verdict: approved ? 'approved' : 'denied',
      source: 'user',
      tokenVerdict: approved ? 'allow_once' : undefined,
      reason: reason ?? (approved ? '用户确认' : '用户拒绝'),
    });

    // 2. 再通知 tool-caller（带 tokenId）。token?.id 在拒绝时为 undefined，符合预期。
    const resolved = this.permissionFlow.resolveUserConfirm(requestId, approved, reason, token?.id);
    if (!resolved) return false;

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
    /** 15.0 机制 D：显式目标 Agent（brain.command execute） */
    targetAgentOverride?: string;
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
      // R14-1：中断场景也走 finalizeTask 统一入口
      this.sessionManager.fail(primary.correlationId, { kind: 'terminated' });
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

  /** §17.4: setupRoutingFlow 逻辑已提取至 flows/routing-result-handler.ts（行为保持） */
  private setupRoutingFlow(reviewerIpc: AgentIpc): void {
    setupRoutingResultHandler(reviewerIpc, {
      sessionManager: this.sessionManager,
      fallbackRouter: this.fallbackRouter,
      brainDecisionRecorder: this.brainDecisionRecorder,
      driftDetector: this.driftDetector,
      speculativeCorrelations: this.speculativeCorrelations,
      pendingHandoffs: this.pendingHandoffs,
      reportProgress: (pending, status, summary) => this.reportProgress(pending, status, summary),
      handleRouteDecision: (decision, correlationId) => this.handleRouteDecision(decision, correlationId),
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

    // 13.0 §8.3: 存储 IntentAnchor 到 StateCache — 供 Brain 审核时读取"用户原始意图"
    if (decision.intentAnchor && this.stateCache) {
      this.stateCache.set('intent_anchor', pending.sessionId, {
        goal: decision.intentAnchor.goal,
        constraints: decision.intentAnchor.constraints,
        outputType: decision.intentAnchor.outputType,
        entities: decision.intentAnchor.entities,
        storedAt: Date.now(),
      });
    }

    // 13.0 多智能体协作：如果 Brain 指定了 missionSpec，创建 mission
    // §12.2 意图守卫：chat 意图是简单对话，不需要创建 mission
    // 防重复：Brain 子进程可能已通过 MissionManager 创建了 mission 并回传 missionId，
    // 此时 Core 不应再创建（否则同一条路由请求产生两个 mission）
    if (decision.missionSpec && !decision.missionId && this.missionManager && decision.intent !== 'chat') {
      try {
        const plan = this.missionManager.createMission(
          decision.missionSpec.goal,
          decision.missionSpec.context,
          decision.missionSpec.tasks,
          'brain',
        );
        // 将 missionId 注入 decision，后续 dispatch 时会透传
        decision.missionId = plan.mission.id;
        logger.info({ missionId: plan.mission.id, taskCount: plan.tasks.length }, '13.0 mission created from route decision');

        // P7: 自动生成 squad 结构 — 基于 plan 中 agent 分配的分组
        autoGenerateSquad(this.missionContextDeps, decision.missionId, plan);
      } catch (err) {
        logger.error({ err }, '13.0 mission creation failed, continuing without mission');
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

  /** §17.4: handleRouteFallback 逻辑已提取至 flows/route-handlers.ts（VF-2 LLM 降级副作用逐字保留） */
  private handleRouteFallback(correlationId: string, userMessage?: string): void {
    handleRouteFallbackImpl(correlationId, userMessage, this.routeHandlersDeps);
  }

  /** §17.4: executeSetupAction 逻辑已提取至 flows/route-handlers.ts */
  private executeSetupAction(action: { action: string; params: unknown }): void {
    executeSetupActionImpl(action);
  }

  /** §17.4: loadActiveSkills 逻辑已提取至 flows/route-handlers.ts（注入检测逐字保留） */
  private loadActiveSkills(skillNames: string[]): string | null {
    return loadActiveSkillsImpl(skillNames);
  }

  /** 16.0 §17.4: mission 上下文 helper 函数已提取到 flows/mission-context-builder.ts；§17.4 拆解公开供 flows 文件构建 deps */
  get missionContextDeps(): MissionContextDeps {
    return {
      missionManager: this.missionManager,
      stateCache: this._stateCache,
      taskManager: this.taskManager,
    };
  }

  /** §17.4: 路由处理器簇已提取至 flows/route-handlers.ts（本 getter 构建 RouteHandlersDeps） */
  private get routeHandlersDeps(): RouteHandlersDeps {
    return {
      agentManager: this.agentManager,
      registry: this.registry,
      sessionManager: this.sessionManager,
      taskManager: this.taskManager,
      delegationManager: this.delegationManager,
      fallbackRouter: this.fallbackRouter,
      dialogueRouter: this.dialogueRouter,
      daemonBridge: this.daemonBridge,
      workspaceRouter: this.workspaceRouter,
      runtimeRegistry: this.runtimeRegistry,
      runtimeExecutor: this.runtimeExecutor,
      missionContextDeps: this.missionContextDeps,
      pendingReviewOrigins: this.pendingReviewOrigins,
      handleRouteDecision: (decision, correlationId) => this.handleRouteDecision(decision, correlationId),
      resolveRuntimeForTarget: (targetAgent) => this.resolveRuntimeForTarget(targetAgent),
      executeViaRuntime: (runtime, decision, correlationId, pending) => this.executeViaRuntime(runtime, decision, correlationId, pending),
      dispatchModuleTaskInternal: (input) => this.dispatchModuleTaskInternal(input),
      reportProgress: (pending, status, summary) => this.reportProgress(pending, status, summary),
    };
  }

  /** §17.4: handleChatRoute 逻辑已提取至 flows/route-handlers.ts（systemPrompt/memoryContext/skill/mission 注入逐字保留） */
  private handleChatRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): void {
    handleChatRouteImpl(decision, correlationId, pending, this.routeHandlersDeps);
  }

  /** §17.4: handleTaskRoute 逻辑已提取至 flows/route-handlers.ts */
  private async handleTaskRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    return handleTaskRouteImpl(decision, correlationId, pending, this.routeHandlersDeps);
  }

  /** §17.4: handleExternalRoute 逻辑已提取至 flows/route-handlers.ts（runtime 优先 + daemon 回退逐字保留） */
  private async handleExternalRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    return handleExternalRouteImpl(decision, correlationId, pending, this.routeHandlersDeps);
  }

  /** §17.4: resolveRuntimeForTarget 逻辑已提取至 flows/runtime-execution.ts（行为保持） */
  private resolveRuntimeForTarget(targetAgent: string): AgentRuntime | null {
    return resolveRuntimeForTargetImpl(this.runtimeRegistry, targetAgent);
  }

  /** §17.4: executeViaRuntime 逻辑已提取至 flows/runtime-execution.ts（行为保持，BlockCollector 生命周期副作用逐字保留） */
  private async executeViaRuntime(
    runtime: AgentRuntime,
    decision: RouteDecision,
    correlationId: string,
    pending: PendingRequest,
  ): Promise<void> {
    const deps: RuntimeExecutionDeps = {
      delegationManager: this.delegationManager,
      streamingFlusher: this.streamingFlusher,
      reportProgress: (p, status, summary) => this.reportProgress(p, status, summary),
      sessionManagerFail: (cid, outcome) => this.sessionManager.fail(cid, outcome),
      sendTaskResultForReview: (fgEntry, p, draft) => this.sendTaskResultForReview(fgEntry, p, draft),
    };
    return executeViaRuntimeImpl(runtime, this.runtimeExecutor, decision, correlationId, pending, deps);
  }

  /** §17.4: handleMultiRoute 逻辑已提取至 flows/route-handlers.ts（并行派发副作用逐字保留） */
  private async handleMultiRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    return handleMultiRouteImpl(decision, correlationId, pending, this.routeHandlersDeps);
  }

  /** §17.4: handleWorkspaceRoute 逻辑已提取至 flows/route-handlers.ts（team lead 委托逐字保留） */
  private async handleWorkspaceRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void> {
    return handleWorkspaceRouteImpl(decision, correlationId, pending, this.routeHandlersDeps);
  }

  private async dispatchModuleTaskInternal(input: {
    sessionId: string;
    taskType: string;
    requester: string;
    inputPayload: Record<string, unknown>;
    foreground?: boolean;
    correlationId?: string;
    /** 15.0 机制 D：显式指定目标 Agent（brain.command execute 用），提供时跳过 taskRouter 路由 */
    targetAgentOverride?: string;
  }): Promise<{ taskId: string; targetAgent: string }> {
    // 15.0 机制 D：targetAgentOverride 时直接定向（Brain 指挥官指定目标），否则按 taskType 路由
    const route = input.targetAgentOverride
      ? { targetAgent: input.targetAgentOverride, reason: 'brain.command 显式指定目标 Agent' }
      : this.taskRouter.route({ taskType: input.taskType, requester: input.requester });
    const correlationId = input.correlationId ?? genId('corr');

    const span = getTracer().startTrace('task.dispatch', {
      taskType: input.taskType,
      targetAgent: route.targetAgent,
      correlationId,
    });

    // ─── 13.0 §4.4.1: AgentRequestQueue 并发控制 ───
    // 每个 module agent 同时只处理一个请求，其他排队等待。
    // 队列深度上限 3，等待上限 30s，超出自动拒绝。
    if (this.agentRequestQueue) {
      try {
        await this.agentRequestQueue.enqueue(route.targetAgent, {
          fromAgent: input.requester,
          requestId: correlationId,
        });
        // resolve: 轮到该请求处理，继续正常分发
      } catch (err) {
        // reject: 队列满或等待超时，记录并向上层返回错误
        logger.warn({ targetAgent: route.targetAgent, err: (err as Error).message }, 'task.dispatch: agent 队列拒绝');
        span.setAttributes({ error: (err as Error).message });
        span.end();
        // 创建一个 failed delegation 记录，让上层能看到失败原因
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
        this.delegationManager.fail(taskId, (err as Error).message);
        updatePlanTaskStatus(this.missionContextDeps, taskId, 'failed', (err as Error).message);
        return { taskId, targetAgent: route.targetAgent };
      }
    }

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

    // ─── 13.0 §8.5 + 15.0 R4「委派即授权」: scope 预授权 ───
    // 任务派发时将约束写入 task 级 active_scope。15.0 R4 改为：委派本身即授权该 Agent
    // 用自身工具完成任务，因此默认写入 allowTools:['*']（受下方 blockTools/blockPaths 约束）。
    //
    // 为什么委派即授权：Brain 决定把任务交给目标 Agent，意味着已认可"该 Agent 用自身工具
    // 完成任务"——逐次让 Brain 审核每个 edit_code/write_file 既无必要（Brain 已知情），又会在
    // 默认 allow-all 配置下因危险类别早返回 requiresReview 而被静默阻断（Code Agent 经
    // permission.request 同步路径无法异步审核）。allowTools 让这些工具自动放行（签 token）。
    //
    // 若 inputPayload 带 forbiddenTools（Brain 路由 / 纠偏收窄），并入 blockTools——
    // block 永远优先于 allow（evaluateScope 先判 block），Brain 收窄依然生效。
    if (this.permissionCoordinator && this._stateCache) {
      const forbiddenTools = input.inputPayload.forbiddenTools as string[] | undefined;
      this.permissionCoordinator.setActiveScope(taskId, {
        allowTools: ['*'],
        ...(forbiddenTools && forbiddenTools.length > 0 ? { blockTools: forbiddenTools } : {}),
      });
      logger.debug(
        { taskId, allowTools: ['*'], blockTools: forbiddenTools ?? null },
        'task.dispatch: 委派即授权 scope（allowTools 全工具集 + forbiddenTools 收窄）',
      );
    }

    // 13.0 多智能体协作：从 inputPayload 透传 missionId 和 planTaskId
    const missionId = input.inputPayload.missionId as string | undefined;
    const planTaskId = input.inputPayload.planTaskId as string | undefined;

    // ─── 16.0 P4-C2：派发点投影 delegate 信封（fire-and-forget 审计影子）───
    // 在 delegationManager.create 返回 taskId 之后、ipc.send('agent.task') 之前落板。
    // initBoard 幂等 + addMember + postBoardMessage(delegate)。失败 no-op，不影响派发主路径。
    postDelegateEnvelope(taskId, {
      from: resolveLeaderForDelegate(input.inputPayload.parentTaskId as string | undefined),
      to: route.targetAgent,
      subTaskGoal: (input.inputPayload.message as string) ?? (input.inputPayload.instruction as string) ?? '',
      sessionId: input.sessionId,
      parentTaskId: input.inputPayload.parentTaskId as string | undefined,
      scope: { allowTools: ['*'], ...(input.inputPayload.forbiddenTools ? { blockTools: input.inputPayload.forbiddenTools } : {}) },
    });

    const taskPayload = {
      taskId,
      sessionId: input.sessionId,
      taskType: input.taskType,
      inputPayload: input.inputPayload,
      // 13.0：透传 mission 上下文，让 Agent 知道自己属于哪个 mission
      ...(missionId ? { missionId } : {}),
      ...(planTaskId ? { planTaskId } : {}),
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

  /** §17.4: 审核流簇已提取至 flows/review-flow.ts（本 getter 构建 ReviewFlowDeps） */
  private get reviewFlowDeps(): ReviewFlowDeps {
    return {
      agentManager: this.agentManager,
      registry: this.registry,
      sessionManager: this.sessionManager,
      taskManager: this.taskManager,
      delegationManager: this.delegationManager,
      streamingFlusher: this.streamingFlusher,
      auditRecorder: this.auditRecorder,
      brainDecisionRecorder: this.brainDecisionRecorder,
      dialogueRouter: this.dialogueRouter,
      observationRecorder: this.observationRecorder,
      takeoverController: this.takeoverController,
      superiorReviewFlow: this.superiorReviewFlow,
      missionManager: this.missionManager,
      pendingReviewOrigins: this.pendingReviewOrigins,
      pendingHandoffs: this.pendingHandoffs,
      speculativeCorrelations: this.speculativeCorrelations,
      handleRouteDecision: (decision, correlationId) => this.handleRouteDecision(decision, correlationId),
      performDriftCheckAndApprove: (pending, primaryIpc, primaryName, reviewerIpc, reviewerName, correlationId, sessionId, draft, turn) => this.performDriftCheckAndApprove(pending, primaryIpc, primaryName, reviewerIpc, reviewerName, correlationId, sessionId, draft, turn),
      onConversationCompleted: (sessionId, userMessage, assistantResponse, toolCalls) => this.onConversationCompleted(sessionId, userMessage, assistantResponse, toolCalls),
      dispatchFeedbackExtraction: (sessionId, userMessage, assistantResponse, requester) => this.dispatchFeedbackExtraction(sessionId, userMessage, assistantResponse, requester),
      reportProgress: (pending, status, summary) => this.reportProgress(pending, status, summary),
    };
  }

  /** §17.4: 审核流簇已提取至 flows/review-flow.ts（本方法为薄包装构建 ReviewFlowDeps） */
  private setupReviewFlow(primaryIpc: AgentIpc, reviewerIpc: AgentIpc, primaryName: string, reviewerName: string): void {
    setupReviewFlowImpl(primaryIpc, reviewerIpc, primaryName, reviewerName, this.reviewFlowDeps);
  }

  /** §17.4: handleTaskReviewResult 逻辑已提取至 flows/review-flow.ts（委派 complete + plan update + onConversationCompleted 逐字保留） */
  private handleTaskReviewResult(review: ReviewResult, correlationId: string): void {
    handleTaskReviewResultImpl(review, correlationId, this.reviewFlowDeps);
  }

  /** §17.4: onSuperiorChainCompleted 逻辑已提取至 flows/review-flow.ts */
  private onSuperiorChainCompleted(correlationId: string, modifiedResponse: string | undefined, reviewerIpc: AgentIpc, reviewerName: string): void {
    onSuperiorChainCompletedImpl(correlationId, modifiedResponse, reviewerIpc, reviewerName, this.reviewFlowDeps);
  }

  /** §17.4: approveReviewDegraded 逻辑已提取至 flows/review-flow.ts（emit no_response → delegation complete → session complete 三步序列逐字保留） */
  private approveReviewDegraded(
    correlationId: string,
    draft: string,
    reason: string,
    sessionId: string,
  ): void {
    approveReviewDegradedImpl(correlationId, draft, reason, sessionId, this.reviewFlowDeps);
  }

  /** §17.4: onSuperiorChainRejected 逻辑已提取至 flows/review-flow.ts（委派 fail + session fail 逐字保留） */
  private onSuperiorChainRejected(correlationId: string, reason: string): void {
    onSuperiorChainRejectedImpl(correlationId, reason, this.reviewFlowDeps);
  }

  /** §17.4: sendTaskResultForReview 逻辑已提取至 flows/review-flow.ts（reviewer 不可用降级 + 30s 超时降级逐字保留） */
  private sendTaskResultForReview(fgEntry: { correlationId: string; sessionId: string }, pending: PendingRequest, draftResponse: string): void {
    sendTaskResultForReviewImpl(fgEntry, pending, draftResponse, this.reviewFlowDeps);
  }

  /** §17.4: setupAgentAskUserFlow 逻辑已提取至 flows/ask-user-flow.ts（observationRecorder + markAskingUser + emit ask_user 逐字保留） */
  private setupAgentAskUserFlow(reviewerIpc: AgentIpc): void {
    setupAgentAskUserFlowImpl(reviewerIpc, {
      agentManager: this.agentManager,
      sessionManager: this.sessionManager,
      delegationManager: this.delegationManager,
      observationRecorder: this.observationRecorder,
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

  /** §17.4: 任务结果处理簇已提取至 flows/foreground-result.ts（行为保持，本 getter 构建 ForegroundResultDeps） */
  private get foregroundResultDeps(): ForegroundResultDeps {
    return {
      delegationManager: this.delegationManager,
      sessionManager: this.sessionManager,
      taskManager: this.taskManager,
      streamingFlusher: this.streamingFlusher,
      missionContextDeps: this.missionContextDeps,
      agentRequestQueue: this.agentRequestQueue,
      observationRecorder: this.observationRecorder,
      sendTaskResultForReview: (fgEntry, pending, draft) => this.sendTaskResultForReview(fgEntry, pending, draft),
      dispatchModuleTaskInternal: (input) => this.dispatchModuleTaskInternal(input),
    };
  }

  /** §17.4: handleTaskReject 逻辑已提取至 flows/foreground-result.ts（重路由 / 降级副作用逐字保留） */
  private handleTaskReject(agentName: string, msg: IpcMessage): void {
    handleTaskRejectImpl(agentName, msg, this.foregroundResultDeps);
  }

  /** §17.4: handleForegroundTaskResult 逻辑已提取至 flows/foreground-result.ts（AgentRequestQueue 槽位释放 + 委派终态收口逐字保留） */
  private handleForegroundTaskResult(
    result: AgentTaskResultPayload,
    fgEntry: { correlationId: string; sessionId: string },
    agentName: string,
  ): void {
    handleForegroundTaskResultImpl(result, fgEntry, agentName, this.foregroundResultDeps);
  }

  /** §17.4: resolveMultiTaskResult 逻辑已提取至 flows/foreground-result.ts */
  private resolveMultiTaskResult(
    group: import('../contracts/delegation.js').DelegationGroup,
    correlationId: string,
    sessionId: string,
  ): void {
    resolveMultiTaskResultImpl(group, correlationId, sessionId, this.foregroundResultDeps);
  }

  /** §17.4: setupDaemonTaskResultHandlers 逻辑已提取至 flows/foreground-result.ts（V-2 超时/cancel 终态化逐字保留） */
  private setupDaemonTaskResultHandlers(): void {
    setupDaemonTaskResultHandlersImpl(this.foregroundResultDeps);
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

  /** §17.4: performDriftCheckAndApprove 逻辑已提取至 flows/drift-flow.ts（DriftDetector + VerifyGate 逐字保留，§17.7.3 keep 的活路径） */
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
    const deps: DriftFlowDeps = {
      agentManager: this.agentManager,
      registry: this.registry,
      delegationManager: this.delegationManager,
      sessionManager: this.sessionManager,
      driftDetector: this.driftDetector,
      pendingReviewOrigins: this.pendingReviewOrigins,
      approveReviewDegraded: (correlationId, draft, reason, sessionId) => this.approveReviewDegraded(correlationId, draft, reason, sessionId),
      dispatchFeedbackExtraction: (sessionId, userMessage, assistantResponse, requester) => this.dispatchFeedbackExtraction(sessionId, userMessage, assistantResponse, requester),
      reportProgress: (pending, status, summary) => this.reportProgress(pending, status, summary),
    };
    performDriftCheckAndApproveImpl(pending, primaryIpc, primaryName, reviewerIpc, reviewerName, correlationId, sessionId, draft, turn, deps);
  }
}
