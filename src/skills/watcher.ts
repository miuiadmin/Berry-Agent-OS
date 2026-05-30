import { watch, existsSync, type FSWatcher } from 'node:fs';
import { platform } from 'node:os';
import type { ISkillLoader } from './contract.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('skill-watcher');
const DEBOUNCE_MS = 500;

export interface SkillWatcherCallbacks {
  onRefresh?: () => void;
}

export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private loader: ISkillLoader,
    private callbacks?: SkillWatcherCallbacks,
  ) {}

  watch(skillsDir: string): void {
    if (this.watcher) return;
    if (!existsSync(skillsDir)) return;

    if (platform() === 'linux') {
      const [major] = process.versions.node.split('.').map(Number);
      if (major < 20) {
        logger.warn('Linux 上 recursive fs.watch 需要 Node >= 20，嵌套 SKILL.md 变更可能无法检测');
      }
    }

    try {
      this.watcher = watch(skillsDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith('.md')) return;
        this.debounce();
      });
      logger.info({ dir: skillsDir }, '已启动技能目录监视');
    } catch (err) {
      logger.warn({ err, dir: skillsDir }, '无法监视技能目录');
    }
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private debounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.loader.refresh();
      this.callbacks?.onRefresh?.();
      logger.debug('技能文件变更已刷新');
    }, DEBOUNCE_MS);
  }
}
