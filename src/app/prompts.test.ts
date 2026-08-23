/**
 * L5 app 单元测试（ctx.prompts 具名提示词段服务）——id 校验三码 / 字典序物化 /
 * render 抛错占位不杀 / 注册注销广播 / disposer 护栏。真根作用域（createContext），
 * 无 mock。
 */

import { describe, expect, it } from 'vitest';
import { AppError, PROMPT_SECTION_DUPLICATE, PROMPT_SECTION_INVALID } from '../contracts/errors.js';
import { createContext } from '../context/index.js';
import { PROMPTS_CHANGE_EVENT, registerPromptsService } from './prompts.js';

/** 建一个挂好 prompts 服务的根作用域（每用例独立） */
function setup() {
  const ctx = createContext({ name: 'test-prompts' });
  const service = registerPromptsService(ctx);
  return { ctx, service };
}

/** 断言抛错码（错误码是唯一判据） */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('应当抛错');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

describe('registerSection 输入执法', () => {
  it('id 形状：大写/缺斜线/多段斜线/前导数字段 = PROMPT_SECTION_INVALID', () => {
    const { service } = setup();
    expectCode(() => service.registerSection({ id: 'Memory/core', render: () => 'x' }), PROMPT_SECTION_INVALID);
    expectCode(() => service.registerSection({ id: 'memorycore', render: () => 'x' }), PROMPT_SECTION_INVALID);
    expectCode(() => service.registerSection({ id: 'memory/a/b', render: () => 'x' }), PROMPT_SECTION_INVALID);
    expectCode(() => service.registerSection({ id: '1memory/core', render: () => 'x' }), PROMPT_SECTION_INVALID);
  });
  it('render 缺失或非函数 = PROMPT_SECTION_INVALID', () => {
    const { service } = setup();
    expectCode(
      () => service.registerSection({ id: 'a/b', render: undefined as unknown as () => string }),
      PROMPT_SECTION_INVALID,
    );
  });
  it('撞名 = PROMPT_SECTION_DUPLICATE（不静默覆盖）', () => {
    const { service } = setup();
    service.registerSection({ id: 'memory/core', render: () => '一' });
    expectCode(() => service.registerSection({ id: 'memory/core', render: () => '二' }), PROMPT_SECTION_DUPLICATE);
  });
});

describe('段集变更广播（prompts_change，与 tools_change 同族）', () => {
  it('注册与注销均广播，载荷 = 现行段 id 清单字典序', () => {
    const { ctx, service } = setup();
    const seen: string[][] = [];
    ctx.on(PROMPTS_CHANGE_EVENT, (ids: string[]) => seen.push([...ids]));
    const d1 = service.registerSection({ id: 'zz/late', render: () => 'z' });
    const d2 = service.registerSection({ id: 'aa/first', render: () => 'a' });
    expect(seen.at(-1)).toEqual(['aa/first', 'zz/late']); // 字典序与注册序解耦
    d1();
    expect(seen.at(-1)).toEqual(['aa/first']);
    d2();
    expect(seen.at(-1)).toEqual([]);
    expect(seen).toHaveLength(4); // 每次变更一条广播
  });
  it('注销幂等 + 不误撤他者同位注册', () => {
    const { service } = setup();
    const d1 = service.registerSection({ id: 'a/b', render: () => '1' });
    d1();
    d1(); // 幂等
    expect(service.listSections()).toEqual([]);
    // 注册→注销→他人再注册同 id：旧 disposer 再调不得撤他人段
    const dOld = service.registerSection({ id: 'a/b', render: () => 'old' });
    dOld();
    service.registerSection({ id: 'a/b', render: () => 'new' });
    dOld();
    expect(service.listSections()).toEqual(['a/b']);
  });
});

describe('materialize（具名段物化——重建时点求值）', () => {
  it('id 字典序拼接、段间空行分隔；空渲染段跳过不留空壳', () => {
    const { service } = setup();
    service.registerSection({ id: 'zz/x', render: () => 'Z 段' });
    service.registerSection({ id: 'aa/y', render: () => 'A 段' });
    service.registerSection({ id: 'mm/empty', render: () => '  ' });
    expect(service.materialize()).toBe('A 段\n\nZ 段');
  });
  it('render 抛错 = 插件 bug：诊断占位进提示词、不杀重建', () => {
    const { service } = setup();
    service.registerSection({
      id: 'bad/boom',
      render: () => {
        throw new Error('数据库连不上');
      },
    });
    service.registerSection({ id: 'good/ok', render: () => '好段' });
    const out = service.materialize();
    expect(out).toContain('渲染失败');
    expect(out).toContain('bad/boom');
    expect(out).toContain('好段'); // 后续段照常物化
  });
  it('物化即求值快照：后续源变化不追溯已物化串（组装一次随会话冻结）', () => {
    const { service } = setup();
    let value = '第一版';
    service.registerSection({ id: 'live/x', render: () => value });
    const frozen = service.materialize();
    value = '第二版';
    expect(frozen).toBe('第一版'); // 冻结串不变
    expect(service.materialize()).toBe('第二版'); // 下次重建取新值
  });
  it('空段集 → 空串（调用方 filter——不产生空分节）', () => {
    const { service } = setup();
    expect(service.materialize()).toBe('');
  });
});

describe('服务注册面（ctx.get）', () => {
  it("provide('prompts')——插件经 ctx.get 取同实例", () => {
    const { ctx, service } = setup();
    expect(ctx.get('prompts')).toBe(service);
  });
});
