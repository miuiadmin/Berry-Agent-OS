/**
 * L4 channels — 命令注册表测试（headless 纯逻辑）。
 */

import { describe, expect, it } from 'vitest';
import { createCommandRegistry } from './commands.js';
import type { CommandDefinition } from './types.js';

/** 组一条测试命令 */
const cmd = (name: string, handler?: CommandDefinition['handler']): CommandDefinition => ({
  name,
  description: `${name} 命令`,
  handler: handler ?? (() => {}),
});

describe('CommandRegistry.parse', () => {
  it('非斜杠输入返回 null', () => {
    const registry = createCommandRegistry();
    expect(registry.parse('hello')).toBeNull();
    expect(registry.parse('  /前置空格会被 trim 后仍算命令')).not.toBeNull();
  });

  it('解析命令名与 args（多空格归一、args 保留原文）', () => {
    const registry = createCommandRegistry();
    expect(registry.parse('/help')).toEqual({ name: 'help', args: '' });
    expect(registry.parse('/skill:demo  剩余参数')).toEqual({ name: 'skill:demo', args: '剩余参数' });
    // 多行 args 原样保留（含换行）
    expect(registry.parse('/run 第一行\n第二行')).toEqual({ name: 'run', args: '第一行\n第二行' });
  });

  it('裸斜杠按空命令名处理（不匹配任何注册名）', () => {
    const registry = createCommandRegistry();
    expect(registry.parse('/')).toEqual({ name: '', args: '' });
  });
});

describe('CommandRegistry.register', () => {
  it('注册后可 lookup / list（list 按名排序）', () => {
    const registry = createCommandRegistry();
    registry.register(cmd('zeta'));
    registry.register(cmd('alpha'));
    expect(registry.lookup('alpha')?.description).toBe('alpha 命令');
    expect(registry.list().map((c) => c.name)).toEqual(['alpha', 'zeta']);
  });

  it('同名后写胜出', () => {
    const registry = createCommandRegistry();
    registry.register(
      cmd('dup', () => {
        throw new Error('旧者');
      }),
    );
    const calls: string[] = [];
    registry.register(
      cmd('dup', () => {
        calls.push('新者');
      }),
    );
    expect(registry.dispatch('/dup')).resolves.toBe('ok');
    expect(calls).toEqual(['新者']);
  });

  it('注销器幂等且仅摘本定义（防误摘后写胜出者）', () => {
    const registry = createCommandRegistry();
    const disposeOld = registry.register(cmd('dup'));
    registry.register(cmd('dup'));
    disposeOld(); // 旧者注销不应摘掉新者
    expect(registry.lookup('dup')).toBeDefined();
    disposeOld(); // 幂等：二次调用无副作用
    expect(registry.lookup('dup')).toBeDefined();
  });

  it('注销后再注册可恢复', () => {
    const registry = createCommandRegistry();
    const dispose = registry.register(cmd('tmp'));
    dispose();
    expect(registry.lookup('tmp')).toBeUndefined();
    registry.register(cmd('tmp'));
    expect(registry.lookup('tmp')).toBeDefined();
  });
});

describe('CommandRegistry.onChange（注册面变更通知，M4 autocomplete 投影重建）', () => {
  it('注册胜出/后写胜出/注销摘除三时点触发；幂等注销与被顶替者注销不触发', () => {
    const registry = createCommandRegistry();
    let fired = 0;
    registry.onChange(() => {
      fired++;
    });
    const disposeA = registry.register(cmd('dup'));
    expect(fired).toBe(1); // 注册胜出
    const disposeB = registry.register(cmd('dup')); // 后写胜出（同名胜出也须重投影）
    expect(fired).toBe(2);
    disposeA(); // 被顶替者注销——表未变，不触发
    expect(fired).toBe(2);
    disposeB(); // 现任摘除——触发
    expect(fired).toBe(3);
    disposeB(); // 幂等注销——不触发
    expect(fired).toBe(3);
  });

  it('退订器摘除后不再触发', () => {
    const registry = createCommandRegistry();
    let fired = 0;
    const off = registry.onChange(() => {
      fired++;
    });
    off();
    registry.register(cmd('late'));
    expect(fired).toBe(0);
  });

  it('监听器异常隔离：炸掉的监听器不拖垮注册路径，其余监听器照常收到', () => {
    const registry = createCommandRegistry();
    const seen: string[] = [];
    registry.onChange(() => {
      throw new Error('投影重建失败');
    });
    registry.onChange(() => {
      seen.push('alive');
    });
    expect(() => registry.register(cmd('survive'))).not.toThrow();
    expect(seen).toEqual(['alive']);
    expect(registry.lookup('survive')).toBeDefined(); // 注册本身成功
  });
});

describe('CommandRegistry.dispatch', () => {
  it('三种结果：非命令 / 未知名 / 已派发', async () => {
    const registry = createCommandRegistry();
    expect(await registry.dispatch('普通消息')).toBe('not-command');
    expect(await registry.dispatch('/不存在')).toBe('unknown');
    const got: string[] = [];
    registry.register(
      cmd('echo', (args) => {
        got.push(args);
      }),
    );
    expect(await registry.dispatch('/echo  hi')).toBe('ok');
    expect(got).toEqual(['hi']);
  });

  it('handler 抛错原样上抛（通道壳负责兜底为通知）', async () => {
    const registry = createCommandRegistry();
    registry.register(
      cmd('boom', () => {
        throw new Error('炸了');
      }),
    );
    await expect(registry.dispatch('/boom')).rejects.toThrow('炸了');
  });

  it('handler 可为异步', async () => {
    const registry = createCommandRegistry();
    const got: string[] = [];
    registry.register({
      name: 'slow',
      description: '异步命令',
      handler: async (args) => {
        await Promise.resolve();
        got.push(args);
      },
    });
    expect(await registry.dispatch('/slow x')).toBe('ok');
    expect(got).toEqual(['x']);
  });
});
