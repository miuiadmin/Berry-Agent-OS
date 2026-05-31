/**
 * 配置文件监视器
 *
 * 从 ConfigService 抽取为独立模块，通过依赖注入回调实现可测试性。
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

  constructor(
    private filePath: string,
    private onChange: () => void,
    private opts: ConfigWatcherOptions = {},
  ) {}

  start(): void {
    if (!existsSync(this.filePath)) return;
    if (this.watcher) return;

    const debounceMs = this.opts.debounceMs ?? 1000;
    this.watcher = watch(this.filePath, () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.onChange();
      }, debounceMs);
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
