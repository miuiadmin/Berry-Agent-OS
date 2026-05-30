import { watch, existsSync, readdirSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import type { AgentLifecycle } from './agent-lifecycle.js';
import type { AgentRegistry } from './agent-registry.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent-watcher');
const DEBOUNCE_MS = 500;

export class AgentWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private watchDir: string = '';

  constructor(
    private lifecycle: AgentLifecycle,
    private registry: AgentRegistry,
  ) {}

  watch(userAgentsDir: string): void {
    if (this.watcher) return;
    if (!existsSync(userAgentsDir)) return;

    this.watchDir = userAgentsDir;

    if (platform() === 'linux') {
      const [major] = process.versions.node.split('.').map(Number);
      if (major < 20) {
        logger.warn('Linux 上 recursive fs.watch 需要 Node >= 20，嵌套目录变更可能无法检测');
      }
    }

    try {
      this.watcher = watch(userAgentsDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (!filename.includes('agent.json') && !filename.endsWith('.ts')) return;

        const agentName = filename.split(/[/\\]/)[0];
        if (!agentName) return;

        this.debounce(agentName, () => this.handleChange(agentName));
      });
      logger.info({ dir: userAgentsDir }, '已启动 Agent 目录监视');
    } catch (err) {
      logger.warn({ err, dir: userAgentsDir }, '无法监视 Agent 目录');
    }
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private async handleChange(agentName: string): Promise<void> {
    const agentDir = join(this.watchDir, agentName);
    const manifestPath = join(agentDir, 'agent.json');

    if (!existsSync(agentDir)) {
      if (this.registry.has(agentName)) {
        const check = this.registry.canUnregister(agentName);
        if (check.ok) {
          try {
            await this.lifecycle.remove(agentName);
          } catch (err) {
            logger.warn({ err, name: agentName }, '自动移除智能体失败');
          }
        }
      }
      return;
    }

    if (!existsSync(manifestPath)) return;

    if (this.registry.has(agentName)) {
      try {
        await this.lifecycle.upgrade(agentName);
      } catch (err) {
        logger.warn({ err, name: agentName }, '自动升级智能体失败');
      }
    } else {
      try {
        await this.lifecycle.install(agentDir);
      } catch (err) {
        logger.warn({ err, name: agentName }, '自动安装智能体失败');
      }
    }
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, DEBOUNCE_MS));
  }
}
