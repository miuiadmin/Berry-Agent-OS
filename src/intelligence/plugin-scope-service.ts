import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type { IPluginScopeService, PluginDiscoveryResult, PluginScopeRecord } from './contracts.js';

export class PluginScopeService implements IPluginScopeService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      getPlugin: this.db.prepare(`SELECT * FROM plugins_meta WHERE id = ?`),
      updateScope: this.db.prepare(`UPDATE plugins_meta SET scope = ?, updated_at = ? WHERE id = ?`),

      getPrivatePlugins: this.db.prepare(`
        SELECT id, name, scope, status, has_prompt, has_tools, has_code, has_hooks, has_service
        FROM plugins_meta WHERE scope = 'private' AND owner_agent_id = ? AND status != 'quarantined'
      `),
      getWorkspacePlugins: this.db.prepare(`
        SELECT id, name, scope, status, has_prompt, has_tools, has_code, has_hooks, has_service
        FROM plugins_meta WHERE scope = 'workspace' AND workspace_id = ? AND status != 'quarantined'
      `),
      getGlobalPlugins: this.db.prepare(`
        SELECT id, name, scope, status, has_prompt, has_tools, has_code, has_hooks, has_service
        FROM plugins_meta WHERE scope = 'global' AND status != 'quarantined'
      `),

      getBinding: this.db.prepare(`SELECT * FROM agent_plugin_bindings WHERE agent_id = ? AND plugin_id = ?`),
      insertBinding: this.db.prepare(`
        INSERT OR IGNORE INTO agent_plugin_bindings (id, agent_id, plugin_id, source, enabled, assigned_by, created_at)
        VALUES (?, ?, ?, 'shared', 1, ?, ?)
      `),
      deleteBinding: this.db.prepare(`DELETE FROM agent_plugin_bindings WHERE agent_id = ? AND plugin_id = ?`),
      getBindings: this.db.prepare(`SELECT agent_id, enabled, pinned FROM agent_plugin_bindings WHERE plugin_id = ?`),
      toggleBinding: this.db.prepare(`UPDATE agent_plugin_bindings SET enabled = ? WHERE plugin_id = ? AND agent_id = ?`),
      getAgentBindings: this.db.prepare(`SELECT plugin_id, enabled FROM agent_plugin_bindings WHERE agent_id = ?`),
    };
  }

  promote(pluginId: string, targetScope: 'workspace' | 'global'): void {
    const plugin = this.stmts.getPlugin.get(pluginId) as Record<string, unknown> | undefined;
    if (!plugin) throw new Error(`Plugin ${pluginId} not found`);

    const currentScope = plugin.scope as string;
    if (targetScope === 'workspace' && currentScope !== 'private') {
      throw new Error(`Can only promote to workspace from private (current: ${currentScope})`);
    }
    if (targetScope === 'global' && currentScope !== 'workspace') {
      throw new Error(`Can only promote to global from workspace (current: ${currentScope})`);
    }

    this.stmts.updateScope.run(targetScope, Date.now(), pluginId);
  }

  demote(pluginId: string, targetScope: 'private' | 'workspace'): void {
    const plugin = this.stmts.getPlugin.get(pluginId) as Record<string, unknown> | undefined;
    if (!plugin) throw new Error(`Plugin ${pluginId} not found`);

    const currentScope = plugin.scope as string;
    if (targetScope === 'workspace' && currentScope !== 'global') {
      throw new Error(`Can only demote to workspace from global (current: ${currentScope})`);
    }
    if (targetScope === 'private' && currentScope !== 'workspace') {
      throw new Error(`Can only demote to private from workspace (current: ${currentScope})`);
    }

    this.stmts.updateScope.run(targetScope, Date.now(), pluginId);
  }

  shareWithAgent(pluginId: string, agentId: string, assignedBy: string): void {
    this.stmts.insertBinding.run(genId(), agentId, pluginId, assignedBy, Date.now());
  }

  unshareFromAgent(pluginId: string, agentId: string): void {
    this.stmts.deleteBinding.run(agentId, pluginId);
  }

  discover(agentId: string, workspaceId: string): PluginDiscoveryResult {
    const privatePlugins = this.stmts.getPrivatePlugins.all(agentId) as PluginScopeRecord[];
    const workspacePlugins = this.stmts.getWorkspacePlugins.all(workspaceId) as PluginScopeRecord[];
    const globalPlugins = this.stmts.getGlobalPlugins.all() as PluginScopeRecord[];

    const agentBindings = this.stmts.getAgentBindings.all(agentId) as Array<{ plugin_id: string; enabled: number }>;
    const bindingMap = new Map(agentBindings.map(b => [b.plugin_id, b.enabled]));

    const annotate = (plugins: PluginScopeRecord[]): PluginScopeRecord[] =>
      plugins.map(p => ({
        ...p,
        binding_status: bindingMap.has(p.id) ? (bindingMap.get(p.id) ? 'enabled' : 'disabled') : 'unbound',
      }));

    return {
      private: annotate(privatePlugins),
      workspace: annotate(workspacePlugins),
      global: annotate(globalPlugins),
    };
  }

  getBindings(pluginId: string): Array<{ agent_id: string; enabled: number; pinned: number }> {
    return this.stmts.getBindings.all(pluginId) as Array<{ agent_id: string; enabled: number; pinned: number }>;
  }

  toggleBinding(pluginId: string, agentId: string, enabled: boolean): void {
    this.stmts.toggleBinding.run(enabled ? 1 : 0, pluginId, agentId);
  }
}
