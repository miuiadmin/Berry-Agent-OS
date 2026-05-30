import type { Database } from 'better-sqlite3';
import type { PluginRecord } from '../../contracts/plugins-v2.js';
import type { DangerLevel } from '../../utils/types.js';

export interface RawToolDefinition {
  name: string;
  description: string;
  pluginName: string;
  toolName: string;
  inputSchemaJson: Record<string, unknown>;
  dangerLevel: DangerLevel;
}

export interface ToolFacetRuntime {
  execute(pluginName: string, toolName: string, input: Record<string, unknown>): Promise<{ ok: boolean; output?: unknown; error?: string }>;
}

export class ToolFacet {
  constructor(
    private readonly db: Database,
    private readonly runtime: ToolFacetRuntime,
  ) {}

  getToolDefinitions(plugins: PluginRecord[]): RawToolDefinition[] {
    const toolPlugins = plugins.filter(p => p.hasTools);
    const definitions: RawToolDefinition[] = [];
    const seen = new Set<string>();

    for (const plugin of toolPlugins) {
      const tools = this.db.prepare(
        'SELECT * FROM plugin_tools WHERE plugin_id = ?'
      ).all(plugin.id) as Record<string, unknown>[];

      for (const row of tools) {
        const toolName = row.tool_name as string;
        const qualifiedName = `${plugin.name}.${toolName}`;
        if (seen.has(qualifiedName)) continue;
        seen.add(qualifiedName);

        const permScope = (row.permission_scope as string) ?? 'readonly';
        const dangerLevel: DangerLevel = permScope === 'dangerous' ? 'dangerous'
          : permScope === 'network' ? 'moderate'
          : 'safe';

        definitions.push({
          name: qualifiedName,
          description: `[插件 ${plugin.name}] ${row.description as string}`,
          pluginName: plugin.name,
          toolName,
          inputSchemaJson: row.input_schema ? JSON.parse(row.input_schema as string) : { type: 'object', properties: {} },
          dangerLevel,
        });
      }
    }

    return definitions;
  }
}
