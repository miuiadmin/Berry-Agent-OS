/**
 * KernelBootstrap — phased initialization extracted from CoreService.
 *
 * Each method is a self-contained phase that returns the services it creates.
 * CoreService.startInternal() calls these phases in order, keeping the
 * orchestrator thin and each phase independently testable.
 */

import type Database from 'better-sqlite3';
import { AgentLifecycle } from './agent-lifecycle.js';
import { AgentManager } from './agent-manager.js';
import { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import { initStreamDispatcher } from './stream-dispatcher.js';
import { OrphanReconciler } from './orphan-reconciler.js';
import type { AppConfig } from '../config/schema.js';
import { createCoreModuleRegistry, registerAgentModules, type ModuleRegistry } from './module-system.js';
import { initTracer, createSqliteSink } from '../observability/tracer.js';
import { getDb } from '../memory/index.js';
import { TaskManager } from './task-manager.js';
import { TaskNotifier } from './task-notification.js';
import { AgentProgress } from './agent-progress.js';
import { EvolutionEngine, CapabilityService } from '../evolution/index.js';
import { SkillService } from '../skills/index.js';
import { PluginRegistry, PluginLoader, PluginRuntime, PluginRuntimeV2 } from '../plugins/index.js';
import { PermissionEngine, TokenIssuer, ApprovalManager } from '../safety/index.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { SessionManager } from './session-manager.js';
import { AuditRecorder } from './audit-recorder.js';
import { TakeoverController } from '../testing/model-takeover.js';
import { getPluginsDir } from '../utils/paths.js';
import type { MemoryRuntime } from '../memory/index.js';
import { getLogger } from '../utils/logger.js';
import type { PluginRecord } from '../contracts/plugins-v2.js';

const logger = getLogger('kernel-bootstrap');

// --- Return types ---

export interface InfrastructureResult {
  db: Database.Database;
  moduleRegistry: ModuleRegistry;
  agentLifecycle: AgentLifecycle;
}

export interface ServicesResult {
  taskManager: TaskManager;
  taskNotifier: TaskNotifier;
  agentProgress: AgentProgress;
  evolutionEngine: EvolutionEngine;
  capabilityService: CapabilityService;
  skillService: SkillService;
  pluginRuntime: PluginRuntime;
  pluginRuntimeV2: PluginRuntimeV2 | null;
  permissionCoordinator: PermissionCoordinator;
  sessionManager: SessionManager;
  auditRecorder: AuditRecorder;
  takeoverController: TakeoverController | null;
}

// --- Phase functions ---

/**
 * Phase 1 — Infrastructure: DB, agent discovery, module registry,
 * observability tracer, lifecycle seeding.
 */
export function initInfrastructure(
  config: AppConfig,
  registry: AgentRegistry,
  agentManager: AgentManager,
  eventBus: EventBus,
  moduleRegistry: ModuleRegistry,
): InfrastructureResult {
  const db = getDb();

  registry.validateSystemRoles();
  registerAgentModules(registry, moduleRegistry);
  moduleRegistry.persist(db);

  const agentLifecycle = new AgentLifecycle(registry, agentManager, moduleRegistry, eventBus, db);
  agentLifecycle.seedBundledAgents();

  moduleRegistry.markStatus(db, 'db', 'running');
  moduleRegistry.markStatus(db, 'config', 'running');
  moduleRegistry.markStatus(db, 'event-bus', 'running');
  // H1/H2: 初始化 StreamDispatcher（订阅 EventBus 的 4 个 stream/dialogue 事件并 fan-out 给 transport 订阅者）
  // 必须在 EventBus 就绪后、其他业务模块 emit 事件前调用
  initStreamDispatcher();
  // R4-P0-4：启动 orphan user row reconciler，定期扫"user 后 60s 内无 assistant"的孤儿对
  // 兜底写入 [系统] 提示行，让用户刷新后至少能看到 assistant 占位说明
  // R6 重构：原 R4-P0-4 启动时用 setInterval 60s 持续扫（"补丁式"扫，
  // 暴露 in-memory pendingRequests 脆弱性问题）。改为启动时一次性扫：
  // in-memory pending 脆弱性由 taskManager / streamingFlusher /
  // saveConversationTurn 多层兜底共同覆盖；OrphanReconciler 仅是
  // "已有架构内的兜底扫描"，不再持续跑。
  const orphanReconciler = new OrphanReconciler(eventBus);
  // 启动后延迟 5s 跑首次扫描（避免与 daemon 启动竞争）
  setTimeout(() => {
    const result = orphanReconciler.runOnce();
    if (result.reconciled > 0) {
      logger.warn(result, 'orphan user row 一次性兜底已写入');
    }
  }, 5_000);
  globalThis.__berry_orphanReconciler = orphanReconciler;
  initTracer([createSqliteSink(db)]);
  moduleRegistry.markStatus(db, 'observability', 'running');
  moduleRegistry.markStatus(db, 'memory', 'running');
  moduleRegistry.markStatus(db, 'permissions', 'running');
  moduleRegistry.markStatus(db, 'llm', 'running');
  moduleRegistry.markStatus(db, 'agent-manager', 'starting');

  logger.debug('Phase 1 (Infrastructure) complete');
  return { db, moduleRegistry, agentLifecycle };
}

/**
 * Phase 2 — Services: task management, evolution, skills, plugins,
 * permissions, session management, audit, LLM takeover.
 */
export async function initServices(
  config: AppConfig,
  eventBus: EventBus,
  memoryRuntime: MemoryRuntime,
  onPluginPendingReview?: (plugin: PluginRecord) => void,
): Promise<ServicesResult> {
  const db = getDb();

  const taskManager = new TaskManager(db, eventBus);
  const taskNotifier = new TaskNotifier(db, eventBus);
  const agentProgress = new AgentProgress(db, eventBus);

  const evolutionEngine = new EvolutionEngine(db);
  const capabilityService = new CapabilityService(db);

  const skillService = new SkillService({ db });
  skillService.initialize();

  const pluginRegistry = new PluginRegistry(db);
  const pluginLoader = new PluginLoader();
  const pluginRuntime = new PluginRuntime(db, pluginLoader);
  await pluginRuntime.initialize(pluginRegistry.list());

  let pluginRuntimeV2: PluginRuntimeV2 | null = null;
  if (config.plugins.unified) {
    const { PluginRegistryV2 } = await import('../plugins/index.js');
    const registryV2 = new PluginRegistryV2(db);
    pluginRuntimeV2 = new PluginRuntimeV2({
      db,
      eventBus,
      pluginsDir: config.plugins.pluginsDir || getPluginsDir(),
      onPendingReview: onPluginPendingReview,
    });
    const enabledPlugins = registryV2.list({ status: 'enabled' });
    await pluginRuntimeV2.initialize(enabledPlugins);
    logger.info({ count: enabledPlugins.length }, 'Plugin runtime v2 initialized (unified mode)');
  }

  const permissionEngine = new PermissionEngine(config.permissionMode);
  const tokenIssuer = new TokenIssuer(db);
  const approvalManager = new ApprovalManager(db, tokenIssuer, config.permissionMode);

  const permissionCoordinator = new PermissionCoordinator({
    engine: permissionEngine,
    tokenIssuer,
    approvalManager,
  });

  const sessionManager = new SessionManager({
    memoryRuntime,
    skillLoader: skillService,
    evolutionEngine,
    pluginRuntimeV2,
    config,
  });

  const auditRecorder = new AuditRecorder(db);

  let takeoverController: TakeoverController | null = null;
  if ((config.llm.mode ?? 'live') === 'takeover') {
    takeoverController = new TakeoverController();
  }

  logger.debug('Phase 2 (Services) complete');
  return {
    taskManager, taskNotifier, agentProgress,
    evolutionEngine, capabilityService, skillService,
    pluginRuntime, pluginRuntimeV2,
    permissionCoordinator, sessionManager, auditRecorder,
    takeoverController,
  };
}
