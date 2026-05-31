/**
 * 配置文件监视器
 *
 * 从 ConfigService 抽取的可独立测试的文件监视器。
 * 使用依赖注入：onChange 回调由调用者提供。
 */

import { watch, existsSync, type FSWatcher } from 'node:fs';
import { getLogger } from '../observability/logger.js';

const logger = getLogger('config-watcher');

export interface ConfigWatcherOptions {
  /** 防抖间隔（毫秒），默认 1000 */
  debounceMs?: number;
}

export class ConfigFileWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private filePath: string,
    private onChange: () => void,
    opts: ConfigWatcherOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 1000;
  }

  start(): void {
    if (!existsSync(this.filePath)) return;
    if (this.watcher) return;

    this.watcher = watch(this.filePath, () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.onChange();
      }, this.debounceMs);
    });
    logger.info('已启动配置文件监视');
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
