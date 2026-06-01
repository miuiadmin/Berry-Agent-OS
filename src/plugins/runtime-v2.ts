import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import type {
  PluginRecord,
  HookEvent,
  HookAction,
  HookHandler,
  PromptInjectionContext,
  PluginExecResultV2,
  IPluginRuntimeV2,
  ResolvedPluginSet,
} from '../contracts/plugins-v2.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import { IsolatedPluginExecutor } from './isolated-runtime.js';
import { PluginRegistryV2 } from './registry-v2.js';
import { ScopeResolver } from './scope-resolver.js';
import { PromptFacet } from './facets/prompt-facet.js';
import { ToolFacet, type RawToolDefinition } from './facets/tool-facet.js';
import { HookOrchestrator } from './facets/hook-facet.js';
import { CodeFacet } from './facets/code-facet.js';
import { ServiceFacet } from './facets/service-facet.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('plugin-runtime-v2');

export interface PluginRuntimeV2Deps {
  db: Database;
  eventBus?: EventBus;
  pluginsDir: string;
  allowedHosts?: string[];
  onPendingReview?: (plugin: PluginRecord) => void;
}

export class PluginRuntimeV2 implements IPluginRuntimeV2 {
  private readonly db: Database;
  private readonly registry: PluginRegistryV2;
  private readonly scopeResolver: ScopeResolver;
  private readonly promptFacet: PromptFacet;
  private readonly toolFacet: ToolFacet;
  private readonly hookOrchestrator: HookOrchestrator;
  private readonly codeFacet: CodeFacet;
  private readonly serviceFacet: ServiceFacet;
  private readonly onPendingReview?: (plugin: PluginRecord) => void;
  private readonly executor: IsolatedPluginExecutor;
  private plugins: PluginRecord[] = [];

  constructor(deps: PluginRuntimeV2Deps) {
    this.db = deps.db;
    this.executor = new IsolatedPluginExecutor({
      db: deps.db,
      eventBus: deps.eventBus,
      allowedHosts: deps.allowedHosts,
      pluginsDir: deps.pluginsDir,
    });

    this.registry = new PluginRegistryV2(deps.db);
    this.scopeResolver = new ScopeResolver({ db: deps.db, registry: this.registry });
    this.promptFacet = new PromptFacet(deps.db);
    this.toolFacet = new ToolFacet(deps.db, this);
    this.hookOrchestrator = new HookOrchestrator(deps.db);
    this.codeFacet = new CodeFacet(this.executor);
    this.serviceFacet = new ServiceFacet({
      executor: this.executor,
      pluginsDir: deps.pluginsDir,
      onQuarantine: (pluginId) => {
        try { this.registry.updateStatus(pluginId, 'quarantined'); } catch { /* already quarantined */ }
      },
    });
    this.onPendingReview = deps.onPendingReview;
  }

  async initialize(plugins: PluginRecord[]): Promise<void> {
    this.plugins = plugins;

    for (const plugin of plugins) {
      try {
        if (plugin.hasCode || plugin.hasTools) {
          await this.codeFacet.spawn(plugin, this.getPluginsDir());
        }
        if (plugin.hasService) {
          await this.serviceFacet.start(plugin);
        }
      } catch (err) {
        logger.warn({ plugin: plugin.name, error: (err as Error).message }, 'Failed to initialize plugin');
      }
    }

    logger.info({ count: plugins.length }, 'Plugin runtime v2 initialized');
    this.triggerPendingReviews();
  }

  private triggerPendingReviews(): void {
    if (!this.onPendingReview) return;
    const pending = this.registry.list({ status: 'pending_review' as any });
    for (const plugin of pending) {
      this.onPendingReview(plugin);
    }
  }

  async reload(): Promise<void> {
    await this.serviceFacet.stopAll();
    await this.executor.terminateAll();
    const enabledPlugins = this.registry.list({ status: 'enabled' });
    await this.initialize(enabledPlugins);
  }

  getToolDefinitions(agentId?: string): ToolDefinition[] {
    const plugins = agentId
      ? this.resolveForAgent(agentId).tools
      : this.plugins.filter(p => p.hasTools);

    const rawDefs = this.toolFacet.getToolDefinitions(plugins);
    return rawDefs.map(raw => this.rawToToolDefinition(raw));
  }

  private rawToToolDefinition(raw: RawToolDefinition): ToolDefinition {
    return {
      name: raw.name,
      description: raw.description,
      inputSchema: z.record(z.string(), z.unknown()),
      dangerLevel: raw.dangerLevel,
      execute: async (input: unknown): Promise<ToolResult> => {
        const result = await this.executeTool(raw.pluginName, raw.toolName, input);
        if (result.ok) {
          return { content: JSON.stringify(result.output ?? {}), isError: false };
        }
        return { content: result.error ?? 'Plugin execution failed', isError: true };
      },
    };
  }

  buildPromptBlock(context: PromptInjectionContext): string {
    const resolved = this.scopeResolver.resolve(context.agentId, context.workspaceId, context.userId);
    return this.promptFacet.buildPromptBlock(resolved.prompt, context);
  }

  getHooksForEvent(event: HookEvent, agentId?: string): HookHandler[] {
    const plugins = agentId
      ? this.resolveForAgent(agentId).hooks
      : this.plugins.filter(p => p.hasHooks);
    return this.hookOrchestrator.getHandlers(event, plugins);
  }

  async executeHookChain(event: HookEvent, payload: unknown, agentId?: string): Promise<HookAction> {
    const plugins = agentId
      ? this.resolveForAgent(agentId).hooks
      : this.plugins.filter(p => p.hasHooks);

    return this.hookOrchestrator.executeChain(event, payload, plugins, async (handler, data) => {
      const result = await this.executor.execute(handler.pluginName, handler.handlerPath, data, 30);
      const output = result.output as Record<string, unknown> | undefined;
      if (!result.ok || !output) return { action: 'pass' };
      return (output as unknown) as HookAction;
    });
  }

  async executeTool(pluginName: string, toolName: string, input: unknown): Promise<PluginExecResultV2> {
    const t0 = Date.now();
    try {
      const result = await this.executor.execute(pluginName, toolName, input, 30000);
      const durationMs = Date.now() - t0;
      const plugin = this.registry.getByName(pluginName);
      if (plugin) this.registry.recordUsage(plugin.id, result.ok);
      return result.ok
        ? { ok: true, output: result.output, durationMs }
        : { ok: false, error: result.error, durationMs };
    } catch (err) {
      return { ok: false, error: (err as Error).message, durationMs: Date.now() - t0 };
    }
  }

  async executeCode(pluginName: string, input: unknown): Promise<PluginExecResultV2> {
    const plugin = this.registry.getByName(pluginName);
    if (!plugin) return { ok: false, error: `Plugin not found: ${pluginName}`, durationMs: 0 };
    return this.codeFacet.execute(plugin, input);
  }

  async startService(pluginName: string): Promise<void> {
    const plugin = this.registry.getByName(pluginName);
    if (!plugin) throw new Error(`Plugin not found: ${pluginName}`);
    await this.serviceFacet.start(plugin);
  }

  async stopService(pluginName: string): Promise<void> {
    await this.serviceFacet.stop(pluginName);
  }

  execute(pluginName: string, toolName: string, input: Record<string, unknown>): Promise<PluginExecResultV2> {
    return this.executeTool(pluginName, toolName, input);
  }

  private resolveForAgent(agentId: string): ResolvedPluginSet {
    const plugin = this.plugins.find(p => p.ownerAgentId === agentId);
    const workspaceId = plugin?.workspaceId ?? '';
    const userId = plugin?.userId ?? '';
    return this.scopeResolver.resolve(agentId, workspaceId, userId);
  }

  private getPluginsDir(): string {
    return (this.executor as unknown as { deps: { pluginsDir?: string } }).deps?.pluginsDir ?? '';
  }
}
