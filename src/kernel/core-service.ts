import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentManager } from './agent-manager.js';
import { AgentRegistry } from './agent-registry.js';
import { EventBus, initEventBus, getEventBus } from './event-bus.js';
import type { AppConfig } from '../config/schema.js';
import type { LlmConfig } from '../llm/types.js';
import { initInfrastructure, initServices } from './bootstrap.js';
import type { TaskManager } from './task-manager.js';
import type { TaskNotifier } from './task-notification.js';
import type { AgentProgress } from './agent-progress.js';
import type { RouteRequestPayload } from '../contracts/routing.js';
import { TaskRouter } from './task-router.js';
import { createCoreModuleRegistry, type ModuleRegistry } from './module-system.js';
import { AgentLifecycle } from './agent-lifecycle.js';
import { AgentWatcher } from './agent-watcher.js';
import { ConfigService } from '../config/index.js';
import { DelegationOrchestrator } from './delegation-orchestrator.js';
import { WorkspaceRouter } from './workspace-router.js';
import { SocketServer } from './socket-server.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { PermissionEngine } from '../safety/permissions.js';
import { AuditRecorder } from './audit-recorder.js';
import { SessionManager } from './session-manager.js';
import { DriftMetricsService } from './drift-metrics.js';
import { initDb, closeDb, getDb } from '../memory/index.js';
import { MemoryRuntime } from '../memory/index.js';
import { SkillService, SkillWatcher } from '../skills/index.js';
import { PluginRuntime, PluginRuntimeV2 } from '../plugins/index.js';
import { TakeoverController } from '../testing/model-takeover.js';
import { ensureDirs, getSocketPath, getPidPath, getUserAgentsDir, getSkillsDir } from '../utils/paths.js';
import { getLogger } from '../utils/logger.js';
/** 13.0 §13.5: 用户会话排队（并发消息串行化） */
import { getUserSessionQueue } from './user-session-queue.js';

import type { LogLevel } from '../observability/types.js';
import { CronScheduler } from '../cron/index.js';
import { createLlmClient } from '../llm/index.js';
import { createProviderRegistry, type ProviderRegistry } from '../providers/registry.js';
import { McpManager } from '../mcp/index.js';
import { ToolRegistry, registerTool, getToolRegistry, createDelegationTools, createTeamTools } from '../tools/index.js';
import { OrgTreeManager, AgentHierarchy, TrustManager } from '../workspaces/index.js';
import { SuperiorReviewFlow } from './flows/superior-review-flow.js';
import { RuntimeRegistry } from './runtime/runtime-registry.js';
import { RuntimeExecutor } from './runtime/runtime-executor.js';
import { ExternalRuntimeDriver } from './runtime/drivers/external-driver.js';
import { BuiltinDriver } from './runtime/drivers/builtin-driver.js';
import { CheckpointService } from './checkpoint-service.js';
import { ErrorClassifier } from './error-classifier.js';
import { TaskCheckpointManager } from './task-checkpoint.js';
import { ChannelManager, TelegramChannel } from '../channels/index.js';
import { WorkspaceManager } from '../workspaces/index.js';
// R15: WebServer / intelligence 模块改为动态 import（initWebServer 内），消除 kernel→web 编译期依赖
import type { HumanDelegationManager } from './human-delegation.js';
import {
  handleMessage,
  handleChannelMessage,
} from './handlers/index.js';
import { registerAllHandlers } from './handlers/unified-handlers.js';
import { initMessageBus, type MessageBus } from './message-bus.js';
import { createMetricsMiddleware } from './middleware.js';
import { SchemaRegistry, createValidationMiddleware } from './validation-middleware.js';
import { createAuthMiddleware } from './auth-middleware.js';
import {
  SocketMessageRequestSchema,
  DaemonRegisterSchema,
  DaemonHeartbeatSchema,
  DaemonTaskResultSchema,
  EvolutionDispatchSchema,
  HandshakeRequestSchema,
} from '../contracts/message-schemas.js';
import type { ServiceContainer } from './service-container.js';
import { DaemonBridge } from './daemon-bridge.js';
import { TerminalRenderer } from '../observability/terminal-renderer.js';

const logger = getLogger('core-service');

function getBundledAgentsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), '..', 'agents', 'bundled');
}

export class CoreService {
  private config: AppConfig;
  private registry: AgentRegistry;
  private agentManager: AgentManager;
  private eventBus: EventBus;
  private moduleRegistry: ModuleRegistry;
  private taskManager: TaskManager | null = null;
  private taskNotifier: TaskNotifier | null = null;
  private agentProgress: AgentProgress | null = null;
  private taskRouter: TaskRouter;
  private memoryRuntime: MemoryRuntime;
  private skillService: SkillService | null = null;
  private pluginRuntime: PluginRuntime | null = null;
  private pluginRuntimeV2: PluginRuntimeV2 | null = null;
  private takeoverController: TakeoverController | null = null;
  private agentLifecycle: AgentLifecycle | null = null;
  private agentWatcher: AgentWatcher | null = null;
  private skillWatcher: SkillWatcher | null = null;
  private configService: ConfigService | null = null;
  private messageRouter: DelegationOrchestrator | null = null;
  private socketServer: SocketServer | null = null;
  private cronScheduler: CronScheduler | null = null;
  private mcpManager: McpManager | null = null;
  private channelManager: ChannelManager | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private orgTreeManager: OrgTreeManager | null = null;
  private trustManager: TrustManager | null = null;
  private runtimeRegistry: RuntimeRegistry | null = null;
  private checkpointService: CheckpointService | null = null;
  private humanDelegationManager: HumanDelegationManager | null = null;
  private webServer: { start(): Promise<void>; stop(): Promise<void> } | null = null;
  private notificationHooksCleanup: (() => void) | null = null;
  private permissionCoordinator: PermissionCoordinator | null = null;
  private sessionManager: SessionManager | null = null;
  private daemonChild: ChildProcess | null = null;
  private auditRecorder: AuditRecorder | null = null;
  private currentLogLevel: LogLevel;
  private logLevelResetTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalRenderer: TerminalRenderer | null = null;
  private messageBus: MessageBus;
  private capabilityBus: import('../bus/capability-bus.js').CapabilityBus | null = null;
  private willLoop: import('./will-loop.js').WillLoop | null = null;
  /**
   * 16.0 P3-A2 任务板纠偏观察器（advisory only）。
   * 定时轻扫所有 in_progress 的板，嗅到 drift/stuck/spawn_explosion 风险时 emit
   * 'delegation.checkpoint_needed' 让 brain 介入（设计文档/23 §4.2 + §10.1）。
   * lifecycle：startInternal 创建并 .start()，stop() 时 .stop()。详见 board-observer.ts。
   */
  private boardObserver: import('./board-observer.js').BoardObserver | null = null;
  private insightsTimer: ReturnType<typeof setInterval> | null = null;
  private suggestionCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 15.0 机制 C：周期审计定时器（定时跑 Auditor 扫描，高危报告推 Brain） */
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private providerRegistryHolder: { current: ProviderRegistry } | null = null;
  /** 主进程 LLM 客户端 holder（支持配置热重载时替换） */
  private builtinLlmHolder: { current: import('../llm/index.js').LlmClient } | null = null;

  constructor() {
    this.configService = new ConfigService();
    this.config = this.configService.get();
    this.eventBus = initEventBus();
    this.messageBus = initMessageBus();
    this.messageBus.use(createMetricsMiddleware());

    const schemaRegistry = new SchemaRegistry();
    schemaRegistry.register('socket:message', SocketMessageRequestSchema);
    schemaRegistry.register('socket:daemon.register', DaemonRegisterSchema);
    schemaRegistry.register('socket:daemon.heartbeat', DaemonHeartbeatSchema);
    schemaRegistry.register('socket:daemon.task.result', DaemonTaskResultSchema);
    schemaRegistry.register('socket:evolution.dispatch', EvolutionDispatchSchema);
    schemaRegistry.register('socket:handshake', HandshakeRequestSchema);
    this.messageBus.use(createValidationMiddleware(schemaRegistry));
    this.eventBus.setMessageBus(this.messageBus);
    this.moduleRegistry = createCoreModuleRegistry();
    this.registry = new AgentRegistry();
    this.taskRouter = new TaskRouter(this.registry);
    this.agentManager = new AgentManager(this.config, this.registry, this.eventBus);
    this.memoryRuntime = new MemoryRuntime(this.config.memory);
    this.currentLogLevel = this.config.observability.level as LogLevel;
  }

  async start(): Promise<void> {
    ensureDirs();
    initDb();

    // 初始化 IPC journal（可靠投递 + 崩溃重放）
    const { IpcJournal } = await import('./ipc-journal.js');
    const ipcJournal = new IpcJournal(getDb());
    this.agentManager.setJournal(ipcJournal);
    // 定时清理已投递的 journal 记录（1 小时保留）
    const journalCleanupTimer = setInterval(() => ipcJournal.cleanup(), 60 * 60 * 1000);
    journalCleanupTimer.unref();

    try {
      await this.startInternal();
    } catch (err) {
      await this.cleanup();
      throw err;
    }
  }

  private async startInternal(): Promise<void> {
    await this.registry.discover({
      bundled: getBundledAgentsDir(),
      user: getUserAgentsDir(),
    });

    // Phase 1: Infrastructure
    const { agentLifecycle } = initInfrastructure(
      this.config, this.registry, this.agentManager, this.eventBus, this.moduleRegistry,
    );
    this.agentLifecycle = agentLifecycle;

    // Phase 2: Services
    const svc = await initServices(
      this.config,
      this.eventBus,
      this.memoryRuntime,
      (plugin) => {
        this.messageRouter?.dispatchModuleTask({
          sessionId: 'plugin_review',
          taskType: 'plugin_review',
          requester: 'plugin_runtime',
          inputPayload: { taskType: 'plugin_review', pluginId: plugin.id, pluginName: plugin.name, manifest: plugin },
        }).catch((e) => { logger.debug({ err: e, plugin: plugin.name }, 'Plugin review dispatch failed'); });
      },
    );
    this.taskManager = svc.taskManager;
    this.taskNotifier = svc.taskNotifier;
    this.agentProgress = svc.agentProgress;
    const evolutionEngine = svc.evolutionEngine;
    const capabilityService = svc.capabilityService;
    this.skillService = svc.skillService;
    this.pluginRuntime = svc.pluginRuntime;
    this.pluginRuntimeV2 = svc.pluginRuntimeV2;
    this.permissionCoordinator = svc.permissionCoordinator;
    this.sessionManager = svc.sessionManager;
    this.auditRecorder = svc.auditRecorder;
    this.takeoverController = svc.takeoverController;
    const auditRecorder = svc.auditRecorder;

    logger.info('正在启动 Berry 服务...');

    if (process.env.APP_TERMINAL_MODE === 'human') {
      this.terminalRenderer = new TerminalRenderer();
      this.terminalRenderer.start(this.eventBus);
      this.terminalRenderer.info('服务启动中...');
    }

    await this.agentManager.startAll();
    this.moduleRegistry.markStatus(getDb(), 'agent-manager', 'running');

    for (const agent of this.registry.listResident()) {
      this.moduleRegistry.markStatus(getDb(), `${agent.manifest.name}-agent`, 'running');
    }

    this.messageRouter = new DelegationOrchestrator({
      agentManager: this.agentManager,
      registry: this.registry,
      taskManager: this.taskManager,
      taskRouter: this.taskRouter,
      permissionCoordinator: this.permissionCoordinator,
      auditRecorder,
      sessionManager: this.sessionManager,
      agentProgress: this.agentProgress,
      capabilityService,
      takeoverController: this.takeoverController,
      memoryRuntime: this.memoryRuntime,
    });
    this.messageRouter.setup();
    this.messageRouter.init({ pluginRuntimeV2: this.pluginRuntimeV2 });

    // 13.0 §13.8: Brain 崩溃重启后需重新挂载跨进程事件中继（cron.review/signal_intervention/checker.dispatch）。
    // 注入回调：agent-manager 检测到 brain 注册 → 调 orchestrator.onBrainRegistered() 刷新 relay。
    this.agentManager.onAgentRegistered = (name: string) => {
      if (name === 'brain') {
        this.messageRouter?.onBrainRegistered();
      }
    };

    // 13.0 多智能体协作：初始化 Mission 系统（共享 MissionManager 实例 + plan/squad 工具）
    const { MissionManager } = await import('./mission-manager.js');
    const missionManager = new MissionManager(getEventBus());
    this.messageRouter.initMissionSystem(missionManager);
    // 注入同一个 MissionManager 到 plan/squad 工具（让 agent 的 useTool('plan'/'squad') 可用）
    const { initMissionTools } = await import('../tools/plan-tools.js');
    initMissionTools(missionManager);

    // 13.0 §5.3.7 + §13.20: 启动 Brain 审核反馈 → 用户偏好进化监听
    // brain.feedback 事件 → PatternMatcher → user_preferences 表
    const { startBrainFeedbackEvolutionListener } = await import('./brain-feedback-evolution.js');
    startBrainFeedbackEvolutionListener();

    // 13.0 §13.5: 对话完成后自动 dequeue 排队的 user session
    // conversation.result 触发后检查 UserSessionQueue，如有排队项则取出并重新派发给 channel
    getEventBus().on('conversation.result', (payload) => {
      try {
        const { sessionId } = payload;
        if (!sessionId) return;
        // 从 sessionId 反推 userId（channel 路径格式: channel-{type}-{userId}）
        const channelMatch = sessionId.match(/^channel-(\w+)-(.+)$/);
        if (!channelMatch) return;
        const userId = channelMatch[2];
        const queued = getUserSessionQueue().dequeue(userId);
        if (queued) {
          logger.info({ userId, correlationId: queued.correlationId }, '13.0 UserSessionQueue: auto-dequeue after conversation.result');
        }
      } catch { /* dequeue 失败不阻塞 */ }
    });

    // 13.0 P5: 订阅 self-evolution 信号 — who:"skills" 的 task 完成后触发技能创建
    getEventBus().on('capability.evolution.request', (payload) => {
      try {
        const { missionId, taskId, skillDescription } = payload;
        if (!skillDescription) return;
        // 委派给 evolution agent 执行技能创建（通过 orchestrator dispatch）
        this.messageRouter?.dispatchModuleTask({
          sessionId: `mission-${missionId}`,
          taskType: 'evolution',
          requester: 'mission-system',
          inputPayload: {
            taskType: 'create_skill',
            userMessage: skillDescription,
            source: `mission:${missionId}:task:${taskId}`,
          },
          foreground: false,
        }).catch((err: any) => {
          const logger = getLogger('core-service');
          logger.warn({ err, missionId, taskId }, '13.0 evolution dispatch failed');
        });
      } catch { /* evolution 失败不阻塞 */ }
    });

    // 13.0 §5.3.5: 订阅 user.ask_response — HTTP API 路径（POST /conversation/ask-user-response）发出的回复事件
    // HTTP 路径通过 EventBus 投递，此处桥接到 sendUserReply() → IPC 到 agent
    // （WS 路径由 unified-handlers.ts 直接调用 sendUserReply，不走此桥）
    getEventBus().on('user.ask_response', (payload) => {
      try {
        const { sessionId, correlationId, response } = payload;
        const taskId = payload.taskId ?? '';
        if (!sessionId || !correlationId || !response) return;
        this.messageRouter?.sendUserReply(
          { sessionId, taskId, reply: response },
          correlationId,
        );
        logger.debug({ sessionId, correlationId }, '13.0 user.ask_response → sendUserReply bridge');
      } catch (err) {
        logger.warn({ err }, '13.0 user.ask_response bridge failed');
      }
    });

    // 启动 session 垃圾回收（5 分钟间隔，30 分钟无活动清理缓存与 pendingAsks）
    this.sessionManager.startGc();

    // 12.0: 初始化漂移检测器
    if (this.config.drift?.enabled !== false) {
      const { DriftDetector } = await import('./drift-detector.js');
      this.messageRouter.init({ driftDetector: new DriftDetector(getDb(), this.config.drift?.thresholds) });
    }
    this.registerSkillChangedHandler();
    this.registerPluginTools();

    if (this.config.daemon.enabled) {
      const daemonBridge = new DaemonBridge(this.eventBus, this.taskManager, {
        heartbeatTimeoutMs: this.config.daemon.heartbeatTimeoutMs,
        taskTimeoutMs: this.config.daemon.taskTimeoutMs,
      });
      this.messageRouter.init({ daemonBridge });
      this.messageRouter.setupDaemonEvents();
    }

    // Runtime Registry: unified execution interface
    const runtimeRegistry = new RuntimeRegistry();
    const providerRegistry = createProviderRegistry(
      this.config.llm,
      this.config.llm.channelsConfig,
      // onMutate: persist channel/tier changes to config.yaml
      (channels, tiers) => {
        this.configService?.updateSection({
          llm: { channelsConfig: { channels: channels as any, tiers } },
        } as any);
      },
    );
    // Mutable holder — allows hot-rebuild when config.yaml changes
    this.providerRegistryHolder = { current: providerRegistry };
    const builtinLlm = createLlmClient(this.config.llm, {
      db: getDb(),
      eventBus: this.eventBus,
      providerRegistry,
      budgetConfig: this.config.budget,
    });
    this.builtinLlmHolder = { current: builtinLlm };
    runtimeRegistry.register('builtin', new BuiltinDriver(this.builtinLlmHolder));

    // Wire LLM-driven evolution extractor
    if (this.config.memory.evolutionEnabled) {
      const { UnifiedEvolutionExtractor } = await import('../evolution/unified-extractor.js');
      const extractor = new UnifiedEvolutionExtractor(builtinLlm, getDb());
      evolutionEngine.setExtractor(extractor);
    }

    if (this.messageRouter.daemonBridge) {
      runtimeRegistry.register('claude_code', new ExternalRuntimeDriver(
        this.messageRouter.daemonBridge, this.eventBus, this.taskManager, 'claude_code',
      ));
      runtimeRegistry.register('opencode', new ExternalRuntimeDriver(
        this.messageRouter.daemonBridge, this.eventBus, this.taskManager, 'opencode',
      ));
    }

    this.runtimeRegistry = runtimeRegistry;
    this.messageRouter.init({ runtimeRegistry });

    // Capability Bus: unified capability invocation
    const { CapabilityBus, PermissionGate, BusAuditLogger, registerToolsAsBusCapabilities, registerPermissionCapabilities } = await import('../bus/index.js');
    const capabilityBus = new CapabilityBus();
    const permissionGate = new PermissionGate();
    permissionGate.setBrainJudge({
      requestJudge: async (input) => {
        const result = await this.messageRouter!.requestPermissionJudge({
          sessionId: input.sessionId,
          agentName: input.agentName,
          toolName: input.capabilityName,
          toolInput: typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
          dangerLevel: input.dangerLevel,
        });
        return { allowed: result.allowed, reason: result.reason };
      },
    });
    // 15.0 机制 A §2.5：让 capability 权限路径与 IPC 路径一致尊重当前权限模式
    permissionGate.setMode((sessionId) => this.messageRouter?.permissionCoordinator?.getMode(sessionId) ?? 'ask');
    capabilityBus.setPermissionGate(permissionGate);
    capabilityBus.setAuditLogger(new BusAuditLogger(getDb()));

    // Register existing tools on Bus
    const allTools = getToolRegistry();
    registerToolsAsBusCapabilities(capabilityBus, allTools);

    // Register permission system as Bus capability (orchestrator slimming)
    registerPermissionCapabilities(capabilityBus, {
      permissionCoordinator: this.permissionCoordinator!,
      requestBrainJudge: async (input) => {
        const result = await this.messageRouter!.requestPermissionJudge(input);
        return { allowed: result.allowed, reason: result.reason };
      },
    });

    this.capabilityBus = capabilityBus;
    this.messageRouter.init({ capabilityBus });
    capabilityBus.startIdleDetection();
    // Transaction Manager: atomic multi-step operations with revert (§2.1)
    const { TransactionManager } = await import('../bus/transaction.js');
    const transactionManager = new TransactionManager(capabilityBus);
    capabilityBus.register(
      { name: 'revert_last_transaction', description: 'Revert the most recent committed transaction (undo file changes)', dangerLevel: 'moderate', provider: { type: 'builtin', name: 'transaction' } },
      async () => transactionManager.revertLastCommitted({ sessionId: 'user-undo' }),
    );

    // World Model: continuous global state for Brain decisions
    const { WorldModelRuntime } = await import('./world-model.js');
    const worldModel = new WorldModelRuntime(getDb());
    this.messageRouter.init({ worldModel });

    // Feed external events into World Model for contextual awareness
    this.eventBus.on('daemon.task.failed', ({ taskId, runtime, error }) => {
      worldModel.updateFromEvent({ type: 'task_failure', source: runtime, summary: `Task ${taskId} failed: ${error}`, severity: 'warning' });
    });
    this.eventBus.on('agent.crashed', ({ name, error }) => {
      worldModel.updateFromEvent({ type: 'agent_crash', source: name, summary: error ?? `Agent ${name} crashed`, severity: 'critical' });
    });
    this.eventBus.on('mcp.failed', ({ serverName, error }) => {
      worldModel.updateFromEvent({ type: 'mcp_failure', source: serverName, summary: error, severity: 'warning' });
    });

    // Will Loop: Brain autonomous action cycle (Phase D)
    const { WillLoop } = await import('./will-loop.js');
    const willLoop = new WillLoop(builtinLlm, worldModel, capabilityBus, getDb(), {
      enabled: this.config.autonomy.willLoopEnabled,
      intervalMs: this.config.autonomy.willLoopIntervalMs,
      maxAutoDangerLevel: this.config.autonomy.maxAutoDangerLevel,
      maxActionsPerHour: this.config.autonomy.maxActionsPerHour,
    });
    willLoop.start();
    this.willLoop = willLoop;

    // Imagination Engine + Self-Modification Capability (Phase D.4-D.5)
    const { ImaginationEngine } = await import('./imagination-engine.js');
    const { SelfModificationAudit } = await import('./self-modification-audit.js');
    const { registerSelfModificationCapabilities } = await import('./self-mod-capability.js');
    const imagination = new ImaginationEngine(builtinLlm, getDb());
    const selfModAudit = new SelfModificationAudit(getDb());
    registerSelfModificationCapabilities(capabilityBus, {
      audit: selfModAudit,
      imagination,
      requireSimulation: true,
      minSimulationScore: 0.6,
    });

    // Time Intelligence (Phase D.5)
    const { TimeIntelligence } = await import('./time-intelligence.js');
    const timeIntelligence = new TimeIntelligence(getDb());

    // Wire Phase D modules into Will Loop
    willLoop.setImaginationEngine(imagination);
    willLoop.setTimeIntelligence(timeIntelligence);

    // Suggestion Queue: Will Loop stores suggestions, Brain delivers on next interaction
    const { SuggestionQueue } = await import('./suggestion-queue.js');
    const suggestionQueue = new SuggestionQueue(getDb());
    willLoop.setSuggestionQueue(suggestionQueue);
    this.messageRouter.init({ suggestionQueue });

    // 16.0 P3-A2：BoardObserver 装配（advisory only 看板纠偏定时器）。
    // 每 30s 扫所有 in_progress 的板，嗅到 drift/stuck/spawn_explosion 风险时
    // emit 'delegation.checkpoint_needed' 让 brain 经 checkpoint 路径介入（§4.2 + §10.1）。
    // deps.agentManager 传入便于未来按成员活跃度过滤扫描目标；brainIpc 留 undefined——
    // observer 走 EventBus emit checkpoint，不直投 brain（避免新造触发路径，§「架构优雅定律」）。
    // 纯 advisory：所有扫描异常仅 warn，绝不影响主路径（详见 board-observer.ts 的硬约束）。
    const { BoardObserver } = await import('./board-observer.js');
    const boardObserver = new BoardObserver({ agentManager: this.agentManager ?? undefined });
    boardObserver.start();
    this.boardObserver = boardObserver;

    // Schedule daily cleanup of old suggestions
    this.suggestionCleanupTimer = setInterval(() => {
      try {
        const cleaned = suggestionQueue.cleanup();
        if (cleaned > 0) logger.info({ cleaned }, 'Suggestion queue cleanup completed');
      } catch (err) {
        logger.error({ err }, 'Suggestion queue cleanup failed');
      }
    }, 86_400_000);

    // Register Time Intelligence as Bus capabilities
    const { registerTimeIntelligenceCapabilities } = await import('../bus/time-capability.js');
    registerTimeIntelligenceCapabilities(capabilityBus, timeIntelligence);

    // Schedule automatic insights lifecycle (validate/expire stale insights hourly)
    const { runInsightsLifecycle } = await import('./insights-lifecycle.js');
    runInsightsLifecycle(getDb());
    this.insightsTimer = setInterval(() => {
      runInsightsLifecycle(getDb());
      import('../evolution/stats-job.js').then(m => m.runStatsJob(getDb())).catch((e) => { logger.warn({ err: e }, 'Stats job failed'); });
    }, 3600_000);

    // 15.0 机制 C：周期审计 — 定时跑 Auditor 5 维扫描，高危报告经现有 brain.observe 通道推 Brain
    // （observationType='agent_event' 复用观察通道，priority=0 永不裁剪；低危仅记 debug 日志）。
    // 用动态 import 匹配 insightsTimer 风格；runAudit 是纯确定性 SQL，进程内执行无需派发子进程。
    const AUDIT_INTERVAL_MS = 3600_000; // 1 小时
    const AUDIT_ESCALATE_THRESHOLD = 0.3;
    this.auditTimer = setInterval(() => {
      import('../agents/bundled/auditor/scan.js')
        .then(({ runAudit }) => {
          try {
            const report = runAudit(getDb());
            if (report.riskScore < AUDIT_ESCALATE_THRESHOLD) {
              logger.debug({ riskScore: report.riskScore, taskCount: report.taskCount }, '周期审计通过');
              return;
            }
            const brainName = this.registry.requireRole('orchestrator').manifest.name;
            const brain = this.agentManager.getAgent(brainName);
            if (brain?.ipc) {
              brain.ipc.send('brain.observe', brainName, {
                sessionId: 'system-audit',
                taskId: 'audit-periodic',
                observationType: 'agent_event',
                fromAgent: 'auditor',
                toAgent: 'brain',
                // 15.0 mechC C-5：发 condensed 摘要（riskScore + recommendations + 各维度计数），
                // 避免完整 findings 经 observationRecorder 的 safeSlice(content,2000) 截断丢数据。
                // Brain 拿到可行动的 riskScore + 建议即可；完整报告留在 AuditReport 返回值。
                content: JSON.stringify({
                  kind: 'audit_report',
                  riskScore: report.riskScore,
                  taskCount: report.taskCount,
                  counts: {
                    patterns: report.findings.patterns.length,
                    risks: report.findings.risks.length,
                    inconsistencies: report.findings.inconsistencies.length,
                    coverageGaps: report.findings.coverageGaps.length,
                    driftRecap: report.findings.driftRecap.length,
                  },
                  // recommendations 限长防 safeSlice(2000) 截断成残缺 JSON（forbiddenTools/evolutionTriggers 上限）
                  recommendations: {
                    escalationToUser: report.recommendations.escalationToUser,
                    forbiddenTools: report.recommendations.forbiddenTools?.slice(0, 20),
                    evolutionTriggers: report.recommendations.evolutionTriggers?.slice(0, 5),
                  },
                  topRisks: report.findings.risks.slice(0, 3).map(r => `${r.severity}:${r.description.slice(0, 80)}`),
                }),
                priority: report.riskScore >= 0.6 ? 0 : 1, // 高危 critical 永不裁剪
              });
            }
            logger.warn({ riskScore: report.riskScore, taskCount: report.taskCount }, '周期审计发现风险，已推 Brain');
          } catch (err) {
            logger.warn({ err }, '周期审计执行失败（best-effort）');
          }
        })
        .catch((err) => logger.warn({ err }, '周期审计模块加载失败'));
    }, AUDIT_INTERVAL_MS);

    // §3.1/§3.2 Lifecycle subscriptions: wire system events to agent tasks
    const { LifecycleEventManager } = await import('../bus/lifecycle.js');
    const lifecycleManager = new LifecycleEventManager();
    lifecycleManager.on('permission.denied', (data) => {
      this.messageRouter?.dispatchModuleTask({
        sessionId: 'lifecycle', taskType: 'detect_gap', requester: 'lifecycle',
        inputPayload: { taskType: 'detect_gap', recentPermissionDenials: [JSON.stringify(data)] },
      }).catch((e) => { logger.debug({ err: e }, 'Gap detection dispatch failed'); });
    });
    capabilityBus.on('permission.denied', (data) => {
      lifecycleManager.emit('permission.denied', data);
    });
    capabilityBus.on('agent.idle', (data) => {
      lifecycleManager.emit('agent.idle', data);
    });
    this.eventBus.on('agent.crashed', () => {
      lifecycleManager.emit('agent.task_completed', { status: 'crashed' });
    });

    // Checkpoint + Resume: error classifier, checkpoint service, runtime executor
    const errorClassifier = new ErrorClassifier();
    const checkpointMgr = new TaskCheckpointManager(getDb());
    const checkpointService = new CheckpointService(
      checkpointMgr, this.taskManager, errorClassifier, this.eventBus,
    );
    this.checkpointService = checkpointService;

    const runtimeExecutor = new RuntimeExecutor(checkpointService, errorClassifier);
    this.messageRouter.init({ runtimeExecutor });

    // Recover resumable tasks from previous run
    checkpointService.recoverOnStartup();

    // §9.0 M8: Start task sweep for stale dispatched/running tasks
    // P2-9: 启动时立即清理残留任务（重启后 AbortController/timeout 丢失）
    this.taskManager!.recoverOnStartup();
    this.taskManager!.startSweep();
    // W8 修复：恢复 waiting_approval 状态的残留任务（taskManager 不处理此状态）
    this.sessionManager!.recoverSessions(getDb());
    // 恢复崩溃前未完成的 ask_user 状态（进程崩溃后内存 Map 丢失，从 SQLite 恢复）
    this.sessionManager!.recoverPendingAsks(getDb());

    // P2-13 + R15: agent.crashed 期间的消息缓冲队列
    // crash handler 执行期间新消息可能被路由到正在重启的 agent，导致消息丢失。
    // R15 提取为独立 CrashBufferManager，消除内联并发控制和重复 drain 逻辑。
    const { CrashBufferManager } = await import('./crash-buffer-manager.js');
    const crashBuffer = new CrashBufferManager();

    this.eventBus.on('agent.crashed', ({ name }) => {
      // 标记 agent 正在崩溃处理中，缓冲后续消息
      crashBuffer.markCrashed(name);
      crashBuffer.setSafetyTimer(name, this.messageRouter!);

      this.taskManager!.failByAgent(name, `智能体 ${name} 崩溃`);
      this.messageRouter?.failDelegationsByAgent(name, `智能体 ${name} 崩溃`);

      // ─── 13.0 §4.4.1: 清理 AgentRequestQueue 中该 agent 的所有排队请求 ───
      // Agent 崩溃后，排队等待该 agent 的请求全部拒绝（发送 agent_unavailable 错误）
      const queue = this.messageRouter?.requestQueue;
      if (queue) {
        queue.clearForAgent(name, `智能体 ${name} 崩溃`);
        logger.info({ agent: name }, 'agent.crashed: 已清理请求队列');
      }

      // VF-3: 立即拒绝所有等待该 Agent 回复的 pending dialogue（不等 60s 超时）
      // 发起方的 LLM 收到 AgentCrashError 后能做出合理决策（不重试，换路径）
      if (this.messageRouter?.dialogueRouter) {
        const rejected = this.messageRouter.dialogueRouter.rejectAllForAgent(name);
        if (rejected > 0) {
          logger.info({ agent: name, rejectedDialogues: rejected }, 'agent.crashed: rejected pending dialogues');
        }
      }
      // R14-1：5 兜底合一。agent.crashed 失败源统一调 sessionManager.fail，
      // 不再自己拼 partialContent + contentOverride + complete。
      // taskManager.failByAgent 已 emit 'task.failed'，但本路径还需要清理
      // pending state（in-memory 仍持有），所以显式调 fail。
      for (const [msgId, pending] of this.sessionManager!.entries()) {
        if (!pending.taskId) continue;
        const task = this.taskManager!.getTask(pending.taskId);
        if (task?.target_agent === name && task.status === 'failed') {
          // 13.0 §13.21: agent 崩溃的 plan task 标记 failed，触发级联 + mission 收敛
          if (pending.missionId && pending.planTaskId) {
            try {
              missionManager.updatePlan(pending.missionId, {
                task_id: pending.planTaskId,
                status: 'failed',
                result: `Agent ${name} 崩溃`,
              });
            } catch (planErr) {
              logger.debug({ err: planErr, missionId: pending.missionId }, 'agent.crashed: plan task 标记失败（非致命）');
            }
          }
          this.sessionManager!.fail(msgId, { kind: 'crash', agentName: name });
        }
      }
      // crash handler 完成，释放缓冲
      crashBuffer.release(name, this.messageRouter!);
    });

    this.eventBus.on('budget.alert', ({ scope, scopeId, tier, usedPercent, message }) => {
      if (tier === 'critical' || tier === 'exceeded') {
        logger.warn({ scope, scopeId, tier, usedPercent: Math.round(usedPercent * 100) }, message);
      } else {
        logger.info({ scope, scopeId, tier, usedPercent: Math.round(usedPercent * 100) }, message);
      }
    });

    this.socketServer = new SocketServer(getSocketPath());
    this.messageBus.use(createAuthMiddleware(
      (connId) => this.socketServer!.getConnectionAuthState(connId),
      this.socketServer.getAuthConfig(),
    ));
    this.registerSocketHandlers();
    await this.socketServer.start();

    if (this.config.daemon.enabled && this.config.daemon.autoStart) {
      this.spawnDaemonProcess();
    }

    // R15: WebServer 初始化提取为独立方法（+ 动态 import 消除 kernel→web 编译期依赖）
    await this.initWebServer();

    this.agentWatcher = new AgentWatcher(this.agentLifecycle!, this.registry);
    this.agentWatcher.watch(getUserAgentsDir());

    this.skillWatcher = new SkillWatcher(this.skillService!, {
      onRefresh: () => this.sessionManager?.clearPromptCache(),
    });
    this.skillWatcher.watch(getSkillsDir());

    if (this.config.cron.enabled) {
      const cronLlm = createLlmClient(this.config.llm, { db: getDb(), eventBus: this.eventBus, providerRegistry: this.providerRegistryHolder!.current, budgetConfig: this.config.budget });
      this.cronScheduler = new CronScheduler(getDb(), cronLlm, this.skillService!, this.eventBus, this.config.cron);
      this.cronScheduler.start();
      await this.cronScheduler.catchUp();
      logger.info('定时任务调度器已启动');
    }

    if (this.config.mcp.servers.length > 0) {
      const mcpLlm = createLlmClient(this.config.llm, { db: getDb(), eventBus: this.eventBus, providerRegistry: this.providerRegistryHolder!.current, budgetConfig: this.config.budget });
      const mcpToolRegistry = new ToolRegistry();
      this.mcpManager = new McpManager(this.eventBus, mcpToolRegistry, mcpLlm);
      await this.mcpManager.start(this.config.mcp.servers);
      logger.info({ serverCount: this.config.mcp.servers.length }, 'MCP 客户端已启动');

      // §8.10: Register MCP tools on Bus for capability discovery
      const { registerMcpToolsOnBus } = await import('../bus/mcp-adapter.js');
      const mcpTools = mcpToolRegistry.getAll().map(t => ({
        serverName: 'mcp', toolName: t.name, description: t.description,
      }));
      registerMcpToolsOnBus(capabilityBus, mcpTools, {
        execute: async (_server, toolName, input) => {
          const tool = mcpToolRegistry.get(toolName);
          if (!tool) throw new Error(`MCP tool ${toolName} not found`);
          return tool.execute(input);
        },
      });
    }

    this.workspaceManager = new WorkspaceManager(getDb(), this.eventBus);

    if (this.messageRouter && this.workspaceManager) {
      const wsRouter = new WorkspaceRouter(getDb(), this.workspaceManager, this.messageRouter.fallback);
      this.messageRouter.init({ workspaceRouter: wsRouter });

      const delegationTools = createDelegationTools({
        db: getDb(),
        workspaceRouter: wsRouter,
        workspaceManager: this.workspaceManager,
        orchestrator: this.messageRouter,
      });
      for (const tool of delegationTools) {
        registerTool(tool);
      }

      this.orgTreeManager = new OrgTreeManager(getDb());
      const agentHierarchy = new AgentHierarchy(getDb());
      wsRouter.setOrgTree(this.orgTreeManager, agentHierarchy);

      const trustManager = new TrustManager(getDb());
      this.trustManager = trustManager;
      const superiorReviewFlow = new SuperiorReviewFlow({
        db: getDb(),
        agentManager: this.agentManager,
        registry: this.registry,
        delegationManager: this.messageRouter.delegation,
        agentHierarchy,
        trustManager,
      });
      this.messageRouter.init({ superiorReviewFlow });

      const teamTools = createTeamTools({
        db: getDb(),
        orgTreeManager: this.orgTreeManager,
        agentHierarchy,
        workspaceRouter: wsRouter,
        workspaceManager: this.workspaceManager,
      });
      for (const tool of teamTools) {
        registerTool(tool);
      }
    }

    // Re-sync Bus with any tools registered after initial Bus setup (delegation/team tools)
    const lateTools = getToolRegistry().filter(t => !capabilityBus.has(t.name));
    if (lateTools.length > 0) {
      registerToolsAsBusCapabilities(capabilityBus, lateTools);
    }

    // §8.17: Register session_search as Bus capability
    const { registerSessionSearchCapability } = await import('../memory/session-search.js');
    registerSessionSearchCapability(capabilityBus, getDb());

    // 15.0 FTS5: 注册 dialogue_search 能力（检索 Agent 间对话/审计历史）
    const { registerDialogueSearchCapability } = await import('../memory/dialogue-search.js');
    registerDialogueSearchCapability(capabilityBus, getDb());

    // P2-12: 始终创建 ChannelManager，Telegram/CLI 等非 WS channel 统一管理
    // WS 的 inbound 走 ws-handler.ts，outbound 走 WsEventBridge，不经过 ChannelManager
    this.channelManager = new ChannelManager();
    this.channelManager.onMessage((msg) => {
      handleChannelMessage(msg.userId, msg.text, msg.channelType, this.buildServiceContainer());
    });
    await this.channelManager.startAll();
    // 订阅 EventBus conversation.result 事件，将结果分发到对应 channel。
    // WS 由 WsEventBridge 独立处理，此处仅覆盖 channel-cli-* / channel-telegram-* 等
    this.channelManager.initEventBridge(this.eventBus);

    const telegramConfig = this.config.channels.telegram;
    if (telegramConfig.enabled && telegramConfig.token) {
      const tgChannel = new TelegramChannel({
        token: telegramConfig.token,
        pollingInterval: telegramConfig.pollingInterval,
        allowedUserIds: telegramConfig.allowedUserIds.length > 0 ? telegramConfig.allowedUserIds : undefined,
      });
      this.channelManager.register(tgChannel);
      await tgChannel.start();
      logger.info('Telegram channel 已启动');
    }

    this.configService!.startWatcher();
    this.configService!.onChange(({ changedKeys: fields, config }) => {
      this.config = config;
      this.currentLogLevel = this.config.observability.level as LogLevel;
      this.sessionManager?.clearPromptCache();

      if (fields.includes('mcp')) {
        this.mcpManager?.handleConfigReload(this.config.mcp.servers);
      }
      if (fields.includes('skills') && this.skillService) {
        this.skillService.refresh();
        logger.info('Skills reloaded after config change');
      }
      if (fields.includes('llm')) {
        this.propagateLlmConfig(config.llm);
      }
      // 15.0 D4：全局默认权限模式热重载——与 mcp/skills/llm 同走 config reload。
      // 仅影响无显式 per-session mode 的会话（它们回退 default）；per-session mode 不受影响。
      // 之前 config.permissionMode 改动不生效（updateEngine 零调用），靠重启才能切换默认模式。
      if (fields.includes('permissionMode')) {
        this.permissionCoordinator?.updateEngine(new PermissionEngine(config.permissionMode));
        logger.info({ mode: config.permissionMode }, 'PermissionCoordinator 默认引擎已热重载');
      }

      logger.info({ fields }, 'Config reloaded');
    });

    const pidPath = getPidPath();
    if (existsSync(pidPath)) {
      try {
        const existingPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(existingPid, 0);
        throw new Error(`Berry 服务已在运行 (PID: ${existingPid})，请先停止后再启动`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        unlinkSync(pidPath);
      }
    }
    writeFileSync(pidPath, String(process.pid));
    logger.info({ pid: process.pid }, 'Berry 服务已启动');

    if (this.terminalRenderer) {
      this.terminalRenderer.info(`服务就绪 (pid:${process.pid})`);
      if (this.config.web.enabled) {
        this.terminalRenderer.info(`Web Dashboard http://${this.config.web.host}:${this.config.web.port}`);
      }
    }
  }

  private registerSocketHandlers(): void {
    const ss = this.socketServer!;
    const services = this.buildServiceContainer();
    const hasDaemon = !!this.messageRouter!.daemonBridge;

    registerAllHandlers(this.messageBus, services, hasDaemon);
    ss.setMessageBus(this.messageBus);
  }

  private buildServiceContainer(): ServiceContainer {
    return {
      agentManager: this.agentManager,
      registry: this.registry,
      agentLifecycle: this.agentLifecycle!,
      taskManager: this.taskManager!,
      taskRouter: this.taskRouter,
      sessionManager: this.sessionManager!,
      messageRouter: this.messageRouter!,
      permissionCoordinator: this.permissionCoordinator!,
      auditRecorder: this.auditRecorder!,
      agentProgress: this.agentProgress,
      daemonBridge: this.messageRouter!.daemonBridge,
      delegationManager: this.messageRouter!.delegation,
      fallbackRouter: this.messageRouter!.fallback,
      takeoverController: this.takeoverController,
      memoryRuntime: this.memoryRuntime,
      capabilityService: null,
      pluginRuntimeV2: this.pluginRuntimeV2,
      workspaceRouter: this.messageRouter!.workspaceRouter,
      orgTreeManager: this.orgTreeManager,
      trustManager: this.trustManager,
      runtimeRegistry: this.runtimeRegistry,
      checkpointService: this.checkpointService,
      driftDetector: this.messageRouter!.driftDetector,
      schedulerService: null,
      notificationService: null,
      memoryLayerService: null,
      workspaceContextService: null,
      pluginScopeService: null,
      templateService: null,
      asyncDelegationService: null,
      teamBuilderService: null,
      channelManager: this.channelManager,
      config: this.config,
      configService: this.configService!,
      getLogLevel: () => this.currentLogLevel,
      setLogLevel: (level) => { this.currentLogLevel = level; },
      setLogLevelResetTimer: (timer) => { this.logLevelResetTimer = timer; },
      getLogLevelResetTimer: () => this.logLevelResetTimer,
      getDaemonStatus: () => {
        const bridge = this.messageRouter?.daemonBridge;
        if (!bridge) return null;
        return {
          connected: bridge.isAvailable,
          runtimes: bridge.runtimes.map(r => r.name),
          availableSlots: bridge.availableSlots,
        };
      },
    };
  }

  private registerSkillChangedHandler(): void {
    const primaryAgent = this.registry.requireRole('primary');
    const primaryName = primaryAgent.manifest.name;
    const primary = this.agentManager.getAgent(primaryName);
    if (!primary) return;

    primary.ipc.onMessage('skill.changed', () => {
      this.skillService?.refresh();
      this.sessionManager!.clearPromptCache();
      logger.info('技能变更，已刷新 prompt cache');
    });
  }

  private registerPluginTools(): void {
    // 13.0 §13.18: v2 插件工具统一注册到全局 ToolRegistry
    // v2 unified mode 管理插件通过自己的 facet 系统，工具定义注册到 ToolRegistry
    // 后 LLM 和 AgentPort.useTool() 都能透明发现和调用插件工具
    if (this.pluginRuntimeV2) {
      const v2Tools = this.pluginRuntimeV2.getToolDefinitions();
      if (v2Tools.length > 0) {
        for (const tool of v2Tools) {
          registerTool(tool);
        }
        logger.info({ count: v2Tools.length }, 'v2 plugin tools registered to global ToolRegistry');

        // 通过 EventBus 广播工具变更，让已启动的 agent 感知新工具
        // agent 端收到后重新获取 tool list（LLM 下次 turn 可用新工具）
        const eventBus = getEventBus();
        eventBus.emit('tools.updated', { added: v2Tools.map(t => t.name) });
      }
      return;
    }

    // v1 路径：通过 plugin-host agent 代理执行
    if (!this.pluginRuntime) return;
    const pluginTools = this.pluginRuntime.getPluginTools();
    if (pluginTools.length === 0) return;

    const hostAgent = this.registry.getByRole('plugin-host');
    if (!hostAgent) return;
    const hostName = hostAgent.manifest.name;
    const host = this.agentManager.getAgent(hostName);
    if (!host) return;

    const toolDefs = pluginTools.map(t => ({
      name: t.name,
      description: t.description,
      dangerLevel: t.dangerLevel,
      inputSchema: {},
    }));

    host.ipc.send('plugins.register_tools', hostName, toolDefs);

    host.ipc.onMessage('plugin.execute', async (msg) => {
      const { toolName, input } = msg.payload as { toolName: string; input: unknown };
      const parts = toolName.split(':');
      const pluginName = parts[1];
      const tool = parts[2];

      if (!pluginName || !tool) {
        const response = { ok: false, error: `无效的插件工具名: ${toolName}` };
        host.ipc.send('plugin.execute.result', hostName, response, msg.id);
        return;
      }

      const result = await this.pluginRuntime!.execute(pluginName, tool, (input as Record<string, unknown>) ?? {});
      host.ipc.send('plugin.execute.result', hostName, result, msg.id);
    });
  }

  private spawnDaemonProcess(): void {
    const daemonEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');

    this.daemonChild = fork(daemonEntry, [], {
      env: {
        ...process.env,
        DAEMON_SOCKET_PATH: getSocketPath(),
        DAEMON_CONFIG_JSON: JSON.stringify(this.config.daemon),
      },
      stdio: 'ignore',
      detached: false,
    });

    this.daemonChild.on('exit', (code) => {
      logger.info({ code }, 'Daemon process exited');
      this.daemonChild = null;
    });

    logger.info({ pid: this.daemonChild.pid }, 'Daemon process spawned');
  }

  /**
   * 初始化 Web 服务器（HTTP API + WebSocket + 嵌入式 SPA）
   *
   * R15 解耦审计：从 startInternal 提取为独立方法 + 动态 import，
   * 消除 kernel → src/web/server.ts 的编译期依赖（M2+M3）。
   * kernel 通过结构化类型 { start(); stop() } 引用 WebServer，
   * 不持有具体类引用。
   */
  private async initWebServer(): Promise<void> {
    if (!this.config.web.enabled) return;

    // R15: 动态 import 消除 kernel → web 编译期依赖
    const { WebServer } = await import('../web/server.js');
    const { NotificationService } = await import('../intelligence/notification-service.js');
    const { MemoryLayerService } = await import('../intelligence/memory-layer-service.js');
    const { WorkspaceContextService } = await import('../intelligence/workspace-context-service.js');
    const { PluginScopeService } = await import('../intelligence/plugin-scope-service.js');
    const { TemplateService } = await import('../intelligence/template-service.js');
    const { AsyncDelegationService } = await import('../intelligence/async-delegation-service.js');
    const { HumanDelegationManager } = await import('./human-delegation.js');
    const { registerNotificationHooks } = await import('../intelligence/notification-hooks.js');

    const msgCtx = this.buildServiceContainer();
    const db = getDb();
    const notificationService = new NotificationService(db, getEventBus());
    const memoryLayerService = new MemoryLayerService(db);
    const workspaceContextService = new WorkspaceContextService(db);
    const pluginScopeService = new PluginScopeService(db);
    const templateService = new TemplateService(db);
    const asyncDelegationService = new AsyncDelegationService(db);
    this.humanDelegationManager = new HumanDelegationManager(db);

    const cleanupHooks = registerNotificationHooks(getEventBus(), () => notificationService);
    this.notificationHooksCleanup = cleanupHooks;

    // P2-10: 启动时清理残留的 pending 委托（重启后 in-memory callback/timeout 丢失）
    this.humanDelegationManager.recoverOnStartup();

    this.webServer = new WebServer({
      port: this.config.web.port,
      host: this.config.web.host,
      deps: {
        taskManager: this.taskManager!,
        sessionManager: this.sessionManager!,
        agentManager: this.agentManager,
        agentLifecycle: this.agentLifecycle!,
        eventBus: getEventBus(),
        config: this.config,
        configService: this.configService!,
        permissionCoordinator: this.permissionCoordinator!,
        handleMessage: (request, socket) => handleMessage(request, socket, msgCtx),
        // P0-3 修复：handleInterrupt 通过 EventBus 投递，不再直写 ws
        // 符合设计原则'kernel 业务路径不持 user-side ws.Socket'
        handleInterrupt: (sessionId, reason) => {
          const result = this.messageRouter!.interruptSession(sessionId, reason);
          getEventBus().emit('conversation.interrupted', {
            sessionId,
            taskId: result.taskId ?? null,
            reason: reason ?? 'user_interrupt',
          });
        },
        resolvePermissionConfirm: (requestId, approved, reason) => {
          return this.messageRouter!.resolveUserPermissionConfirm(requestId, approved, reason);
        },
        startTimeMs: Date.now(),
        secret: this.config.web.secret,
        notificationService,
        memoryLayerService,
        workspaceContextService,
        pluginScopeService,
        templateService,
        asyncDelegationService,
        humanDelegationManager: this.humanDelegationManager,
        getProviderRegistry: () => this.providerRegistryHolder!.current,
        // W7 修复：Drift metrics 工厂，替代 api-routes.ts 中的 require() 动态加载
        getDriftMetrics: () => new DriftMetricsService(getDb()),
      },
    });
    await this.webServer.start();
  }

  getTakeoverController(): TakeoverController | null {
    return this.takeoverController;
  }

  getTaskNotifier(): TaskNotifier | null {
    return this.taskNotifier;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  private async cleanup(): Promise<void> {
    if (this.agentWatcher) {
      this.agentWatcher.dispose();
      this.agentWatcher = null;
    }
    if (this.skillWatcher) {
      this.skillWatcher.dispose();
      this.skillWatcher = null;
    }
    if (this.skillService) {
      this.skillService.dispose();
      this.skillService = null;
    }
    if (this.cronScheduler) {
      this.cronScheduler.stop();
      this.cronScheduler = null;
    }
    if (this.mcpManager) {
      await this.mcpManager.stop();
      this.mcpManager = null;
    }
    if (this.channelManager) {
      this.channelManager.disposeEventBridge();
      await this.channelManager.stopAll();
      this.channelManager = null;
    }
    if (this.socketServer) {
      this.socketServer.stop();
      this.socketServer = null;
    }
    if (this.notificationHooksCleanup) {
      this.notificationHooksCleanup();
      this.notificationHooksCleanup = null;
    }
    if (this.webServer) {
      await this.webServer.stop();
      this.webServer = null;
    }
    if (this.takeoverController) {
      this.takeoverController.dispose();
      this.takeoverController = null;
    }
    // P0: 先停止 GC + 刷写流式内容，再关 taskManager（flusher 依赖它）
    this.sessionManager?.stopGc();
    this.messageRouter?.dispose();
    if (this.taskManager) {
      this.taskManager.stopSweep();
      this.taskManager.dispose();
      this.taskManager = null;
    }
    this.eventBus.removeAll();
    await this.agentManager.stopAll();
    closeDb();
    logger.error('启动失败，已清理已分配资源');
  }

  async stop(): Promise<void> {
    logger.info('正在停止 Berry 服务...');

    // Stop autonomous systems first to prevent actions during shutdown
    if (this.willLoop) {
      this.willLoop.stop();
      this.willLoop = null;
    }
    // 16.0 P3-A2：停 BoardObserver 定时扫描（advisory only，停止即可，无需 flush）
    if (this.boardObserver) {
      this.boardObserver.stop();
      this.boardObserver = null;
    }
    if (this.insightsTimer) {
      clearInterval(this.insightsTimer);
      this.insightsTimer = null;
    }
    if (this.suggestionCleanupTimer) {
      clearInterval(this.suggestionCleanupTimer);
      this.suggestionCleanupTimer = null;
    }
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
      this.auditTimer = null;
    }
    if (this.capabilityBus?.stopAllTriggers) {
      this.capabilityBus.stopAllTriggers();
      this.capabilityBus.stopIdleDetection();
    }

    if (this.terminalRenderer) {
      this.terminalRenderer.stop();
      this.terminalRenderer = null;
    }

    if (this.agentWatcher) {
      this.agentWatcher.dispose();
    }
    if (this.skillWatcher) {
      this.skillWatcher.dispose();
    }
    if (this.skillService) {
      this.skillService.dispose();
    }
    if (this.takeoverController) {
      this.takeoverController.dispose();
    }
    // P0: 先停止 GC + 刷写流式内容，再关 taskManager（flusher 依赖它）
    this.sessionManager?.stopGc();
    // 收尾所有未完成的 pending requests（清理 timer + resolve '服务关闭'）
    this.sessionManager?.disposeAllPending('服务正在关闭');
    this.messageRouter?.dispose();
    // 停止 channelManager 的 EventBus 订阅和所有 channel（与 cleanup() 保持一致）
    if (this.channelManager) {
      this.channelManager.disposeEventBridge();
      await this.channelManager.stopAll();
    }
    if (this.taskManager) {
      this.taskManager.dispose();
    }
    this.eventBus.removeAll();
    try {
      for (const agent of this.registry.listResident()) {
        this.moduleRegistry.markStatus(getDb(), `${agent.manifest.name}-agent`, 'stopped');
      }
      this.moduleRegistry.markStatus(getDb(), 'agent-manager', 'stopped');
    } catch (err) {
      logger.debug({ err }, '关闭时模块状态更新失败');
    }

    if (this.socketServer) {
      this.socketServer.stop();
    }

    if (this.webServer) {
      await this.webServer.stop();
    }

    if (this.mcpManager) {
      await this.mcpManager.stop();
    }

    if (this.daemonChild) {
      const child = this.daemonChild;
      this.daemonChild = null;
      // Graceful shutdown with forced kill fallback
      const killTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
          logger.warn('Daemon process force-killed after SIGTERM timeout');
        }
      }, 5000);
      child.on('exit', () => clearTimeout(killTimer));
      child.kill('SIGTERM');
    }
    if (this.messageRouter?.daemonBridge) {
      this.messageRouter.daemonBridge.stop();
    }

    await this.agentManager.stopAll();
    if (this.sessionManager) {
      const evolutionIdle = await this.sessionManager.waitForEvolutionIdle(30000);
      if (!evolutionIdle) {
        logger.warn('记忆自进化任务未在停止超时内完成，继续关闭服务');
      }
    }
    closeDb();

    const pidPath = getPidPath();
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }

    logger.info('Berry 服务已停止');
  }

  /**
   * Propagate LLM config changes to main-process registry and all running agent child processes.
   * Each child process will recreate its ProviderRegistry and LlmClient in-place.
   */
  private propagateLlmConfig(llmConfig: LlmConfig): void {
    // Rebuild main-process registry so API routes serve fresh data
    if (this.providerRegistryHolder) {
      this.providerRegistryHolder.current = createProviderRegistry(llmConfig, llmConfig.channelsConfig);
    }
    // 重建主进程 LLM 客户端（BuiltinDriver 等通过 holder 间接引用，自动生效）
    if (this.builtinLlmHolder) {
      this.builtinLlmHolder.current = createLlmClient(llmConfig, {
        db: getDb(),
        eventBus: this.eventBus,
        providerRegistry: this.providerRegistryHolder!.current,
        budgetConfig: this.config.budget,
      });
    }
    // Propagate to child processes via IPC
    for (const agent of this.registry.listResident()) {
      const instance = this.agentManager.getAgent(agent.manifest.name);
      if (instance) {
        instance.ipc.send('config.llm_update', agent.manifest.name, { llm: llmConfig });
      }
    }
    logger.info('LLM config propagated to all processes');
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  const service = new CoreService();

  process.on('SIGTERM', async () => {
    await service.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await service.stop();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, '未捕获异常');
    service.stop().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝');
  });

  service.start().catch((err) => {
    logger.error({ err }, 'Berry 服务启动失败');
    process.exit(1);
  });
}
