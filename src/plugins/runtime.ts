import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import type { PluginManifest } from './types.js';
import type { PluginContext } from './sdk.js';
import type { PluginLoader } from './loader.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { IPluginRuntime, PluginExecResult } from './contract.js';
import type { DangerLevel } from '../utils/types.js';
import type { EventBus } from '../contracts/infrastructure.js';
import { IsolatedPluginExecutor } from './isolated-runtime.js';
import { safeParse } from './utils.js';
import { SqlitePluginStorage } from './storage.js';
import { getLogger } from '../utils/logger.js';
import { genId } from '../utils/id.js';

const logger = getLogger('plugin-runtime');

interface PluginToolMeta {
  pluginName: string;
  toolName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissionScope: string;
}

const PLUGIN_EXEC_TIMEOUT_MS = 30_000;

export class PluginRuntime implements IPluginRuntime {
  private toolMeta: PluginToolMeta[] = [];
  private executor: IsolatedPluginExecutor;
  private isolated = new Set<string>();
  private pluginConfigs = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly db: Database,
    private readonly loader: PluginLoader,
    private readonly eventBus?: EventBus,
  ) {
    this.executor = new IsolatedPluginExecutor({ db, eventBus });
  }

  async initialize(manifests: PluginManifest[]): Promise<void> {
    const enabled = manifests.filter(m => m.status === 'enabled');
    for (const manifest of enabled) {
      try {
        await this.loader.load(manifest);
        this.pluginConfigs.set(manifest.name, (manifest.capabilities ?? {}) as Record<string, unknown>);
        try {
          await this.executor.spawn(manifest.name, manifest.entryPath);
          this.isolated.add(manifest.name);
        } catch {
          logger.debug({ plugin: manifest.name }, 'Worker 隔离不可用，使用进程内执行');
        }
        this.loadToolMeta(manifest);

        const loaded = this.loader.getLoaded().get(manifest.name);
        if (loaded?.definition.hooks?.onInstall) {
          await loaded.definition.hooks.onInstall();
        }
      } catch (err) {
        this.recordEvent(manifest.id, 'load_error', { error: (err as Error).message });
      }
    }
  }

  async reload(manifests: PluginManifest[]): Promise<void> {
    for (const [, loaded] of this.loader.getLoaded()) {
      if (loaded.definition.hooks?.onUninstall) {
        try { await loaded.definition.hooks.onUninstall(); } catch { /* best-effort */ }
      }
    }
    await this.executor.terminateAll();
    this.isolated.clear();
    this.pluginConfigs.clear();
    await this.loader.unloadAll();
    this.toolMeta = [];
    await this.initialize(manifests);
  }

  getPluginTools(): ToolDefinition[] {
    return this.toolMeta.map(meta => this.toToolDefinition(meta));
  }

  async execute(pluginName: string, toolName: string, input: Record<string, unknown>): Promise<PluginExecResult> {
    const start = Date.now();

    if (this.isolated.has(pluginName)) {
      return this.executeIsolated(pluginName, toolName, input, start);
    }
    return this.executeInProcess(pluginName, toolName, input, start);
  }

  private async executeIsolated(
    pluginName: string, toolName: string, input: Record<string, unknown>, start: number,
  ): Promise<PluginExecResult> {
    const config = this.pluginConfigs.get(pluginName) ?? {};
    const result = await this.executor.execute(pluginName, toolName, input, PLUGIN_EXEC_TIMEOUT_MS, config);
    const durationMs = Date.now() - start;

    if (result.ok) {
      const output = typeof result.output === 'object' && result.output !== null
        ? result.output as Record<string, unknown>
        : { result: result.output };
      this.updateStats(pluginName, true);
      this.recordEvent(this.getPluginId(pluginName), 'tool_executed', { tool: toolName, durationMs, ok: true });
      return { ok: true, output, durationMs };
    }

    this.updateStats(pluginName, false);
    this.recordEvent(this.getPluginId(pluginName), 'tool_error', { tool: toolName, durationMs, error: result.error });
    return { ok: false, error: result.error ?? '执行失败', durationMs };
  }

  private async executeInProcess(
    pluginName: string, toolName: string, input: Record<string, unknown>, start: number,
  ): Promise<PluginExecResult> {
    const loaded = this.loader.getLoaded().get(pluginName);
    if (!loaded) {
      return { ok: false, error: `插件未加载: ${pluginName}`, durationMs: 0 };
    }

    const handler = loaded.definition.tools[toolName];
    if (!handler) {
      return { ok: false, error: `工具不存在: ${pluginName}:${toolName}`, durationMs: 0 };
    }

    const ctx: PluginContext = {
      pluginName,
      toolName,
      log: {
        debug: (msg, data) => logger.debug({ plugin: pluginName, ...data }, msg),
        info: (msg, data) => logger.info({ plugin: pluginName, ...data }, msg),
        warn: (msg, data) => logger.warn({ plugin: pluginName, ...data }, msg),
        error: (msg, data) => logger.error({ plugin: pluginName, ...data }, msg),
      },
      storage: new SqlitePluginStorage(this.db, pluginName),
      config: this.pluginConfigs.get(pluginName) ?? {},
      fetch: (url, init) => fetch(url, init),
      emit: (event, payload) => {
        this.eventBus?.emit(`plugin.${pluginName}.${event}` as never, payload as never);
      },
    };

    try {
      const result = await Promise.race([
        Promise.resolve(handler(input, ctx)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('插件执行超时')), PLUGIN_EXEC_TIMEOUT_MS),
        ),
      ]);

      const durationMs = Date.now() - start;
      const output = typeof result === 'object' && result !== null
        ? result as Record<string, unknown>
        : { result };

      this.updateStats(pluginName, true);
      this.recordEvent(this.getPluginId(pluginName), 'tool_executed', { tool: toolName, durationMs, ok: true });
      return { ok: true, output, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = (err as Error).message;
      this.updateStats(pluginName, false);
      this.recordEvent(this.getPluginId(pluginName), 'tool_error', { tool: toolName, durationMs, error });
      return { ok: false, error, durationMs };
    }
  }

  private loadToolMeta(manifest: PluginManifest): void {
    const rows = this.db.prepare(
      `SELECT tool_name, title, description, input_schema, output_schema, permission_scope
       FROM plugin_tools WHERE plugin_id = ?`,
    ).all(manifest.id) as Array<Record<string, unknown>>;

    for (const row of rows) {
      this.toolMeta.push({
        pluginName: manifest.name,
        toolName: row.tool_name as string,
        title: (row.title as string) || (row.tool_name as string),
        description: (row.description as string) || '',
        inputSchema: safeParse(row.input_schema as string),
        outputSchema: row.output_schema ? safeParse(row.output_schema as string) : undefined,
        permissionScope: (row.permission_scope as string) || 'readonly',
      });
    }
  }

  private toToolDefinition(meta: PluginToolMeta): ToolDefinition {
    const fullName = `plugin:${meta.pluginName}:${meta.toolName}`;
    return {
      name: fullName,
      description: `[插件 ${meta.pluginName}] ${meta.description}`,
      inputSchema: z.record(z.string(), z.unknown()),
      dangerLevel: scopeToDangerLevel(meta.permissionScope),
      execute: async (input: unknown): Promise<ToolResult> => {
        const result = await this.execute(
          meta.pluginName,
          meta.toolName,
          (input as Record<string, unknown>) ?? {},
        );
        if (result.ok) {
          return { content: JSON.stringify(result.output) };
        }
        return { content: result.error ?? '执行失败', isError: true };
      },
    };
  }

  private updateStats(pluginName: string, success: boolean): void {
    const field = success ? 'success_count' : 'failure_count';
    this.db.prepare(`
      UPDATE plugins_meta
      SET use_count = use_count + 1, ${field} = ${field} + 1, last_used_at = ?
      WHERE name = ?
    `).run(Date.now(), pluginName);
  }

  private getPluginId(pluginName: string): string {
    const row = this.db.prepare(`SELECT id FROM plugins_meta WHERE name = ?`)
      .get(pluginName) as { id: string } | undefined;
    return row?.id ?? pluginName;
  }

  private recordEvent(pluginId: string, eventType: string, payload: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO plugin_events (id, plugin_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(genId('pe'), pluginId, eventType, JSON.stringify(payload), Date.now());
  }
}

function scopeToDangerLevel(scope: string): DangerLevel {
  if (scope.includes('readonly')) return 'safe';
  if (scope.includes('file')) return 'moderate';
  if (scope.includes('shell') || scope.includes('network')) return 'dangerous';
  return 'moderate';
}

