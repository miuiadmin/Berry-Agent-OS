import type { PluginRecord } from '../../contracts/plugins-v2.js';
import type { IsolatedPluginExecutor } from '../isolated-runtime.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('service-facet');
const MAX_CONCURRENT_SERVICES = 10;
const MAX_RESTART_ATTEMPTS = 3;

interface ServiceEntry {
  pluginName: string;
  pluginId: string;
  state: 'running' | 'stopped' | 'failed';
  restartCount: number;
  cronInterval?: ReturnType<typeof setInterval>;
}

export interface ServiceFacetDeps {
  executor: IsolatedPluginExecutor;
  pluginsDir: string;
  onQuarantine?: (pluginId: string) => void;
}

export class ServiceFacet {
  private services = new Map<string, ServiceEntry>();
  private readonly executor: IsolatedPluginExecutor;
  private readonly pluginsDir: string;
  private readonly onQuarantine?: (pluginId: string) => void;

  constructor(deps: ServiceFacetDeps) {
    this.executor = deps.executor;
    this.pluginsDir = deps.pluginsDir;
    this.onQuarantine = deps.onQuarantine;
  }

  async start(plugin: PluginRecord): Promise<void> {
    if (this.services.has(plugin.name)) return;
    if (this.services.size >= MAX_CONCURRENT_SERVICES) {
      throw new Error(`Service pool limit reached (${MAX_CONCURRENT_SERVICES})`);
    }

    const manifest = plugin.manifestJson;
    if (!manifest?.facets.service) {
      throw new Error(`Plugin ${plugin.name} has no service facet`);
    }

    const entryPath = `${this.pluginsDir}/${plugin.name}/${manifest.facets.service.entrypoint}`;
    await this.executor.spawn(plugin.name, entryPath);

    const entry: ServiceEntry = {
      pluginName: plugin.name,
      pluginId: plugin.id,
      state: 'running',
      restartCount: 0,
    };

    if (manifest.facets.service.schedule) {
      const intervalMs = this.parseScheduleToMs(manifest.facets.service.schedule);
      if (intervalMs > 0) {
        entry.cronInterval = setInterval(() => {
          void this.tick(plugin.name);
        }, intervalMs);
      }
    }

    this.services.set(plugin.name, entry);
    logger.info({ plugin: plugin.name }, 'Service started');
  }

  async stop(pluginName: string): Promise<void> {
    const entry = this.services.get(pluginName);
    if (!entry) return;

    if (entry.cronInterval) clearInterval(entry.cronInterval);
    await this.executor.terminate(pluginName);
    entry.state = 'stopped';
    this.services.delete(pluginName);
    logger.info({ plugin: pluginName }, 'Service stopped');
  }

  async tick(pluginName: string): Promise<void> {
    const entry = this.services.get(pluginName);
    if (!entry || entry.state !== 'running') return;

    try {
      await this.executor.execute(pluginName, '__service_tick__', {}, 30000);
    } catch (err) {
      logger.warn({ plugin: pluginName, error: (err as Error).message }, 'Service tick failed');
      await this.handleFailure(entry);
    }
  }

  async stopAll(): Promise<void> {
    const names = [...this.services.keys()];
    await Promise.all(names.map(n => this.stop(n)));
  }

  isRunning(pluginName: string): boolean {
    return this.services.get(pluginName)?.state === 'running';
  }

  getRunningCount(): number {
    return this.services.size;
  }

  private async handleFailure(entry: ServiceEntry): Promise<void> {
    const manifest = this.getRestartPolicy(entry.pluginName);
    if (manifest === 'never') {
      entry.state = 'failed';
      await this.stop(entry.pluginName);
      return;
    }

    entry.restartCount++;
    if (entry.restartCount > MAX_RESTART_ATTEMPTS) {
      logger.error({ plugin: entry.pluginName }, 'Service exceeded max restarts, quarantining');
      entry.state = 'failed';
      if (entry.cronInterval) clearInterval(entry.cronInterval);
      await this.executor.terminate(entry.pluginName);
      this.services.delete(entry.pluginName);
      this.onQuarantine?.(entry.pluginId);
      return;
    }

    logger.info({ plugin: entry.pluginName, attempt: entry.restartCount }, 'Restarting service');
    await this.executor.terminate(entry.pluginName);
    try {
      const entryPath = `${this.pluginsDir}/${entry.pluginName}/index.js`;
      await this.executor.spawn(entry.pluginName, entryPath);
    } catch {
      entry.state = 'failed';
    }
  }

  private getRestartPolicy(pluginName: string): 'on-failure' | 'always' | 'never' {
    for (const entry of this.services.values()) {
      if (entry.pluginName === pluginName) return 'on-failure';
    }
    return 'on-failure';
  }

  private parseScheduleToMs(schedule: string): number {
    const match = schedule.match(/^every\s+(\d+)\s*(s|m|h|d)$/i);
    if (!match) return 0;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * (multipliers[unit] ?? 0);
  }
}
