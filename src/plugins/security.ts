import type { Database } from 'better-sqlite3';
import type { PluginStorage } from './sdk.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('plugin-security');

export interface PluginPermissionScope {
  allowedTools: string[];
  maxStorageBytes: number;
  networkAllowed: boolean;
  allowedHosts?: string[];
}

const DEFAULT_SCOPE: PluginPermissionScope = {
  allowedTools: [],
  maxStorageBytes: 10 * 1024 * 1024, // 10MB
  networkAllowed: false,
};

export function createPermissionScope(manifest?: {
  permissions?: Partial<PluginPermissionScope>;
}): PluginPermissionScope {
  return { ...DEFAULT_SCOPE, ...(manifest?.permissions ?? {}) };
}

export class QuotaEnforcedStorage implements PluginStorage {
  constructor(
    private inner: PluginStorage,
    private db: Database,
    private pluginName: string,
    private maxBytes: number,
  ) {}

  async get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    const currentSize = this.getCurrentSize();
    const existingValue = await this.inner.get(key);
    const existingSize = existingValue ? Buffer.byteLength(existingValue, 'utf8') : 0;
    const newSize = Buffer.byteLength(value, 'utf8');
    const projectedSize = currentSize - existingSize + newSize;

    if (projectedSize > this.maxBytes) {
      throw new PluginQuotaExceededError(
        this.pluginName,
        projectedSize,
        this.maxBytes,
      );
    }

    return this.inner.set(key, value);
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    return this.inner.list(prefix);
  }

  getCurrentSize(): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(LENGTH(value)), 0) as total_bytes FROM plugin_storage WHERE plugin_name = ?`,
    ).get(this.pluginName) as { total_bytes: number };
    return row.total_bytes;
  }

  getQuotaUsage(): { usedBytes: number; maxBytes: number; usedPercent: number } {
    const used = this.getCurrentSize();
    return {
      usedBytes: used,
      maxBytes: this.maxBytes,
      usedPercent: this.maxBytes > 0 ? used / this.maxBytes : 0,
    };
  }
}

export class PluginQuotaExceededError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly requested: number,
    public readonly limit: number,
  ) {
    super(`Plugin "${pluginName}" storage quota exceeded: ${requested} bytes > ${limit} bytes limit`);
    this.name = 'PluginQuotaExceededError';
  }
}

export function filterToolsByScope(
  requestedTools: string[],
  scope: PluginPermissionScope,
): { allowed: string[]; denied: string[] } {
  if (scope.allowedTools.length === 0) {
    return { allowed: requestedTools, denied: [] };
  }

  const allowed: string[] = [];
  const denied: string[] = [];

  for (const tool of requestedTools) {
    if (scope.allowedTools.includes(tool)) {
      allowed.push(tool);
    } else {
      denied.push(tool);
    }
  }

  return { allowed, denied };
}

export function validateNetworkAccess(url: string, scope: PluginPermissionScope): boolean {
  if (!scope.networkAllowed) return false;
  if (!scope.allowedHosts || scope.allowedHosts.length === 0) return true;

  try {
    const parsed = new URL(url);
    return scope.allowedHosts.some(host =>
      parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

export interface PluginDependency {
  name: string;
  dependsOn: string[];
}

export function resolveDependencyOrder(plugins: PluginDependency[]): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byName = new Map(plugins.map(p => [p.name, p]));

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular plugin dependency detected: ${name}`);
    }

    visiting.add(name);
    const plugin = byName.get(name);
    if (plugin) {
      for (const dep of plugin.dependsOn) {
        visit(dep);
      }
    }
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  }

  for (const p of plugins) {
    visit(p.name);
  }

  return result;
}
