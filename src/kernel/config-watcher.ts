import { watch, existsSync, type FSWatcher } from 'node:fs';
import { loadConfig, type AppConfig } from './config.js';
import { getConfigPath } from '../utils/paths.js';
import type { EventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('config-watcher');

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: AppConfig;

  constructor(private eventBus: EventBus, initial: AppConfig) {
    this.current = initial;
  }

  start(): void {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return;
    this.watcher = watch(configPath, () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 1000);
    });
    logger.info('已启动配置文件监视');
  }

  getConfig(): AppConfig {
    return this.current;
  }

  dispose(): void {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private reload(): void {
    try {
      const next = loadConfig();
      this.current = next;
      this.eventBus.emit('config.reloaded', { fields: ['all'] });
      logger.info('配置已热重载');
    } catch (err) {
      logger.warn({ err }, '配置重载失败，保持当前配置');
    }
  }
}
