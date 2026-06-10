/**
 * 任务模板库单元测试。
 */

import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  listTemplates,
  getTemplateMeta,
  toTaskSpecs,
  type TaskTemplate,
} from './mission-templates.js';

describe('mission-templates', () => {
  describe('listTemplates', () => {
    it('列出 4 个内置模板', () => {
      const list = listTemplates();
      expect(list).toHaveLength(4);
      const names = list.map(t => t.name);
      expect(names).toContain('code-refactor');
      expect(names).toContain('feature-dev');
      expect(names).toContain('bug-fix');
      expect(names).toContain('full-project');
    });

    it('每个模板有元信息', () => {
      const list = listTemplates();
      for (const t of list) {
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.recommendedFor).toBeTruthy();
        expect(t.taskCount).toBeGreaterThan(0);
      }
    });
  });

  describe('getTemplateMeta', () => {
    it('返回已知模板的元信息', () => {
      const meta = getTemplateMeta('bug-fix');
      expect(meta).not.toBeNull();
      expect(meta!.taskCount).toBe(3);
    });

    it('未知模板返回 null', () => {
      expect(getTemplateMeta('unknown-template')).toBeNull();
    });
  });

  describe('renderTemplate', () => {
    it('code-refactor 生成 4 个任务，串行依赖', () => {
      const tasks = renderTemplate('code-refactor', '重构 auth 模块');
      expect(tasks).toHaveLength(4);
      // 任务 0 无依赖
      expect(tasks[0].depends_on).toEqual([]);
      // 任务 1 依赖任务 0
      expect(tasks[1].depends_on).toContain(0);
      // 任务 3 依赖任务 2
      expect(tasks[3].depends_on).toContain(2);
    });

    it('feature-dev 生成 5 个任务，文档与测试并行', () => {
      const tasks = renderTemplate('feature-dev', '添加新功能');
      expect(tasks).toHaveLength(5);
      // 任务 3 (文档) 依赖任务 1 (实现)
      expect(tasks[3].depends_on).toContain(1);
      // 任务 4 (审查) 依赖任务 2 和 3
      expect(tasks[4].depends_on).toContain(2);
      expect(tasks[4].depends_on).toContain(3);
    });

    it('bug-fix 生成 3 个任务，串行依赖', () => {
      const tasks = renderTemplate('bug-fix', '修复 crash');
      expect(tasks).toHaveLength(3);
      expect(tasks[0].depends_on).toEqual([]);
      expect(tasks[1].depends_on).toContain(0);
      expect(tasks[2].depends_on).toContain(1);
    });

    it('full-project 生成 6 个任务', () => {
      const tasks = renderTemplate('full-project', '搭建电商平台');
      expect(tasks).toHaveLength(6);
    });

    it('目标 goal 嵌入任务描述', () => {
      const tasks = renderTemplate('code-refactor', '清理 utils.ts');
      expect(tasks[0].what).toContain('清理 utils.ts');
    });

    it('未知模板抛错并列出可用模板', () => {
      expect(() => renderTemplate('unknown', 'x')).toThrow(/未知模板/);
    });
  });

  describe('toTaskSpecs', () => {
    it('将 depends_on 索引转换为 t-N ID 格式', () => {
      const templates: TaskTemplate[] = [
        { what: 'T1', who: 'code', depends_on: [] },
        { what: 'T2', who: 'code', depends_on: [0] },
        { what: 'T3', who: 'code', depends_on: [0, 1] },
      ];
      const specs = toTaskSpecs(templates);
      expect(specs).toHaveLength(3);
      expect(specs[0].depends_on).toEqual([]);
      expect(specs[1].depends_on).toEqual(['t-1']);
      expect(specs[2].depends_on).toEqual(['t-1', 't-2']);
    });

    it('保留 what 和 who 字段', () => {
      const templates: TaskTemplate[] = [
        { what: '写测试', who: 'skills', depends_on: [] },
      ];
      const specs = toTaskSpecs(templates);
      expect(specs[0].what).toBe('写测试');
      expect(specs[0].who).toBe('skills');
    });
  });

  describe('end-to-end: 模板 + toTaskSpecs', () => {
    it('bug-fix 模板 → 任务规范序列', () => {
      const templates = renderTemplate('bug-fix', '修边界问题');
      const specs = toTaskSpecs(templates);
      expect(specs).toHaveLength(3);
      // 第一个任务无依赖
      expect(specs[0].depends_on).toEqual([]);
      // 第二个任务依赖第一个
      expect(specs[1].depends_on).toEqual(['t-1']);
      // 第三个任务依赖第二个
      expect(specs[2].depends_on).toEqual(['t-2']);
    });
  });
});
