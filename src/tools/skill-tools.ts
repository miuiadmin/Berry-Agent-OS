import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './types.js';
import { SkillService } from '../skills/skill-service.js';
import type { SkillView } from '../contracts/skills.js';
import { validateSkillMarkdown } from '../skills/registry.js';
import { genId } from '../utils/id.js';

interface SkillToolsOptions {
  onChange?: () => void;
  getSessionId?: () => string | undefined;
  shellInjection?: boolean;
}

const ListSkillsSchema = z.object({
  includeDisabled: z.boolean().optional().describe('是否包含已禁用的技能，默认 false'),
  origin: z.enum(['bundled', 'generated', 'user']).optional().describe('按来源过滤'),
  tag: z.string().optional().describe('按标签过滤'),
});

const GetSkillSchema = z.object({
  name: z.string().describe('要获取的技能名称'),
  arguments: z.string().optional().describe('传递给技能的参数文本（技能可通过 $ARGUMENTS 引用）'),
});

const CreateSkillSchema = z.object({
  name: z.string().describe('技能名称（kebab-case 或中文）'),
  description: z.string().describe('技能的一句话描述'),
  content: z.string().optional().describe('完整的 SKILL.md 内容（含 YAML frontmatter）。不提供则自动生成模板'),
});

const UpdateSkillSchema = z.object({
  name: z.string().describe('技能名称'),
  content: z.string().describe('完整的 SKILL.md 新内容（含 YAML frontmatter）'),
});

const PatchSkillSchema = z.object({
  name: z.string().describe('技能名称'),
  find: z.string().describe('要替换的原文本'),
  replace: z.string().describe('替换后的新文本'),
  replaceAll: z.boolean().optional().describe('是否替换所有匹配项，默认只替换第一处'),
});

const DisableSkillSchema = z.object({
  name: z.string().describe('技能名称'),
  disabled: z.boolean().describe('true 禁用，false 启用'),
});

const DeleteSkillSchema = z.object({
  name: z.string().describe('技能名称'),
  removeFiles: z.boolean().optional().describe('是否同时删除技能目录文件，默认 false'),
});

const ReportOutcomeSchema = z.object({
  name: z.string().describe('刚使用的技能名称'),
  success: z.boolean().describe('技能执行是否成功达到预期目的'),
  note: z.string().optional().describe('可选的简短说明（失败原因或改进建议）'),
});

const ImportSkillSchema = z.object({
  url: z.string().describe('SKILL.md 的 HTTP(S) URL'),
  name: z.string().optional().describe('覆盖技能名称（默认使用文件中的 name）'),
});

const ForkSkillSchema = z.object({
  name: z.string().describe('要在后台执行的技能名称'),
  arguments: z.string().optional().describe('传递给技能的参数'),
});

export function createSkillTools(db: Database, service: SkillService, options?: SkillToolsOptions): ToolDefinition[];
export function createSkillTools(db: Database, options?: SkillToolsOptions): ToolDefinition[];
export function createSkillTools(db: Database, serviceOrOptions?: SkillService | SkillToolsOptions, maybeOptions?: SkillToolsOptions): ToolDefinition[] {
  let service: SkillService;
  let options: SkillToolsOptions | undefined;

  if (serviceOrOptions && 'initialize' in serviceOrOptions) {
    service = serviceOrOptions as SkillService;
    options = maybeOptions;
  } else {
    options = serviceOrOptions as SkillToolsOptions | undefined;
    service = new SkillService({ db });
    service.initialize();
  }

  const onChange = options?.onChange;
  const getSessionId = options?.getSessionId;
  const shellInjectionEnabled = options?.shellInjection ?? false;

  function writeEpisode(eventType: string, content: string, metadata?: Record<string, unknown>): void {
    const sessionId = getSessionId?.();
    if (!sessionId) return;
    try {
      db.prepare(
        `INSERT INTO episodes (id, session_id, event_type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(genId('ep'), sessionId, eventType, content, metadata ? JSON.stringify(metadata) : null, Date.now());
    } catch { /* best-effort */ }
  }

  const listSkillsTool: ToolDefinition = {
    name: 'list_skills',
    description: '列出所有可用技能及其统计信息（来源、状态、使用次数、成功率）。可按来源和标签过滤。',
    inputSchema: ListSkillsSchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { includeDisabled, origin, tag } = input as z.infer<typeof ListSkillsSchema>;

      const skills = service.list({ includeDisabled, origin, tag });
      if (skills.length === 0) return { content: '当前没有可用技能。' };

      const dbDisabled = new Set(
        (db.prepare(`SELECT name FROM skills_meta WHERE disabled = 1`).all() as Array<{ name: string }>).map(r => r.name),
      );

      const lines = skills.map(s => {
        const fm = s.frontmatter;
        const tags = fm.tags?.length ? ` [${fm.tags.join(', ')}]` : '';
        const isDisabled = fm.disabled || dbDisabled.has(s.name);
        const disabled = isDisabled ? ' [已禁用]' : '';
        const fork = fm.context_fork ? ' [后台]' : '';
        const stats = getStatsLine(db, s.name);
        return `- **${s.name}** — ${fm.description}\n  来源: ${fm.origin} | 状态: active | 创建者: ${fm.created_by}${stats}${tags}${disabled}${fork}`;
      });
      return { content: lines.join('\n') };
    },
  };

  const getSkillTool: ToolDefinition = {
    name: 'get_skill',
    description: '获取指定技能的完整指令和元数据。返回内容、权限范围和关联文件。',
    inputSchema: GetSkillSchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, arguments: args } = input as z.infer<typeof GetSkillSchema>;
      const skill = service.get(name);
      if (!skill) return { content: `技能不存在: ${name}`, isError: true };

      try {
        const result = await service.executeContent(name, {
          arguments: args,
          sessionId: getSessionId?.(),
          shellInjection: shellInjectionEnabled,
        });
        if (!result) return { content: `技能加载失败: ${name}`, isError: true };

        writeEpisode('skill_viewed', name, { skillName: name, origin: skill.origin });

        const statsRow = db.prepare(
          `SELECT view_count, use_count, success_count, failure_count, patch_count, last_used_at FROM skills_meta WHERE name = ?`,
        ).get(name) as { view_count: number; use_count: number; success_count: number; failure_count: number; patch_count: number; last_used_at: number | null } | undefined;

        const view: SkillView & { permissionScope?: unknown; effort?: string; contextFork?: boolean } = {
          name: skill.name,
          description: skill.frontmatter.description,
          version: skill.frontmatter.version,
          origin: skill.frontmatter.origin,
          state: 'active',
          content: result.content,
          skillDir: skill.skillDir,
          linkedFiles: skill.linkedFiles,
          stats: {
            viewCount: (statsRow?.view_count ?? 0) + 1,
            useCount: statsRow?.use_count ?? 0,
            successRate: statsRow && statsRow.use_count > 0
              ? Math.round((statsRow.success_count / statsRow.use_count) * 100)
              : null,
            patchCount: statsRow?.patch_count ?? 0,
            lastUsedAt: statsRow?.last_used_at ?? null,
          },
          arguments: skill.frontmatter.arguments,
          whenToUse: skill.frontmatter.when_to_use,
          permissionScope: result.permissionScope,
          effort: result.effort,
          contextFork: result.contextFork,
          note: '此技能内容已在本次会话中加载，后续 turn 无需再次调用 get_skill。',
        };
        return { content: JSON.stringify(view, null, 2) };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };

  const createSkillTool: ToolDefinition = {
    name: 'create_skill',
    description: '创建新的用户技能（SKILL.md 文件）。需要提供名称和描述，可选提供完整内容。',
    inputSchema: CreateSkillSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, description, content } = input as z.infer<typeof CreateSkillSchema>;
      try {
        const skill = service.createUserSkill({ name, description, content });
        onChange?.();
        return { content: JSON.stringify({ ok: true, name: skill.name, filePath: skill.filePath, message: `技能已创建: ${skill.name}` }) };
      } catch (err) {
        return { content: `创建失败: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const updateSkillTool: ToolDefinition = {
    name: 'update_skill',
    description: '完整替换技能内容。验证后原子写入。',
    inputSchema: UpdateSkillSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, content } = input as z.infer<typeof UpdateSkillSchema>;
      const skill = service.get(name);
      if (!skill) return { content: `技能不存在: ${name}`, isError: true };

      const validation = validateSkillMarkdown(content);
      if (!validation.ok) {
        return { content: `验证失败: ${validation.errors.join('; ')}`, isError: true };
      }

      await writeFile(skill.filePath, content, 'utf-8');
      service.recordPatch(name);
      service.refresh();
      onChange?.();
      return { content: JSON.stringify({ ok: true, name, filePath: skill.filePath, message: '技能已更新' }) };
    },
  };

  const patchSkillTool: ToolDefinition = {
    name: 'patch_skill',
    description: '局部修改技能内容（查找并替换）。验证失败不写入。',
    inputSchema: PatchSkillSchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, find, replace, replaceAll } = input as z.infer<typeof PatchSkillSchema>;
      const skill = service.get(name);
      if (!skill) return { content: `技能不存在: ${name}`, isError: true };

      const rawContent = await readFile(skill.filePath, 'utf-8');
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (rawContent.match(new RegExp(escaped, 'g')) || []).length;
      if (count === 0) return { content: '未找到匹配内容', isError: true };

      const newContent = replaceAll
        ? rawContent.replaceAll(find, replace)
        : rawContent.replace(find, replace);

      const validation = validateSkillMarkdown(newContent);
      if (!validation.ok) {
        return { content: `修改后验证失败: ${validation.errors.join('; ')}`, isError: true };
      }

      await writeFile(skill.filePath, newContent, 'utf-8');
      service.recordPatch(name);
      service.refresh();
      onChange?.();
      return { content: JSON.stringify({ ok: true, name, filePath: skill.filePath, message: `已替换 ${replaceAll ? count : 1} 处` }) };
    },
  };

  const disableSkillTool: ToolDefinition = {
    name: 'disable_skill',
    description: '启用或禁用技能。禁用后技能不会出现在 prompt 中。',
    inputSchema: DisableSkillSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, disabled } = input as z.infer<typeof DisableSkillSchema>;
      try {
        const registry = service.getRegistry();
        const skill = registry.setDisabled(name, disabled);
        service.refresh();
        onChange?.();
        return { content: JSON.stringify({ ok: true, name: skill.name, filePath: skill.filePath, message: disabled ? '技能已禁用' : '技能已启用' }) };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };

  const deleteSkillTool: ToolDefinition = {
    name: 'delete_skill',
    description: '删除技能。可选同时删除技能文件目录。',
    inputSchema: DeleteSkillSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, removeFiles } = input as z.infer<typeof DeleteSkillSchema>;
      try {
        const registry = service.getRegistry();
        const skill = registry.delete(name, { removeFiles });
        service.refresh();
        onChange?.();
        return { content: JSON.stringify({ ok: true, name: skill.name, filePath: skill.filePath, message: removeFiles ? '技能及文件已删除' : '技能记录已删除' }) };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  };

  const reportOutcomeTool: ToolDefinition = {
    name: 'report_skill_outcome',
    description: '报告技能执行结果。必须在使用技能后调用，用于追踪成功率并触发 after_execution hook。',
    inputSchema: ReportOutcomeSchema,
    dangerLevel: 'safe',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, success, note } = input as z.infer<typeof ReportOutcomeSchema>;
      const skill = service.get(name);
      if (!skill) return { content: `技能不存在: ${name}`, isError: true };

      service.recordOutcome(name, success);
      writeEpisode('skill_executed', name, { skillName: name, success, note });
      return { content: JSON.stringify({ ok: true, name, success, message: success ? '已记录成功' : '已记录失败' }) };
    },
  };

  const importSkillTool: ToolDefinition = {
    name: 'import_skill',
    description: '从 URL 导入技能。获取远程 SKILL.md 并保存到本地技能目录。',
    inputSchema: ImportSkillSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { url } = input as z.infer<typeof ImportSkillSchema>;
      try {
        const manifest = await service.importFromUrl(url);
        onChange?.();
        return { content: JSON.stringify({ ok: true, name: manifest.name, filePath: manifest.filePath, message: `技能已导入: ${manifest.name}` }) };
      } catch (err) {
        return { content: `导入失败: ${(err as Error).message}`, isError: true };
      }
    },
  };

  const forkSkillTool: ToolDefinition = {
    name: 'fork_skill',
    description: '在后台执行技能（context:fork 模式）。适用于长时间运行的分析类技能。',
    inputSchema: ForkSkillSchema,
    dangerLevel: 'moderate',
    async execute(input: unknown): Promise<ToolResult> {
      const { name, arguments: args } = input as z.infer<typeof ForkSkillSchema>;
      const skill = service.get(name);
      if (!skill) return { content: `技能不存在: ${name}`, isError: true };

      try {
        const result = await service.executeContent(name, {
          arguments: args,
          sessionId: getSessionId?.(),
          shellInjection: shellInjectionEnabled,
        });
        if (!result) return { content: `技能加载失败: ${name}`, isError: true };

        writeEpisode('skill_forked', name, { skillName: name, args });
        return {
          content: JSON.stringify({
            ok: true,
            name,
            mode: 'forked',
            content: result.content,
            message: `技能 ${name} 已在后台模式加载，内容已返回供异步处理。`,
          }),
        };
      } catch (err) {
        return { content: `执行失败: ${(err as Error).message}`, isError: true };
      }
    },
  };

  return [
    listSkillsTool,
    getSkillTool,
    createSkillTool,
    updateSkillTool,
    patchSkillTool,
    disableSkillTool,
    deleteSkillTool,
    reportOutcomeTool,
    importSkillTool,
    forkSkillTool,
  ];
}

function getStatsLine(db: Database, name: string): string {
  const row = db.prepare(
    `SELECT use_count, view_count, success_count FROM skills_meta WHERE name = ?`,
  ).get(name) as { use_count: number; view_count: number; success_count: number } | undefined;

  if (!row) return '';
  const successRate = row.use_count > 0
    ? `${Math.round((row.success_count / row.use_count) * 100)}%`
    : '-';
  return ` | 查看: ${row.view_count}次 | 使用: ${row.use_count}次 | 成功率: ${successRate}`;
}
