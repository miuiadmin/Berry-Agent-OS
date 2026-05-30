import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  QuotaEnforcedStorage,
  PluginQuotaExceededError,
  filterToolsByScope,
  validateNetworkAccess,
  resolveDependencyOrder,
  createPermissionScope,
} from './security.js';
import { SqlitePluginStorage } from './storage.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE plugin_storage (
      plugin_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_name, key)
    );
  `);
  return db;
}

describe('QuotaEnforcedStorage', () => {
  let db: InstanceType<typeof Database>;
  let storage: QuotaEnforcedStorage;

  beforeEach(() => {
    db = createDb();
    const inner = new SqlitePluginStorage(db, 'test-plugin');
    storage = new QuotaEnforcedStorage(inner, db, 'test-plugin', 100);
  });

  it('allows writes within quota', async () => {
    await storage.set('key1', 'hello');
    expect(await storage.get('key1')).toBe('hello');
  });

  it('throws on quota exceeded', async () => {
    const bigValue = 'x'.repeat(101);
    await expect(storage.set('big', bigValue)).rejects.toThrow(PluginQuotaExceededError);
  });

  it('accounts for existing value replacement', async () => {
    await storage.set('key', 'x'.repeat(50));
    // Replacing with same size should work
    await storage.set('key', 'y'.repeat(50));
    expect(await storage.get('key')).toBe('y'.repeat(50));
  });

  it('reports quota usage', async () => {
    await storage.set('a', 'hello'); // 5 bytes
    const usage = storage.getQuotaUsage();
    expect(usage.usedBytes).toBe(5);
    expect(usage.maxBytes).toBe(100);
    expect(usage.usedPercent).toBeCloseTo(0.05, 2);
  });
});

describe('filterToolsByScope', () => {
  it('allows all tools when scope is empty', () => {
    const scope = createPermissionScope();
    const result = filterToolsByScope(['read_file', 'shell_exec'], scope);
    expect(result.allowed).toEqual(['read_file', 'shell_exec']);
    expect(result.denied).toEqual([]);
  });

  it('filters tools by allowlist', () => {
    const scope = createPermissionScope({ permissions: { allowedTools: ['read_file'] } });
    const result = filterToolsByScope(['read_file', 'shell_exec'], scope);
    expect(result.allowed).toEqual(['read_file']);
    expect(result.denied).toEqual(['shell_exec']);
  });
});

describe('validateNetworkAccess', () => {
  it('denies when network not allowed', () => {
    const scope = createPermissionScope({ permissions: { networkAllowed: false } });
    expect(validateNetworkAccess('https://example.com', scope)).toBe(false);
  });

  it('allows any host when no restriction', () => {
    const scope = createPermissionScope({ permissions: { networkAllowed: true } });
    expect(validateNetworkAccess('https://example.com', scope)).toBe(true);
  });

  it('restricts to allowed hosts', () => {
    const scope = createPermissionScope({
      permissions: { networkAllowed: true, allowedHosts: ['api.github.com'] },
    });
    expect(validateNetworkAccess('https://api.github.com/repos', scope)).toBe(true);
    expect(validateNetworkAccess('https://evil.com/hack', scope)).toBe(false);
  });

  it('supports subdomain matching', () => {
    const scope = createPermissionScope({
      permissions: { networkAllowed: true, allowedHosts: ['github.com'] },
    });
    expect(validateNetworkAccess('https://api.github.com/repos', scope)).toBe(true);
  });
});

describe('resolveDependencyOrder', () => {
  it('returns correct topological order', () => {
    const order = resolveDependencyOrder([
      { name: 'c', dependsOn: ['a', 'b'] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'a', dependsOn: [] },
    ]);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('throws on circular dependency', () => {
    expect(() => resolveDependencyOrder([
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
    ])).toThrow('Circular');
  });

  it('handles independent plugins', () => {
    const order = resolveDependencyOrder([
      { name: 'x', dependsOn: [] },
      { name: 'y', dependsOn: [] },
    ]);
    expect(order).toHaveLength(2);
    expect(order).toContain('x');
    expect(order).toContain('y');
  });
});
