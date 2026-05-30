import type { Database } from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type {
  PluginManifestV2,
  PluginRecord,
  PluginToolRecord,
  PluginHookRecord,
  AgentPluginBinding,
  PluginListFilter,
  PluginScope,
  PluginStatus,
  PluginSource,
  BindingSource,
  ResolvedPluginSet,
  IPluginRegistryV2,
} from '../contracts/plugins-v2.js';

function now(): number {
  return Date.now();
}

function rowToRecord(row: Record<string, unknown>): PluginRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    version: (row.version as number) ?? 1,
    description: (row.description as string) ?? '',
    scope: (row.scope as PluginScope) ?? 'private',
    ownerAgentId: (row.owner_agent_id as string) ?? null,
    workspaceId: (row.workspace_id as string) ?? null,
    userId: (row.user_id as string) ?? '',
    source: (row.source as PluginSource) ?? 'user',
    riskLevel: (row.risk_level as 'low' | 'medium' | 'high') ?? 'low',
    status: (row.status as PluginStatus) ?? 'draft',
    hasPrompt: Boolean(row.has_prompt),
    hasTools: Boolean(row.has_tools),
    hasCode: Boolean(row.has_code),
    hasHooks: Boolean(row.has_hooks),
    hasService: Boolean(row.has_service),
    promptContent: (row.prompt_content as string) ?? null,
    promptPriority: (row.prompt_priority as number) ?? 0.5,
    promptActivationRules: row.prompt_activation_rules ? JSON.parse(row.prompt_activation_rules as string) : null,
    manifestJson: row.manifest_json ? JSON.parse(row.manifest_json as string) : null,
    permissionsJson: row.permissions_json ? JSON.parse(row.permissions_json as string) : null,
    evolutionJson: row.evolution_json ? JSON.parse(row.evolution_json as string) : null,
    importance: (row.importance as number) ?? 0.6,
    useCount: (row.use_count as number) ?? 0,
    successCount: (row.success_count as number) ?? 0,
    failureCount: (row.failure_count as number) ?? 0,
    lastUsedAt: (row.last_used_at as number) ?? null,
    previousVersions: row.previous_versions ? JSON.parse(row.previous_versions as string) : null,
    promotedFromId: (row.promoted_from_id as string) ?? null,
    promotedAt: (row.promoted_at as number) ?? null,
    tags: row.tags ? JSON.parse(row.tags as string) : null,
    createdAt: (row.created_at as number) ?? now(),
    updatedAt: (row.updated_at as number) ?? now(),
  };
}

function rowToToolRecord(row: Record<string, unknown>): PluginToolRecord {
  return {
    id: row.id as string,
    pluginId: row.plugin_id as string,
    toolName: row.tool_name as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    inputSchema: row.input_schema ? JSON.parse(row.input_schema as string) : {},
    outputSchema: row.output_schema ? JSON.parse(row.output_schema as string) : null,
    permissionScope: (row.permission_scope as PluginToolRecord['permissionScope']) ?? 'readonly',
    createdAt: (row.created_at as number) ?? now(),
  };
}

function rowToHookRecord(row: Record<string, unknown>): PluginHookRecord {
  return {
    id: row.id as string,
    pluginId: row.plugin_id as string,
    event: row.event as PluginHookRecord['event'],
    handlerPath: row.handler_path as string,
    priority: (row.priority as number) ?? 50,
    enabled: Boolean(row.enabled),
    createdAt: (row.created_at as number) ?? now(),
  };
}

function rowToBinding(row: Record<string, unknown>): AgentPluginBinding {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    pluginId: row.plugin_id as string,
    source: (row.source as BindingSource) ?? 'self',
    enabled: Boolean(row.enabled),
    pinned: Boolean(row.pinned),
    configJson: row.config_json ? JSON.parse(row.config_json as string) : null,
    assignedBy: (row.assigned_by as string) ?? null,
    createdAt: (row.created_at as number) ?? now(),
  };
}

const VALID_TRANSITIONS: Record<PluginStatus, PluginStatus[]> = {
  draft: ['validating', 'failed'],
  validating: ['pending_review', 'pending_user_confirm', 'enabled', 'failed'],
  pending_review: ['enabled', 'failed'],
  pending_user_confirm: ['enabled', 'failed'],
  enabled: ['disabled', 'quarantined'],
  disabled: ['enabled', 'draft'],
  quarantined: ['disabled', 'rolled_back'],
  rolled_back: ['enabled', 'disabled'],
  failed: ['draft'],
};

export class PluginRegistryV2 implements IPluginRegistryV2 {
  constructor(private readonly db: Database) {}

  list(filter?: PluginListFilter): PluginRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.scope) { conditions.push('scope = ?'); params.push(filter.scope); }
    if (filter?.status) { conditions.push('status = ?'); params.push(filter.status); }
    if (filter?.source) { conditions.push('source = ?'); params.push(filter.source); }
    if (filter?.hasPrompt !== undefined) { conditions.push('has_prompt = ?'); params.push(filter.hasPrompt ? 1 : 0); }
    if (filter?.hasTools !== undefined) { conditions.push('has_tools = ?'); params.push(filter.hasTools ? 1 : 0); }
    if (filter?.hasHooks !== undefined) { conditions.push('has_hooks = ?'); params.push(filter.hasHooks ? 1 : 0); }
    if (filter?.hasService !== undefined) { conditions.push('has_service = ?'); params.push(filter.hasService ? 1 : 0); }
    if (filter?.workspaceId) { conditions.push('workspace_id = ?'); params.push(filter.workspaceId); }
    if (filter?.userId) { conditions.push('user_id = ?'); params.push(filter.userId); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM plugins_meta ${where} ORDER BY importance DESC, use_count DESC`;
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  get(id: string): PluginRecord | undefined {
    const row = this.db.prepare('SELECT * FROM plugins_meta WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByName(name: string): PluginRecord | undefined {
    const row = this.db.prepare('SELECT * FROM plugins_meta WHERE name = ? ORDER BY created_at DESC LIMIT 1').get(name) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getForAgent(agentId: string, workspaceId: string, userId: string): ResolvedPluginSet {
    const disabledIds = new Set(
      (this.db.prepare(
        `SELECT plugin_id FROM agent_plugin_bindings WHERE agent_id = ? AND enabled = 0`
      ).all(agentId) as Array<{ plugin_id: string }>).map(r => r.plugin_id)
    );

    const globalPlugins = (this.db.prepare(
      `SELECT * FROM plugins_meta WHERE scope = 'global' AND user_id = ? AND status = 'enabled'`
    ).all(userId) as Record<string, unknown>[]).map(rowToRecord).filter(p => !disabledIds.has(p.id));

    const workspacePlugins = (this.db.prepare(
      `SELECT * FROM plugins_meta WHERE scope = 'workspace' AND workspace_id = ? AND status = 'enabled'`
    ).all(workspaceId) as Record<string, unknown>[]).map(rowToRecord).filter(p => !disabledIds.has(p.id));

    const privatePluginIds = (this.db.prepare(
      `SELECT plugin_id FROM agent_plugin_bindings WHERE agent_id = ? AND enabled = 1`
    ).all(agentId) as Array<{ plugin_id: string }>).map(r => r.plugin_id);

    const privatePlugins = privatePluginIds.length > 0
      ? (this.db.prepare(
          `SELECT * FROM plugins_meta WHERE id IN (${privatePluginIds.map(() => '?').join(',')}) AND status = 'enabled'`
        ).all(...privatePluginIds) as Record<string, unknown>[]).map(rowToRecord)
      : [];

    const seen = new Set<string>();
    const all: PluginRecord[] = [];

    for (const p of privatePlugins) {
      seen.add(p.name);
      all.push(p);
    }
    for (const p of workspacePlugins) {
      if (!seen.has(p.name)) { seen.add(p.name); all.push(p); }
    }
    for (const p of globalPlugins) {
      if (!seen.has(p.name)) { seen.add(p.name); all.push(p); }
    }

    return {
      all,
      prompt: all.filter(p => p.hasPrompt),
      tools: all.filter(p => p.hasTools),
      hooks: all.filter(p => p.hasHooks),
      services: all.filter(p => p.hasService),
      code: all.filter(p => p.hasCode),
    };
  }

  create(manifest: PluginManifestV2, userId: string, workspaceId?: string): PluginRecord {
    const id = genId('plg');
    const ts = now();
    const facets = manifest.facets;

    this.db.prepare(`
      INSERT INTO plugins_meta (
        id, name, version, description, scope, source, risk_level, status,
        has_prompt, has_tools, has_code, has_hooks, has_service,
        prompt_content, prompt_priority, prompt_activation_rules,
        manifest_json, permissions_json, evolution_json,
        importance, tags, owner_agent_id, workspace_id, user_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft',
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        0.6, ?, ?, ?, ?,
        ?, ?)
    `).run(
      id, manifest.name, manifest.version, manifest.description,
      manifest.scope, manifest.source, manifest.riskLevel,
      facets.prompt ? 1 : 0,
      facets.tools?.length ? 1 : 0,
      facets.code ? 1 : 0,
      facets.hooks?.length ? 1 : 0,
      facets.service ? 1 : 0,
      facets.prompt?.content ?? null,
      facets.prompt?.priority ?? 0.5,
      facets.prompt?.activationRules ? JSON.stringify(facets.prompt.activationRules) : null,
      JSON.stringify(manifest),
      JSON.stringify(manifest.permissions),
      manifest.evolution ? JSON.stringify(manifest.evolution) : null,
      null, null, workspaceId ?? null, userId,
      ts, ts,
    );

    if (facets.tools) {
      const insertTool = this.db.prepare(`
        INSERT INTO plugin_tools (id, plugin_id, tool_name, title, description, input_schema, output_schema, permission_scope, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const tool of facets.tools) {
        insertTool.run(
          genId('ptl'), id, tool.name, tool.title, tool.description,
          JSON.stringify(tool.inputSchema),
          tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
          tool.permissionScope, ts,
        );
      }
    }

    if (facets.hooks) {
      const insertHook = this.db.prepare(`
        INSERT INTO plugin_hooks (id, plugin_id, event, handler_path, priority, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `);
      for (const hook of facets.hooks) {
        insertHook.run(genId('phk'), id, hook.event, hook.handlerPath, hook.priority, ts);
      }
    }

    return this.get(id)!;
  }

  updateStatus(id: string, status: PluginStatus): void {
    const current = this.get(id);
    if (!current) throw new Error(`Plugin not found: ${id}`);
    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed?.includes(status)) {
      throw new Error(`Invalid status transition: ${current.status} → ${status}`);
    }
    this.db.prepare('UPDATE plugins_meta SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  bind(agentId: string, pluginId: string, source: BindingSource): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_plugin_bindings (id, agent_id, plugin_id, source, enabled, pinned, created_at)
      VALUES (?, ?, ?, ?, 1, 0, ?)
    `).run(genId('apb'), agentId, pluginId, source, now());
  }

  unbind(agentId: string, pluginId: string): void {
    this.db.prepare('DELETE FROM agent_plugin_bindings WHERE agent_id = ? AND plugin_id = ?').run(agentId, pluginId);
  }

  getBindings(agentId: string): AgentPluginBinding[] {
    const rows = this.db.prepare('SELECT * FROM agent_plugin_bindings WHERE agent_id = ?').all(agentId) as Record<string, unknown>[];
    return rows.map(rowToBinding);
  }

  getTools(pluginId: string): PluginToolRecord[] {
    const rows = this.db.prepare('SELECT * FROM plugin_tools WHERE plugin_id = ?').all(pluginId) as Record<string, unknown>[];
    return rows.map(rowToToolRecord);
  }

  getHooks(pluginId: string): PluginHookRecord[] {
    const rows = this.db.prepare('SELECT * FROM plugin_hooks WHERE plugin_id = ?').all(pluginId) as Record<string, unknown>[];
    return rows.map(rowToHookRecord);
  }

  recordUsage(id: string, success: boolean): void {
    const col = success ? 'success_count' : 'failure_count';
    const importanceChange = success ? 0.05 : -0.2;
    this.db.prepare(`
      UPDATE plugins_meta SET
        use_count = use_count + 1,
        ${col} = ${col} + 1,
        importance = MAX(0, MIN(1, importance + ?)),
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(importanceChange, now(), now(), id);
  }
}
