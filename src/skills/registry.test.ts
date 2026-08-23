/**
 * L3 skills 测试 — 本地 FS 发现（技能根短路 / 递归 / gitignore / symlink
 * 跟随）+ 服务合并（first-wins 冲突诊断 / symlink 去重 / refresh 重扫）
 * + 渐进披露清单渲染 + 默认发现位置。真文件系统 fixtures。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalSkillsProvider,
  createSkillsService,
  defaultSkillLocations,
  renderAvailableSkills,
  scanSkillLocation,
} from './index.js';
import type { Skill, SkillDiagnostic, SkillsProvider } from './types.js';

/** 本次测试的临时根目录（afterEach 清理；null = 尚未创建） */
let root: string | null = null;

/** 新建临时根目录并登记清理 */
function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'skills-test-'));
  return root;
}

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

/** 在 root 下写一个标准技能目录（返回技能目录路径） */
function writeSkill(rootDir: string, name: string, description = `技能 ${name}`, extra = ''): string {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n${extra}---\n\n# ${name}\n`);
  return dir;
}

/** 断言型 provider（服务层测试用；可注入技能或抛异常） */
function stubProvider(id: string, skills: Skill[], diagnostics: SkillDiagnostic[] = []): SkillsProvider {
  return { id, list: () => ({ skills, diagnostics }) };
}

describe('scanSkillLocation（发现算法）', () => {
  it('技能根短路：目录含 SKILL.md 即为技能，不再递归其子目录', () => {
    const dir = makeRoot();
    writeSkill(dir, 'outer');
    writeSkill(join(dir, 'outer'), 'inner'); // outer 内嵌套技能——属 outer 资源，不独立成技能
    const { skills } = scanSkillLocation({ dir, source: 'user' });
    expect(skills.map((s) => s.name)).toEqual(['outer']);
  });

  it('递归发现：多层子目录各含技能根', () => {
    const dir = makeRoot();
    writeSkill(join(dir, 'alpha'), 'alpha');
    writeSkill(join(dir, 'nested', 'beta'), 'beta');
    const { skills } = scanSkillLocation({ dir, source: 'user' });
    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('点开头目录与 node_modules 跳过', () => {
    const dir = makeRoot();
    writeSkill(join(dir, '.hidden'), 'hidden-skill');
    writeSkill(join(dir, 'node_modules', 'pkg'), 'pkg-skill');
    const { skills } = scanSkillLocation({ dir, source: 'user' });
    expect(skills).toEqual([]);
  });

  it('目录不存在 → 空产物零诊断（缺目录是常态非异常）', () => {
    const result = scanSkillLocation({ dir: '/definitely/not/here/skills', source: 'user' });
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('扫描目标是文件而非目录 → list-failed 警告不崩', () => {
    const dir = makeRoot();
    const file = join(dir, 'plain.md');
    writeFileSync(file, 'x');
    const { skills, diagnostics } = scanSkillLocation({ dir: file, source: 'user' });
    expect(skills).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'list-failed' });
  });

  it('尊重 .gitignore：被忽略技能目录不发现', () => {
    const dir = makeRoot();
    writeFileSync(join(dir, '.gitignore'), 'ignored-skill/\n');
    writeSkill(dir, 'kept-skill');
    writeSkill(dir, 'ignored-skill');
    const { skills } = scanSkillLocation({ dir, source: 'project' });
    expect(skills.map((s) => s.name)).toEqual(['kept-skill']);
  });

  it('嵌套 .gitignore 只作用于其所在子树', () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'nest'), { recursive: true });
    writeFileSync(join(dir, 'nest', '.gitignore'), 'secret/\n');
    writeSkill(join(dir, 'nest'), 'normal-skill');
    writeSkill(join(dir, 'nest', 'secret'), 'secret-skill');
    const { skills } = scanSkillLocation({ dir, source: 'user' });
    expect(skills.map((s) => s.name)).toEqual(['normal-skill']);
  });

  it('SKILL.md 本身被 gitignore → 该目录不算技能根，继续向下递归', () => {
    const dir = makeRoot();
    // 忽略 aa/SKILL.md（文件级模式）而非整个 aa 目录
    writeFileSync(join(dir, '.gitignore'), 'aa/SKILL.md\n');
    writeSkill(dir, 'aa');
    writeSkill(join(dir, 'aa', 'bb'), 'bb'); // aa 不是技能根后 bb 应被发现
    const { skills } = scanSkillLocation({ dir, source: 'user' });
    expect(skills.map((s) => s.name)).toEqual(['bb']);
  });

  it('symlink 目录跟随（链接到的技能目录可发现）', () => {
    const dir = makeRoot();
    const real = writeSkill(join(dir, 'real-store'), 'linked-skill');
    mkdirSync(join(dir, 'entry'), { recursive: true });
    symlinkSync(real, join(dir, 'entry', 'alias'), 'dir');
    const { skills } = scanSkillLocation({ dir: join(dir, 'entry'), source: 'user' });
    expect(skills.map((s) => s.name)).toEqual(['linked-skill']);
  });
});

describe('createSkillsService（合并语义）', () => {
  it('位置顺序即优先级：project 与 user 同名 → project 胜出并记 collision', () => {
    const base = makeRoot();
    const projectDir = join(base, 'project');
    const userDir = join(base, 'user');
    writeSkill(projectDir, 'alpha', 'project 版');
    writeSkill(userDir, 'alpha', 'user 版');

    const service = createSkillsService();
    service.registerProvider(
      createLocalSkillsProvider({
        locations: [
          { dir: projectDir, source: 'project' },
          { dir: userDir, source: 'user' },
        ],
      }),
    );
    const { skills, diagnostics } = service.refresh();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'alpha', source: 'project', description: 'project 版' });
    // 落选者诊断：winner/loser 路径齐备
    const collision = diagnostics.find((d) => d.type === 'collision')!;
    expect(collision.collision).toEqual({
      name: 'alpha',
      winnerPath: join(projectDir, 'alpha', 'SKILL.md'),
      loserPath: join(userDir, 'alpha', 'SKILL.md'),
    });
  });

  it('提供方注册序即优先序：先注册者赢', () => {
    const service = createSkillsService();
    const mkSkill = (desc: string): Skill => ({
      name: 'same-name',
      description: desc,
      content: 'x',
      filePath: `/ws/${desc}/SKILL.md`,
      baseDir: `/ws/${desc}`,
      source: 'user',
      disableModelInvocation: false,
    });
    service.registerProvider(stubProvider('first', [mkSkill('first 版')]));
    service.registerProvider(stubProvider('second', [mkSkill('second 版')]));
    const { skills } = service.refresh();
    expect(skills[0]!.description).toBe('first 版');
  });

  it('symlink 去重：同一真实 SKILL.md 经两位置出现 → 只保留首个，不算冲突', () => {
    const base = makeRoot();
    const realDir = writeSkill(join(base, 'real'), 'dup-skill');
    const aliasRoot = join(base, 'alias');
    mkdirSync(aliasRoot);
    symlinkSync(realDir, join(aliasRoot, 'dup-skill'), 'dir');

    const service = createSkillsService();
    service.registerProvider(
      createLocalSkillsProvider({
        locations: [
          { dir: join(base, 'real'), source: 'user' },
          { dir: aliasRoot, source: 'user' },
        ],
      }),
    );
    const { skills, diagnostics } = service.refresh();
    expect(skills).toHaveLength(1);
    expect(diagnostics.filter((d) => d.type === 'collision')).toEqual([]);
  });

  it('refresh 重扫：新增技能文件后再次 refresh 拾取（/reload 语义）', () => {
    const dir = makeRoot();
    writeSkill(dir, 'alpha');
    const service = createSkillsService();
    service.registerProvider(createLocalSkillsProvider({ locations: [{ dir, source: 'user' }] }));

    service.refresh();
    expect(service.get('alpha')).toBeDefined();
    expect(service.get('beta')).toBeUndefined();

    writeSkill(dir, 'beta');
    service.refresh();
    expect(service.get('beta')).toBeDefined();
    expect(service.list()).toHaveLength(2);
  });

  it('provider.list() 抛异常 → provider-failed 警告，其余提供方不受影响', () => {
    const dir = makeRoot();
    writeSkill(dir, 'alpha');
    const service = createSkillsService();
    service.registerProvider({
      id: 'broken',
      list: () => {
        throw new Error('炸了');
      },
    });
    service.registerProvider(createLocalSkillsProvider({ locations: [{ dir, source: 'user' }] }));
    const { skills, diagnostics } = service.refresh();
    expect(skills.map((s) => s.name)).toEqual(['alpha']);
    expect(diagnostics).toEqual([
      expect.objectContaining({ type: 'warning', code: 'provider-failed', path: 'broken' }),
    ]);
  });

  it('registerProvider 注销器：摘除后 refresh 不再包含其技能（幂等）', () => {
    const service = createSkillsService();
    const dispose = service.registerProvider(
      stubProvider('p1', [
        {
          name: 'from-p1',
          description: 'd',
          content: 'x',
          filePath: '/p1/SKILL.md',
          baseDir: '/p1',
          source: 'user',
          disableModelInvocation: false,
        },
      ]),
    );
    service.refresh();
    expect(service.get('from-p1')).toBeDefined();
    dispose();
    dispose(); // 幂等
    service.refresh();
    expect(service.get('from-p1')).toBeUndefined();
  });
});

describe('renderAvailableSkills（渐进披露清单 §4.3）', () => {
  /** 组一个最小技能对象（清单渲染纯函数测试） */
  function mkSkill(name: string, description: string, hidden = false): Skill {
    return {
      name,
      description,
      content: '正文',
      filePath: `/ws/skills/${name}/SKILL.md`,
      baseDir: `/ws/skills/${name}`,
      source: 'user',
      disableModelInvocation: hidden,
    };
  }

  it('XML 形态：name/description/location 三件套 + 使用说明行 + 按名排序', () => {
    const rendered = renderAvailableSkills([mkSkill('zeta', 'Z 描述'), mkSkill('alpha', 'A 描述')]);
    expect(rendered).toContain('<available_skills>');
    expect(rendered).toContain('</available_skills>');
    // alpha 排在 zeta 前（确定性排序）
    expect(rendered.indexOf('<name>alpha</name>')).toBeLessThan(rendered.indexOf('<name>zeta</name>'));
    expect(rendered).toContain('<location>/ws/skills/alpha/SKILL.md</location>');
    // 相对路径解析指引（pi/agentskills 集成格式原样）
    expect(rendered).toContain('resolve it against the skill directory');
  });

  it('disable-model-invocation 隐藏：不出现在清单（仅显式调用）', () => {
    const rendered = renderAvailableSkills([mkSkill('visible', 'v'), mkSkill('hidden-one', 'h', true)]);
    expect(rendered).toContain('<name>visible</name>');
    expect(rendered).not.toContain('hidden-one');
  });

  it('描述含 XML 实体字符 → 转义防结构逃逸', () => {
    const rendered = renderAvailableSkills([mkSkill('esc', '含 <tag> & "引号"')]);
    expect(rendered).toContain('<description>含 &lt;tag&gt; &amp; &quot;引号&quot;</description>');
  });

  it('无可见技能 → 空串', () => {
    expect(renderAvailableSkills([])).toBe('');
    expect(renderAvailableSkills([mkSkill('only-hidden', 'h', true)])).toBe('');
  });
});

describe('defaultSkillLocations（§4.4 三处落地）', () => {
  it('受信工作区：project 位置在列且最高优先', () => {
    const locations = defaultSkillLocations('/ws/project', { trusted: true, homeDir: '/fake-home' });
    expect(locations).toEqual([
      { dir: '/ws/project/.agents/skills', source: 'project' },
      { dir: '/fake-home/.berry/skills', source: 'user' },
      { dir: '/fake-home/.agents/skills', source: 'user' },
      { dir: '/fake-home/.claude/skills', source: 'user' },
    ]);
  });

  it('未受信工作区：不扫 project 层（防恶意仓库）', () => {
    const locations = defaultSkillLocations('/ws/project', { trusted: false, homeDir: '/fake-home' });
    expect(locations.every((l) => l.source !== 'project')).toBe(true);
    expect(locations).toHaveLength(3);
  });
});
