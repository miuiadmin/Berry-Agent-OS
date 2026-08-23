/**
 * L3 skills 测试 — SKILL.md 解析与校验（frontmatter 拆分 / name 与 description
 * 校验宽容度 / disable-model-invocation / 显式激活包装），契约篇 §4.2/§4.5。
 */

import { describe, expect, it } from 'vitest';
import { formatSkillInvocation, parseSkillMd, splitFrontmatter } from './skill-md.js';

/** 一段标准合法的 SKILL.md 内容（测试基线） */
const VALID = `---\nname: pdf-tools\ndescription: 生成与合并 PDF 文档\n---\n\n# PDF 工具\n\n按步骤操作。\n`;

describe('splitFrontmatter', () => {
  it('标准 frontmatter → 拆分（body trim 保留 Markdown）', () => {
    const { frontmatter, body } = splitFrontmatter(VALID);
    expect(frontmatter.name).toBe('pdf-tools');
    expect(frontmatter.description).toBe('生成与合并 PDF 文档');
    expect(body).toBe('# PDF 工具\n\n按步骤操作。');
  });

  it('无 frontmatter → 空对象 + 全文为正文', () => {
    const { frontmatter, body } = splitFrontmatter('# 只有正文\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# 只有正文\n');
  });

  it('未闭合 frontmatter（只有开头 ---）→ 整文当正文（宽容，description 校验兜底）', () => {
    const { frontmatter, body } = splitFrontmatter('---\nname: x\n正文照旧');
    expect(frontmatter).toEqual({});
    expect(body).toBe('---\nname: x\n正文照旧');
  });

  it('CRLF 归一后拆分', () => {
    const crlf = '---\r\nname: pdf-tools\r\ndescription: 描述\r\n---\r\n\r\n正文\r\n';
    const { frontmatter, body } = splitFrontmatter(crlf);
    expect(frontmatter.name).toBe('pdf-tools');
    expect(body).toBe('正文');
  });

  it('description 含冒号等 YAML 敏感字符（引号包裹）→ 正常解析', () => {
    const content = '---\nname: pdf-tools\ndescription: "a: b: c 的说明"\n---\n\n正文\n';
    expect(splitFrontmatter(content).frontmatter.description).toBe('a: b: c 的说明');
  });
});

describe('parseSkillMd（宽容度语义）', () => {
  it('完整合法技能：字段齐 + baseDir 推导 + source 透传', () => {
    const { skill, diagnostics } = parseSkillMd(VALID, '/ws/.agents/skills/pdf-tools/SKILL.md', 'project');
    expect(diagnostics).toEqual([]);
    expect(skill).toMatchObject({
      name: 'pdf-tools',
      description: '生成与合并 PDF 文档',
      content: '# PDF 工具\n\n按步骤操作。',
      filePath: '/ws/.agents/skills/pdf-tools/SKILL.md',
      baseDir: '/ws/.agents/skills/pdf-tools',
      source: 'project',
      disableModelInvocation: false,
    });
  });

  it('name 缺省 → 回落父目录名（天然满足同名要求，零诊断）', () => {
    const content = '---\ndescription: 有描述即可\n---\n\n正文\n';
    const { skill, diagnostics } = parseSkillMd(content, '/ws/skills/pdf-tools/SKILL.md', 'user');
    expect(skill?.name).toBe('pdf-tools');
    expect(diagnostics).toEqual([]);
  });

  it('name 与父目录不同名 → invalid-metadata 警告但技能仍加载', () => {
    const content = '---\nname: other-name\ndescription: 描述\n---\n\n正文\n';
    const { skill, diagnostics } = parseSkillMd(content, '/ws/skills/pdf-tools/SKILL.md', 'user');
    expect(skill?.name).toBe('other-name');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ type: 'warning', code: 'invalid-metadata' });
    expect(diagnostics[0]!.message).toContain('不同名');
  });

  it('name 非法形态各自出警告（超长 / 大写 / 首尾连字符 / 连连续字符）', () => {
    const mk = (name: string) => `---\nname: ${name}\ndescription: d\n---\n\nx\n`;
    const long = 'a'.repeat(65);
    expect(parseSkillMd(mk(long), `/ws/skills/${long}/SKILL.md`, 'user').diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('超长'),
    ]);
    // 大写字母：字符集不过（父目录同名前提下再叠一条）
    const upper = parseSkillMd(mk('PDF-Tools'), '/ws/skills/PDF-Tools/SKILL.md', 'user').diagnostics;
    expect(upper.map((d) => d.message)).toEqual([expect.stringContaining('非法字符')]);
    expect(parseSkillMd(mk('-lead'), '/ws/skills/-lead/SKILL.md', 'user').diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('首尾不得为连字符'),
    ]);
    expect(parseSkillMd(mk('a--b'), '/ws/skills/a--b/SKILL.md', 'user').diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('连续连字符'),
    ]);
  });

  it('description 缺失 / 空白 / 非字符串 → 整体拒绝（skill null）+ 警告', () => {
    for (const content of [
      '---\nname: pdf-tools\n---\n\n正文\n', // 缺失
      '---\nname: pdf-tools\ndescription: "   "\n---\n\n正文\n', // 纯空白
      '---\nname: pdf-tools\ndescription: 42\n---\n\n正文\n', // 非字符串
    ]) {
      const { skill, diagnostics } = parseSkillMd(content, '/ws/skills/pdf-tools/SKILL.md', 'user');
      expect(skill).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ type: 'warning', code: 'invalid-metadata' });
    }
  });

  it('description 超 1024 → 警告但技能仍加载', () => {
    const long = 'x'.repeat(1025);
    const { skill, diagnostics } = parseSkillMd(
      `---\nname: pdf-tools\ndescription: ${long}\n---\n\n正文\n`,
      '/ws/skills/pdf-tools/SKILL.md',
      'user',
    );
    expect(skill?.name).toBe('pdf-tools');
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('超长')]);
  });

  it('disable-model-invocation：true 解析为隐藏；非 true 值（字符串）忽略', () => {
    const hidden = parseSkillMd(
      '---\nname: pdf-tools\ndescription: d\ndisable-model-invocation: true\n---\n\nx\n',
      '/ws/skills/pdf-tools/SKILL.md',
      'user',
    );
    expect(hidden.skill?.disableModelInvocation).toBe(true);
    const notBool = parseSkillMd(
      '---\nname: pdf-tools\ndescription: d\ndisable-model-invocation: "true"\n---\n\nx\n',
      '/ws/skills/pdf-tools/SKILL.md',
      'user',
    );
    expect(notBool.skill?.disableModelInvocation).toBe(false);
  });

  it('未知字段容忍（metadata 扩展槽）', () => {
    const { skill, diagnostics } = parseSkillMd(
      '---\nname: pdf-tools\ndescription: d\nmetadata: { owner: dev }\nunknown-field: 1\n---\n\nx\n',
      '/ws/skills/pdf-tools/SKILL.md',
      'user',
    );
    expect(skill?.name).toBe('pdf-tools');
    expect(diagnostics).toEqual([]);
  });

  it('坏 YAML → parse-failed 诊断 + 整体拒绝', () => {
    const bad = '---\nname: [unclosed\ndescription: d\n---\n\nx\n';
    const { skill, diagnostics } = parseSkillMd(bad, '/ws/skills/pdf-tools/SKILL.md', 'user');
    expect(skill).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ type: 'warning', code: 'parse-failed' });
  });
});

describe('formatSkillInvocation（§4.5(b) 显式激活包装）', () => {
  it('全文包为具名 skill 块 + References 相对路径行', () => {
    const { skill } = parseSkillMd(VALID, '/ws/.agents/skills/pdf-tools/SKILL.md', 'project');
    const block = formatSkillInvocation(skill!);
    expect(block.startsWith('<skill name="pdf-tools" location="/ws/.agents/skills/pdf-tools/SKILL.md">\n')).toBe(true);
    expect(block).toContain('References are relative to /ws/.agents/skills/pdf-tools.');
    expect(block).toContain('# PDF 工具');
    expect(block.endsWith('</skill>')).toBe(true);
  });

  it('追加指令（/skill:name args 的 args）拼在块后', () => {
    const { skill } = parseSkillMd(VALID, '/ws/skills/pdf-tools/SKILL.md', 'user');
    const withArgs = formatSkillInvocation(skill!, '合并 a.pdf 与 b.pdf');
    expect(withArgs.endsWith('</skill>\n\n合并 a.pdf 与 b.pdf')).toBe(true);
  });
});
