/**
 * L5 app — 应用清单注册表测试（契约篇 §5.4 第二纵切）。
 * 三面：manifest schema 拒绝式校验 / 官方目录装载（含坏清单与撞名）/ 组件在场断言
 * （按装载身份串匹配激活行——skip 与 unresolved 行不算在场）。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, APP_DUPLICATE, APP_INVALID, APP_NOT_FOUND } from '../contracts/errors.js';
import { validateAppManifest } from '../contracts/app.js';
import {
  assertAppComponents,
  loadOfficialApps,
  mergeRequestForApp,
  OFFICIAL_APPS_DIR,
  resolveApp,
} from './app-registry.js';
import type { CompositionReport } from './composition.js';

/** 最小合法清单素材（逐用例覆写单字段造坏形状） */
const base = {
  id: 'acme/coder',
  label: 'Acme 代码助手',
  components: ['builtin:chat'],
};

/** 捕获并断言错误码（本模块测试的错误断言惯例） */
function expectCode(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error('应抛错而未抛');
}

describe('validateAppManifest：schema 拒绝式校验', () => {
  it('最小合法清单通过（budget 可选）', () => {
    const m = validateAppManifest(base, '测试');
    expect(m.id).toBe('acme/coder');
    expect(m.budget).toBeUndefined();
  });

  it('未知字段拒绝（additionalProperties: false 全层）', () => {
    expectCode(() => validateAppManifest({ ...base, extra: 1 }, '测试'), APP_INVALID);
  });

  it('缺 id / 缺 label / components 空集均拒', () => {
    const { id: _dropId, ...noId } = base;
    expectCode(() => validateAppManifest(noId, '测试'), APP_INVALID);
    const { label: _dropLabel, ...noLabel } = base;
    expectCode(() => validateAppManifest(noLabel, '测试'), APP_INVALID);
    expectCode(() => validateAppManifest({ ...base, components: [] }, '测试'), APP_INVALID);
  });

  it('id 形状不合法拒（大写 / 斜线开头 / 连字符开头）', () => {
    expectCode(() => validateAppManifest({ ...base, id: 'Acme' }, '测试'), APP_INVALID);
    expectCode(() => validateAppManifest({ ...base, id: '/acme' }, '测试'), APP_INVALID);
    expectCode(() => validateAppManifest({ ...base, id: '-acme' }, '测试'), APP_INVALID);
  });

  it('budget.dailyTokens 非正整数拒（0 / 小数 / 字符串）', () => {
    for (const bad of [0, 1.5, '1000']) {
      expectCode(() => validateAppManifest({ ...base, budget: { dailyTokens: bad } }, '测试'), APP_INVALID);
    }
  });

  it('grants.approval 收键（第三纵切）：两 knob 合法词汇通过、词汇外值拒', () => {
    // 合法：档位与审批策略各取一值（词汇镜像 safety 面 SandboxMode/ApprovalPolicyMode）
    const m = validateAppManifest(
      { ...base, grants: { approval: { sandboxMode: 'read-only', approvalPolicy: 'never' } } },
      '测试',
    );
    expect(m.grants?.approval?.sandboxMode).toBe('read-only');
    expect(m.grants?.approval?.approvalPolicy).toBe('never');
    // 词汇外值拒绝（沙箱档/策略两维同纪律——拒绝式不宽容）
    expectCode(
      () => validateAppManifest({ ...base, grants: { approval: { sandboxMode: 'full' } } }, '测试'),
      APP_INVALID,
    );
    expectCode(
      () => validateAppManifest({ ...base, grants: { approval: { approvalPolicy: 'always' } } }, '测试'),
      APP_INVALID,
    );
    // 未知子键拒绝（additionalProperties: false 全层贯穿）
    expectCode(() => validateAppManifest({ ...base, grants: { approval: { roots: ['/tmp'] } } }, '测试'), APP_INVALID);
  });

  it('budget.memoryMb 收键（第三纵切补第二纵切欠账）：正整数通过、非正/小数拒', () => {
    const m = validateAppManifest({ ...base, budget: { dailyTokens: 1000, memoryMb: 256 } }, '测试');
    expect(m.budget?.memoryMb).toBe(256);
    for (const bad of [0, -1, 1.5, '256']) {
      expectCode(() => validateAppManifest({ ...base, budget: { memoryMb: bad } }, '测试'), APP_INVALID);
    }
  });

  it('message 载 where 与首错路径（instancePath）——与加载器校验同惯例', () => {
    const err = expectCode(() => validateAppManifest({ ...base, components: [] }, '/x/acme.app.yaml'), APP_INVALID);
    expect(err.message).toContain('/x/acme.app.yaml');
    expect(err.message).toContain('/components');
  });
});

describe('loadOfficialApps：官方目录装载', () => {
  it('仓库 apps/ 真目录：chat 与 hermes 在册（清单是应用包唯一源）', () => {
    const apps = loadOfficialApps();
    expect(apps.get('chat')?.label).toBe('对话');
    expect(apps.get('hermes')?.components).toEqual([
      'builtin:chat',
      'builtin:memory',
      'builtin:subagent',
      'builtin:goal',
    ]);
    // hermes 声明每日预算（canAfford app 维的声明面）
    expect(apps.get('hermes')?.budget?.dailyTokens).toBeGreaterThan(0);
  });

  it('临时目录装载：合法清单入册，非 .app.yaml 文件忽略', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-reg-test-'));
    try {
      writeFileSync(join(dir, 'one.app.yaml'), 'id: vendor/one\nlabel: 一号\ncomponents:\n  - builtin:chat\n');
      writeFileSync(join(dir, 'README.md'), '# 不入册\n');
      const apps = loadOfficialApps(dir);
      expect([...apps.keys()]).toEqual(['vendor/one']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('坏 yaml = APP_INVALID 拒启（官方件随包，坏 = 发版事故）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-reg-test-'));
    try {
      writeFileSync(join(dir, 'bad.app.yaml'), 'id: [unclosed\n');
      const err = expectCode(() => loadOfficialApps(dir), APP_INVALID);
      expect(err.message).toContain('yaml 解析失败');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('id 撞名 = APP_DUPLICATE（官方裸名是保留字——撞名即发版事故）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-reg-test-'));
    try {
      const body = 'id: vendor/one\nlabel: 一号\ncomponents:\n  - builtin:chat\n';
      writeFileSync(join(dir, 'a.app.yaml'), body);
      writeFileSync(join(dir, 'b.app.yaml'), body);
      expectCode(() => loadOfficialApps(dir), APP_DUPLICATE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录缺失 = 空表防御（不因布局异常炸启动面）', () => {
    expect(loadOfficialApps(join(tmpdir(), '不存在的目录-防御位')).size).toBe(0);
  });

  it('官方目录常量锚定仓库根 apps/（src 与 dist 同为上溯两级）', () => {
    expect(OFFICIAL_APPS_DIR.endsWith('apps')).toBe(true);
  });
});

describe('assertAppComponents：组件在场断言（按装载身份串）', () => {
  /** 合成最小组合树：rows 带 pkg 身份串与挂载目标，plan 三态（激活 / skip / unresolved） */
  const composition = (
    rows: Array<{ id: string; pkg?: string; apps?: string[] }>,
    plan: Array<{ id: string; skip?: string; unresolved?: string }>,
  ): CompositionReport => ({ rows, plan }) as unknown as CompositionReport;

  /** 单应用清单：三组件（chat 在场易满足，另两个逐用例控制） */
  const apps = new Map([
    ['vendor/one', { id: 'vendor/one', label: '一号', components: ['builtin:chat', 'vendor/tool', 'vendor/gone'] }],
  ]) as Parameters<typeof assertAppComponents>[0];

  it('激活行在场；行 id 与身份串不挂钩（匹配只认 pkg 字段）', () => {
    const comp = composition(
      [
        { id: 'main', pkg: 'builtin:chat' }, // 行 id 随意命名
        { id: 'tools', pkg: 'vendor/tool' },
      ],
      [{ id: 'main' }, { id: 'tools' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/gone']);
  });

  it('skip 行 = 用户裁量不算在场（缺场进 gaps，应用级隔离不拒启）', () => {
    const comp = composition(
      [
        { id: 'main', pkg: 'builtin:chat' },
        { id: 'tools', pkg: 'vendor/tool' },
      ],
      [{ id: 'main' }, { id: 'tools', skip: 'disabled' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/tool', 'vendor/gone']);
  });

  it('unresolved 行（入口解析失败）同样不算在场', () => {
    const comp = composition(
      [{ id: 'main', pkg: 'builtin:chat' }],
      [{ id: 'main' }, { id: 'tools', unresolved: '未安装' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/tool', 'vendor/gone']);
  });

  it('全部组件在场 = 无缺口（应用不出现在 gaps）', () => {
    const comp = composition(
      [
        { id: 'a', pkg: 'builtin:chat' },
        { id: 'b', pkg: 'vendor/tool' },
        { id: 'c', pkg: 'vendor/gone' },
      ],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    );
    expect(assertAppComponents(apps, comp).size).toBe(0);
  });

  it('D1 值域升级：在场 = 挂系统 ∪ 挂本应用；挂他应用 ≠ 在场（契约篇 §5.1 冷读 F7/SF3）', () => {
    // vendor/gone 挂在**别应用**组合——注册落他应用域层、进不了本应用组成面：
    // 断言与投影同域，对本应用即缺场照报
    const comp = composition(
      [
        { id: 'a', pkg: 'builtin:chat' },
        { id: 'b', pkg: 'vendor/tool' },
        { id: 'c', pkg: 'vendor/gone', apps: ['别应用'] },
      ],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/gone']);
  });

  it('D1 挂本应用即在场（overlay 复挂同件进本应用作用域——与挂系统行并集判定）', () => {
    const comp = composition(
      [
        { id: 'a', pkg: 'builtin:chat' },
        { id: 'b', pkg: 'vendor/tool', apps: ['vendor/one'] }, // 挂本应用
        { id: 'c', pkg: 'vendor/gone', apps: ['vendor/one'] },
      ],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    );
    expect(assertAppComponents(apps, comp).size).toBe(0);
  });
});

/* ---------------- 第三纵切：进入面解析 + 委派合并钩子 ---------------- */

describe('resolveApp：进入面 id 解析（CLI --app / TUI /app <id>）', () => {
  const apps = new Map([
    ['chat', { id: 'chat', label: '对话', components: ['builtin:chat'] }],
    ['hermes', { id: 'hermes', label: 'Hermes', components: ['builtin:chat'] }],
  ]) as Parameters<typeof resolveApp>[0];

  it('查有返回清单；查无 = APP_NOT_FOUND 且 message 披露在册清单（自助排错）', () => {
    expect(resolveApp(apps, 'hermes').id).toBe('hermes');
    const err = expectCode(() => resolveApp(apps, 'no-such'), APP_NOT_FOUND);
    expect(err.message).toContain('no-such');
    expect(err.message).toContain('chat、hermes'); // 在册清单随错披露
  });

  it('空注册表 = 无——组合树空装语义的说明面（不是静默空串）', () => {
    const err = expectCode(() => resolveApp(new Map(), 'x'), APP_NOT_FOUND);
    expect(err.message).toContain('在册应用：无');
  });
});

describe('mergeRequestForApp：delegable 委派请求合并钩子（与 agents/*.md 同语义）', () => {
  /** 基准请求（请求侧自由半边——合并只收窄不改宽） */
  const request = { prompt: '干活' } as Parameters<ReturnType<typeof mergeRequestForApp>>[0];

  it('无 agent 段 = 恒等合并（纯清单应用委派裸跑）', () => {
    const merge = mergeRequestForApp({ id: 'x', label: 'X', components: ['builtin:chat'] });
    expect(merge(request)).toEqual(request);
  });

  it('persona 钉死 + model 覆盖 + toolFilter 交集（请求未给名单 = 用清单名单）', () => {
    const merge = mergeRequestForApp({
      id: 'x',
      label: 'X',
      components: ['builtin:chat'],
      agent: { persona: '应用人格', model: 'probe/model-x', toolFilter: ['read', 'grep', 'bash'] },
    });
    // 请求未给 toolFilter → 全量 → 用清单名单
    expect(merge(request)).toMatchObject({
      persona: '应用人格',
      model: 'probe/model-x',
      toolFilter: ['read', 'grep', 'bash'],
    });
    // 请求给了名单 → 交集（两侧白名单同时执法）
    const narrowed = merge({ ...request, toolFilter: ['read', 'write'], persona: '请求人格' } as typeof request);
    expect(narrowed.toolFilter).toEqual(['read']); // 交集；write 不在清单即被裁
    expect(narrowed.persona).toBe('应用人格'); // persona 钉死——请求人格被清单覆盖
  });
});
