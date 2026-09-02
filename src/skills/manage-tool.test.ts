/**
 * skill_manage 工具测试（契约篇 §7.1 第 3 条工具形态，2026-09-03 提示词工程
 * 与自进化批）。覆盖：list 三层标注 / create 校验与同名拒写 / patch 单点执法
 * 与层别拒改 / onChange 触发时机。文件系统用临时目录全真（不 mock fs）。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSkillManageTool } from './manage-tool.js';
import { createSkillsService } from './registry.js';
import type { SkillLocation } from './types.js';

/** 组装测试件：真实 skills 服务 + 临时目录（project 层 + user 层各一） */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'skill-manage-test-'));
  const projectDir = join(root, 'workspace', '.agents', 'skills');
  const userDir = join(root, 'home', '.berry', 'skills');
  const locations: SkillLocation[] = [
    { dir: projectDir, source: 'project' },
    { dir: userDir, source: 'user' },
  ];
  const skills = createSkillsService({});
  skills.registerProvider({
    id: 'local-fs',
    list: () => {
      // 简化 provider：直接扫两目录（discovery 全真版太重，此处测工具不测发现）
      const out: ReturnType<typeof scanOne> = [];
      for (const loc of locations) out.push(...scanOne(loc));
      return { skills: out, diagnostics: [] };
    },
  });
  let changeCount = 0;
  const tool = createSkillManageTool({
    skills,
    projectSkillsDir: projectDir,
    onChange: () => {
      changeCount += 1;
      skills.refresh();
    },
  });
  return { root, projectDir, userDir, skills, tool, changeRef: { get: () => changeCount } };
}

/** 目录扫描极简版（只喂工具测试所需字段——frontmatter 解析走真解析器更佳但此处够用） */
function scanOne(loc: SkillLocation): import('./types.js').Skill[] {
  try {
    const entries = require('node:fs').readdirSync(loc.dir, { withFileTypes: true }) as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const filePath = join(loc.dir, e.name, 'SKILL.md');
        const raw = require('node:fs').readFileSync(filePath, 'utf-8') as string;
        // frontmatter 简解（name/description/provenance——测试值可控无需容错）
        const nameMatch = raw.match(/^name: (.+)$/m);
        const descMatch = raw.match(/^description: "?(.+?)"?$/m);
        const provMatches = [...raw.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]);
        const fm = raw.split(/^---$/m)[1] ?? '';
        const content = raw.slice(fm.length + 6);
        return {
          name: nameMatch?.[1] ?? e.name,
          description: descMatch?.[1] ?? '',
          content,
          filePath,
          baseDir: join(loc.dir, e.name),
          source: loc.source,
          disableModelInvocation: false,
          provenance: provMatches.length > 0 ? { memories: provMatches } : undefined,
        } as import('./types.js').Skill;
      });
  } catch {
    return [];
  }
}

describe('skill_manage 工具', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  it('list：空库 → 提示可 create', async () => {
    const res = await env.tool.execute({ action: 'list' }, {} as never);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.type === 'text' && res.content[0].text).toContain('技能库为空');
  });

  it('create：写 project 层 SKILL.md + frontmatter 生成 + onChange 触发 + 渐进披露可见', async () => {
    const res = await env.tool.execute(
      {
        action: 'create',
        name: 'deploy-checklist',
        description: '部署前自查清单',
        content: '# 部署自查\n\n1. 跑测试\n2. 看门禁',
        provenance: ['mem-001', 'mem-002'],
      },
      {} as never,
    );
    expect(res.isError).toBeUndefined();
    // 文件落盘 + frontmatter 结构
    const filePath = join(env.projectDir, 'deploy-checklist', 'SKILL.md');
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toContain('name: deploy-checklist');
    expect(raw).toContain('description: "部署前自查清单"');
    expect(raw).toContain('provenance:');
    expect(raw).toContain('  - mem-001');
    expect(raw).toContain('# 部署自查');
    // onChange 已触发（即时刷新收口）
    expect(env.changeRef.get()).toBe(1);
    // 刷新后渐进披露清单可见新技能
    expect(env.skills.get('deploy-checklist')?.description).toBe('部署前自查清单');
  });

  it('create：同名已存在（任一层）→ 响亮拒不覆写', async () => {
    await env.tool.execute({ action: 'create', name: 'dup', description: '第一份', content: 'A' }, {} as never);
    // user 层再造一个同名（模拟跨层撞名）
    mkdirSync(join(env.userDir, 'dup'), { recursive: true });
    writeFileSync(join(env.userDir, 'dup', 'SKILL.md'), '---\nname: dup\ndescription: "用户层"\n---\nB', 'utf-8');
    env.skills.refresh();
    const res = await env.tool.execute(
      { action: 'create', name: 'dup', description: '又一份', content: 'C' },
      {} as never,
    );
    expect(res.isError).toBe(true);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('已存在');
    expect(text).toContain('不覆写');
  });

  it('create：name 非法字符 → TOOL_ARGUMENTS_INVALID', async () => {
    await expect(
      env.tool.execute({ action: 'create', name: 'Bad_Name', description: 'x', content: 'y' }, {} as never),
    ).rejects.toThrow('非法字符');
    // 路径穿越面：name 字符集已拒 `/` 与 `.`
    await expect(
      env.tool.execute({ action: 'create', name: '../escape', description: 'x', content: 'y' }, {} as never),
    ).rejects.toThrow();
  });

  it('create：description 超长 → 拒', async () => {
    await expect(
      env.tool.execute(
        { action: 'create', name: 'long-desc', description: 'x'.repeat(1025), content: 'y' },
        {} as never,
      ),
    ).rejects.toThrow('description 校验不过');
  });

  it('patch：项目层技能单点替换成功 + onChange 触发', async () => {
    await env.tool.execute(
      { action: 'create', name: 'guide', description: '指引', content: '步骤一：旧做法\n步骤二：照旧' },
      {} as never,
    );
    const before = env.changeRef.get();
    const res = await env.tool.execute(
      { action: 'patch', name: 'guide', find: '旧做法', replace: '新做法' },
      {} as never,
    );
    expect(res.isError).toBeUndefined();
    const raw = readFileSync(join(env.projectDir, 'guide', 'SKILL.md'), 'utf-8');
    expect(raw).toContain('步骤一：新做法');
    expect(raw).not.toContain('旧做法');
    // frontmatter 原样保留
    expect(raw).toContain('name: guide');
    expect(env.changeRef.get()).toBe(before + 1);
  });

  it('patch：多处命中 → 拒并要求扩大上下文', async () => {
    await env.tool.execute(
      { action: 'create', name: 'multi', description: '多匹配', content: '同词出现\n又一次同词' },
      {} as never,
    );
    const res = await env.tool.execute({ action: 'patch', name: 'multi', find: '同词', replace: 'X' }, {} as never);
    expect(res.isError).toBe(true);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('多处命中');
  });

  it('patch：user 层技能 → 拒并指路人面', async () => {
    mkdirSync(join(env.userDir, 'personal'), { recursive: true });
    writeFileSync(
      join(env.userDir, 'personal', 'SKILL.md'),
      '---\nname: personal\ndescription: "用户层技能"\n---\n正文',
      'utf-8',
    );
    env.skills.refresh();
    const res = await env.tool.execute({ action: 'patch', name: 'personal', find: '正文', replace: 'X' }, {} as never);
    expect(res.isError).toBe(true);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('用户层');
    expect(text).toContain('用户本人');
  });

  it('patch：零匹配 → 拒', async () => {
    await env.tool.execute({ action: 'create', name: 'clean', description: '干净', content: '唯一内容' }, {} as never);
    const res = await env.tool.execute({ action: 'patch', name: 'clean', find: '不存在', replace: 'X' }, {} as never);
    expect(res.isError).toBe(true);
  });

  it('list：三层来源与溯源标注', async () => {
    await env.tool.execute(
      { action: 'create', name: 'proj-skill', description: '项目层技能', content: 'A', provenance: ['m1'] },
      {} as never,
    );
    mkdirSync(join(env.userDir, 'user-skill'), { recursive: true });
    writeFileSync(
      join(env.userDir, 'user-skill', 'SKILL.md'),
      '---\nname: user-skill\ndescription: "用户层技能"\n---\nB',
      'utf-8',
    );
    env.skills.refresh();
    const res = await env.tool.execute({ action: 'list' }, {} as never);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('proj-skill [项目层]');
    expect(text).toContain('溯源 1 条记忆');
    expect(text).toContain('user-skill [用户层]');
  });
});
