/**
 * L4 channels — ctx.ui 聚合器测试（headless：桩后端验降级与广播规则）。
 */

import { describe, expect, it } from 'vitest';
import { createUiService, parseBooleanAnswer } from './ui.js';
import type { UiBackend, UiChoice } from './types.js';

/** 桩后端：记录调用；能力面按参数裁剪（缺省 = 不支持可选原语） */
function stubBackend(
  id: string,
  caps: { confirm?: boolean; input?: boolean; select?: boolean; setWidget?: boolean } = {},
) {
  const calls: { op: string; message: string }[] = [];
  /** 桩 input 的应答脚本（逐条弹出；耗尽返回 ''） */
  const scriptedInputs: string[] = [];
  const backend: UiBackend = {
    id,
    notify: (message) => calls.push({ op: 'notify', message }),
    setStatus: (message) => calls.push({ op: 'setStatus', message }),
    ...(caps.input
      ? {
          input: async (message: string) => {
            calls.push({ op: 'input', message });
            return scriptedInputs.shift() ?? '';
          },
        }
      : {}),
    ...(caps.confirm ? { confirm: async (m: string) => (calls.push({ op: 'confirm', message: m }), true) } : {}),
    ...(caps.select
      ? {
          select: async (m: string, _choices: readonly UiChoice[]) => (
            calls.push({ op: 'select', message: m }),
            '选值'
          ),
        }
      : {}),
    ...(caps.setWidget ? { setWidget: (node: unknown) => calls.push({ op: 'setWidget', message: String(node) }) } : {}),
  };
  return { backend, calls, scriptedInputs };
}

describe('parseBooleanAnswer', () => {
  it('y/yes/是 → true；n/no/否 → false；其余 undefined（大小写与空白归一）', () => {
    expect(parseBooleanAnswer('Y')).toBe(true);
    expect(parseBooleanAnswer(' yes ')).toBe(true);
    expect(parseBooleanAnswer('是')).toBe(true);
    expect(parseBooleanAnswer('N')).toBe(false);
    expect(parseBooleanAnswer('no')).toBe(false);
    expect(parseBooleanAnswer('否')).toBe(false);
    expect(parseBooleanAnswer('也许')).toBeUndefined();
    expect(parseBooleanAnswer('')).toBeUndefined();
  });
});

describe('UiService 非交互原语', () => {
  it('notify / setStatus 广播全部在线后端', () => {
    const ui = createUiService();
    const a = stubBackend('a');
    const b = stubBackend('b');
    ui.attach(a.backend);
    ui.attach(b.backend);
    ui.notify('你好', { level: 'warn' });
    ui.setStatus('忙碌');
    expect(a.calls).toEqual([
      { op: 'notify', message: '你好' },
      { op: 'setStatus', message: '忙碌' },
    ]);
    expect(b.calls).toEqual(a.calls);
  });

  it('attach 返回摘除器：摘除后不再广播；幂等', () => {
    const ui = createUiService();
    const { backend, calls } = stubBackend('solo');
    const detach = ui.attach(backend);
    detach();
    detach(); // 幂等
    ui.notify('无人接收');
    expect(calls).toEqual([]);
  });
});

describe('UiService 阻塞原语直连', () => {
  it('confirm / input / select 直达首个支持的后端（接入序即优先序）', async () => {
    const ui = createUiService();
    const full = stubBackend('full', { confirm: true, input: true, select: true });
    ui.attach(full.backend);
    await expect(ui.confirm('确认？')).resolves.toBe(true);
    await expect(ui.select('挑一个', [{ value: 'a', label: 'A' }])).resolves.toBe('选值');
    const plain = stubBackend('plain');
    ui.attach(plain.backend);
    await ui.input('说点什么');
    // input 落在 full（首个支持者），plain 未收到
    expect(full.calls.some((c) => c.op === 'input')).toBe(true);
    expect(plain.calls.some((c) => c.op === 'input')).toBe(false);
  });
});

describe('UiService 降级规则（技术栈篇 §4.3）', () => {
  it('select → input 编号清单：序号 / value / label 任一命中', async () => {
    const ui = createUiService();
    const { backend, scriptedInputs } = stubBackend('io', { input: true });
    ui.attach(backend);
    const choices: UiChoice[] = [
      { value: 'red', label: '红色' },
      { value: 'blue', label: '蓝色' },
    ];
    scriptedInputs.push('2');
    await expect(ui.select('选颜色', choices)).resolves.toBe('blue');
    scriptedInputs.push('red');
    await expect(ui.select('选颜色', choices)).resolves.toBe('red');
    scriptedInputs.push('红色');
    await expect(ui.select('选颜色', choices)).resolves.toBe('red');
  });

  it('select 降级后不匹配 → 空值（调用方按无效处理）', async () => {
    const ui = createUiService();
    const { backend, scriptedInputs } = stubBackend('io', { input: true });
    ui.attach(backend);
    scriptedInputs.push('不存在的选项');
    await expect(ui.select('选颜色', [{ value: 'red', label: '红色' }])).resolves.toBe('');
  });

  it('confirm → input y/n 解析；未识别保守 false', async () => {
    const ui = createUiService();
    const { backend, scriptedInputs } = stubBackend('io', { input: true });
    ui.attach(backend);
    scriptedInputs.push('yes');
    await expect(ui.confirm('继续？')).resolves.toBe(true);
    scriptedInputs.push('不知道');
    await expect(ui.confirm('继续？')).resolves.toBe(false);
  });

  it('setWidget 无支持者 → 降级 notify', () => {
    const ui = createUiService();
    const { backend, calls } = stubBackend('plain');
    ui.attach(backend);
    ui.setWidget({ kind: 'chart' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.op).toBe('notify');
  });
});

describe('UiService 无交互通道 fail-soft', () => {
  it('空聚合器：confirm false（fail-closed）/ input 空串 / select 空串', async () => {
    const ui = createUiService();
    await expect(ui.confirm('确认？')).resolves.toBe(false);
    await expect(ui.input('输入')).resolves.toBe('');
    await expect(ui.select('选', [{ value: 'a', label: 'A' }])).resolves.toBe('');
  });

  it('仅非交互后端在线时同为保守值', async () => {
    const ui = createUiService();
    ui.attach(stubBackend('只读').backend);
    await expect(ui.confirm('确认？')).resolves.toBe(false);
    await expect(ui.input('输入')).resolves.toBe('');
  });
});
