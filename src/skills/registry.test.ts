/**
 * L3 skills 测试 — 本地 FS 发现（技能根短路 / 递归 / gitignore / symlink
 * 跟随）+ 服务合并（first-wins 冲突诊断 / symlink 去重 / refresh 重扫）
 * + 渐进披露清单渲染 + 默认发现位置。真文件系统 fixtures。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalSkillsProvider,
  createSkillsService,
  defaultSkillLocations,
  renderAvailableSkills,
  scanSkillLocation,
} from './index.js';
import { parseSkillMd } from './skill-md.js';
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

  it('provider 运行期退化抛错 → refresh 降 provider-failed 警告，其余提供方不受影响', () => {
    const dir = makeRoot();
    writeSkill(dir, 'alpha');
    const service = createSkillsService();
    // 注册时点健康（首调过 B12 形状断言），注册后内部状态翻转——模拟运行期退化
    let healthy = true;
    service.registerProvider({
      id: 'broken',
      list: () => {
        if (!healthy) throw new Error('炸了');
        return { skills: [], diagnostics: [] };
      },
    });
    service.registerProvider(createLocalSkillsProvider({ locations: [{ dir, source: 'user' }] }));
    healthy = false; // 翻转为运行期退化（注册时点已过——退到 refresh 期由 merge 守卫降级）
    const { skills, diagnostics } = service.refresh();
    expect(skills.map((s) => s.name)).toEqual(['alpha']);
    expect(diagnostics).toEqual([
      expect.objectContaining({ type: 'warning', code: 'provider-failed', path: 'broken' }),
    ]);
  });

  it('B12 注册首炸即拒：list() 首调抛错 → registerProvider 抛 SKILLS_PROVIDER_INVALID 且不入链', () => {
    const service = createSkillsService();
    let caught: (Error & { code?: string }) | undefined;
    try {
      service.registerProvider({
        id: 'broken',
        list: () => {
          throw new Error('炸了');
        },
      });
    } catch (err) {
      caught = err as Error & { code?: string };
    }
    // 码与报文双断言（AppError 报文本身不含码前缀——码在 err.code）
    expect(caught?.code).toBe('SKILLS_PROVIDER_INVALID');
    expect(caught?.message).toMatch(/首调 list\(\) 即抛错——炸了/);
    // 未入链：空链 refresh 无 provider-failed 警告（若残留条目此处会现警告）
    const { skills, diagnostics } = service.refresh();
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('B12 退化形各腿：list 非函数 / 缺键 / 元素粗验——注册时点即拒（报文含 provider id 归因）', () => {
    const service = createSkillsService();
    // 腿一：list 不是函数
    expect(() => service.registerProvider({ id: 'not-fn', list: undefined as unknown as () => never })).toThrowError(
      /not-fn 形状不合：list 不是函数/,
    );
    // 腿二：返回缺 skills/diagnostics 数组键
    expect(() => service.registerProvider({ id: 'no-keys', list: () => ({}) as never })).toThrowError(
      /no-keys 形状不合：返回缺 skills 数组/,
    );
    // 腿三：skills 元素缺 name/description/filePath 串键
    expect(() =>
      service.registerProvider({ id: 'bad-elem', list: () => ({ skills: [{ name: 'x' }], diagnostics: [] }) as never }),
    ).toThrowError(/bad-elem 形状不合：skills\[0\] 缺 name\/description\/filePath 串键/);
    // 腿四：diagnostics 元素缺三键
    expect(() =>
      service.registerProvider({ id: 'bad-diag', list: () => ({ skills: [], diagnostics: [{}] }) as never }),
    ).toThrowError(/bad-diag 形状不合：diagnostics\[0\] 缺 type\/code\/message 键/);
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

describe('defaultSkillLocations（§4.4 发现位置落地）', () => {
  it('受信工作区：project 位置在列且最高优先；出厂层置末位', () => {
    const locations = defaultSkillLocations('/ws/project', {
      trusted: true,
      homeDir: '/fake-home',
      factoryRoot: '/factory',
    });
    expect(locations).toEqual([
      { dir: '/ws/project/.agents/skills', source: 'project' },
      { dir: '/fake-home/.berry/skills', source: 'user' },
      { dir: '/fake-home/.agents/skills', source: 'user' },
      { dir: '/fake-home/.claude/skills', source: 'user' },
      { dir: '/factory/skills', source: 'package' },
    ]);
  });

  it('未受信工作区：不扫 project 层（防恶意仓库）；出厂层不受信任判定影响', () => {
    const locations = defaultSkillLocations('/ws/project', {
      trusted: false,
      homeDir: '/fake-home',
      factoryRoot: '/factory',
    });
    expect(locations.every((l) => l.source !== 'project')).toBe(true);
    expect(locations).toHaveLength(4);
    // 出厂层 = 宿主信任（与官方件注册表同源分发），恒扫描
    expect(locations[locations.length - 1]).toEqual({ dir: '/factory/skills', source: 'package' });
  });
});

describe('出厂技能层（§4.4 ⑤——样例技能随包分发，拍板 17）', () => {
  it('factoryRoot 目录扫描可见技能（目录缺失 = 常态静默零诊断）', () => {
    const root = makeRoot();
    // fixture：出厂根下放一个技能
    mkdirSync(join(root, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 演示\n---\n\n正文\n',
    );
    const provider = createLocalSkillsProvider({ locations: [{ dir: join(root, 'skills'), source: 'package' }] });
    const result = provider.list();
    expect(result.skills.map((s) => s.name)).toEqual(['demo-skill']);
    expect(result.skills[0]?.source).toBe('package');
    // 缺失目录：静默（常态非异常——与 project/user 层一致）
    const empty = createLocalSkillsProvider({ locations: [{ dir: join(root, 'no-such'), source: 'package' }] });
    expect(empty.list()).toEqual({ skills: [], diagnostics: [] });
  });

  it('repo 根出厂样例三件解析通过（出厂内容回归锁——格式坏在 CI 抓出）', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const names = ['commit-checklist', 'apps-quickstart', 'troubleshooting'];
    for (const name of names) {
      const filePath = join(repoRoot, 'skills', name, 'SKILL.md');
      const content = readFileSync(filePath, 'utf8');
      const { skill, diagnostics } = parseSkillMd(content, filePath, 'package');
      expect(diagnostics, `${name} 诊断应为空`).toEqual([]);
      expect(skill?.name).toBe(name);
      expect(skill?.description.length ?? 0).toBeGreaterThan(0);
      // 正文非空（指令体是技能的实体）
      expect(skill?.content.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('createSkillsService（变更广播——契约篇 §2.2 增补 6，#17 回归锁）', () => {
  /** 造一个最小 provider fixture（id 可指定） */
  const providerOf = (id: string): SkillsProvider => ({
    id,
    list: () => ({ skills: [], diagnostics: [] as SkillDiagnostic[] }),
  });

  it('registerProvider/注销各触发一次 onProvidersChange，载荷 = 现行 id 清单（注册序）', () => {
    const events: string[][] = [];
    const service = createSkillsService({
      onProvidersChange: (ids) => events.push([...ids]),
    });
    const disposeA = service.registerProvider(providerOf('prov-a'));
    const disposeB = service.registerProvider(providerOf('prov-b'));
    expect(events).toEqual([['prov-a'], ['prov-a', 'prov-b']]); // 注册序快照
    disposeA();
    expect(events.at(-1)).toEqual(['prov-b']); // 注销后现行链
    disposeB();
    expect(events.at(-1)).toEqual([]);
    disposeB(); // 幂等注销不再触发
    expect(events).toHaveLength(4); // 注册×2 + 注销×2，幂等注销零事件
  });

  it('缺省不广播（纯测试场景零负担）', () => {
    const service = createSkillsService();
    expect(() => service.registerProvider(providerOf('prov-silent'))).not.toThrow();
  });
});

describe('createSkillsService — D1 app 行拒载（契约篇 §5.1 注册面路由）', () => {
  /** 两行探针 fixture（第三十六批 apps 数组化）：row-app 挂应用 chat（在投影）、其余行挂系统（不在投影） */
  const rowApp = {
    get: (rowId: string) => (rowId === 'row-app' ? ['chat'] : undefined),
    size: () => 1,
  };
  /** 本组最小 provider fixture（空技能——注册/拒载语义与内容无关） */
  const providerOf = (id: string): SkillsProvider => ({
    id,
    list: () => ({ skills: [], diagnostics: [] as SkillDiagnostic[] }),
  });

  it('app 行注册拒绝：COMPOSITION_ROW_INVALID——provider 全局注入 systemPrompt 无域层', async () => {
    const { runInCallerChain } = await import('../context/chain.js');
    const { AppError, COMPOSITION_ROW_INVALID } = await import('../contracts/errors.js');
    const service = createSkillsService({ rowApp });
    // 装载器 apply 帧 / 组合根 seam 还帧形态：行 id 进 caller 链 → 服务面单一
    // 执法点拒绝（装载期拒绝——加载器收为行失败）
    try {
      runInCallerChain('row-app', () => service.registerProvider(providerOf('prov-app')));
      expect.unreachable('应抛 COMPOSITION_ROW_INVALID');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as InstanceType<typeof AppError>).code).toBe(COMPOSITION_ROW_INVALID);
      expect((e as InstanceType<typeof AppError>).message).toContain('apps: chat');
    }
  });

  it('系统行与无帧注册不受影响（宿主装配段/合法语境照常注册）', async () => {
    const { runInCallerChain } = await import('../context/chain.js');
    const seen: string[][] = [];
    const service = createSkillsService({
      rowApp,
      onProvidersChange: (ids) => seen.push([...ids]),
    });
    // 挂系统的行：探针查无 → 照常
    runInCallerChain('row-sys', () => service.registerProvider(providerOf('prov-sys')));
    // 无帧（宿主装配段直注册——local-fs provider 即此形态）：照常
    service.registerProvider(providerOf('prov-host'));
    expect(seen.at(-1)).toEqual(['prov-sys', 'prov-host']);
  });

  it('缺省不接探针 = 不执法（纯测试/诊断面）', () => {
    const service = createSkillsService();
    expect(() => service.registerProvider(providerOf('prov-plain'))).not.toThrow();
  });
});
