/**
 * L5 app — 项目指令文件四层发现测试（尾刀四：instructions 段）。
 *
 * 单测：四层缺省序/项目层双名 first-wins/截断护栏/缺失静默 + 组合根全栈一件
 * （段物化进系统提示词 + 来源标注行在场 + environment 段序在前）。
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultInstructionLocations, discoverInstructions, renderInstructions } from './instructions.js';
import { createBerryRuntime } from './assembly.js';
import type { BerryRuntime } from './assembly.js';

/** 临时目录（realpath 归一） */
function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/* ---------------- 单测 ---------------- */

describe('instructions 四层发现（骨架篇 §7.3）', () => {
  it('缺省四层序：Berry 用户 → agents.md 标准 → CC 兼容 → 项目层（双名候选）', () => {
    const locations = defaultInstructionLocations('/ws', { homeDir: '/home' });
    expect(locations).toEqual([
      { dir: '/home/.berry', files: ['AGENTS.md'], source: 'user' },
      { dir: '/home/.agents', files: ['AGENTS.md'], source: 'user' },
      { dir: '/home/.claude', files: ['CLAUDE.md'], source: 'user' },
      { dir: '/ws', files: ['AGENTS.md', 'CLAUDE.md'], source: 'project' },
    ]);
  });

  it('四层全缺 = 零段零诊断（无指令文件不是异常）', () => {
    const root = makeTempDir('instr-');
    const { sections, diagnostics } = discoverInstructions(
      defaultInstructionLocations(root, { homeDir: join(root, 'home') }),
    );
    expect(sections).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(renderInstructions(sections)).toBe('');
  });

  it('项目层双名 first-wins：AGENTS.md 在场即不读 CLAUDE.md（防 symlink 双读）', () => {
    const dir = makeTempDir('instr-fw-');
    writeFileSync(join(dir, 'AGENTS.md'), '标准名内容');
    writeFileSync(join(dir, 'CLAUDE.md'), '兼容名内容（不应入段）');
    const { sections } = discoverInstructions([{ dir, files: ['AGENTS.md', 'CLAUDE.md'], source: 'project' }]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.content).toBe('标准名内容');
    expect(sections[0]!.filePath).toBe(join(dir, 'AGENTS.md'));
  });

  it('项目层仅有 CLAUDE.md 时取兼容名；拼接序 = 通用在前项目殿后 + 来源标注行', () => {
    const home = makeTempDir('instr-home-');
    const ws = makeTempDir('instr-ws-');
    mkdirSync(join(home, '.berry'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.berry', 'AGENTS.md'), 'Berry 用户层');
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'CC 兼容层');
    writeFileSync(join(ws, 'CLAUDE.md'), '项目层（兼容名）');
    const { sections } = discoverInstructions(defaultInstructionLocations(ws, { homeDir: home }));
    expect(sections.map((s) => s.content)).toEqual(['Berry 用户层', 'CC 兼容层', '项目层（兼容名）']);
    // 渲染：每段带来源标注行（路径归因）；通用层排在项目层前
    const rendered = renderInstructions(sections);
    expect(rendered).toContain('# 指令来源：');
    expect(rendered.indexOf('Berry 用户层')).toBeLessThan(rendered.indexOf('项目层（兼容名）'));
  });

  it('单文件超 64KiB 截断 + 诊断 + 截断标注', () => {
    const dir = makeTempDir('instr-cap-');
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 100));
    const { sections, diagnostics } = discoverInstructions([{ dir, files: ['AGENTS.md'], source: 'user' }]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('已截断入段');
    expect(sections[0]!.content).toContain('[已截断：文件超 64KiB 上限]');
    // 截断后总长 = 上限 + 标注（内容本体不超限多少）
    expect(Buffer.byteLength(sections[0]!.content)).toBeLessThan(64 * 1024 + 200);
  });
});

/* ---------------- 组合根全栈 ---------------- */

describe('instructions 段全栈（组合根装配 → 系统提示词）', () => {
  const runtimes: BerryRuntime[] = [];
  afterEach(async () => {
    while (runtimes.length > 0) {
      const runtime = runtimes.pop()!;
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it('指令文件内容物化进系统提示词（来源标注 + 正文 + environment 段序在前）', async () => {
    const userDir = makeTempDir('instr-e2e-user-');
    const ws = makeTempDir('instr-e2e-ws-');
    mkdirSync(join(userDir, '.berry'), { recursive: true });
    writeFileSync(join(userDir, '.berry', 'AGENTS.md'), '全局纪律：提交前跑四门禁');
    writeFileSync(join(ws, 'CLAUDE.md'), '本项目纪律：注释用中文');
    const runtime = await createBerryRuntime({
      dbPath: ':memory:',
      workspace: ws,
      instructionLocations: defaultInstructionLocations(ws, { homeDir: userDir }),
    });
    runtimes.push(runtime);
    expect(runtime.systemPrompt).toContain('全局纪律：提交前跑四门禁');
    expect(runtime.systemPrompt).toContain('本项目纪律：注释用中文');
    expect(runtime.systemPrompt).toContain('# 指令来源：');
    // 宿主自留地两段按 id 字典序分节：environment < instructions（环境感知在指令前）
    expect(runtime.systemPrompt.indexOf('# 运行环境')).toBeLessThan(runtime.systemPrompt.indexOf('# 指令来源'));
  });
});
