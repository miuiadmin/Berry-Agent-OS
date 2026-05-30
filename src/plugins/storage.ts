import type { Database } from 'better-sqlite3';
import type { PluginStorage } from './sdk.js';

export class SqlitePluginStorage implements PluginStorage {
  constructor(
    private readonly db: Database,
    private readonly pluginName: string,
  ) {}

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare(
      `SELECT value FROM plugin_storage WHERE plugin_name = ? AND key = ?`,
    ).get(this.pluginName, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO plugin_storage (plugin_name, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(plugin_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(this.pluginName, key, value, Date.now());
  }

  async delete(key: string): Promise<void> {
    this.db.prepare(
      `DELETE FROM plugin_storage WHERE plugin_name = ? AND key = ?`,
    ).run(this.pluginName, key);
  }

  async list(prefix?: string): Promise<string[]> {
    if (prefix) {
      const rows = this.db.prepare(
        `SELECT key FROM plugin_storage WHERE plugin_name = ? AND key LIKE ? ORDER BY key`,
      ).all(this.pluginName, `${prefix}%`) as Array<{ key: string }>;
      return rows.map(r => r.key);
    }
    const rows = this.db.prepare(
      `SELECT key FROM plugin_storage WHERE plugin_name = ? ORDER BY key`,
    ).all(this.pluginName) as Array<{ key: string }>;
    return rows.map(r => r.key);
  }
}
