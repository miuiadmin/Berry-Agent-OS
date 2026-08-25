/**
 * L3 skills 测试 — 包层 provider（技能包插件，契约篇 §1.2 第六件）：
 * 目录扫描（source=package）/ package-missing 拒绝式诊断（warning 不杀行）/
 * 优先级回归锁（provider 注册序 = 合并优先序——local-fs 装配序 ⑦ 先于插件 ⑨
 * 的机制本体，用户本地恒压过包内技能）。真文件系统 fixtures。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSkillsProvider, createPackageSkillsProvider, createSkillsService } from './index.js';

/** 本次测试的临时根目录（afterEach 清理；null = 尚未创建） */
let root: string | null = null;

/** 新建临时根目录并登记清理 */
function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'skills-pkg-'));
  return root;
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

/** 在指定目录下写一个标准技能目录（返回技能目录路径） */
function writeSkill(rootDir: string, name: string): string {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "技能 ${name}"\n---\n\n# ${name}\n`);
  return dir;
}

describe('createPackageSkillsProvider（包层 provider）', () => {
  it('目录存在：以 source=package 扫描发现技能，provider id = package:<插件名>', () => {
    const dir = makeRoot();
    writeSkill(join(dir, 'pkg-root', 'skills'), 'commit-style');

    const provider = createPackageSkillsProvider({
      pluginName: 'superpowers',
      packageRoot: join(dir, 'pkg-root'),
      dirs: ['./skills'],
    });
    // 诊断溯源：provider id 携带插件声明名
    expect(provider.id).toBe('package:superpowers');

    const { skills, diagnostics } = provider.list();
    expect(diagnostics).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(['commit-style']);
    expect(skills[0]!.source).toBe('package');
    expect(skills[0]!.filePath).toBe(join(dir, 'pkg-root', 'skills', 'commit-style', 'SKILL.md'));
  });

  it('目录缺失：package-missing warning 诊断、零技能不断流（声明了却缺失是真异常，不杀行）', () => {
    const dir = makeRoot();
    const provider = createPackageSkillsProvider({
      pluginName: 'ghost',
      packageRoot: join(dir, 'pkg-root'), // skills/ 子目录从未创建
      dirs: ['./skills'],
    });

    const { skills, diagnostics } = provider.list();
    expect(skills).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('package-missing');
    expect(diagnostics[0]!.type).toBe('warning');
    // 消息带插件名（归因）、path 是解析后的绝对路径（诊断出口可定位）
    expect(diagnostics[0]!.message).toContain('ghost');
    expect(diagnostics[0]!.path).toBe(join(dir, 'pkg-root', 'skills'));
  });

  it('多目录清单：逐目录扫描，缺失与存在并存时各自成产物', () => {
    const dir = makeRoot();
    writeSkill(join(dir, 'pkg-root', 'a'), 'commit-style');
    // b/ 缺失

    const provider = createPackageSkillsProvider({
      pluginName: 'mixed',
      packageRoot: join(dir, 'pkg-root'),
      dirs: ['./a', './b'],
    });
    const { skills, diagnostics } = provider.list();
    expect(skills.map((s) => s.name)).toEqual(['commit-style']);
    expect(diagnostics.map((d) => d.code)).toEqual(['package-missing']);
  });

  it('空清单：零技能零诊断', () => {
    const provider = createPackageSkillsProvider({ pluginName: 'x', packageRoot: '/tmp', dirs: [] });
    expect(provider.list()).toEqual({ skills: [], diagnostics: [] });
  });

  it('优先级回归锁：local-fs（先注册）压过包层同名技能——provider 注册序即合并优先序', () => {
    // 机制本体锁：装配序 ⑦（local-fs）先于 ⑨（插件技能回调），故用户本地恒压过
    // 包内技能。merge 不读 source 字段——优先级纯靠注册序，此测试钉死该序语义
    const dir = makeRoot();
    writeSkill(join(dir, 'user-home', 'skills'), 'commit-style');
    writeSkill(join(dir, 'pkg-root', 'skills'), 'commit-style');

    const service = createSkillsService();
    service.registerProvider(
      createLocalSkillsProvider({ locations: [{ dir: join(dir, 'user-home', 'skills'), source: 'user' }] }),
    );
    service.registerProvider(
      createPackageSkillsProvider({
        pluginName: 'superpowers',
        packageRoot: join(dir, 'pkg-root'),
        dirs: ['./skills'],
      }),
    );
    const { skills, diagnostics } = service.refresh();

    const winner = service.get('commit-style')!;
    expect(winner.source).toBe('user'); // 用户本地胜出
    expect(skills.filter((s) => s.name === 'commit-style')).toHaveLength(1); // 同名只留一份
    const collision = diagnostics.find((d) => d.code === 'collision');
    expect(collision).toBeTruthy();
    expect(collision!.collision!.winnerPath).toContain('user-home');
    expect(collision!.collision!.loserPath).toContain('pkg-root'); // 落选者 = 包内技能
  });
});
