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
import { parseSkillMd } from './skill-md.js';
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
        const provMatches = [...raw.matchAll(/^ {4}- (.+)$/gm)].map((m) => m[1]);
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
    expect(raw).toContain('    - "mem-001"'); // id 字符串化转义 + 对象形嵌套（遗漏大扫 20260903 skills D3-3）
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

  it('create：盘上名不符文件对注册表隐身 → 拒不覆写（遗漏大扫 20260903 skills D3-1 修死）', async () => {
    // frontmatter name 与目录名不符 → 以 frontmatter 名入册 → 按目录名 get() 查不到
    mkdirSync(join(env.projectDir, 'broken'), { recursive: true });
    writeFileSync(
      join(env.projectDir, 'broken', 'SKILL.md'),
      '---\nname: other-name\ndescription: "用户的珍贵正文技能"\n---\n用户的珍贵正文',
      'utf-8',
    );
    env.skills.refresh();
    const res = await env.tool.execute(
      { action: 'create', name: 'broken', description: '新技能', content: '新内容' },
      {} as never,
    );
    expect(res.isError).toBe(true);
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toContain('不覆写');
    // 用户原文件完好无损（修前：静默覆写毁文件且回执成功）
    expect(readFileSync(join(env.projectDir, 'broken', 'SKILL.md'), 'utf-8')).toContain('用户的珍贵正文');
    expect(env.changeRef.get()).toBe(0); // 拒路径零刷新
  });

  it('patch：find 同现 frontmatter 与正文 → 只改正文位、name 原样（遗漏大扫 20260903 skills D3-2a 修死）', async () => {
    await env.tool.execute(
      { action: 'create', name: 'guide', description: '指引', content: '步骤见 guide 附录' },
      {} as never,
    );
    const res = await env.tool.execute({ action: 'patch', name: 'guide', find: 'guide', replace: '手册' }, {} as never);
    expect(res.isError).toBeUndefined();
    const raw = readFileSync(join(env.projectDir, 'guide', 'SKILL.md'), 'utf-8');
    // 正文位已换（修前：raw.replace 命中更靠前的 frontmatter 位 → name 被改孤儿化）
    expect(raw).toContain('步骤见 手册 附录');
    expect(raw).toContain('name: guide');
    expect(raw).not.toContain('name: 手册');
  });

  it('patch：CRLF 正文多行 find 命中 + 回写归一 LF（遗漏大扫 20260903 skills D3-2a 修死）', async () => {
    // 手写盘上文件：frontmatter LF + 正文 CRLF（Windows 编辑器混排形态——解析侧
    // splitFrontmatter 已归一、旧 patch 的 raw 未归一 → 多行 find 永远误诊零匹配）
    mkdirSync(join(env.projectDir, 'crlf-doc'), { recursive: true });
    writeFileSync(
      join(env.projectDir, 'crlf-doc', 'SKILL.md'),
      '---\nname: crlf-doc\ndescription: "CRLF 文档"\n---\n正文甲\r\n第二行收尾\r\n',
      'utf-8',
    );
    env.skills.refresh();
    const res = await env.tool.execute(
      { action: 'patch', name: 'crlf-doc', find: '正文甲\n第二行收尾', replace: '正文乙\n第二行改写' },
      {} as never,
    );
    expect(res.isError).toBeUndefined();
    const raw = readFileSync(join(env.projectDir, 'crlf-doc', 'SKILL.md'), 'utf-8');
    expect(raw).toContain('正文乙\n第二行改写');
    expect(raw).not.toContain('\r\n'); // 归一回写 = 本工具写面统一 LF（create 同款）
    expect(raw).toContain('name: crlf-doc');
  });

  it('patch：replace 含 $ 家族字面写出不展开（遗漏大扫 20260903 skills D3-2b 修死）', async () => {
    await env.tool.execute(
      { action: 'create', name: 'dsign', description: '符号', content: '标记 OLD 区' },
      {} as never,
    );
    const res = await env.tool.execute(
      { action: 'patch', name: 'dsign', find: 'OLD', replace: '$`' }, // $` = JS 替换模式「匹配前全串」
      {} as never,
    );
    expect(res.isError).toBeUndefined();
    const raw = readFileSync(join(env.projectDir, 'dsign', 'SKILL.md'), 'utf-8');
    // 字面 $` 写出（修前：$` 展开把 frontmatter+正文前缀整段复制进替换点——体积内容双爆炸）
    expect(raw).toContain('标记 $` 区');
    expect((raw.match(/name: dsign/g) ?? []).length).toBe(1); // 前缀未被复制
  });

  it('create：provenance id 含换行/引号 → 字符串化转义后真解析器可装载（遗漏大扫 20260903 skills D3-3 修死）', async () => {
    const evil = 'm1\n  description: "broken';
    const res = await env.tool.execute(
      { action: 'create', name: 'prov-lift', description: '晋升', content: '正文', provenance: [evil] },
      {} as never,
    );
    expect(res.isError).toBeUndefined();
    // 落盘文件过真解析器（修前：id 原样拼接注入换行级字段断 YAML——回执成功但装载即弃）
    const raw = readFileSync(join(env.projectDir, 'prov-lift', 'SKILL.md'), 'utf-8');
    const parsed = parseSkillMd(raw, join(env.projectDir, 'prov-lift', 'SKILL.md'), 'project');
    expect(parsed.skill).not.toBeNull();
    expect(parsed.skill?.provenance?.memories[0]).toBe(evil); // id 完整往返
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
