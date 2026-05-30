import { readFileSync, existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { PluginManifestV2, PluginSource, PluginScope } from '../../contracts/plugins-v2.js';
import { PluginRegistryV2 } from '../registry-v2.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('skill-migration');

interface SkillRow {
  id: string;
  name: string;
  version: string;
  description: string;
  file_path: string;
  origin: 'bundled' | 'generated' | 'user';
  state: string;
  use_count: number;
  success_count: number;
  failure_count: number;
  disabled: number;
  when_to_use: string | null;
  arguments_json: string | null;
  model_invocable: number;
}

const ORIGIN_TO_SOURCE: Record<string, PluginSource> = {
  bundled: 'bundled',
  generated: 'evolved',
  user: 'user',
};

const ORIGIN_TO_SCOPE: Record<string, PluginScope> = {
  bundled: 'global',
  generated: 'private',
  user: 'private',
};

export interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: Array<{ name: string; error: string }>;
}

export function migrateSkillsToPlugins(
  db: Database,
  userId: string,
  agentId?: string,
): MigrationResult {
  const registry = new PluginRegistryV2(db);
  const skills = db.prepare(
    `SELECT * FROM skills_meta WHERE state = 'active' AND disabled = 0`
  ).all() as SkillRow[];

  const result: MigrationResult = { total: skills.length, migrated: 0, skipped: 0, errors: [] };

  for (const skill of skills) {
    try {
      const existing = registry.getByName(skill.name);
      if (existing) {
        result.skipped++;
        continue;
      }

      const promptContent = loadSkillContent(skill.file_path);
      if (!promptContent) {
        result.skipped++;
        continue;
      }

      const manifest: PluginManifestV2 = {
        apiVersion: 'berry.plugin.v2',
        name: skill.name,
        version: skill.version || '1.0.0',
        description: skill.description,
        source: ORIGIN_TO_SOURCE[skill.origin] ?? 'user',
        riskLevel: 'low',
        scope: ORIGIN_TO_SCOPE[skill.origin] ?? 'private',
        facets: {
          prompt: {
            content: promptContent,
            injection: 'system',
            priority: 0.5,
            activationRules: {
              always: !skill.when_to_use,
              taskTags: skill.when_to_use ? [skill.when_to_use] : undefined,
            },
          },
        },
        permissions: {
          storage: { maxBytes: 1024 * 1024 },
        },
      };

      const record = registry.create(manifest, userId);
      registry.updateStatus(record.id, 'validating');
      registry.updateStatus(record.id, 'enabled');

      if (agentId) {
        registry.bind(agentId, record.id, 'self');
      }

      result.migrated++;
      logger.info({ skill: skill.name, pluginId: record.id }, 'Skill migrated to plugin');
    } catch (err) {
      result.errors.push({ name: skill.name, error: (err as Error).message });
    }
  }

  logger.info(
    { total: result.total, migrated: result.migrated, skipped: result.skipped, errors: result.errors.length },
    'Skill migration complete',
  );
  return result;
}

function loadSkillContent(filePath: string): string | null {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
