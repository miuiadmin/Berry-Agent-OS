import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, closeDb } from '../memory/db.js';
import { SkillsRegistry, sanitizeName, validateSkillMarkdown } from './registry.js';
import type { SkillDraftInput } from './types.js';

let tempDir: string;
let db: Database.Database;
let registry: SkillsRegistry;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-skills-'));
  const dbPath = join(tempDir, 'test.db');
  db = initDb(dbPath);
  registry = new SkillsRegistry(db, join(tempDir, 'skills'));
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const VALID_SKILL_CONTENT = `---
name: test-skill
description: 一个测试技能
version: 0.1.0
origin: user
---

# test-skill

## 触发条件

- 用户请求与测试相关的操作时使用。

## 执行规则

- 按照标准测试流程执行操作。
- 输出简洁可审计的结果。
`;

describe('sanitizeName', () => {
  it('转换为 kebab-case', () => {
    expect(sanitizeName('Hello World')).toBe('hello-world');
  });

  it('保留中文字符', () => {
    expect(sanitizeName('测试技能')).toBe('测试技能');
  });

  it('去除首尾连字符', () => {
    expect(sanitizeName('--test--')).toBe('test');
  });

  it('截断超长名称', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeName(long).length).toBeLessThanOrEqual(64);
  });

  it('空字符串返回默认值', () => {
    expect(sanitizeName('---')).toBe('generated-skill');
  });
});

describe('validateSkillMarkdown', () => {
  it('合法内容通过验证', () => {
    const result = validateSkillMarkdown(VALID_SKILL_CONTENT);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('缺少 front matter 报错', () => {
    const result = validateSkillMarkdown('# No front matter\n\n## 触发条件\n\n- x\n\n## 执行规则\n\n- y\n\nname: x\ndescription: y\n' + 'x'.repeat(50));
    expect(result.ok).toBe(false);
  });

  it('缺少 name 字段报错', () => {
    const content = VALID_SKILL_CONTENT.replace('name: test-skill', '');
    const result = validateSkillMarkdown(content);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('缺少 description 字段报错', () => {
    const content = VALID_SKILL_CONTENT.replace('description: 一个测试技能', '');
    const result = validateSkillMarkdown(content);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('description'))).toBe(true);
  });

  it('缺少触发条件章节报错', () => {
    const content = VALID_SKILL_CONTENT.replace('## 触发条件', '## 其他');
    const result = validateSkillMarkdown(content);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('触发条件'))).toBe(true);
  });

  it('缺少执行规则章节报错', () => {
    const content = VALID_SKILL_CONTENT.replace('## 执行规则', '## 其他');
    const result = validateSkillMarkdown(content);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('执行规则'))).toBe(true);
  });

  it('内容过短时生成警告', () => {
    const short = '---\nname: x\ndescription: y\n---\n## 触发条件\n- a\n## 执行规则\n- b';
    const result = validateSkillMarkdown(short);
    expect(result.warnings.some(w => w.includes('较短'))).toBe(true);
  });
});

describe('SkillsRegistry', () => {
  describe('createUserSkill', () => {
    it('创建用户技能并写入文件', () => {
      const skill = registry.createUserSkill({
        name: 'my-skill',
        description: '我的技能',
        content: VALID_SKILL_CONTENT,
      });

      expect(skill.name).toBe('my-skill');
      expect(skill.description).toBe('我的技能');
      expect(skill.origin).toBe('user');
      expect(skill.disabled).toBe(false);
      expect(existsSync(skill.filePath)).toBe(true);
    });

    it('无 content 时使用自动生成模板', () => {
      const skill = registry.createUserSkill({
        name: 'auto-gen',
        description: '自动生成的技能',
      });

      expect(skill.name).toBe('auto-gen');
      const content = readFileSync(skill.filePath, 'utf-8');
      expect(content).toContain('## 触发条件');
      expect(content).toContain('## 执行规则');
    });

    it('验证失败抛出异常', () => {
      expect(() => registry.createUserSkill({
        name: 'bad',
        description: '坏技能',
        content: 'invalid content without sections',
      })).toThrow('技能验证失败');
    });

    it('同名技能 upsert 更新而非重复', () => {
      registry.createUserSkill({ name: 'dup', description: '第一版', content: VALID_SKILL_CONTENT });
      const updated = registry.createUserSkill({
        name: 'dup',
        description: '第二版',
        content: VALID_SKILL_CONTENT.replace('一个测试技能', '更新后的描述'),
      });

      expect(updated.description).toBe('第二版');
      expect(registry.list()).toHaveLength(1);
    });
  });

  describe('createOrUpdateGeneratedSkill', () => {
    it('生成技能并注册', () => {
      const input: SkillDraftInput = {
        name: 'gen-skill',
        description: '生成的技能描述',
        evidence: ['用户偏好 A', '用户偏好 B'],
        source: 'conversation',
      };

      const skill = registry.createOrUpdateGeneratedSkill(input);
      expect(skill.name).toBe('gen-skill');
      expect(skill.origin).toBe('generated');
      expect(existsSync(skill.filePath)).toBe(true);

      const content = readFileSync(skill.filePath, 'utf-8');
      expect(content).toContain('用户偏好 A');
      expect(content).toContain('用户偏好 B');
      expect(content).toContain('fingerprint:');
    });
  });

  describe('list / get / load', () => {
    it('list 返回所有注册技能', () => {
      registry.createUserSkill({ name: 'a', description: 'A', content: VALID_SKILL_CONTENT });
      registry.createUserSkill({
        name: 'b', description: 'B',
        content: VALID_SKILL_CONTENT.replace('test-skill', 'b'),
      });

      const all = registry.list();
      expect(all).toHaveLength(2);
      expect(all.map(s => s.name).sort()).toEqual(['a', 'b']);
    });

    it('get 返回单个技能', () => {
      registry.createUserSkill({ name: 'x', description: 'X', content: VALID_SKILL_CONTENT });
      const skill = registry.get('x');
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('x');
    });

    it('get 不存在返回 undefined', () => {
      expect(registry.get('not-exist')).toBeUndefined();
    });

    it('load 返回文件内容', () => {
      registry.createUserSkill({ name: 'loaded', description: 'L', content: VALID_SKILL_CONTENT });
      const content = registry.load('loaded');
      expect(content).toBe(VALID_SKILL_CONTENT);
    });

    it('load 不存在时抛出异常', () => {
      expect(() => registry.load('ghost')).toThrow('技能不存在');
    });
  });

  describe('setDisabled', () => {
    it('禁用技能', () => {
      registry.createUserSkill({ name: 'dis', description: 'D', content: VALID_SKILL_CONTENT });
      const disabled = registry.setDisabled('dis', true);
      expect(disabled.disabled).toBe(true);
    });

    it('重新启用技能', () => {
      registry.createUserSkill({ name: 'en', description: 'E', content: VALID_SKILL_CONTENT });
      registry.setDisabled('en', true);
      const enabled = registry.setDisabled('en', false);
      expect(enabled.disabled).toBe(false);
    });

    it('不存在时抛出异常', () => {
      expect(() => registry.setDisabled('nope', true)).toThrow('技能不存在');
    });
  });

  describe('delete', () => {
    it('从数据库删除技能', () => {
      registry.createUserSkill({ name: 'del', description: 'D', content: VALID_SKILL_CONTENT });
      const deleted = registry.delete('del');
      expect(deleted.name).toBe('del');
      expect(registry.get('del')).toBeUndefined();
    });

    it('removeFiles 同时删除文件', () => {
      const skill = registry.createUserSkill({ name: 'rm', description: 'R', content: VALID_SKILL_CONTENT });
      expect(existsSync(skill.filePath)).toBe(true);

      registry.delete('rm', { removeFiles: true });
      expect(existsSync(skill.filePath)).toBe(false);
    });

    it('不存在时抛出异常', () => {
      expect(() => registry.delete('nope')).toThrow('技能不存在');
    });
  });

  describe('reload', () => {
    it('从磁盘发现并注册技能文件', () => {
      const skillDir = join(tempDir, 'skills', 'disk-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), VALID_SKILL_CONTENT, 'utf-8');

      const loaded = registry.reload();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('test-skill');
    });

    it('跳过无效技能文件', () => {
      const skillDir = join(tempDir, 'skills', 'bad-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'invalid', 'utf-8');

      const loaded = registry.reload();
      expect(loaded).toHaveLength(0);
    });

    it('目录不存在时返回空数组', () => {
      const emptyRegistry = new SkillsRegistry(db, join(tempDir, 'nonexistent'));
      expect(emptyRegistry.reload()).toEqual([]);
    });
  });

  describe('validateFile', () => {
    it('验证存在的合法文件', () => {
      const filePath = join(tempDir, 'valid.md');
      writeFileSync(filePath, VALID_SKILL_CONTENT, 'utf-8');
      const result = registry.validateFile(filePath);
      expect(result.ok).toBe(true);
    });

    it('文件不存在返回错误', () => {
      const result = registry.validateFile(join(tempDir, 'nope.md'));
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('不存在');
    });
  });

  describe('stats', () => {
    it('返回统计概览', () => {
      registry.createUserSkill({ name: 's1', description: 'S1', content: VALID_SKILL_CONTENT });
      registry.createUserSkill({
        name: 's2', description: 'S2',
        content: VALID_SKILL_CONTENT.replace('test-skill', 's2'),
      });
      registry.setDisabled('s2', true);

      const stats = registry.stats();
      expect(stats.total).toBe(2);
      expect(stats.enabled).toBe(1);
      expect(stats.disabled).toBe(1);
      expect(stats.byOrigin).toBeDefined();
    });
  });

  describe('loadBundled', () => {
    it('发现并注册内置技能', () => {
      const loaded = registry.loadBundled();
      expect(loaded.length).toBeGreaterThanOrEqual(2);

      const names = loaded.map(s => s.name);
      expect(names).toContain('json-formatter');
      expect(names).toContain('text-summarizer');

      for (const skill of loaded) {
        expect(skill.origin).toBe('bundled');
        expect(skill.disabled).toBe(false);
      }
    });

    it('loadBundled 注册后 list 可查', () => {
      registry.loadBundled();
      const all = registry.list();
      expect(all.some(s => s.name === 'json-formatter')).toBe(true);
    });
  });
});
