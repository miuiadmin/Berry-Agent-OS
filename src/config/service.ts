/**
 * ConfigService 实现
 *
 * 瘦编排器：委托给纯函数（resolver、writer、diagnostics）。
 * 不再持有 schema registry —— schema 是静态组合。
 */

import { getLogger } from '../observability/logger.js';
import { getConfigPath, getAppHome as getAppHomePath } from '../utils/paths.js';
import type { IConfigService, ConfigChangeEvent, ConfigChangeListener, SectionChangeListener, ValidationDiagnostics } from './contract.js';
import type { AppConfig } from './schema.js';
import { CONFIG_KEYS } from './schema.js';
import { resolveConfig, readYamlFile, applyEnvOverrides } from './resolver.js';
import { atomicWriteYaml, deepMerge } from './writer.js';
import { ConfigFileWatcher } from './watcher.js';
import { diagnoseConfig } from './diagnostics.js';
import { AppConfigSchema } from './schema.js';

const logger = getLogger('config-service');

export class ConfigService implements IConfigService {
  private current: AppConfig;
  private globalListeners = new Set<ConfigChangeListener>();
  private sectionListeners = new Map<keyof AppConfig, Set<SectionChangeListener<any>>>();
  private watcher: ConfigFileWatcher | null = null;
  private disposed = false;

  constructor(
    private configPath: string = getConfigPath(),
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    this.current = resolveConfig(this.configPath, this.env);
  }

  // ─── IConfigService ──────────────────────────────────────────

  get(): AppConfig {
    return this.current;
  }

  getSection<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.current[key];
  }

  updateSection(partial: Partial<AppConfig>): { ok: boolean; error?: string } {
    const filtered = this.filterKnownKeys(partial as Record<string, unknown>);
    if (Object.keys(filtered).length === 0) {
      return { ok: false, error: 'No valid config keys provided' };
    }

    const currentRaw = readYamlFile(this.configPath);
    const merged = deepMerge(currentRaw, filtered);

    // 校验：合并 env overrides 后验证
    const withEnv = applyEnvOverrides(merged, this.env);
    const result = AppConfigSchema.safeParse(withEnv);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ok: false, error: `Validation failed: ${issues}` };
    }

    // 原子写入
    try {
      atomicWriteYaml(this.configPath, merged);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  reload(): void {
    if (this.disposed) return;
    try {
      const previous = this.current;
      this.current = resolveConfig(this.configPath, this.env);
      const changedKeys = this.diffKeys(previous, this.current);
      this.notify({ changedKeys, config: this.current });
      logger.info({ changedKeys }, '配置已重载');
    } catch (err) {
      logger.warn({ err }, '配置重载失败，保持当前配置');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatcher();
    this.globalListeners.clear();
    this.sectionListeners.clear();
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.globalListeners.add(listener);
    return () => { this.globalListeners.delete(listener); };
  }

  onSectionChange<K extends keyof AppConfig>(key: K, listener: SectionChangeListener<K>): () => void {
    let set = this.sectionListeners.get(key);
    if (!set) {
      set = new Set();
      this.sectionListeners.set(key, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getAppHome(): string {
    return getAppHomePath();
  }

  diagnostics(): ValidationDiagnostics {
    const report = diagnoseConfig(this.configPath, this.env);
    return {
      valid: report.valid,
      issues: report.issues.map(i => ({ path: i.path, message: i.message })),
    };
  }

  // ─── File Watcher ────────────────────────────────────────────

  /** 启动文件监听（由 CoreService 调用） */
  startWatcher(): void {
    if (this.watcher) return;
    this.watcher = new ConfigFileWatcher(this.configPath, () => this.reload());
    this.watcher.start();
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private filterKnownKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (CONFIG_KEYS.has(key)) {
        result[key] = obj[key];
      }
    }
    return result;
  }

  private diffKeys(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const changed: string[] = [];
    for (const key of allKeys) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
        changed.push(key);
      }
    }
    return changed;
  }

  private notify(event: ConfigChangeEvent): void {
    // 全局监听器
    for (const listener of this.globalListeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err }, 'ConfigChangeListener error');
      }
    }
    // Section 级监听器
    for (const key of event.changedKeys) {
      const set = this.sectionListeners.get(key as keyof AppConfig);
      if (set) {
        for (const listener of set) {
          try {
            listener(event.config[key as keyof AppConfig], event.config);
          } catch (err) {
            logger.warn({ err }, 'SectionChangeListener error');
          }
        }
      }
    }
  }
}
