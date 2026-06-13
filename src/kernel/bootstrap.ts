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
  // 注意：stream.* / dialogue.status / conversation.* 事件由 src/web/ws-event-bridge.ts
  // 直接订阅 EventBus 并转发到 WS 客户端（kernel 不再持有 ws.Socket 引用）。
  // R14-2：OrphanReconciler 已删除。原本的"启动 5s 一次性扫 + globalThis holder"
  // 模式被替换为 SessionManager.recoverSessions(db) 在启动阶段直接把
  // stale task 标记为 failed/timeout + 在写入点（saveMessage）兜底写 [系统] 行
  // 到 conversations 表。概念上从"周期性扫表"消解为"写入点失败处理"。
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
    // 15.0 R2-4：session 被 GC 回收时，同步清理 PermissionCoordinator 的 per-session mode，
    // 避免 sessionModes 随会话累积无界增长。
    onSessionGc: (sessionId) => permissionCoordinator.clearSessionMode(sessionId),
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
