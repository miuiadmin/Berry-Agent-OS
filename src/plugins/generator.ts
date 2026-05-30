import type { Database } from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getPluginsDir } from '../utils/paths.js';
import { genId } from '../utils/id.js';
import { sanitizeName } from '../skills/registry.js';
import { validatePluginDir } from './validator.js';
import { asRecord, safeParse } from './utils.js';
import type {
  PluginDraftInput,
  PluginDryRunResult,
  PluginFixtureTestResult,
  PluginInspection,
  PluginManifest,
  PluginValidationResult,
} from './types.js';

export class PluginRegistry {
  constructor(private readonly db: Database, private readonly rootDir = getPluginsDir()) {}

  createDraft(input: PluginDraftInput): { manifest: PluginManifest; validation: PluginValidationResult } {
    const name = sanitizeName(input.name);
    const pluginDir = join(this.rootDir, name);
    mkdirSync(join(pluginDir, 'tests'), { recursive: true });

    const manifestPath = join(pluginDir, 'plugin.json');
    const entryPath = join(pluginDir, 'entry.ts');
    const fixturePath = join(pluginDir, 'tests', 'basic.fixture.json');
    const toolName = `${name.replace(/-/g, '_')}_run`;

    const manifestJson = {
      apiVersion: 'berry.plugin.v1',
      name,
      version: '0.1.0',
      description: input.description,
      source: 'generated',
      riskLevel: input.riskLevel,
      capabilities: { generated: true },
      permissions: { scopes: ['plugin.generated.readonly'] },
      tools: [
        {
          name: toolName,
          title: `${name} 执行`,
          description: input.description,
          permissionScope: 'plugin.generated.readonly',
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string', description: '传给插件的文本输入' },
            },
            required: ['input'],
          },
          outputSchema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
        },
      ],
      evidence: input.evidence,
    };

    writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n', 'utf-8');
    writeFileSync(entryPath, renderEntry(name, toolName), 'utf-8');
    writeFileSync(fixturePath, JSON.stringify({
      name: `${name}-basic`,
      tool: toolName,
      input: { input: 'ping' },
      expect: { ok: true },
    }, null, 2) + '\n', 'utf-8');

    const validation = validatePluginDir(pluginDir);
    const manifest = this.upsertDraft({
      id: existingPluginId(this.db, name) ?? genId('plg'),
      name,
      version: '0.1.0',
      description: input.description,
      pluginDir,
      manifestPath,
      entryPath,
      apiVersion: 'berry.plugin.v1',
      source: 'generated',
      status: validation.ok ? 'pending_review' : 'failed',
      riskLevel: input.riskLevel,
      capabilities: manifestJson.capabilities,
      permissions: manifestJson.permissions,
    }, validation);

    return { manifest, validation };
  }

  inspect(name: string): PluginInspection {
    const manifest = this.get(name);
    if (!manifest) throw new Error(`插件不存在: ${name}`);
    const validation = validatePluginDir(manifest.pluginDir);
    const tools = this.db.prepare(`
      SELECT tool_name, title, description, input_schema, output_schema, permission_scope, enabled
      FROM plugin_tools WHERE plugin_id = ? ORDER BY tool_name
    `).all(manifest.id) as Record<string, unknown>[];
    const recentEvents = this.db.prepare(`
      SELECT event_type, payload, created_at
      FROM plugin_events WHERE plugin_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(manifest.id) as Record<string, unknown>[];

    return {
      manifest,
      manifestFile: readJsonFile(manifest.manifestPath),
      validation,
      tools: tools.map((row) => ({
        name: row.tool_name as string,
        title: row.title as string,
        description: row.description as string,
        inputSchema: safeParse(row.input_schema as string),
        outputSchema: row.output_schema ? safeParse(row.output_schema as string) : undefined,
        permissionScope: row.permission_scope as string,
        enabled: row.enabled === 1,
      })),
      recentEvents: recentEvents.map((row) => ({
        eventType: row.event_type as string,
        payload: safeParse(row.payload as string),
        createdAt: row.created_at as number,
      })),
    };
  }

  dryRun(name: string, toolName: string, input: Record<string, unknown>): PluginDryRunResult {
    const manifest = this.get(name);
    if (!manifest) throw new Error(`插件不存在: ${name}`);
    const validation = this.validate(name);
    if (!validation.ok) {
      return { ok: false, plugin: name, tool: toolName, input, error: validation.errors.join('; '), mode: 'fixture-runtime' };
    }
    const tool = validation.tools.find((item) => item.name === toolName);
    if (!tool) {
      return { ok: false, plugin: name, tool: toolName, input, error: `工具不存在: ${toolName}`, mode: 'fixture-runtime' };
    }

    const missing = validateRequiredInput(tool.inputSchema, input);
    if (missing.length > 0) {
      return {
        ok: false,
        plugin: name,
        tool: toolName,
        input,
        error: `输入缺少必填字段: ${missing.join(', ')}`,
        permissionScope: tool.permissionScope,
        mode: 'fixture-runtime',
      };
    }

    const output = runGeneratedReadonlyTool(input);
    this.recordEvent(manifest.id, 'dry_run', { toolName, ok: true });
    return {
      ok: true,
      plugin: name,
      tool: toolName,
      input,
      output,
      permissionScope: tool.permissionScope,
      mode: 'fixture-runtime',
    };
  }

  runFixtures(name: string): PluginFixtureTestResult {
    const manifest = this.get(name);
    if (!manifest) throw new Error(`插件不存在: ${name}`);
    const testsDir = join(manifest.pluginDir, 'tests');
    const files = existsSync(testsDir)
      ? readdirSync(testsDir).filter((file) => file.endsWith('.fixture.json')).sort()
      : [];
    const results: PluginFixtureTestResult['results'] = [];

    for (const file of files) {
      const fixture = readJsonFile(join(testsDir, file));
      const fixtureName = typeof fixture?.name === 'string' ? fixture.name : file;
      const tool = typeof fixture?.tool === 'string' ? fixture.tool : '';
      const input = asRecord(fixture?.input);
      const expected = asRecord(fixture?.expect);
      const dryRun = this.dryRun(name, tool, input);
      const ok = dryRun.ok && objectMatches(dryRun.output ?? {}, expected);
      results.push({
        name: fixtureName,
        ok,
        tool,
        error: ok ? undefined : dryRun.error ?? '输出不符合 fixture 期望',
        output: dryRun.output,
      });
    }

    const passed = results.filter((item) => item.ok).length;
    const result = {
      ok: results.length > 0 && passed === results.length,
      plugin: name,
      total: results.length,
      passed,
      failed: results.length - passed,
      results,
    };
    this.recordEvent(manifest.id, result.ok ? 'fixtures_passed' : 'fixtures_failed', result);
    return result;
  }

  validate(name: string): PluginValidationResult {
    const manifest = this.get(name);
    if (!manifest) throw new Error(`插件不存在: ${name}`);
    const validation = validatePluginDir(manifest.pluginDir);
    this.syncTools(manifest.id, validation);
    this.setStatus(name, validation.ok ? 'pending_review' : 'failed', validation.ok ? undefined : '插件验证失败');
    this.recordEvent(manifest.id, validation.ok ? 'validated' : 'validation_failed', { ...validation });
    return validation;
  }

  setStatus(name: string, status: PluginManifest['status'], reason?: string): PluginManifest {
    const plugin = this.get(name);
    if (!plugin) throw new Error(`插件不存在: ${name}`);
    this.db.prepare(`
      UPDATE plugins_meta
      SET status = ?, quarantine_reason = ?, updated_at = ?
      WHERE name = ?
    `).run(status, reason ?? null, Date.now(), name);
    const updated = this.get(name)!;
    this.recordEvent(updated.id, `status_${status}`, { reason: reason ?? null });
    return updated;
  }

  enable(name: string): PluginManifest {
    return this.setStatus(name, 'enabled');
  }

  disable(name: string, reason?: string): PluginManifest {
    return this.setStatus(name, 'disabled', reason);
  }

  quarantine(name: string, reason: string): PluginManifest {
    return this.setStatus(name, 'quarantined', reason);
  }

  rollback(name: string, reason?: string): PluginManifest {
    return this.setStatus(name, 'rolled_back', reason ?? '已回滚');
  }

  list(): PluginManifest[] {
    const rows = this.db.prepare(`SELECT * FROM plugins_meta ORDER BY name`).all() as Record<string, unknown>[];
    return rows.map(rowToPlugin);
  }

  get(name: string): PluginManifest | undefined {
    const row = this.db.prepare(`SELECT * FROM plugins_meta WHERE name = ?`).get(name) as Record<string, unknown> | undefined;
    return row ? rowToPlugin(row) : undefined;
  }

  reload(): PluginManifest[] {
    if (!existsSync(this.rootDir)) return [];
    const loaded: PluginManifest[] = [];
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(this.rootDir, entry.name);
      const manifestFile = readJsonFile(join(pluginDir, 'plugin.json'));
      if (!manifestFile) continue;
      const validation = validatePluginDir(pluginDir);
      const name = sanitizeName(String(manifestFile.name ?? entry.name));
      loaded.push(this.upsertDraft({
        id: existingPluginId(this.db, name) ?? genId('plg'),
        name,
        version: String(manifestFile.version ?? '0.1.0'),
        description: String(manifestFile.description ?? name),
        pluginDir,
        manifestPath: join(pluginDir, 'plugin.json'),
        entryPath: join(pluginDir, 'entry.ts'),
        apiVersion: String(manifestFile.apiVersion ?? 'berry.plugin.v1'),
        source: parsePluginSource(manifestFile.source),
        status: validation.ok ? 'pending_review' : 'failed',
        riskLevel: parseRiskLevel(manifestFile.riskLevel),
        capabilities: asRecord(manifestFile.capabilities),
        permissions: asRecord(manifestFile.permissions),
      }, validation));
    }
    return loaded;
  }

  delete(name: string, opts: { removeFiles?: boolean } = {}): PluginManifest {
    const plugin = this.get(name);
    if (!plugin) throw new Error(`插件不存在: ${name}`);
    this.db.prepare(`DELETE FROM plugin_tools WHERE plugin_id = ?`).run(plugin.id);
    this.db.prepare(`DELETE FROM plugin_events WHERE plugin_id = ?`).run(plugin.id);
    this.db.prepare(`DELETE FROM plugins_meta WHERE id = ?`).run(plugin.id);
    if (opts.removeFiles) {
      rmSync(plugin.pluginDir, { recursive: true, force: true });
    }
    return plugin;
  }

  stats(): Record<string, unknown> {
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM plugins_meta`).get() as { count: number }).count;
    const byStatus = this.db.prepare(`
      SELECT status, COUNT(*) AS count, SUM(use_count) AS useCount, SUM(success_count) AS successCount, SUM(failure_count) AS failureCount
      FROM plugins_meta GROUP BY status ORDER BY status
    `).all() as Array<Record<string, unknown>>;
    const byRisk = this.db.prepare(`
      SELECT risk_level AS riskLevel, COUNT(*) AS count FROM plugins_meta GROUP BY risk_level ORDER BY risk_level
    `).all() as Array<Record<string, unknown>>;
    const toolCount = (this.db.prepare(`SELECT COUNT(*) AS count FROM plugin_tools`).get() as { count: number }).count;
    return { total, toolCount, byStatus, byRisk };
  }

  private upsertDraft(plugin: PluginManifest, validation: PluginValidationResult): PluginManifest {
    const now = Date.now();
    const manifestHash = hashFile(plugin.manifestPath);
    const codeHash = hashFile(plugin.entryPath);
    this.db.prepare(`
      INSERT INTO plugins_meta (
        id, name, version, description, plugin_dir, manifest_path, entry_path,
        api_version, source, status, risk_level, capabilities_json, permissions_json,
        manifest_hash, code_hash, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        description = excluded.description,
        plugin_dir = excluded.plugin_dir,
        manifest_path = excluded.manifest_path,
        entry_path = excluded.entry_path,
        api_version = excluded.api_version,
        source = excluded.source,
        status = excluded.status,
        risk_level = excluded.risk_level,
        capabilities_json = excluded.capabilities_json,
        permissions_json = excluded.permissions_json,
        manifest_hash = excluded.manifest_hash,
        code_hash = excluded.code_hash,
        updated_at = excluded.updated_at
    `).run(
      plugin.id,
      plugin.name,
      plugin.version,
      plugin.description,
      plugin.pluginDir,
      plugin.manifestPath,
      plugin.entryPath,
      plugin.apiVersion,
      plugin.source,
      plugin.status,
      plugin.riskLevel,
      JSON.stringify(plugin.capabilities),
      JSON.stringify(plugin.permissions),
      manifestHash,
      codeHash,
      now,
      now,
    );
    const saved = this.get(plugin.name)!;
    this.recordEvent(saved.id, validation.ok ? 'validated' : 'validation_failed', { ...validation });
    this.syncTools(saved.id, validation);
    return saved;
  }

  private syncTools(pluginId: string, validation: PluginValidationResult): void {
    this.db.prepare(`DELETE FROM plugin_tools WHERE plugin_id = ?`).run(pluginId);
    const stmt = this.db.prepare(`
      INSERT INTO plugin_tools (
        id, plugin_id, tool_name, title, description, input_schema,
        output_schema, permission_scope, enabled, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    const now = Date.now();
    for (const tool of validation.tools) {
      stmt.run(
        genId('pt'),
        pluginId,
        tool.name,
        tool.title,
        tool.description,
        JSON.stringify(tool.inputSchema),
        tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
        tool.permissionScope,
        now,
      );
    }
  }

  recordEvent(pluginId: string, eventType: string, payload: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO plugin_events (id, plugin_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(genId('pe'), pluginId, eventType, JSON.stringify(payload), Date.now());
  }
}

function renderEntry(name: string, toolName: string): string {
  return `// Plugin: ${name}
// default export 必须是 { name, tools } 格式的 PluginDefinition

export default {
  name: '${name}',
  tools: {
    '${toolName}': async (input: { input: string }) => {
      return { ok: true, message: input.input };
    },
  },
};
`;
}

function existingPluginId(db: Database, name: string): string | undefined {
  const row = db.prepare(`SELECT id FROM plugins_meta WHERE name = ?`).get(name) as { id: string } | undefined;
  return row?.id;
}

function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rowToPlugin(row: Record<string, unknown>): PluginManifest {
  return {
    id: row.id as string,
    name: row.name as string,
    version: row.version as string,
    description: row.description as string,
    pluginDir: row.plugin_dir as string,
    manifestPath: row.manifest_path as string,
    entryPath: row.entry_path as string,
    apiVersion: row.api_version as string,
    source: row.source as PluginManifest['source'],
    status: row.status as PluginManifest['status'],
    riskLevel: row.risk_level as PluginManifest['riskLevel'],
    capabilities: safeParse(row.capabilities_json as string),
    permissions: safeParse(row.permissions_json as string),
  };
}


function parsePluginSource(value: unknown): PluginManifest['source'] {
  return value === 'bundled' || value === 'generated' || value === 'user' || value === 'installed'
    ? value
    : 'user';
}

function parseRiskLevel(value: unknown): PluginManifest['riskLevel'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}


function validateRequiredInput(schema: Record<string, unknown>, input: Record<string, unknown>): string[] {
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
  return required.filter((key) => !(key in input));
}

function runGeneratedReadonlyTool(input: Record<string, unknown>): Record<string, unknown> {
  const value = typeof input.input === 'string' ? input.input : JSON.stringify(input);
  return { ok: true, message: value };
}

function objectMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) return false;
  }
  return true;
}
