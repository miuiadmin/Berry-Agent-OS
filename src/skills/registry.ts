import type { Database } from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { getSkillsDir } from '../utils/paths.js';
import { genId } from '../utils/id.js';
import type { SkillCreatedBy, SkillDraftInput, SkillManifest, SkillStatsRow, SkillValidationResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SkillsRegistry {
  constructor(private readonly db: Database, private readonly rootDir = getSkillsDir()) {}

  createOrUpdateGeneratedSkill(input: SkillDraftInput): SkillManifest {
    const name = sanitizeName(input.name);
    const filePath = join(this.rootDir, name, 'SKILL.md');
    const body = renderSkill(name, input);
    const validation = validateSkillMarkdown(body);
    if (!validation.ok) {
      throw new Error(`技能验证失败: ${validation.errors.join('; ')}`);
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body, 'utf-8');
    return this.upsert({
      id: existingSkillId(this.db, name) ?? genId('sk'),
      name,
      version: '0.1.0',
      description: input.description,
      origin: 'generated',
      filePath,
      disabled: false,
      createdBy: 'agent',
      state: 'active',
      modelInvocable: true,
      descriptionHidden: false,
    });
  }

  createUserSkill(input: { name: string; description: string; content?: string }): SkillManifest {
    const name = sanitizeName(input.name);
    const filePath = join(this.rootDir, name, 'SKILL.md');
    const body = input.content ?? renderSkill(name, {
      name,
      description: input.description,
      evidence: ['用户手动创建技能。'],
      source: 'manual',
    });
    const validation = validateSkillMarkdown(body);
    if (!validation.ok) {
      throw new Error(`技能验证失败: ${validation.errors.join('; ')}`);
    }

    const fm = parseFrontmatter(body);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body, 'utf-8');
    return this.upsert({
      id: existingSkillId(this.db, name) ?? genId('sk'),
      name,
      version: fm ? getFrontmatterString(fm, 'version') ?? '0.1.0' : '0.1.0',
      description: input.description,
      origin: 'user',
      filePath,
      disabled: false,
      createdBy: 'user',
      state: 'active',
      arguments: fm ? getFrontmatterStringArray(fm, 'arguments') : undefined,
      whenToUse: fm ? getFrontmatterString(fm, 'when_to_use') ?? undefined : undefined,
      allowedTools: fm ? getFrontmatterStringArray(fm, 'allowed_tools') : undefined,
      modelInvocable: fm ? getFrontmatterBool(fm, 'model_invocable', true) : true,
      descriptionHidden: fm ? getFrontmatterBool(fm, 'description_hidden', false) : false,
    });
  }

  reload(): SkillManifest[] {
    if (!existsSync(this.rootDir)) return [];
    const loaded: SkillManifest[] = [];
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(this.rootDir, entry.name, 'SKILL.md');
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf-8');
      const validation = validateSkillMarkdown(content);
      if (!validation.ok) continue;
      const fm = parseFrontmatter(content);
      const name = sanitizeName(fm ? getFrontmatterString(fm, 'name') ?? entry.name : entry.name);
      loaded.push(this.upsert({
        id: existingSkillId(this.db, name) ?? genId('sk'),
        name,
        version: fm ? getFrontmatterString(fm, 'version') ?? '0.1.0' : '0.1.0',
        description: fm ? getFrontmatterString(fm, 'description') ?? name : name,
        origin: parseSkillOrigin(fm ? getFrontmatterString(fm, 'origin') : null),
        filePath,
        disabled: false,
        createdBy: parseCreatedBy(fm ? getFrontmatterString(fm, 'created_by') : null),
        state: 'active',
        arguments: fm ? getFrontmatterStringArray(fm, 'arguments') : undefined,
        whenToUse: fm ? getFrontmatterString(fm, 'when_to_use') ?? undefined : undefined,
        allowedTools: fm ? getFrontmatterStringArray(fm, 'allowed_tools') : undefined,
        modelInvocable: fm ? getFrontmatterBool(fm, 'model_invocable', true) : true,
        descriptionHidden: fm ? getFrontmatterBool(fm, 'description_hidden', false) : false,
      }));
    }
    return loaded;
  }

  loadBundled(): SkillManifest[] {
    const bundledDir = join(__dirname, 'bundled');
    if (!existsSync(bundledDir)) return [];
    const loaded: SkillManifest[] = [];
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = join(bundledDir, entry.name, 'SKILL.md');
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, 'utf-8');
      const validation = validateSkillMarkdown(content);
      if (!validation.ok) continue;
      const fm = parseFrontmatter(content);
      const name = sanitizeName(fm ? getFrontmatterString(fm, 'name') ?? entry.name : entry.name);
      loaded.push(this.upsert({
        id: existingSkillId(this.db, name) ?? genId('sk'),
        name,
        version: fm ? getFrontmatterString(fm, 'version') ?? '0.1.0' : '0.1.0',
        description: fm ? getFrontmatterString(fm, 'description') ?? name : name,
        origin: 'bundled',
        filePath,
        disabled: false,
        createdBy: 'system',
        state: 'active',
        arguments: fm ? getFrontmatterStringArray(fm, 'arguments') : undefined,
        whenToUse: fm ? getFrontmatterString(fm, 'when_to_use') ?? undefined : undefined,
        allowedTools: fm ? getFrontmatterStringArray(fm, 'allowed_tools') : undefined,
        modelInvocable: fm ? getFrontmatterBool(fm, 'model_invocable', true) : true,
        descriptionHidden: fm ? getFrontmatterBool(fm, 'description_hidden', false) : false,
      }));
    }
    return loaded;
  }

  list(): SkillManifest[] {
    const rows = this.db.prepare(`SELECT * FROM skills_meta ORDER BY name`).all() as Record<string, unknown>[];
    return rows.map(rowToSkill);
  }

  get(name: string): SkillManifest | undefined {
    const row = this.db.prepare(`SELECT * FROM skills_meta WHERE name = ?`).get(name) as Record<string, unknown> | undefined;
    return row ? rowToSkill(row) : undefined;
  }

  load(name: string): string {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    return readFileSync(skill.filePath, 'utf-8');
  }

  validateFile(filePath: string): SkillValidationResult {
    if (!existsSync(filePath)) {
      return { ok: false, errors: ['SKILL.md 文件不存在'], warnings: [] };
    }
    return validateSkillMarkdown(readFileSync(filePath, 'utf-8'));
  }

  setDisabled(name: string, disabled: boolean): SkillManifest {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    this.db.prepare(`
      UPDATE skills_meta SET disabled = ?, updated_at = ? WHERE name = ?
    `).run(disabled ? 1 : 0, Date.now(), name);
    return this.get(name)!;
  }

  delete(name: string, opts: { removeFiles?: boolean } = {}): SkillManifest {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    this.db.prepare(`DELETE FROM skills_meta WHERE name = ?`).run(name);
    if (opts.removeFiles) {
      rmSync(dirname(skill.filePath), { recursive: true, force: true });
    }
    return skill;
  }

  stats(): Record<string, unknown> {
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM skills_meta`).get() as { count: number }).count;
    const disabled = (this.db.prepare(`SELECT COUNT(*) AS count FROM skills_meta WHERE disabled = 1`).get() as { count: number }).count;
    const byOrigin = this.db.prepare(`
      SELECT origin, COUNT(*) AS count, SUM(use_count) AS useCount, SUM(success_count) AS successCount, SUM(failure_count) AS failureCount
      FROM skills_meta GROUP BY origin ORDER BY origin
    `).all() as Array<Record<string, unknown>>;
    return { total, enabled: total - disabled, disabled, byOrigin };
  }

  bumpView(name: string): void {
    this.db.prepare(
      `UPDATE skills_meta SET view_count = view_count + 1, last_viewed_at = ? WHERE name = ?`,
    ).run(Date.now(), name);
  }

  recordOutcome(name: string, success: boolean): void {
    const field = success ? 'success_count' : 'failure_count';
    this.db.prepare(
      `UPDATE skills_meta SET use_count = use_count + 1, ${field} = ${field} + 1, last_used_at = ? WHERE name = ?`,
    ).run(Date.now(), name);
  }

  bumpPatch(name: string): void {
    this.db.prepare(
      `UPDATE skills_meta SET patch_count = patch_count + 1, last_patched_at = ?, updated_at = ? WHERE name = ?`,
    ).run(Date.now(), Date.now(), name);
  }

  getStats(name: string): SkillStatsRow | undefined {
    return this.db.prepare(
      `SELECT use_count, view_count, success_count, failure_count, patch_count, last_used_at FROM skills_meta WHERE name = ?`,
    ).get(name) as SkillStatsRow | undefined;
  }

  private upsert(skill: SkillManifest): SkillManifest {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO skills_meta (
        id, name, version, description, file_path, origin, created_by, state, disabled,
        arguments_json, when_to_use, allowed_tools_json, model_invocable, description_hidden,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        description = excluded.description,
        file_path = excluded.file_path,
        origin = excluded.origin,
        created_by = excluded.created_by,
        arguments_json = excluded.arguments_json,
        when_to_use = excluded.when_to_use,
        allowed_tools_json = excluded.allowed_tools_json,
        model_invocable = excluded.model_invocable,
        description_hidden = excluded.description_hidden,
        updated_at = excluded.updated_at
    `).run(
      skill.id,
      skill.name,
      skill.version,
      skill.description,
      skill.filePath,
      skill.origin,
      skill.createdBy,
      skill.state,
      skill.disabled ? 1 : 0,
      skill.arguments ? JSON.stringify(skill.arguments) : null,
      skill.whenToUse ?? null,
      skill.allowedTools ? JSON.stringify(skill.allowedTools) : null,
      skill.modelInvocable ? 1 : 0,
      skill.descriptionHidden ? 1 : 0,
      now,
      now,
    );
    return this.get(skill.name)!;
  }
}

export function sanitizeName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'generated-skill';
}

export function validateSkillMarkdown(content: string): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!content.includes('---')) errors.push('缺少 YAML front matter');
  if (!/^name:\s*.+$/m.test(content)) errors.push('缺少 name 字段');
  if (!/^description:\s*.+$/m.test(content)) errors.push('缺少 description 字段');
  if (!content.includes('## 触发条件')) errors.push('缺少触发条件章节');
  if (!content.includes('## 执行规则')) errors.push('缺少执行规则章节');
  if (content.length < 120) warnings.push('技能内容较短，可能缺少足够执行细节');
  return { ok: errors.length === 0, errors, warnings };
}

function renderSkill(name: string, input: SkillDraftInput): string {
  const evidenceLines = input.evidence.map((item) => `- ${item}`).join('\n') || '- 用户明确表达了可复用偏好。';
  const hash = createHash('sha256').update(`${name}:${input.description}:${evidenceLines}`).digest('hex').slice(0, 12);
  return `---
name: ${name}
description: ${input.description.replace(/\n/g, ' ')}
version: 0.1.0
origin: generated
source: ${input.source}
fingerprint: ${hash}
---

# ${name}

## 触发条件

- 用户请求与以下长期偏好或工作方式相关时使用本技能。
- 当上下文不确定时，优先向 核心系统 查询记忆或请求用户澄清。

## 执行规则

- 优先使用中文输出，除非用户明确要求其他语言。
- 保持结果简洁、可审计，并标注必要的证据来源。
- 不执行本技能未声明的本机操作；需要工具或权限时必须走 核心系统 permission token。

## 证据

${evidenceLines}
`;
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getFrontmatterString(fm: Record<string, unknown>, key: string): string | null {
  const val = fm[key];
  return typeof val === 'string' ? val.trim() : null;
}

function getFrontmatterStringArray(fm: Record<string, unknown>, key: string): string[] | undefined {
  const val = fm[key];
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string');
  return undefined;
}

function getFrontmatterBool(fm: Record<string, unknown>, key: string, defaultVal: boolean): boolean {
  const val = fm[key];
  if (typeof val === 'boolean') return val;
  if (val === 'true') return true;
  if (val === 'false') return false;
  return defaultVal;
}

function parseSkillOrigin(value: string | null): SkillManifest['origin'] {
  return value === 'bundled' || value === 'generated' || value === 'user' ? value : 'user';
}

function parseCreatedBy(value: string | null): SkillCreatedBy {
  return value === 'system' || value === 'agent' || value === 'user' ? value : 'system';
}

function existingSkillId(db: Database, name: string): string | undefined {
  const row = db.prepare(`SELECT id FROM skills_meta WHERE name = ?`).get(name) as { id: string } | undefined;
  return row?.id;
}

function rowToSkill(row: Record<string, unknown>): SkillManifest {
  return {
    id: row.id as string,
    name: row.name as string,
    version: row.version as string,
    description: row.description as string,
    origin: row.origin as SkillManifest['origin'],
    filePath: row.file_path as string,
    disabled: row.disabled === 1,
    createdBy: parseCreatedBy(row.created_by as string | null),
    state: (row.state as SkillManifest['state']) ?? 'active',
    arguments: row.arguments_json ? JSON.parse(row.arguments_json as string) : undefined,
    whenToUse: (row.when_to_use as string) || undefined,
    allowedTools: row.allowed_tools_json ? JSON.parse(row.allowed_tools_json as string) : undefined,
    modelInvocable: row.model_invocable !== 0,
    descriptionHidden: row.description_hidden === 1,
  };
}
