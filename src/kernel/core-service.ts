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
import { ChannelManager, TelegramChannel, WsChannel } from '../channels/index.js';
import { WorkspaceManager } from '../workspaces/index.js';
import { WebServer } from '../web/server.js';
import { NotificationService } from '../intelligence/notification-service.js';
import { MemoryLayerService } from '../intelligence/memory-layer-service.js';
import { WorkspaceContextService } from '../intelligence/workspace-context-service.js';
import { PluginScopeService } from '../intelligence/plugin-scope-service.js';
import { TemplateService } from '../intelligence/template-service.js';
import { AsyncDelegationService } from '../intelligence/async-delegation-service.js';
import { HumanDelegationManager } from './human-delegation.js';
import { registerNotificationHooks } from '../intelligence/notification-hooks.js';
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
  private webServer: WebServer | null = null;
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
  private insightsTimer: ReturnType<typeof setInterval> | null = null;
  private suggestionCleanupTimer: ReturnType<typeof setInterval> | null = null;
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
    this.messageRouter.pluginRuntimeV2 = this.pluginRuntimeV2;

    // 启动 session 垃圾回收（5 分钟间隔，30 分钟无活动清理缓存与 pendingAsks）
    this.sessionManager.startGc();

    // 12.0: 初始化漂移检测器
    if (this.config.drift?.enabled !== false) {
      const { DriftDetector } = await import('./drift-detector.js');
      this.messageRouter.driftDetector = new DriftDetector(getDb(), this.config.drift?.thresholds);
    }
    this.registerSkillChangedHandler();
    this.registerPluginTools();

    if (this.config.daemon.enabled) {
      const daemonBridge = new DaemonBridge(this.eventBus, this.taskManager, {
        heartbeatTimeoutMs: this.config.daemon.heartbeatTimeoutMs,
        taskTimeoutMs: this.config.daemon.taskTimeoutMs,
      });
      this.messageRouter.daemonBridge = daemonBridge;
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
    this.messageRouter.setRuntimeRegistry(runtimeRegistry);

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
    this.messageRouter.setCapabilityBus(capabilityBus);
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
    this.messageRouter.setWorldModel(worldModel);

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
    this.messageRouter.setSuggestionQueue(suggestionQueue);

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
    this.messageRouter.setRuntimeExecutor(runtimeExecutor);

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

    // P2-13: agent.crashed 期间的消息缓冲队列
    // crash handler 执行期间新消息可能被路由到正在重启的 agent，导致消息丢失。
    // 解决方案：crash handler 运行时缓冲消息，agent waitForReady 完成后才释放。
    const crashedAgents = new Set<string>();
    const messageBuffer: Array<{ payload: RouteRequestPayload; correlationId: string }> = [];
    let crashBufferTimer: ReturnType<typeof setTimeout> | null = null;

    this.eventBus.on('agent.crashed', ({ name }) => {
      // 标记 agent 正在崩溃处理中，缓冲后续消息
      crashedAgents.add(name);
      if (crashBufferTimer) clearTimeout(crashBufferTimer);
      // 安全网：10s 后自动释放缓冲（防 crash handler 卡死）
      crashBufferTimer = setTimeout(() => {
        crashedAgents.delete(name);
        // 释放缓冲消息
        while (messageBuffer.length > 0) {
          const { payload, correlationId } = messageBuffer.shift()!;
          this.messageRouter?.sendRouteRequest(payload, correlationId);
        }
      }, 10_000);

      this.taskManager!.failByAgent(name, `智能体 ${name} 崩溃`);
      this.messageRouter?.failDelegationsByAgent(name, `智能体 ${name} 崩溃`);
      for (const [msgId, pending] of this.sessionManager!.entries()) {
        if (!pending.taskId) continue;
        const task = this.taskManager!.getTask(pending.taskId);
        if (task?.target_agent === name && task.status === 'failed') {
          // R4-P0-1：agent.crashed 兜底：partial draftResponse + error 入库，避免 user 消息孤儿
          const errorResponse = `[错误] 智能体 ${name} 崩溃，请重试`;
          const partialContent = pending.draftResponse
            ? `${pending.draftResponse}\n\n${errorResponse}`
            : errorResponse;
          this.sessionManager!.resolvePending(msgId, errorResponse, { contentOverride: partialContent });
        }
      }
      // crash handler 完成，清除崩溃标记和释放缓冲
      crashedAgents.delete(name);
      if (crashBufferTimer) { clearTimeout(crashBufferTimer); crashBufferTimer = null; }
      while (messageBuffer.length > 0) {
        const { payload, correlationId } = messageBuffer.shift()!;
        this.messageRouter?.sendRouteRequest(payload, correlationId);
      }
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

    if (this.config.web.enabled) {
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
      this.messageRouter.workspaceRouter = wsRouter;

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
      this.messageRouter.setSuperiorReviewFlow(superiorReviewFlow);

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

    // P2-12: 始终创建 ChannelManager，WS 作为统一 channel 接入
    this.channelManager = new ChannelManager();
    const wsChannel = new WsChannel();
    this.channelManager.register(wsChannel);
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
    // v2 unified mode manages plugins through its own facet system — skip v1 registration
    if (this.pluginRuntimeV2) return;
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
    if (this.insightsTimer) {
      clearInterval(this.insightsTimer);
      this.insightsTimer = null;
    }
    if (this.suggestionCleanupTimer) {
      clearInterval(this.suggestionCleanupTimer);
      this.suggestionCleanupTimer = null;
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
    this.messageRouter?.dispose();
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
