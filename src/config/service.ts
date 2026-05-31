/**
 * ConfigService 实现
 *
 * 统一配置管理：加载、校验、热重载、读写 API。
 * 组合 schema-registry + env-resolver + watcher。
 */

import { existsSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getConfigPath, getAppHome as getAppHomePath } from '../utils/paths.js';
import { getLogger } from '../observability/logger.js';
import type { IConfigService, ConfigChangeEvent, ConfigChangeListener } from './contract.js';
import type { AppConfig } from './types.js';
import { createDefaultRegistry, type ConfigSchemaRegistry } from './schema-registry.js';
import { resolveEnvOverrides } from './env-resolver.js';

const logger = getLogger('config-service');

export class ConfigService implements IConfigService {
  private current: AppConfig;
  private schema: ReturnType<ConfigSchemaRegistry['buildSchema']>;
  private allowedKeys: Set<string>;
  private listeners = new Set<ConfigChangeListener>();
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private registry: ConfigSchemaRegistry = createDefaultRegistry(),
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    this.schema = registry.buildSchema();
    this.allowedKeys = registry.getKnownKeys();
    this.current = this.loadAndParse();
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

    const configPath = getConfigPath();
    const currentRaw = this.readRaw(configPath);
    const merged = deepMerge(currentRaw, filtered);

    // Validate before writing
    const mergedWithEnv = resolveEnvOverrides(merged, this.env);
    const result = this.schema.safeParse(mergedWithEnv);
    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { ok: false, error: `Validation failed: ${issues}` };
    }

    // Write
    try {
      writeFileSync(configPath, stringifyYaml(merged, { lineWidth: 120 }), 'utf-8');
      // Reload will be triggered by the file watcher
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  reload(): void {
    if (this.disposed) return;
    try {
      const previous = this.current;
      this.current = this.loadAndParse();
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
    this.listeners.clear();
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getConfigPath(): string {
    return getConfigPath();
  }

  getAppHome(): string {
    return getAppHomePath();
  }

  // ─── File Watcher ────────────────────────────────────────────

  /** 启动文件监听（由 CoreService 调用） */
  startWatcher(): void {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return;
    if (this.watcher) return;

    this.watcher = watch(configPath, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.reload(), 1000);
    });
    logger.info('已启动配置文件监视');
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────

  private loadAndParse(): AppConfig {
    const configPath = getConfigPath();
    let fileData: Record<string, unknown> = {};

    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        fileData = parseYaml(raw) ?? {};
      } catch (err) {
        logger.error({ err, configPath }, '配置文件解析失败，使用默认值');
        fileData = {};
      }
    }

    const merged = resolveEnvOverrides(fileData, this.env);
    return this.schema.parse(merged) as AppConfig;
  }

  private readRaw(configPath: string): Record<string, unknown> {
    if (!existsSync(configPath)) return {};
    try {
      const raw = readFileSync(configPath, 'utf-8');
      return (parseYaml(raw) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  private filterKnownKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (this.allowedKeys.has(key)) {
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err }, 'ConfigChangeListener error');
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (isObject(srcVal) && isObject(tgtVal)) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
