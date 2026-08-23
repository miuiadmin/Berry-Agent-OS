/**
 * L4 channels — 提问队列测试（headless：FIFO / 路由 / pending 状态）。
 */

import { describe, expect, it } from 'vitest';
import { createPromptQueue } from './prompt.js';
import type { PromptIo } from './prompt.js';

/** 记录型出屏回调（show/echo 调用序即上屏序） */
function recorder() {
  const log: string[] = [];
  const io: PromptIo = {
    show: (q) => log.push(`show:${q}`),
    echo: (a) => log.push(`echo:${a}`),
  };
  return { io, log };
}

describe('PromptQueue', () => {
  it('非 prompt 期 handleSubmit 返回 false（交正常输入流）', () => {
    const { io } = recorder();
    const queue = createPromptQueue(io);
    expect(queue.handleSubmit('/help')).toBe(false);
    expect(queue.pending()).toBe(false);
  });

  it('ask 后 handleSubmit 消费为答案：resolve + echo + pending 翻转', async () => {
    const { io, log } = recorder();
    const queue = createPromptQueue(io);
    const answer = queue.ask('叫什么名字？');
    expect(queue.pending()).toBe(true);
    expect(queue.handleSubmit('张三')).toBe(true);
    await expect(answer).resolves.toBe('张三');
    expect(queue.pending()).toBe(false);
    expect(log).toEqual(['show:叫什么名字？', 'echo:张三']);
  });

  it('FIFO：同时两问，第一问先占屏，答案不串线', async () => {
    const { io, log } = recorder();
    const queue = createPromptQueue(io);
    const first = queue.ask('第一问');
    const second = queue.ask('第二问');
    // 只有第一问上屏；第二问在排队
    expect(log).toEqual(['show:第一问']);
    expect(queue.handleSubmit('答一')).toBe(true);
    await expect(first).resolves.toBe('答一');
    // 第二问随即占屏
    expect(log).toEqual(['show:第一问', 'echo:答一', 'show:第二问']);
    expect(queue.handleSubmit('答二')).toBe(true);
    await expect(second).resolves.toBe('答二');
  });

  it('prompt 期间命令文本也消费为答案（占屏优先于命令路由）', async () => {
    const { io } = recorder();
    const queue = createPromptQueue(io);
    const answer = queue.ask('确认？[y/n]');
    // 用户在 prompt 期输入 '/help' —— 这是答案不是命令
    expect(queue.handleSubmit('/help')).toBe(true);
    await expect(answer).resolves.toBe('/help');
    expect(queue.pending()).toBe(false);
  });
});
