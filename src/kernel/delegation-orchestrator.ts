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
import type { MemoryRuntime } from '../memory/runtime.js';
import { getDb } from '../memory/db.js';
import type { IPluginRuntimeV2 } from '../contracts/plugins-v2.js';
import type { WorkspaceRouter } from './workspace-router.js';
import type { RuntimeRegistry } from './runtime/runtime-registry.js';
import type { AgentRuntime, AgentEvent, ExecutionTask } from '../contracts/agent-runtime.js';
import type { RuntimeExecutor } from './runtime/runtime-executor.js';
import { DelegationManager } from './delegation-manager.js';
import { FallbackRouter } from './fallback-router.js';
import { CorrectionFlow } from './flows/correction-flow.js';
import { SuperiorReviewFlow } from './flows/superior-review-flow.js';
import {
  setupAuditHandler,
  setupMemoryHandlers,
  setupCapabilityHandler,
  setupModelOverrideHandler,
  setupTakeoverRouting,
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
import type { SocketProgressEvent, SocketTextDeltaEvent } from '../contracts/socket-protocol.js';
import type { RouteDecision, RouteResultPayload, RouteRequestPayload } from '../contracts/routing.js';
import type { PermissionJudgeResultPayload, AgentAskUserPayload, AgentUserReplyPayload } from '../contracts/routing.js';
import type { DraftResponsePayload, FinalResponsePayload } from '../contracts/messaging.js';
import type { ReviewResult, TurnRecord } from '../contracts/review.js';
import type { PermissionRequestPayload, PermissionValidatePayload, PermissionConsumePayload, PermissionAcquirePayload } from '../contracts/permissions.js';
import type { AgentTaskPayload, AgentTaskResultPayload, TaskAcknowledgePayload, TaskStartedPayload, TaskProgressPayload, TaskTelemetryPayload } from '../contracts/tasks.js';
import type { CorrectionConstraints } from '../contracts/delegation.js';
import type { DangerLevel } from '../utils/types.js';

const logger = getLogger('orchestrator');

const DISPATCH_RETRY_MS = 3000;
const JUDGE_TIMEOUT_MS = 30_000;
const JUDGE_MAX_PER_WINDOW = 5;
const JUDGE_WINDOW_MS = 10_000;

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

  // Permission judge state
  private pendingJudges = new Map<string, (result: PermissionJudgeResultPayload) => void>();
  private pendingJudgeInputs = new Map<string, { sessionId: string; toolName: string }>();
  private judgeTimestamps: number[] = [];

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

  private get proxyDeps(): ProxyHandlersDeps {
    return {
      auditRecorder: this.auditRecorder,
      sessionManager: this.sessionManager,
      capabilityService: this.capabilityService,
      takeoverController: this.takeoverController,
      memoryRuntime: this.memoryRuntime,
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
    this.setupPermissionJudgeHandler(reviewer.ipc);
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
    this.setupPermissionHandlers(primary.ipc, primaryName, true);
    setupAuditHandler(primary.ipc, primaryName, this.proxyDeps);
    setupMemoryHandlers(primary.ipc, primaryName, this.proxyDeps);
    setupCapabilityHandler(primary.ipc, primaryName, this.proxyDeps);
    setupModelOverrideHandler(primary.ipc, primaryName, this.proxyDeps);
    this.setupTaskHandlers(primary.ipc, primaryName);
    setupTakeoverRouting(primary.ipc, primaryName, this.proxyDeps);
    setupTakeoverRouting(reviewer.ipc, reviewerName, this.proxyDeps);
  }

  setupDaemonEvents(): void {
    this.setupDaemonTaskResultHandlers();
  }

  setupModuleAgent(agentName: string): void {
    const agent = this.agentManager.getAgent(agentName);
    if (!agent) return;
    if (this.setupAgentIpcs.has(agent.ipc)) return;
    this.setupAgentIpcs.add(agent.ipc);

    this.setupTaskResultHandlers(agent.ipc, agentName);
    this.setupPermissionHandlers(agent.ipc, agentName, false);
    setupAuditHandler(agent.ipc, agentName, this.proxyDeps);
    setupTakeoverRouting(agent.ipc, agentName, this.proxyDeps);
  }

  // ═══ PUBLIC API ═══════════════════════════════════

  sendRouteRequest(payload: RouteRequestPayload, correlationId: string): void {
    withTrace('router.sendRouteRequest', () => {
      const orchestratorAgent = this.registry.requireRole('orchestrator');
      const orchestratorName = orchestratorAgent.manifest.name;
      const brain = this.agentManager.getAgent(orchestratorName);
      if (!brain) {
        logger.error('Brain agent not available for routing');
        this.handleRouteFallback(correlationId);
        return;
      }
      brain.ipc.send('route.request', orchestratorName, payload, correlationId);
    });
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
    return withTrace('router.requestPermissionJudge', () => this.requestJudgeInternal(input));
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
      const partialResponse = pending.draftResponse ?? primary.finalResponse;
      this.sessionManager.deletePending(primary.correlationId);
      pending.resolve(partialResponse ?? '[已停止]');
    }

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
        this.brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, decision as any);
        getEventBus().emit('message.routed', {
          sessionId: pending.sessionId,
          taskId: pending.taskId ?? correlationId,
          targetAgent: decision.targetAgent,
          intent: decision.intent,
        });
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

  private handleChatRoute(decision: RouteDecision, correlationId: string, pending: PendingRequest): void {
    const primaryAgent = this.registry.requireRole('primary');
    const primaryName = primaryAgent.manifest.name;
    const primary = this.agentManager.getAgent(primaryName);
    if (!primary) {
      pending.resolve('[系统错误] 对话智能体不可用');
      this.sessionManager.deletePending(correlationId);
      return;
    }

    this.pendingReviewOrigins.set(correlationId, 'conversation');
    this.reportProgress(pending, 'thinking', '正在思考...');

    const systemPrompt = this.sessionManager.buildPrompt(pending.sessionId);
    const memoryContext = this.sessionManager.buildMemoryContext(pending.sessionId, pending.userMessage);

    primary.ipc.send('user.message', primaryName, {
      sessionId: pending.sessionId,
      message: pending.userMessage,
      taskId: pending.taskId,
      systemPrompt,
      memoryContext,
      instruction: decision.instruction,
      intent: decision.intent,
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
      const { taskId } = await this.dispatchModuleTaskInternal({
        sessionId: pending.sessionId,
        taskType,
        requester: 'brain-route',
        inputPayload: {
          message: pending.userMessage,
          instruction: decision.instruction,
          contextHints: decision.contextHints,
        },
        foreground: true,
        correlationId,
      });
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
            if (pending.streaming && pending.socket && !pending.socket.destroyed) {
              const socketEvent: SocketTextDeltaEvent = { type: 'text_delta', text, taskId: delegationId };
              pending.socket.write(JSON.stringify(socketEvent) + '\n');
            }
            break;
          }
          case 'execution_completed': {
            const finalText = textAccumulator || (event.data.content as string) || '';
            pending.draftResponse = finalText;
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
            if (resumable) {
              logger.info({ correlationId, error }, 'Execution failed but resumable');
              this.delegationManager.fail(delegationId, `[resumable] ${error}`);
              this.sessionManager.deletePending(correlationId);
              pending.resolve(`[${runtime.name}] 执行中断（可恢复）: ${error}`);
            } else {
              this.delegationManager.fail(delegationId, error);
              this.sessionManager.deletePending(correlationId);
              pending.resolve(`[${runtime.name}] 执行失败: ${error}`);
            }
            return;
          }
          case 'execution_cancelled': {
            this.delegationManager.fail(delegationId, 'Cancelled');
            this.sessionManager.deletePending(correlationId);
            pending.resolve(`[${runtime.name}] 执行已取消`);
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
        this.delegationManager.fail(delegationId, 'No output produced');
        this.sessionManager.deletePending(correlationId);
        pending.resolve(`[${runtime.name}] 未产出任何输出`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ correlationId, err }, 'Runtime execution error');
      this.delegationManager.fail(delegationId, message);
      this.sessionManager.deletePending(correlationId);
      pending.resolve(`[${runtime.name}] 执行异常: ${message}`);
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
      const { sessionId, draft, toolCalls } = msg.payload as DraftResponsePayload;
      const correlationId = msg.correlationId!;
      const pending = this.sessionManager.getPending(correlationId);
      if (!pending) return;

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
      pending.toolCalls = calls;

      const entry = this.delegationManager.getByCorrelation(correlationId);
      const wsId = entry?.workspaceId;
      if (this.superiorReviewFlow?.interceptForSuperiorReview(correlationId, entry?.targetAgent ?? '', wsId, turn, entry?.id)) {
        this.pendingReviewOrigins.set(correlationId, 'superior_chain');
        this.reportProgress(pending, 'reviewing', '正在上级审核...');
        return;
      }

      this.pendingReviewOrigins.set(correlationId, 'conversation');
      this.reportProgress(pending, 'reviewing', '正在审核...');

      reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
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
          review as any,
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
      const pending = this.sessionManager.getPending(correlationId);
      if (!pending) return;

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

      this.sessionManager.saveConversationTurn(sessionId, pending.userMessage, response);
      this.sessionManager.queueEvolution(sessionId, pending.userMessage, response);
      this.sessionManager.queueCapabilityEvolution(sessionId, pending.userMessage, response);

      getEventBus().emit('message.responded', {
        sessionId,
        taskId: pending.taskId ?? '',
        response,
        verdict: reviewVerdict,
      });

      pending.resolve(response);
    });
  }

  private handleTaskReviewResult(review: ReviewResult, correlationId: string): void {
    const pending = this.sessionManager.getPending(correlationId);
    if (!pending) return;

    const response = review.verdict === 'modify' && review.finalResponse
      ? review.finalResponse
      : pending.draftResponse ?? '';

    const entry = this.delegationManager.getByCorrelation(correlationId);
    if (entry) {
      this.delegationManager.complete(entry.id, response);
    }

    this.sessionManager.deletePending(correlationId);
    this.sessionManager.saveConversationTurn(pending.sessionId, pending.userMessage, response);
    this.sessionManager.queueEvolution(pending.sessionId, pending.userMessage, response);
    this.sessionManager.queueCapabilityEvolution(pending.sessionId, pending.userMessage, response);
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

    this.pendingReviewOrigins.delete(correlationId);
    const entry = this.delegationManager.getByCorrelation(correlationId);
    if (entry) {
      this.delegationManager.fail(entry.id, `Superior rejected: ${reason}`);
    }

    this.sessionManager.deletePending(correlationId);
    pending.resolve(`[上级审核退回] ${reason}`);
  }

  private sendTaskResultForReview(fgEntry: { correlationId: string; sessionId: string }, pending: PendingRequest, draftResponse: string): void {
    const entry = this.delegationManager.getByCorrelation(fgEntry.correlationId);
    if (entry) {
      this.delegationManager.submitForReview(entry.id, { delegationId: entry.id, response: draftResponse });
    }

    const reviewerAgent = this.registry.requireRole('reviewer');
    const reviewerName = reviewerAgent.manifest.name;
    const reviewer = this.agentManager.getAgent(reviewerName);

    if (!reviewer) {
      if (entry) this.delegationManager.complete(entry.id, draftResponse);
      this.sessionManager.deletePending(fgEntry.correlationId);
      pending.resolve(draftResponse);
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
    this.reportProgress(pending, 'reviewing', '正在审核任务结果...');

    reviewer.ipc.send('review.request', reviewerName, { turn }, fgEntry.correlationId);
  }

  // ═══ PERMISSIONS ══════════════════════════════════

  private setupPermissionJudgeHandler(reviewerIpc: AgentIpc): void {
    reviewerIpc.onMessage('permission.judge.result', (msg: IpcMessage) => {
      const result = msg.payload as PermissionJudgeResultPayload;
      const correlationId = msg.correlationId!;

      // Record permission decision
      const judgeInput = this.pendingJudgeInputs?.get(correlationId);
      if (judgeInput) {
        this.brainDecisionRecorder?.recordPermissionDecision(
          judgeInput.sessionId,
          judgeInput.toolName,
          result as any,
        );
        this.pendingJudgeInputs?.delete(correlationId);
      }

      const pending = this.pendingJudges.get(correlationId);
      if (pending) {
        pending(result);
        this.pendingJudges.delete(correlationId);
      }
    });
  }

  private isJudgeRateLimited(): boolean {
    const now = Date.now();
    this.judgeTimestamps = this.judgeTimestamps.filter(t => now - t < JUDGE_WINDOW_MS);
    return this.judgeTimestamps.length >= JUDGE_MAX_PER_WINDOW;
  }

  private requestJudgeInternal(input: {
    sessionId: string;
    agentName: string;
    toolName: string;
    toolInput: string;
    dangerLevel: DangerLevel;
    taskContext?: string;
  }): Promise<PermissionJudgeResultPayload> {
    if (this.isJudgeRateLimited()) {
      return Promise.resolve({ allowed: false, reason: '权限判断请求过于频繁，已限流' });
    }
    this.judgeTimestamps.push(Date.now());

    return new Promise((resolve) => {
      const correlationId = genId('pjudge');
      const timeout = setTimeout(() => {
        this.pendingJudges.delete(correlationId);
        this.pendingJudgeInputs.delete(correlationId);
        resolve({ allowed: false, reason: '权限判断超时' });
      }, JUDGE_TIMEOUT_MS);

      this.pendingJudges.set(correlationId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.pendingJudgeInputs.set(correlationId, { sessionId: input.sessionId, toolName: input.toolName });

      const orchestratorAgent = this.registry.requireRole('orchestrator');
      const brain = this.agentManager.getAgent(orchestratorAgent.manifest.name);
      if (!brain) {
        clearTimeout(timeout);
        this.pendingJudges.delete(correlationId);
        resolve({ allowed: false, reason: 'Brain 不可用' });
        return;
      }

      brain.ipc.send('permission.judge', orchestratorAgent.manifest.name, {
        sessionId: input.sessionId,
        agentName: input.agentName,
        toolName: input.toolName,
        toolInput: input.toolInput,
        dangerLevel: input.dangerLevel,
        taskContext: input.taskContext,
      }, correlationId);
    });
  }

  private setupPermissionHandlers(agentIpc: AgentIpc, agentName: string, isPrimary: boolean): void {
    agentIpc.onMessage('permission.request', (msg: IpcMessage) => {
      const { toolName, toolInput, dangerLevel, taskId } = msg.payload as PermissionRequestPayload;
      const replyId = msg.id;

      let sessionId: string;
      if (isPrimary) {
        const pendingReq = (taskId ? this.sessionManager.findPendingByTaskId(taskId) : undefined)
          ?? this.sessionManager.findAnyPendingWithTaskId();
        sessionId = pendingReq?.sessionId ?? 'unknown';

        const result = this.permissionCoordinator.checkAndIssue({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
          taskId,
          correlationId: msg.correlationId ?? replyId,
        });
        agentIpc.send('permission.result', agentName, result, replyId);
      } else {
        sessionId = taskId ?? agentName;
        const result = this.permissionCoordinator.checkAndIssueSimple({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
        });
        agentIpc.send('permission.result', agentName, result, replyId);
      }
    });

    agentIpc.onMessage('permission.validate', (msg: IpcMessage) => {
      const { tokenId, sessionId, toolName, toolInput } = msg.payload as PermissionValidatePayload;
      const result = this.permissionCoordinator.validate({ tokenId, sessionId, agentName, toolName, toolInput });
      agentIpc.send('permission.result', agentName, result, msg.id);
    });

    agentIpc.onMessage('permission.consume', (msg: IpcMessage) => {
      const { tokenId } = msg.payload as PermissionConsumePayload;
      const result = this.permissionCoordinator.consume(tokenId);
      agentIpc.send('permission.result', agentName, result, msg.id);
    });

    agentIpc.onMessage('permission.acquire', async (msg: IpcMessage) => {
      const { toolName, toolInput, dangerLevel, taskId } = msg.payload as PermissionAcquirePayload;
      const replyId = msg.id;

      let sessionId: string;
      if (isPrimary) {
        const pendingReq = (taskId ? this.sessionManager.findPendingByTaskId(taskId) : undefined)
          ?? this.sessionManager.findAnyPendingWithTaskId();
        sessionId = pendingReq?.sessionId ?? 'unknown';

        const result = this.permissionCoordinator.acquire({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
          taskId,
          correlationId: msg.correlationId ?? replyId,
        });

        if (result.requiresReview) {
          const judgment = await this.requestJudgeInternal({
            sessionId,
            agentName,
            toolName,
            toolInput,
            dangerLevel: dangerLevel as DangerLevel,
            taskContext: taskId,
          });

          if (judgment.correction && taskId) {
            const entry = this.delegationManager.get(taskId);
            if (entry) {
              const constraints: CorrectionConstraints = {};
              if (judgment.correction.forbidTools?.length) {
                constraints.forbiddenTools = judgment.correction.forbidTools;
              }
              if (Object.keys(constraints).length > 0) {
                this.delegationManager.applyConstraints(taskId, constraints);
              }
            }
          }

          agentIpc.send('permission.result', agentName, {
            allowed: judgment.allowed,
            reason: judgment.reason,
            correction: judgment.correction,
          }, replyId);
        } else {
          agentIpc.send('permission.result', agentName, result, replyId);
        }
      } else {
        sessionId = taskId ?? agentName;
        const result = this.permissionCoordinator.checkAndIssueSimple({
          agentName,
          sessionId,
          toolName,
          toolInput,
          dangerLevel: dangerLevel as DangerLevel,
        });
        agentIpc.send('permission.result', agentName, result, replyId);
      }
    });
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
        const pending = this.sessionManager.getPending(entry.correlationId);
        if (pending) {
          this.reportProgress(pending, 'asking', question);
        }
      }
    });
  }

  // ═══ TASK HANDLERS ════════════════════════════════

  private setupTaskHandlers(agentIpc: AgentIpc, agentName: string): void {
    this.setupCommonTaskHandlers(agentIpc, agentName);

    agentIpc.onMessage('task.progress', (msg: IpcMessage) => {
      const { taskId, summary } = msg.payload as TaskProgressPayload;
      const task = taskId ? this.taskManager.getTask(taskId) : undefined;
      if (task && this.agentProgress) {
        this.agentProgress.report({
          taskId,
          sessionId: task.session_id,
          source: msg.from,
          message: summary,
          payload: { from: msg.from },
        });
      }
    });
  }

  private setupTaskResultHandlers(agentIpc: AgentIpc, agentName: string): void {
    this.setupCommonTaskHandlers(agentIpc, agentName);

    agentIpc.onMessage('agent.task.result', (msg: IpcMessage) => {
      const result = msg.payload as AgentTaskResultPayload;

      if (result.ok) {
        this.taskManager.complete(result.taskId, result.outputPayload ?? {});
      } else {
        this.taskManager.fail(result.taskId, result.error ?? '任务失败');
      }

      const entry = this.delegationManager.get(result.taskId);
      if (entry) {
        this.handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, agentName);
      }
    });

    agentIpc.onMessage('agent.ask_user', (msg: IpcMessage) => {
      const payload = msg.payload as AgentAskUserPayload;
      const orchestratorAgent = this.registry.requireRole('orchestrator');
      const brain = this.agentManager.getAgent(orchestratorAgent.manifest.name);
      if (brain) {
        brain.ipc.send('agent.ask_user', orchestratorAgent.manifest.name, payload, msg.correlationId ?? msg.id);
      }
    });
  }

  private setupCommonTaskHandlers(agentIpc: AgentIpc, _agentName: string): void {
    agentIpc.onMessage('task.acknowledge', (msg: IpcMessage) => {
      const { taskId } = msg.payload as TaskAcknowledgePayload;
      if (taskId) {
        this.delegationManager.acknowledge(taskId);
      }
    });

    agentIpc.onMessage('task.started', (msg: IpcMessage) => {
      const { taskId } = msg.payload as TaskStartedPayload;
      if (taskId) {
        this.delegationManager.acknowledge(taskId);
      }
    });

    agentIpc.onMessage('task.telemetry', (msg: IpcMessage) => {
      const payload = msg.payload as TaskTelemetryPayload;
      switch (payload.kind) {
        case 'text_delta': {
          if (!payload.taskId) return;
          const entry = this.delegationManager.get(payload.taskId);
          if (!entry) return;
          this.delegationManager.recordOutput(payload.taskId, { delegationId: payload.taskId, kind: 'text_delta', data: { text: payload.text } });
          const pending = this.sessionManager.getPending(entry.correlationId);
          if (pending?.streaming && pending.socket && !pending.socket.destroyed) {
            const evt: SocketTextDeltaEvent = { type: 'text_delta', text: payload.text, taskId: payload.taskId };
            pending.socket.write(JSON.stringify(evt) + '\n');
          }
          break;
        }
        case 'llm_completed': {
          if (payload.taskId) {
            const entry = this.delegationManager.get(payload.taskId);
            if (entry) {
              this.delegationManager.recordOutput(payload.taskId, {
                delegationId: payload.taskId,
                kind: 'usage',
                data: { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens },
              });
            }
          }
          getEventBus().emit('llm.request.completed', {
            taskId: payload.taskId,
            agentName: payload.agentName,
            inputTokens: payload.inputTokens,
            outputTokens: payload.outputTokens,
            cacheRead: payload.cacheRead,
            cacheCreation: payload.cacheCreation,
            durationMs: payload.durationMs,
          });
          break;
        }
        case 'tool_result': {
          if (!payload.taskId) return;
          const entry = this.delegationManager.get(payload.taskId);
          if (!entry) return;
          this.delegationManager.recordOutput(payload.taskId, {
            delegationId: payload.taskId,
            kind: payload.isError ? 'tool_error' : 'tool_result',
            data: { toolName: payload.toolName },
          });
          break;
        }
        case 'uncertainty': {
          if (!payload.taskId) return;
          const entry = this.delegationManager.get(payload.taskId);
          if (!entry) return;
          this.delegationManager.reportUncertainty(payload.taskId, payload.reason);
          break;
        }
      }
    });
  }

  private handleForegroundTaskResult(
    result: AgentTaskResultPayload,
    fgEntry: { correlationId: string; sessionId: string },
    agentName: string,
  ): void {
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
      this.delegationManager.fail(result.taskId, result.error ?? '任务失败');
      const errorResponse = `[${agentName}] 任务失败: ${result.error ?? '未知错误'}`;
      this.sessionManager.deletePending(fgEntry.correlationId);
      pending.resolve(errorResponse);
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
      if (!pending?.streaming || !pending.socket || pending.socket.destroyed) return;

      if (event.kind === 'text' && event.data.kind === 'text') {
        const evt: SocketTextDeltaEvent = { type: 'text_delta', text: event.data.text, taskId };
        pending.socket.write(JSON.stringify(evt) + '\n');
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
      if (targetAgent !== '__daemon__') return;
      const entry = this.delegationManager.get(taskId);
      if (!entry) return;

      const result: AgentTaskResultPayload = { taskId, ok: false, error: '外部智能体执行超时' };
      this.handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__');
    });
  }

  // ═══ UTILITY ══════════════════════════════════════

  private reportProgress(pending: PendingRequest, status: SocketProgressEvent['status'], summary: string): void {
    if (pending.streaming && pending.socket && !pending.socket.destroyed) {
      const event: SocketProgressEvent = { type: 'progress', status, summary, taskId: pending.taskId };
      pending.socket.write(JSON.stringify(event) + '\n');
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

  private formatAgentResult(agentName: string, outputPayload: Record<string, unknown>): string {
    if (typeof outputPayload.response === 'string') return outputPayload.response;
    if (typeof outputPayload.result === 'string') return outputPayload.result;
    return `[${agentName}] 任务完成:\n${JSON.stringify(outputPayload, null, 2)}`;
  }
}
