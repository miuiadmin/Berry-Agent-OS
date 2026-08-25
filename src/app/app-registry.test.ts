/**
 * L5 app — 应用清单注册表测试（契约篇 §5.4 第二纵切）。
 * 三面：manifest schema 拒绝式校验 / 官方目录装载（含坏清单与撞名）/ 组件在场断言
 * （按装载身份串匹配激活行——skip 与 unresolved 行不算在场）。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, APP_DUPLICATE, APP_INVALID } from '../contracts/errors.js';
import { validateAppManifest } from '../contracts/app.js';
import { assertAppComponents, loadOfficialApps, OFFICIAL_APPS_DIR } from './app-registry.js';
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
  /** 合成最小组合树：rows 带 plugin 身份串，plan 三态（激活 / skip / unresolved） */
  const composition = (
    rows: Array<{ id: string; plugin?: string }>,
    plan: Array<{ id: string; skip?: string; unresolved?: string }>,
  ): CompositionReport => ({ rows, plan }) as unknown as CompositionReport;

  /** 单应用清单：三组件（chat 在场易满足，另两个逐用例控制） */
  const apps = new Map([
    ['vendor/one', { id: 'vendor/one', label: '一号', components: ['builtin:chat', 'vendor/tool', 'vendor/gone'] }],
  ]) as Parameters<typeof assertAppComponents>[0];

  it('激活行在场；行 id 与身份串不挂钩（匹配只认 plugin 字段）', () => {
    const comp = composition(
      [
        { id: 'main', plugin: 'builtin:chat' }, // 行 id 随意命名
        { id: 'tools', plugin: 'vendor/tool' },
      ],
      [{ id: 'main' }, { id: 'tools' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/gone']);
  });

  it('skip 行 = 用户裁量不算在场（缺场进 gaps，应用级隔离不拒启）', () => {
    const comp = composition(
      [
        { id: 'main', plugin: 'builtin:chat' },
        { id: 'tools', plugin: 'vendor/tool' },
      ],
      [{ id: 'main' }, { id: 'tools', skip: 'disabled' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/tool', 'vendor/gone']);
  });

  it('unresolved 行（入口解析失败）同样不算在场', () => {
    const comp = composition(
      [{ id: 'main', plugin: 'builtin:chat' }],
      [{ id: 'main' }, { id: 'tools', unresolved: '未安装' }],
    );
    const gaps = assertAppComponents(apps, comp);
    expect(gaps.get('vendor/one')).toEqual(['vendor/tool', 'vendor/gone']);
  });

  it('全部组件在场 = 无缺口（应用不出现在 gaps）', () => {
    const comp = composition(
      [
        { id: 'a', plugin: 'builtin:chat' },
        { id: 'b', plugin: 'vendor/tool' },
        { id: 'c', plugin: 'vendor/gone' },
      ],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    );
    expect(assertAppComponents(apps, comp).size).toBe(0);
  });
});
