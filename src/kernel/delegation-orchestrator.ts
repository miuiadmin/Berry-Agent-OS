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
import { KernelRouter, type AgentIpcLike } from './kernel-router.js';
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
import { metrics } from '../observability/metrics.js';
import { PermissionFlow } from './flows/permission-flow.js';
import { StreamingFlusher } from './streaming-flusher.js';
import { ObservationRecorder } from './observation-recorder.js';
/** 13.0 §13.16: TaskHeartbeatManager — 长任务心跳推送 */
import { getTaskHeartbeatManager, type HeartbeatEntry } from './task-heartbeat-manager.js';
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
import { safeSlice } from '../utils/safe-slice.js';
import { genId } from '../utils/id.js';
import { getTracer } from '../observability/tracer.js';
import { getEventBus } from './event-bus.js';
import { withTrace, getCurrentTrace } from '../observability/trace-context.js';
import { BrainDecisionRecorder } from './brain-decision-recorder.js';
import { isDelegationTerminal, type DelegationEntry } from '../contracts/delegation.js';
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
import { MissionManager } from './mission-manager.js';
import { StateCache } from './state-cache.js';
/** 12.0/13.0 VerifyGate — 独立对抗性意图验证（高漂移时触发） */
import { VerifyGate } from './verify-gate.js';
import { AgentRequestQueue } from './agent-request-queue.js';
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
  /** 12.0/13.0 VerifyGate — 高漂移时的独立对抗性意图验证 */
  private readonly verifyGate = new VerifyGate();

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

    /**
     * P5: 订阅 mission.task_ready 事件 — 依赖满足时自动派发下游任务。
     *
     * 当 MissionManager 检测到某个 waiting 任务的 depends_on 全部完成时，
     * 发出 mission.task_ready 事件。此处订阅并自动派发给负责的 agent。
     */
    getEventBus().on('mission.task_ready', (payload: { missionId: string; taskId: string; who: string; what: string }) => {
      logger.info({ missionId: payload.missionId, taskId: payload.taskId, who: payload.who }, '13.0: mission.task_ready — 自动派发');

      // §12.5: 用 plan 的 who 字段路由到真正负责的 agent（而非写死 chat）。
      // who 是 agent 名，需映射到该 agent 的主 taskType 供 taskRouter 路由。
      const taskType = taskTypeForAgent(payload.who) ?? 'chat';
      this.dispatchModuleTask({
        sessionId: payload.missionId, // missionId 作为 session 的关联标识
        taskType,
        requester: 'brain-mission',
        inputPayload: {
          userMessage: payload.what,
          missionId: payload.missionId,
          planTaskId: payload.taskId,
        },
        foreground: true,
      }).catch(err => {
        logger.warn({ err, missionId: payload.missionId, taskId: payload.taskId, who: payload.who }, '13.0: task_ready 派发失败');
      });
    });

    // 13.0 §12.8: mission 全部完成 → 派发汇总任务给 Conversation agent。
    // 修复缺口：mission.completed 事件此前仅推送前端，后端零订阅者，Conversation 不汇总。
    getEventBus().on('mission.completed', (payload: { missionId: string; goal: string }) => {
      logger.info({ missionId: payload.missionId, goal: payload.goal }, '13.0: mission.completed — 派发汇总');
      this.dispatchModuleTask({
        sessionId: payload.missionId,
        taskType: 'conversation_turn', // Conversation agent 负责 mission 汇总（§12.8）
        requester: 'brain-mission',
        inputPayload: {
          userMessage: `Mission「${payload.goal}」的全部任务已完成，请汇总各任务结果给用户。`,
          missionId: payload.missionId,
          isMissionSummary: true,
        },
        foreground: true,
      }).catch(err => {
        logger.warn({ err, missionId: payload.missionId }, '13.0: mission.completed 汇总派发失败');
      });
    });

    // 13.0 §11.7/§12.5: Brain 观察 blocker/question signal → 发 brain.signal_intervention。
    // 修复缺口：此事件此前零订阅者，Brain 的干预意图无人执行。
    // 消费方式：找到 mission 中活跃的 worker delegation，发 turn.correction 注入软纠偏。
    getEventBus().on('brain.signal_intervention', (payload: {
      missionId: string; from: string; signalType: string; signalMsg: string;
      instruction: string; severity: 'low' | 'medium' | 'high'; createdAt: number;
    }) => {
      // 用 missionId 当 sessionId 查活跃 worker delegation
      const active = this.delegationManager.getActiveForSession(payload.missionId);
      const worker = active.find(e => e.targetAgent === payload.from) ?? active[0];
      if (!worker) {
        logger.debug({ missionId: payload.missionId, from: payload.from }, '13.0: signal_intervention 无活跃 worker，跳过');
        return;
      }
      const agent = this.agentManager.getAgent(worker.targetAgent);
      if (!agent) return;
      // 发 turn.correction（软纠偏：instruction 注入 worker 下一轮 system message）
      agent.ipc.send('turn.correction', worker.targetAgent, {
        delegationId: worker.id,
        action: 'adjust',
        instruction: payload.instruction,
        newConstraints: payload.severity === 'high' ? { forbiddenTools: [] } : undefined,
      } as import('../contracts/delegation.js').TurnCorrectionPayload, genId('sigint'));
      logger.info({ missionId: payload.missionId, targetAgent: worker.targetAgent, signalType: payload.signalType }, '13.0: signal_intervention → turn.correction 已派发');
    });

    // 13.0 §11.6: handoff 完成 → 目标 squad 的 leader 收到主动通知（修复死事件）。
    // 之前 handoff 上下文只写入 squad.json，目标 agent 需轮询才能感知。
    getEventBus().on('mission.handoff', (payload: { missionId: string; from: string; to: string; what: string }) => {
      // 读 squad.json 找到目标 squad 的 leader，把 handoff 摘要推给它的活跃 delegation
      try {
        const leaderAgent = this.missionManager?.resolveSquadLeader?.(payload.missionId, payload.to);
        const target = leaderAgent ?? 'conversation';
        const active = this.delegationManager.getActiveForSession(payload.missionId);
        const worker = active.find(e => e.targetAgent === target);
        if (worker) {
          const agent = this.agentManager.getAgent(worker.targetAgent);
          agent?.ipc.send('task.progress', worker.targetAgent, {
            taskId: worker.id,
            summary: `[Mission handoff] ${payload.from} → ${payload.to}: ${payload.what}`,
            kind: 'mission_handoff',
            missionId: payload.missionId,
          });
        }
        logger.info({ missionId: payload.missionId, to: payload.to, target }, '13.0: mission.handoff 已通知目标 squad');
      } catch (err) {
        logger.debug({ err: (err as Error).message, missionId: payload.missionId }, 'mission.handoff 通知失败（非致命）');
      }
    });
    // 避免 stale 约束/纠偏/行为笔记泄漏到下一个 task
    // （active_scope 用 delegationId，correction/behavior_note 用 sessionId:taskId 复合 key）
    const cleanupTaskState = (delegationId: string, sessionId?: string, taskId?: string) => {
      if (this.permissionCoordinator) {
        this.permissionCoordinator.clearActiveScope(delegationId);
      }
      // 清理 StateCache 中所有与该 task 相关的命名空间条目
      if (this._stateCache) {
        if (taskId) {
          // correction / behavior_note 等用 sessionId:taskId 复合 key
          const compositeKey = sessionId ? `${sessionId}:${taskId}` : taskId;
          this._stateCache.delete('correction', compositeKey);
          this._stateCache.delete('behavior_note', compositeKey);
          // active_scope 用 taskId 作为 key
          this._stateCache.delete('active_scope', taskId);
          // intent_anchor 按 sessionId 索引；task 结束不主动清（跨 task 复用）
        }
        if (sessionId) {
          // mission_context 按 sessionId 索引；task 结束不主动清（跨 task 复用）
        }
      }
    };

    // 单一入口：completed / failed / timeout / cancel 都走同一个清理函数
    const onTermination = (payload: { delegationId: string; sessionId?: string; targetAgent?: string }) => {
      // 从 delegationEntry 反查 sessionId/taskId
      const entry = this.delegationManager.get(payload.delegationId);
      const resolvedTaskId = (entry as unknown as { taskId?: string } | undefined)?.taskId ?? payload.delegationId;
      cleanupTaskState(
        payload.delegationId,
        payload.sessionId ?? entry?.sessionId,
        resolvedTaskId,
      );
      logger.debug({
        delegationId: payload.delegationId,
        sessionId: payload.sessionId ?? entry?.sessionId,
        targetAgent: payload.targetAgent,
      }, 'orchestrator: cleanup task state on delegation end');
    };

    getEventBus().on('delegation.completed', onTermination);
    getEventBus().on('delegation.failed', onTermination);

    // 13.0 §13.16: 启动 TaskHeartbeatManager — 长任务（>1min 无活动）自动发心跳
    // 前端通过 task.heartbeat WS 事件显示「还在工作中」提示
    // getTaskHeartbeatManager 已在文件顶部 import
    const heartbeatMgr = getTaskHeartbeatManager(getEventBus());
    // HeartbeatSource 适配器：把 DelegationManager 的 entries 映射为 HeartbeatEntry
    heartbeatMgr.setSource({
      getActiveDelegations: () => {
        const entries: Array<HeartbeatEntry> = [];
        for (const entry of this.delegationManager.getAll()) {
          if (isDelegationTerminal(entry.state)) continue;
          entries.push({
            delegationId: entry.id,
            taskId: entry.id,
            agentName: entry.targetAgent,
            startedAt: entry.createdAt,
            lastActivityAt: entry.lastCheckpointAt ?? entry.createdAt,
            lastActivityType: entry.lastCheckpointAt ? 'checkpoint' : 'created',
          });
        }
        return entries;
      },
      markHeartbeat: (delegationId: string) => {
        // 心跳标记写入 delegation entry（更新 lastCheckpointAt 避免重复心跳）
        const entry = this.delegationManager.get(delegationId);
        if (entry) {
          entry.lastCheckpointAt = Date.now();
        }
      },
      /** §13.16: 通过 DelegationManager.fail() 终止超时 delegation */
      timeoutDelegation: (delegationId: string, reason: string): boolean => {
        return this.delegationManager.fail(delegationId, reason);
      },
    });
    heartbeatMgr.start();
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

  /**
   * 对话完成后统一的「后完成学习」序列
   *
   * R15 解耦审计：final.response handler 和 handleTaskReviewResult 中
   * queueEvolution + queueCapabilityEvolution + extract_feedback + worldModel
   * 4 步几乎逐行重复。提取为统一 helper，消除补丁式复制粘贴。
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
    toolCalls?: Array<{ name: string }>,
  ): void {
    this.sessionManager.queueEvolution(sessionId, userMessage, assistantResponse);
    this.sessionManager.queueCapabilityEvolution(sessionId, userMessage, assistantResponse);
    this.dispatchFeedbackExtraction(sessionId, userMessage, assistantResponse, 'brain_learning');
    this.worldModelRef?.updateFromConversation({
      userMessage,
      assistantResponse,
      toolCalls,
      sessionId,
    });
  }

  /**
   * 统一的 feedback extraction dispatch helper
   *
   * R15 解耦审计：extract_feedback 的 dispatchModuleTask 调用在 orchestrator 中
   * 出现 5 处（auto-approve / drift-timeout / drift-approve / final.response /
   * handleTaskReviewResult），参数结构完全相同。提取为一行调用。
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
    this.dispatchModuleTask({
      sessionId,
      taskType: 'extract_feedback',
      requester,
      inputPayload: { taskType: 'extract_feedback', userMessage, assistantResponse },
    }).catch((err) => {
      logger.debug({ err, sessionId }, 'Feedback extraction dispatch failed');
    });
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

  private setupRoutingFlow(reviewerIpc: AgentIpc): void {
    reviewerIpc.onMessage('route.result', (msg: IpcMessage) => {
      const { decision } = msg.payload as RouteResultPayload;
      const correlationId = msg.correlationId!;
      logger.info({ correlationId, intent: decision.intent, target: decision.targetAgent }, '路由决策到达');

      const pending = this.sessionManager.getPending(correlationId);
      if (pending) {
        this.fallbackRouter.recordBrainDecision(pending.userMessage, decision);
        this.brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, decision as unknown as Record<string, unknown>, pending.taskId);
        // 12.0: 填充意图锚点到 pending（漂移检测基准）并持久化
        if (decision.intentAnchor) {
          pending.intentAnchor = decision.intentAnchor;
          this.driftDetector?.recordAnchor(
            decision.intentAnchor, pending.userMessage,
            pending.sessionId, correlationId, decision.reason,
          );
        }
        // 13.0 §12.6: 填充 missionId / planTaskId / taskDescription 到 pending（审核时传给 Brain）
        if (decision.missionId) pending.missionId = decision.missionId;
        if (decision.planTaskId) pending.planTaskId = decision.planTaskId;
        if (decision.missionSpec?.tasks?.length && decision.planTaskId) {
          // missionSpec.tasks 没有 id 字段，按 planTaskId 解析（如 t-1 → index 0）
          const m = /^t-(\d+)$/.exec(decision.planTaskId);
          if (m) {
            const idx = parseInt(m[1], 10) - 1;
            const taskSpec = decision.missionSpec.tasks[idx];
            if (taskSpec) pending.taskDescription = taskSpec.what;
          }
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
    if (decision.missionSpec && this.missionManager && decision.intent !== 'chat') {
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
        this.autoGenerateSquad(decision.missionId, plan);
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

  private handleRouteFallback(correlationId: string, userMessage?: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    const message = userMessage ?? pending.userMessage;
    // 13.0 VF-2: 记录 LLM 全局故障的回退路径，让监控和前端能感知
    // 设计依据：设计文档 §23 漏洞 #2 — LLM global failure no fallback strategy
    // 当前策略：fail-soft（用规则 fallback）但记录指标 + 事件，便于：
    // 1. 运维发现 LLM 异常时及时干预
    // 2. 前端可显示「Brain 暂时不可用」提示
    metrics.counter('routing_llm_fallback_total').inc({ reason: 'brain_unavailable' });
    logger.warn({ correlationId, intent: 'chat', sessionId: pending.sessionId }, 'routing: Brain LLM 不可用，降级到 FallbackRouter（规则路由）');

    const decision = this.fallbackRouter.route(message);
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

  /**
   * 13.0 多智能体协作：构造 mission + squad context 文本，注入到 system prompt。
   * 让 agent 知道自己属于哪个 mission、目标是什么、有哪些任务、当前状态、squad 角色。
   *
   * 注入策略（§12.3/§12.6）：
   * - 优先用 renderContext() 输出 squad 队友 + 未解决信号 + 任务进度（planTaskId + targetAgent 已知时）
   * - 回退到 readSummary() + squad 列表（仅 missionId 已知时）
   * - 始终叠加 StateCache 的纠偏/行为笔记
   *
   * @param missionId mission ID
   * @param planTaskId 当前 plan task ID（可选；提供时输出 squad 上下文）
   * @param targetAgent 目标 agent 名（可选；提供时定位 squad 角色）
   * @returns 格式化的 mission context 字符串（用于 system prompt 注入）
   */
  private buildMissionContextPrompt(
    missionId: string,
    planTaskId?: string,
    targetAgent?: string,
  ): string | null {
    if (!this.missionManager) return null;
    try {
      // ① 优先：使用 renderContext 输出 squad 队友/角色/信号
      let contextBlock = '';
      if (planTaskId && targetAgent) {
        const richContext = this.missionManager.renderContext(missionId, planTaskId, targetAgent);
        if (richContext) {
          contextBlock = `## Mission Context\n\n${richContext}`;
        }
      }

      // ② 回退：仅 missionId 时输出 readSummary
      if (!contextBlock) {
        const summary = this.missionManager.readSummary(missionId);
        if (!summary) return null;
        contextBlock = `## Mission Context\n\n${summary}`;
      }

      /** §3.8/§5.3.1: 注入 StateCache 中的纠偏指令和行为笔记 */
      const stateInjections: string[] = [];

      if (this.stateCache) {
        // 注入纠偏指令（correction namespace，key={sessionId}:{taskId}）
        // 当前上下文没有明确的 taskId，所以遍历所有 correction keys
        const correctionKeys = this.stateCache.keys('correction');
        for (const key of correctionKeys) {
          const correction = this.stateCache.get<import('./state-cache.js').CorrectionEntry>('correction', key);
          if (correction) {
            const severityIcon = correction.severity === 'high' ? '🔴' : correction.severity === 'medium' ? '🟡' : '🟢';
            stateInjections.push(`${severityIcon} 纠偏指令: ${correction.instruction}`);
          }
        }

        // 注入行为笔记（behavior_note namespace）
        const behaviorKeys = this.stateCache.keys('behavior_note');
        for (const key of behaviorKeys) {
          const note = this.stateCache.get<import('./state-cache.js').BehaviorNote>('behavior_note', key);
          if (note) {
            stateInjections.push(`📌 行为提醒: ${note.instruction}`);
          }
        }
      }

      let stateContext = '';
      if (stateInjections.length > 0) {
        stateContext = '\n\n## Brain 指令（来自监督系统）\n\n' + stateInjections.join('\n');
      }

      /** P10: squad checker 角色提示（仅在 squad 中有 checker 角色时追加） */
      let checkerHint = '';
      const squad = this.missionManager.readSquad(missionId);
      if (squad && squad.org.squads.some(s => s.members.some(m => m.role === 'check'))) {
        checkerHint = '\n\n### Checker 角色指引\n如果你是 Squad 中的 Checker（验证者）：独立审查 worker 的产出，关注正确性/完整性/安全性/一致性。发现问题通过 squad tool signal(blocker/question) 报告，不直接修改。验证通过用 signal(done)。';
      }

      /**
       * §5.3.11: 注入 HandoffContext（如果存在最近一次交接上下文）。
       * 接收方 agent 需要看到前任 agent 的工作进展、已读文件、阻塞等信息，
       * 才能无缝接手任务，而不是从零开始。
       */
      let handoffContext = '';
      if (planTaskId) {
        const handoffCtx = this.missionManager.readLatestHandoffContextAny(missionId);
        if (handoffCtx) {
          const renderedHandoff = this.missionManager.renderHandoffContext(handoffCtx);
          handoffContext = '\n\n## 任务交接上下文\n\n你是从另一个 Agent 接手的任务。以下是前任的工作状态：\n\n' + renderedHandoff;
        }
      }

      return `${contextBlock}\n\n使用 plan 工具（read）查看完整计划，update 更新自己的任务进度。使用 squad 工具管理团队（read/handoff/signal/update_member）。${checkerHint}${handoffContext}${stateContext}`;
    } catch (err) {
      logger.warn({ err, missionId }, 'buildMissionContextPrompt 失败');
      return null;
    }
  }

  /**
   * P7: 自动生成 squad 结构 — 基于 plan 中 agent 分配的分组。
   *
   * 规则化方法（零 LLM）：提取 plan 中所有 task 的 who 字段去重，
   * 每个 unique agent 创建一个 squad，agent 既是 leader 也是执行者。
   * 适用于 P1 阶段单实例模型。
   *
   * @param missionId Mission ID
   * @param plan 已创建的 plan 对象
   */
  private autoGenerateSquad(missionId: string, plan: import('../contracts/mission.js').Plan): void {
    if (!this.missionManager) return;

    /** 提取去重的 agent 列表 */
    const agentGroups = new Map<string, import('../contracts/mission.js').MissionTask[]>();
    for (const task of plan.tasks) {
      if (!agentGroups.has(task.who)) {
        agentGroups.set(task.who, []);
      }
      agentGroups.get(task.who)!.push(task);
    }

    /** 只有 1 个 agent 时不创建 squad（无需组织） */
    if (agentGroups.size < 2) return;

    /** 收集可用的 agent 名列表（用于 P10 checker 分配） */
    const agentNames = [...agentGroups.keys()];

    try {
      this.missionManager.initSquad(missionId, []);

      for (let i = 0; i < agentNames.length; i++) {
        const agent = agentNames[i];
        const tasks = agentGroups.get(agent)!;
        const goal = tasks.map(t => t.what).join(', ');

        /** P10: 为每个 squad 分配一个 checker（从其他 agent 中轮询选择） */
        const checkerIdx = (i + 1) % agentNames.length;
        const checkerAgent = agentNames[checkerIdx];

        this.missionManager.createSquad(missionId, {
          name: `${agent} 组`,
          goal,
          leader: agent,
          members: [{
            agent: checkerAgent,
            role: 'check',
            on: `验证 ${agent} 的产出质量`,
          }],
        });
      }

      logger.info({ missionId, squadCount: agentNames.length }, 'P7+P10: auto-generated squad with checkers');
    } catch (err) {
      logger.warn({ err, missionId }, 'P7: auto-generate squad failed (non-critical)');
    }
  }

  /**
   * 13.0 多智能体协作：任务完成/失败时同步更新 plan.json 中对应任务的状态。
   *
   * §12.6 审核集成 — agent 完成任务后，plan 中对应任务的状态应该自动更新。
   * 这样 Brain 和其他 agent 通过 plan tool 读取时能看到最新进度。
   *
   * @param taskId - agent task ID
   * @param status - 目标状态 ('done' | 'failed')
   * @param result - 任务结果文本（可选，成功时填输出摘要，失败时填错误信息）
   */
  private updatePlanTaskStatus(taskId: string, status: 'done' | 'failed', result?: string): void {
    if (!this.missionManager) return;
    try {
      const task = this.taskManager?.getTask(taskId);
      if (!task) return;

      /** 从 agent_task 的 input_payload 中提取 missionId 和 planTaskId */
      let inputPayload: Record<string, unknown> = {};
      try {
        const raw = (task as any).inputPayload ?? (task as any).input_payload;
        inputPayload = typeof raw === 'string'
          ? JSON.parse(raw)
          : raw ?? {};
      } catch { return; }

      const missionId = inputPayload.missionId as string | undefined;
      const planTaskId = inputPayload.planTaskId as string | undefined;
      if (!missionId || !planTaskId) return;

      /** 截断结果文本，避免 plan.json 膨胀 */
      const truncatedResult = result ? result.slice(0, 500) : undefined;

      this.missionManager.updatePlan(missionId, {
        task_id: planTaskId,
        status,
        result: truncatedResult,
      });

      logger.info({ missionId, planTaskId, status }, '13.0: plan task status synced on agent completion');
    } catch (err) {
      /** plan 更新失败不应影响主流程 — 非关键操作 */
      logger.warn({ err, taskId, status }, '13.0: plan task status sync failed (non-critical)');
    }
  }

  private handleChatRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): void {
    const primaryAgent = this.registry.requireRole('primary');
    const primaryName = primaryAgent.manifest.name;
    const primary = this.agentManager.getAgent(primaryName);
    if (!primary) {
      // R14-1：unavailable 失败源走 finalizeTask 统一入口
      this.sessionManager.fail(correlationId, { kind: 'unavailable' });
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

    // 13.0 多智能体协作：注入 mission context（让 agent 知道自己的 mission 目标 + squad 角色）
    if (decision.missionId) {
      const missionContext = this.buildMissionContextPrompt(
        decision.missionId,
        decision.planTaskId,
        decision.targetAgent,
      );
      if (missionContext) {
        systemPrompt += `\n\n${missionContext}`;
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
          // 13.0 多智能体协作：透传 missionId，让 Agent 知道自己属于哪个 mission
          ...(decision.missionId ? { missionId: decision.missionId } : {}),
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
        // 13.0：透传 missionId，让外部 agent 知道自己属于哪个 mission
        ...(decision.missionId ? { missionId: decision.missionId } : {}),
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
            this.delegationManager.fail(delegationId, resumable ? `[resumable] ${error}` : error);
            this.sessionManager.fail(correlationId, {
              kind: resumable ? 'cancelled' : 'failed',
              agentName: runtime.name,
              error: resumable ? `执行中断（可恢复）: ${error}` : error,
            });
            return;
          }
          case 'execution_cancelled': {
            this.streamingFlusher.remove(delegationId);
            this.delegationManager.fail(delegationId, 'Cancelled');
            this.sessionManager.fail(correlationId, { kind: 'cancelled', agentName: runtime.name });
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
        // R14-1：未产出输出 走 finalizeTask 统一入口
        this.sessionManager.fail(correlationId, { kind: 'failed', agentName: runtime.name, error: '未产出任何输出' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ correlationId, err }, 'Runtime execution error');
      this.streamingFlusher.remove(delegationId);
      this.delegationManager.fail(delegationId, message);
      // R14-1：Runtime exception 兜底走 finalizeTask 统一入口（含 no_response 通知）
      this.sessionManager.fail(correlationId, { kind: 'runtime_error', agentName: runtime.name, error: message });
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
          inputPayload: {
            ...sub.inputPayload,
            // 13.0：透传 missionId 到子任务
            ...(decision.missionId ? { missionId: decision.missionId } : {}),
          },
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
          // 13.0：透传 missionId 到工作区路由
          ...(decision.missionId ? { missionId: decision.missionId } : {}),
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
        this.updatePlanTaskStatus(taskId, 'failed', (err as Error).message);
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

    // ─── 13.0 §8.5: scope 预授权 ───
    // 任务派发时将 session 级的 PermissionGate scope 复制到 task 级的 active_scope。
    // 这样即使 Brain 纠偏还没来得及触发，第一轮工具执行也受 scope 约束。
    // 如果 inputPayload 中有 forbiddenTools（来自 Brain 路由或纠偏），直接设置。
    if (this.permissionCoordinator && this._stateCache) {
      const forbiddenTools = input.inputPayload.forbiddenTools as string[] | undefined;
      if (forbiddenTools && forbiddenTools.length > 0) {
        this.permissionCoordinator.setActiveScope(taskId, {
          blockTools: forbiddenTools,
        });
        logger.debug({ taskId, forbiddenTools }, 'task.dispatch: 预授权 scope (forbiddenTools)');
      }
    }

    // 13.0 多智能体协作：从 inputPayload 透传 missionId 和 planTaskId
    const missionId = input.inputPayload.missionId as string | undefined;
    const planTaskId = input.inputPayload.planTaskId as string | undefined;

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
          agentDialogCount: this.dialogueRouter?.getDialogueCountByCorrelation(correlationId),
        }),
        // 13.0 §12.6: 透传 mission 上下文（审核后 Brain 会自动 mark plan done）
        missionId: pending.missionId,
        planTaskId: pending.planTaskId,
        taskDescription: pending.taskDescription,
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
          // R14-4：auto-approve 走 recordReview 通用路径，不再有 recordAutoApprove 独立方法。
          // 区分依据：verdict='approve' + level='A' + reason 标注 'auto_approve'，
          // 真实 Brain 审核的 verdict='approve' 不会带 reason='auto_approve'。
          this.auditRecorder.recordReview({
            sessionId,
            level: 'A',
            draft,
            userMessage: pending.userMessage,
            toolCalls: calls,
            verdict: 'approve',
            finalResponse: draft,
            reason: !pending.intentAnchor ? 'auto_approve: no_intent_anchor' : 'auto_approve: level_A',
          });
          primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
          this.dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
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
        this.approveReviewDegraded(correlationId, draft, 'review_ipc_send_failed', pending.sessionId);
        return;
      }

      // 审核超时保护（防止 Brain LLM 挂死）
      setTimeout(() => {
        const stillPending = this.sessionManager.getPending(correlationId);
        if (!stillPending) return;
        logger.warn({ correlationId }, '对话审核超时，自动 approve');
        this.pendingReviewOrigins.delete(correlationId);
        this.approveReviewDegraded(correlationId, draft, 'review_timeout', pending.sessionId);
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
          safeSlice(pending.draftResponse ?? pending.userMessage, 200),
          review as unknown as Record<string, unknown>,
          pending.taskId,
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
      const { sessionId, response, reviewVerdict, reviewReason, originalDraft } = msg.payload as FinalResponsePayload;
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
      // 半收尾：保存对话轮次 + 删除 pending（不 resolve），留后续操作用 pending 数据
      const finalized = this.sessionManager.complete(correlationId, response, { skipResolve: true });
      if (!finalized || finalized === true) return;

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

      this.onConversationCompleted(sessionId, pending.userMessage, response, pending.toolCalls);

      getEventBus().emit('message.responded', {
        sessionId,
        taskId: pending.taskId ?? '',
        response,
        verdict: reviewVerdict,
        // 13.0 灵魂版：将 Brain 审核详情传递到前端（通过 WS bridge）
        reviewReason,
        originalDraft,
      });

      // 13.0 灵魂版：将 Brain 审核信息透传给 CompletionStrategy，
      // 最终由 EventBusStrategy emit 到 conversation.result，前端可消费
      finalized.resolve(response, {
        verdict: reviewVerdict,
        reason: reviewReason,
        originalDraft,
      });

      // 13.0 灵魂版 M5：review 完成后排空观察队列（5s 延迟清除，允许迟到 INTERVENE 仍能读取）
      if (pending.taskId) {
        this.observationRecorder.markDraining(sessionId, pending.taskId);
      }

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

    // 13.0 §12.6: Brain 审核完成后同步更新 plan.json 中对应任务的状态
    // approve → 任务完成（结果用 Brain 审核后的最终回复）
    // modify → 任务完成（结果用 Brain 修改后的回复）
    // reject → 任务失败（结果用 Brain 的拒绝原因）
    if (this.missionManager && entry) {
      try {
        const raw = (entry as any).inputPayload ?? (entry as any).input_payload;
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const missionId = payload?.missionId as string | undefined;
        const planTaskId = payload?.planTaskId as string | undefined;
        if (missionId && planTaskId) {
          const planStatus = review.verdict === 'reject' ? 'failed' as const : 'done' as const;
          const planResult = review.verdict === 'reject'
            ? `Brain 审核拒绝: ${review.reason ?? '未通过审核'}`
            : (response ?? '').slice(0, 500);
          this.missionManager.updatePlan(missionId, {
            task_id: planTaskId,
            status: planStatus,
            result: planResult,
          });
          logger.info({ missionId, planTaskId, verdict: review.verdict }, '13.0: plan task updated after Brain review');
        }
      } catch (err) {
        logger.warn({ err, correlationId }, '13.0: plan update after Brain review failed (non-critical)');
      }
    }

    // 半收尾：保存对话轮次 + 删除 pending（不 resolve），留后续操作用 pending 数据
    const finalized = this.sessionManager.complete(correlationId, response, { skipResolve: true });
    if (!finalized || finalized === true) return;

    this.onConversationCompleted(pending.sessionId, pending.userMessage, response, pending.toolCalls);
    // 所有后续操作完成后再 resolve
    finalized.resolve(response);
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
      missionId: pending.missionId,
      planTaskId: pending.planTaskId,
      taskDescription: pending.taskDescription,
      agentDialogCount: this.dialogueRouter?.getDialogueCountByCorrelation(correlationId),
    };

    reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
  }

  /**
   * 审核降级统一收尾。
   *
   * 当 reviewer 不可用 / IPC 发送失败 / 审核超时时，草稿回复仍有效（不是错误），
   * 直接 approve 落库。封装 emit no_response → delegationManager.complete → sessionManager.complete
   * 三步序列，消除 5 处手写重复。
   *
   * @param correlationId pending request 的 ID
   * @param draft 有效的草稿回复（直接 approve）
   * @param reason 降级原因（用于前端通知和日志）
   * @param sessionId 对话 sessionId
   */
  private approveReviewDegraded(
    correlationId: string,
    draft: string,
    reason: string,
    sessionId: string,
  ): void {
    const pending = this.sessionManager.getPending(correlationId);
    getEventBus().emit('conversation.no_response', {
      sessionId,
      reason,
      taskId: pending?.taskId,
      correlationId,
    });
    const entry = this.delegationManager.getByCorrelation(correlationId);
    if (entry) this.delegationManager.complete(entry.id, draft);
    this.sessionManager.complete(correlationId, draft);
  }

  private onSuperiorChainRejected(correlationId: string, reason: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    if (pending.taskId) this.streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId);
    this.pendingReviewOrigins.delete(correlationId);
    const entry = this.delegationManager.getByCorrelation(correlationId);
    if (entry) this.delegationManager.fail(entry.id, `Superior rejected: ${reason}`);
    this.sessionManager.fail(correlationId, { kind: 'failed', error: `上级审核退回: ${reason}` });
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
      this.approveReviewDegraded(fgEntry.correlationId, draftResponse, 'reviewer_unavailable', fgEntry.sessionId);
      return;
    }

    // 13.0 §12.6: 构造审核记录，包含 mission 上下文
    // 从 delegation entry 的 inputPayload 中提取 missionId 和 planTaskId
    let missionId: string | undefined;
    let planTaskId: string | undefined;
    let taskDescription: string | undefined;
    if (entry) {
      try {
        const raw = (entry as any).inputPayload ?? (entry as any).input_payload;
        const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
        missionId = payload?.missionId;
        planTaskId = payload?.planTaskId;
        taskDescription = payload?.message ?? payload?.userMessage;
      } catch { /* 非关键 */ }
    }

    // 使用 pending 中已记录的 toolCalls（如果有）
    const toolCalls = pending.toolCalls ?? [];

    const turn: TurnRecord = {
      sessionId: fgEntry.sessionId,
      userMessage: pending.userMessage,
      draftResponse,
      toolCalls,
      level: classifyLevel({
        sessionId: fgEntry.sessionId,
        userMessage: pending.userMessage,
        draftResponse,
        toolCalls,
        level: 'A',
        missionId,
        agentDialogCount: this.dialogueRouter?.getDialogueCountByCorrelation(fgEntry.correlationId),
      }),
      // 13.0 §12.6: 注入 mission 上下文，让 Brain 审核时知道"分配的任务是什么"
      missionId,
      planTaskId,
      taskDescription,
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
      this.approveReviewDegraded(fgEntry.correlationId, draftResponse, 'review_ipc_send_failed', fgEntry.sessionId);
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
      this.approveReviewDegraded(fgEntry.correlationId, draftResponse, 'review_timeout', fgEntry.sessionId);
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

      // 13.0 §3.2/§5.3.3: 将 agent 提问写入 Brain 观察队列（priority=0，critical，永不丢弃）
      // Brain 审核时需要知道 agent 主动问了用户什么，以判断：
      // 1. 提问是否合理（该问用户还是自己做决策？）
      // 2. 提问措辞是否安全（有没有泄露敏感信息？）
      // 3. 提问频率是否过高（§3.6 场景 H：意图模糊时应先问用户）
      if (payload.sessionId && this.observationRecorder) {
        this.observationRecorder.record({
          sessionId: payload.sessionId,
          taskId: payload.taskId ?? '',
          observationType: 'user_interaction',
          fromAgent: msg.from,
          content: JSON.stringify({
            direction: 'agent_ask',
            question,
            options: payload.options,
          }),
          priority: 0, // §5.3.3: user_interaction = priority 0（critical，永不丢弃）
        });
      }

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

  /**
   * 13.0 §5.3.14: 处理 Agent 的 task.reject — Agent 拒绝任务并建议其他 Agent。
   *
   * 回退策略：
   * 1. 检查 reRouteDepth（≤ 2 次重路由）
   * 2. 如果 suggestAgent 合理且有该 Agent → 重路由
   * 3. 如果超过 2 次或无合理建议 → 降级让用户决定
   *
   * @param agentName - 拒绝任务的 Agent 名
   * @param msg - task.reject IPC 消息
   */
  private handleTaskReject(agentName: string, msg: IpcMessage): void {
    const { taskId, reason, suggestAgent } = (msg.payload ?? {}) as {
      taskId: string;
      reason: string;
      suggestAgent?: string;
    };

    if (!taskId) {
      logger.warn({ agentName }, 'task.reject: 缺少 taskId，忽略');
      return;
    }

    // 释放 AgentRequestQueue 槽位
    if (this.agentRequestQueue) {
      this.agentRequestQueue.complete(agentName);
    }

    const entry = this.delegationManager.get(taskId);
    if (!entry) {
      logger.warn({ taskId, agentName }, 'task.reject: 任务不存在');
      return;
    }

    // ── 13.0 §8.7: 将 task.reject 写入 Brain 观察队列 ──
    // Brain 通过观察队列看到 agent 拒绝任务，可以审核拒绝理由和 suggestAgent 是否合理。
    // 如果 Brain 不认同 reject（比如觉得 agent 应该能做），可以发纠偏。
    // 如果 Brain 同意 reject → 接受，拒绝后由 Kernel 决定下一步（重路由或降级，见 §5.3.14）
    if (entry.sessionId && this.observationRecorder) {
      this.observationRecorder.record({
        sessionId: entry.sessionId,
        taskId,
        observationType: 'task_reject',
        fromAgent: agentName,
        content: JSON.stringify({ reason, suggestAgent }),
        priority: 0, // task.reject 是 critical 事件，永不丢弃
      });
    }

    // 检查 reRouteDepth
    const currentDepth = entry.reRouteDepth ?? 0;
    const MAX_RE_ROUTE_DEPTH = 2;

    logger.info({ taskId, agentName, reason: reason?.slice(0, 200), suggestAgent, reRouteDepth: currentDepth }, 'task.reject: Agent 拒绝任务');

    // 同步更新 plan task 状态为 failed
    this.updatePlanTaskStatus(taskId, 'failed', `Agent ${agentName} 拒绝: ${reason}`);

    if (currentDepth >= MAX_RE_ROUTE_DEPTH) {
      // 超过 2 次重路由 → 降级处理，通知用户
      logger.info({ taskId, reRouteDepth: currentDepth }, 'task.reject: 重路由次数耗尽，降级');

      this.delegationManager.fail(taskId, `任务被多个 Agent 拒绝。${agentName} 的理由: ${reason}`);

      const pending = this.sessionManager.getPending(entry.correlationId);
      if (pending) {
        // 让 Conversation 告诉用户情况
        this.sessionManager.complete(entry.correlationId,
          `抱歉，这个任务 ${agentName} 和之前的 Agent 都无法处理。\n理由: ${reason}\n请提供更多信息或尝试换个方式描述。`,
        );
      }
      return;
    }

    // 尝试重路由到 suggestAgent
    if (suggestAgent && suggestAgent !== agentName) {
      const newDepth = currentDepth + 1;
      // 标记当前任务失败
      this.delegationManager.fail(taskId, `Agent ${agentName} 拒绝，建议路由给 ${suggestAgent}。理由: ${reason}`);

      // 用新的 reRouteDepth 重新派发
      const pending = this.sessionManager.getPending(entry.correlationId);
      if (pending) {
        logger.info({ taskId, from: agentName, to: suggestAgent, newDepth }, 'task.reject: 重路由到建议 Agent');

        this.dispatchModuleTaskInternal({
          sessionId: entry.sessionId,
          taskType: 'chat',
          requester: agentName,
          inputPayload: {
            message: pending.userMessage ?? entry.userMessage,
            reRouteDepth: newDepth,
            _rejectReason: reason,
            _rejectedBy: agentName,
          },
          correlationId: entry.correlationId,
          foreground: true,
        }).catch(err => {
          logger.warn({ err, taskId }, 'task.reject: 重路由派发失败');
          this.sessionManager.fail(entry.correlationId, { kind: 'failed', agentName, error: `重路由失败: ${(err as Error).message}` });
        });
      }
    } else {
      // 无 suggestAgent → 降级为 chat
      this.delegationManager.fail(taskId, `Agent ${agentName} 拒绝任务且无建议: ${reason}`);
      const pending = this.sessionManager.getPending(entry.correlationId);
      if (pending) {
        this.sessionManager.complete(entry.correlationId,
          `Agent ${agentName} 表示无法处理这个任务。\n理由: ${reason}\n请尝试更具体地描述你的需求。`,
        );
      }
    }
  }

  private handleForegroundTaskResult(
    result: AgentTaskResultPayload,
    fgEntry: { correlationId: string; sessionId: string },
    agentName: string,
  ): void {
    // ─── 13.0 §4.4.1: 释放 AgentRequestQueue 槽位 ───
    // 任务完成后释放该 agent 的并发槽位，让队列中的下一个请求开始处理
    if (this.agentRequestQueue) {
      this.agentRequestQueue.complete(agentName);
    }

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

      // 13.0 多智能体协作：任务失败时同步更新 plan.json 中对应任务的状态
      this.updatePlanTaskStatus(result.taskId, 'failed', result.error);

      // R14-1：foreground 任务失败走 finalizeTask 统一入口
      this.sessionManager.fail(fgEntry.correlationId, { kind: 'failed', agentName, error: result.error });
      return;
    }

    // 13.0 多智能体协作：任务成功完成时同步更新 plan.json 中对应任务的状态
    const agentOutput = this.formatAgentResult(agentName, result.outputPayload ?? {});
    this.updatePlanTaskStatus(result.taskId, 'done', agentOutput);

    const draftResponse = agentOutput;
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

      // R14-1：task.timeout 走 finalizeTask 统一入口（含 no_response 通知）
      const entry = this.delegationManager.get(taskId);
      if (!entry) return;
      const pending = this.sessionManager.getPending(entry.correlationId);
      if (!pending) return;
      this.streamingFlusher.remove(taskId);
      this.sessionManager.fail(entry.correlationId, { kind: 'timeout', agentName: targetAgent, error: `任务执行超时（${targetAgent}）` });
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
      content: safeSlice(draft, 3000),
      checkpointType: 'final_response',
    }, driftCorrelationId);

    // 设置超时：2s 内未收到结果 → 降级 approve
    const timeoutId = setTimeout(() => {
      cleanup();
      logger.debug({ correlationId }, 'drift check timeout, auto-approve');
      primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
      this.dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
    }, 2000);

    const cleanup = () => {
      clearTimeout(timeoutId);
    };

    const handler = async (msg: IpcMessage) => {
      if (msg.correlationId !== driftCorrelationId) return;
      cleanup();

      const { signal } = msg.payload as { signal: import('../contracts/intent.js').DriftSignal };
      const evaluated = this.driftDetector?.evaluate(signal) ?? signal;

      // 记录漂移信号
      this.driftDetector?.recordSignal(evaluated, sessionId, correlationId);

      if (evaluated.suggestedAction === 'verify') {
        // 高偏离 → 先运行 VerifyGate 独立对抗性验证
        // VerifyGate 用 Brain 的 default tier 模型以对抗性视角快速判断回复是否有根本性错误
        // 如果 VerifyGate 确认失败（pass=false）→ 直接 reject，无需完整 review
        // 如果 VerifyGate 无法确认（pass=true）→ 走同步 Brain review 深度审核
        logger.info({ correlationId, score: evaluated.alignmentScore }, 'drift:high → verify gate + sync review');
        if (pending.intentAnchor) {
          try {
            const verdict = await this.verifyGate.verify(
              brainAgent.ipc as any,
              pending.intentAnchor,
              draft,
            );
            if (!verdict.pass) {
              // VerifyGate 确认回复有根本性错误 → 直接 reject（节省一次完整 review LLM 调用）
              logger.info({ correlationId, reason: verdict.reason?.slice(0, 200) }, 'verify:gate REJECT');
              primaryIpc.send('review.result', primaryName, {
                verdict: 'reject',
                reason: `独立验证未通过: ${verdict.reason ?? '回复与用户意图不匹配'}`,
              } as ReviewResult, correlationId);
              this.dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
              return;
            }
            // VerifyGate 通过但仍高漂移 → 走完整 Brain review
            logger.debug({ correlationId }, 'verify:gate pass, proceeding to full review');
          } catch (err) {
            // VerifyGate 异常 → 不阻断，继续走完整 review
            logger.warn({ err, correlationId }, 'verify:gate error, falling back to full review');
          }
        }
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
      this.dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
    };

    brainAgent.ipc.onMessage('drift.check.result', handler);
  }

  private formatAgentResult(agentName: string, outputPayload: Record<string, unknown>): string {
    if (typeof outputPayload.response === 'string') return outputPayload.response;
    if (typeof outputPayload.result === 'string') return outputPayload.result;
    // 防御性兜底：部分 agent（如 code_task）返回 summary 而非 response
    if (typeof outputPayload.summary === 'string') return outputPayload.summary;
    return `[${agentName}] 任务完成:\n${JSON.stringify(outputPayload, null, 2)}`;
  }
}
