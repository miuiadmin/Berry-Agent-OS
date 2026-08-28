/**
 * L5 app — 声明式子代理解析/发现/合并单测（尾刀三：agents/*.md）。
 *
 * 纯逻辑层：parseAgentMd 收形与诊断语义、defaultAgentLocations 四处镜像、
 * discoverAgentMds 扫描序/first-wins、mergeRequestForAgentMd 收窄三腿
 * （persona 固定 / toolFilter 交集 / model 覆盖）。装配级证据在
 * subagent-app.test.ts（静态工具 + 全栈委派）。
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAgentLocations, discoverAgentMds, mergeRequestForAgentMd, parseAgentMd } from './agents-md.js';

/** 临时目录（realpath 归一——macOS /var → /private/var 同款坑） */
function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/* ---------------- parseAgentMd ---------------- */

describe('parseAgentMd（frontmatter 收形 + 诊断语义）', () => {
  it('完整 frontmatter：name/description/tools/model/正文各就各位', () => {
    const content = [
      '---',
      'name: reviewer',
      'description: 资深代码审读员',
      'tools:',
      '  - read',
      '  - grep',
      "model: 'test/model'",
      '---',
      '你是资深审读员，逐行审查。',
      '',
    ].join('\n');
    const { definition, diagnostics } = parseAgentMd(content, '/x/reviewer.md');
    expect(diagnostics).toEqual([]);
    expect(definition).toEqual({
      name: 'reviewer',
      description: '资深代码审读员',
      tools: ['read', 'grep'],
      model: 'test/model',
      systemPrompt: '你是资深审读员，逐行审查。',
      filePath: '/x/reviewer.md',
    });
  });

  it('name 缺省回落文件基名；提供但与基名不符 → 诊断（以 frontmatter 为准）', () => {
    const content = ['---', 'description: 描述', '---', '正文'].join('\n');
    const fallback = parseAgentMd(content, '/x/reviewer.md');
    expect(fallback.definition?.name).toBe('reviewer');
    expect(fallback.diagnostics).toEqual([]);

    const mismatch = parseAgentMd(
      ['---', 'name: other', 'description: 描述', '---', '正文'].join('\n'),
      '/x/reviewer.md',
    );
    expect(mismatch.definition?.name).toBe('other'); // frontmatter 为准
    expect(mismatch.diagnostics).toHaveLength(1);
    expect(mismatch.diagnostics[0]!.message).toContain('不同名');
  });

  it('description 必填唯一硬门槛：缺失/非字符串/空白 → null + 诊断', () => {
    for (const front of ['---\n---\n正文', '---\ndescription: 42\n---\n正文', '---\ndescription: "  "\n---\n正文']) {
      const { definition, diagnostics } = parseAgentMd(front, '/x/a.md');
      expect(definition).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toContain('description 必填');
    }
  });

  it('正文为空 → null + 诊断（正文即系统提示）', () => {
    const { definition, diagnostics } = parseAgentMd(['---', 'description: 描述', '---', '   '].join('\n'), '/x/a.md');
    expect(definition).toBeNull();
    expect(diagnostics[0]!.message).toContain('正文为空');
  });

  it('frontmatter YAML 坏 → null + 诊断', () => {
    const { definition, diagnostics } = parseAgentMd(
      ['---', 'description: [unbalanced', '---', '正文'].join('\n'),
      '/x/a.md',
    );
    expect(definition).toBeNull();
    expect(diagnostics[0]!.message).toContain('YAML 解析失败');
  });

  it('无 frontmatter 整文为正文：缺 description 即拒（宽容拆分 + 硬门槛兜底）', () => {
    const { definition, diagnostics } = parseAgentMd('只是正文没有元数据', '/x/a.md');
    expect(definition).toBeNull();
    expect(diagnostics[0]!.message).toContain('description 必填');
  });

  it('tools 非字符串数组 / model 非字符串 → 字段忽略 + 诊断（不拒整个文件）', () => {
    const { definition, diagnostics } = parseAgentMd(
      ['---', 'description: 描述', 'tools: read', 'model: 42', '---', '正文'].join('\n'),
      '/x/a.md',
    );
    expect(definition?.tools).toBeUndefined();
    expect(definition?.model).toBeUndefined();
    expect(definition?.systemPrompt).toBe('正文');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.message).join('\n')).toContain('tools 须为字符串数组');
    expect(diagnostics.map((d) => d.message).join('\n')).toContain('model 须为字符串');
  });
});

/* ---------------- defaultAgentLocations ---------------- */

describe('defaultAgentLocations（四处镜像——trusted 门 + homeDir 缝）', () => {
  it('trusted：project 层在场（.agents/agents）；非 trusted：仅用户层三处', () => {
    const trusted = defaultAgentLocations('/ws', { homeDir: '/home', trusted: true });
    expect(trusted).toEqual([
      { dir: '/ws/.agents/agents', source: 'project' },
      { dir: '/home/.berry/agents', source: 'user' },
      { dir: '/home/.agents/agents', source: 'user' },
      { dir: '/home/.claude/agents', source: 'user' },
    ]);
    const untrusted = defaultAgentLocations('/ws', { homeDir: '/home' });
    expect(untrusted.every((loc) => loc.source === 'user')).toBe(true);
    expect(untrusted).toHaveLength(3);
  });
});

/* ---------------- discoverAgentMds ---------------- */

describe('discoverAgentMds（扫描 + first-wins）', () => {
  it('目录缺失 = 常态静默（空结果零诊断）；只读一层 .md 文件', () => {
    const root = makeTempDir('agents-md-');
    const { definitions, diagnostics } = discoverAgentMds([
      { dir: join(root, 'missing'), source: 'user' },
      { dir: root, source: 'user' },
    ]);
    expect(definitions).toEqual([]);
    expect(diagnostics).toEqual([]);
    // 子目录不递归：根下只有目录与 .txt 时无产物
    mkdirSync(join(root, 'subdir'));
    writeFileSync(join(root, 'note.txt'), 'x');
    expect(discoverAgentMds([{ dir: root, source: 'user' }]).definitions).toEqual([]);
  });

  it('两文件齐发现；同名 first-wins（locations 序在前的压后面）+ 诊断', () => {
    const dirA = makeTempDir('agents-md-a-');
    const dirB = makeTempDir('agents-md-b-');
    writeFileSync(join(dirA, 'reviewer.md'), '---\ndescription: A 版\n---\nA 正文');
    writeFileSync(join(dirB, 'reviewer.md'), '---\ndescription: B 版\n---\nB 正文');
    writeFileSync(join(dirB, 'writer.md'), '---\ndescription: 写手\n---\n写手正文');
    const { definitions, diagnostics } = discoverAgentMds([
      { dir: dirA, source: 'project' },
      { dir: dirB, source: 'user' },
    ]);
    expect(definitions.map((d) => [d.name, d.description])).toEqual([
      ['reviewer', 'A 版'], // first-wins
      ['writer', '写手'],
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('first-wins');
  });

  it('编码不可判定（GBK 无标签）= 跳过该文件 + 诊断（P1-3 缺口④ prompt 面读者）', () => {
    const dir = makeTempDir('agents-md-gbk-');
    // '测试' 的 GBK 字节——非 win32 本地标签恒空 → ④lossy：跳过不入册
    writeFileSync(join(dir, 'broken.md'), Buffer.from([0xb2, 0xe2, 0xca, 0xd4]));
    writeFileSync(join(dir, 'fine.md'), '---\ndescription: 可读\n---\n正文');
    const { definitions, diagnostics } = discoverAgentMds([{ dir, source: 'user' }]);
    expect(definitions.map((d) => d.name)).toEqual(['fine']); // 坏件跳过、好件照常
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('编码无法判定');
    expect(diagnostics[0]!.message).toContain('broken.md');
  });
});

/* ---------------- mergeRequestForAgentMd ---------------- */

describe('mergeRequestForAgentMd（合并只收窄不改宽——三腿）', () => {
  const def = {
    name: 'reviewer',
    description: '描述',
    tools: ['read', 'grep'],
    model: 'test/model',
    systemPrompt: '审读员人格',
    filePath: '/x/reviewer.md',
  } as const;

  it('persona 恒为文件正文（请求 persona 被覆盖）；model 恒为文件覆盖', () => {
    const merged = mergeRequestForAgentMd(def)({ prompt: '任务', persona: '请求人格' });
    expect(merged.persona).toBe('审读员人格');
    expect(merged.model).toBe('test/model');
  });

  it('请求未带 toolFilter → 用文件 tools；带了 → 交集（两侧白名单同时执法）', () => {
    const noFilter = mergeRequestForAgentMd(def)({ prompt: '任务' });
    expect(noFilter.toolFilter).toEqual(['read', 'grep']);
    const narrowed = mergeRequestForAgentMd(def)({ prompt: '任务', toolFilter: ['read', 'ls'] });
    expect(narrowed.toolFilter).toEqual(['read']);
  });

  it('文件无 tools/model → 请求字段原样透传（缺省不添腿）', () => {
    const bare = { ...def, tools: undefined, model: undefined };
    const merged = mergeRequestForAgentMd(bare)({ prompt: '任务', toolFilter: ['read'] });
    expect(merged.toolFilter).toEqual(['read']);
    expect(merged.model).toBeUndefined();
  });
});
