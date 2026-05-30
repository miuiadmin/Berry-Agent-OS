import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, closeDb } from '../memory/db.js';
import { SkillsRegistry } from '../skills/index.js';
import { createSkillTools } from './skill-tools.js';
import type { ToolDefinition } from './types.js';

let tempDir: string;
let db: Database.Database;
let tools: ToolDefinition[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-skill-tools-'));
  process.env.SERVICE_HOME = tempDir;
  const dbPath = join(tempDir, 'test.db');
  db = initDb(dbPath);
  const registry = new SkillsRegistry(db);
  registry.loadBundled();
  tools = createSkillTools(db);
});

afterEach(() => {
  closeDb();
  delete process.env.SERVICE_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

function getTool(name: string): ToolDefinition {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe('list_skills', () => {
  it('返回内置技能列表', async () => {
    const result = await getTool('list_skills').execute({});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('json-formatter');
    expect(result.content).toContain('text-summarizer');
  });

  it('不显示已禁用技能（默认）', async () => {
    db.prepare(`UPDATE skills_meta SET disabled = 1 WHERE name = 'json-formatter'`).run();
    const result = await getTool('list_skills').execute({});
    expect(result.content).not.toContain('json-formatter');
    expect(result.content).toContain('text-summarizer');
  });

  it('includeDisabled 显示全部', async () => {
    db.prepare(`UPDATE skills_meta SET disabled = 1 WHERE name = 'json-formatter'`).run();
    const result = await getTool('list_skills').execute({ includeDisabled: true });
    expect(result.content).toContain('json-formatter');
    expect(result.content).toContain('已禁用');
  });

  it('显示统计信息', async () => {
    const result = await getTool('list_skills').execute({});
    expect(result.content).toContain('来源:');
    expect(result.content).toContain('状态:');
    expect(result.content).toContain('成功率:');
  });
});

describe('get_skill', () => {
  it('返回结构化 JSON', async () => {
    const result = await getTool('get_skill').execute({ name: 'json-formatter' });
    expect(result.isError).toBeFalsy();
    const view = JSON.parse(result.content);
    expect(view.name).toBe('json-formatter');
    expect(view.content).toContain('## 触发条件');
    expect(view.content).toContain('## 执行规则');
    expect(view.stats).toBeDefined();
    expect(view.linkedFiles).toBeDefined();
    expect(view.state).toBe('active');
  });

  it('递增 view_count', async () => {
    await getTool('get_skill').execute({ name: 'json-formatter' });
    await getTool('get_skill').execute({ name: 'json-formatter' });
    const row = db.prepare(`SELECT view_count FROM skills_meta WHERE name = 'json-formatter'`).get() as { view_count: number };
    expect(row.view_count).toBe(2);
  });

  it('不存在的技能返回错误', async () => {
    const result = await getTool('get_skill').execute({ name: 'nonexistent' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('不存在');
  });
});

describe('create_skill', () => {
  it('创建用户技能', async () => {
    const result = await getTool('create_skill').execute({
      name: 'my-custom-skill',
      description: '自定义测试技能',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('技能已创建');
    expect(result.content).toContain('my-custom-skill');

    const row = db.prepare(`SELECT * FROM skills_meta WHERE name = 'my-custom-skill'`).get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.origin).toBe('user');
    expect(row.created_by).toBe('user');
  });

  it('创建带完整内容的技能', async () => {
    const content = `---
name: full-content
description: 完整内容技能
version: 1.0.0
origin: user
---

# full-content

## 触发条件

- 测试触发条件适用时使用。

## 执行规则

- 按照规则执行。
- 输出结果。
`;
    const result = await getTool('create_skill').execute({
      name: 'full-content',
      description: '完整内容技能',
      content,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('技能已创建');
  });

  it('无效内容返回错误', async () => {
    const result = await getTool('create_skill').execute({
      name: 'bad-skill',
      description: '坏技能',
      content: 'not valid',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('创建失败');
  });
});

describe('patch_skill', () => {
  it('替换技能内容', async () => {
    const createResult = await getTool('create_skill').execute({
      name: 'patchable',
      description: '可修改技能',
    });
    expect(createResult.isError).toBeFalsy();

    const result = await getTool('patch_skill').execute({
      name: 'patchable',
      find: '用户手动创建技能。',
      replace: '从对话中提取的常见模式。',
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);

    const row = db.prepare(`SELECT patch_count FROM skills_meta WHERE name = 'patchable'`).get() as { patch_count: number };
    expect(row.patch_count).toBe(1);
  });

  it('未找到匹配返回错误', async () => {
    const result = await getTool('patch_skill').execute({
      name: 'json-formatter',
      find: 'NONEXISTENT_TEXT_12345',
      replace: 'anything',
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到匹配');
  });
});

describe('report_skill_outcome', () => {
  it('记录成功', async () => {
    await getTool('report_skill_outcome').execute({ name: 'json-formatter', success: true });
    const row = db.prepare(`SELECT use_count, success_count FROM skills_meta WHERE name = 'json-formatter'`).get() as { use_count: number; success_count: number };
    expect(row.use_count).toBe(1);
    expect(row.success_count).toBe(1);
  });

  it('记录失败', async () => {
    await getTool('report_skill_outcome').execute({ name: 'json-formatter', success: false, note: '步骤不完整' });
    const row = db.prepare(`SELECT use_count, failure_count FROM skills_meta WHERE name = 'json-formatter'`).get() as { use_count: number; failure_count: number };
    expect(row.use_count).toBe(1);
    expect(row.failure_count).toBe(1);
  });
});

describe('disable_skill', () => {
  it('禁用技能', async () => {
    const result = await getTool('disable_skill').execute({ name: 'json-formatter', disabled: true });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('已禁用');

    const row = db.prepare(`SELECT disabled FROM skills_meta WHERE name = 'json-formatter'`).get() as { disabled: number };
    expect(row.disabled).toBe(1);
  });
});

describe('delete_skill', () => {
  it('删除技能记录', async () => {
    await getTool('create_skill').execute({ name: 'deletable', description: '将被删除' });
    const result = await getTool('delete_skill').execute({ name: 'deletable' });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);

    const row = db.prepare(`SELECT * FROM skills_meta WHERE name = 'deletable'`).get();
    expect(row).toBeUndefined();
  });
});
