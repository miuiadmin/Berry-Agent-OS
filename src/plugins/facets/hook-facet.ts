import type { Database } from 'better-sqlite3';
import type { HookEvent, HookAction, HookHandler, PluginRecord } from '../../contracts/plugins-v2.js';

const HOOK_TIMEOUT_MS = 30;
const CHAIN_TIMEOUT_MS = 200;

export class HookOrchestrator {
  constructor(private readonly db: Database) {}

  getHandlers(event: HookEvent, plugins: PluginRecord[]): HookHandler[] {
    const hookPluginIds = plugins.filter(p => p.hasHooks).map(p => p.id);
    if (hookPluginIds.length === 0) return [];

    const placeholders = hookPluginIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ph.*, pm.name as plugin_name FROM plugin_hooks ph
      JOIN plugins_meta pm ON pm.id = ph.plugin_id
      WHERE ph.event = ? AND ph.enabled = 1 AND ph.plugin_id IN (${placeholders})
      ORDER BY ph.priority ASC
    `).all(event, ...hookPluginIds) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      pluginName: row.plugin_name as string,
      event: row.event as HookEvent,
      handlerPath: row.handler_path as string,
      priority: row.priority as number,
    }));
  }

  async executeChain(
    event: HookEvent,
    payload: unknown,
    plugins: PluginRecord[],
    executor?: (handler: HookHandler, data: unknown) => Promise<HookAction>,
  ): Promise<HookAction> {
    const handlers = this.getHandlers(event, plugins);
    if (handlers.length === 0) return { action: 'pass' };

    const chainStart = Date.now();
    let currentData = payload;

    for (const handler of handlers) {
      if (Date.now() - chainStart > CHAIN_TIMEOUT_MS) break;

      try {
        const result = await (executor
          ? withTimeout(executor(handler, currentData), HOOK_TIMEOUT_MS)
          : Promise.resolve({ action: 'pass' } as HookAction));

        if (result.action === 'block') return result;
        if (result.action === 'flag') continue;
        if (result.action === 'modify') {
          currentData = (result as { action: 'modify'; data: unknown }).data;
        }
      } catch {
        this.recordFailure(handler.pluginName);
      }
    }

    return { action: 'pass' };
  }

  private recordFailure(pluginName: string): void {
    this.db.prepare(`
      UPDATE plugins_meta SET failure_count = failure_count + 1, updated_at = ? WHERE name = ?
    `).run(Date.now(), pluginName);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hook timeout')), ms)),
  ]);
}
