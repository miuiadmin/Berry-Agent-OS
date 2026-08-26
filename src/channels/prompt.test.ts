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

  it('prompt 期间命令文本也消费为答案（队列面语义——命令路由在通道 onSubmit 层先行）', async () => {
    const { io } = recorder();
    const queue = createPromptQueue(io);
    const answer = queue.ask('确认？[y/n]');
    // 队列不知命令：任何文本（含 / 前缀）到 handleSubmit 即答案。S5 序翻转后
    // tui onSubmit 先派发斜杠命令（prompt 期 /quit 可达），能到这里的非命令文本
    // 才被消费——本测锁队列自身的消费语义（消费方含子代理结算通知等内部提问）
    expect(queue.handleSubmit('/help')).toBe(true);
    await expect(answer).resolves.toBe('/help');
    expect(queue.pending()).toBe(false);
  });

  it('S5 两级出队：background 先排、interactive 后排先出——后台问不队头阻塞用户在场的对话', async () => {
    const { io, log } = recorder();
    const queue = createPromptQueue(io);
    const current = queue.ask('在身问题');
    // 在身未答时排入三问：background 先排、两个 interactive 后排
    const bg = queue.ask('后台任务的确认', { priority: 'background' });
    const int1 = queue.ask('用户第一问');
    const int2 = queue.ask('用户第二问');
    // 答掉在身——advance 从 [bg, int1, int2] 取**最早的 interactive**（int1 先出，
    // bg 不插队但不被压死；同级 FIFO）
    queue.handleSubmit('x');
    await expect(current).resolves.toBe('x');
    expect(log.slice(-1)).toEqual(['show:用户第一问']);
    queue.handleSubmit('y');
    await expect(int1).resolves.toBe('y');
    // 下一个仍是 interactive（int2——bg 继续让位）
    expect(log.slice(-1)).toEqual(['show:用户第二问']);
    queue.handleSubmit('z');
    await expect(int2).resolves.toBe('z');
    // interactive 全清后才轮 background（不被压死）
    expect(log.slice(-1)).toEqual(['show:后台任务的确认']);
    queue.handleSubmit('w');
    await expect(bg).resolves.toBe('w');
    // 缺省 priority = interactive（不传者与显式同权）
    const implicit = queue.ask('缺省优先级问');
    queue.handleSubmit('v');
    await expect(implicit).resolves.toBe('v');
  });

  it('S5 取消收场（冷读闸 F5）：cancelAll 把在身 + 排队全部 resolve undefined（fail-closed）', async () => {
    const { io, log } = recorder();
    const queue = createPromptQueue(io);
    const current = queue.ask('在身问题');
    const waiting1 = queue.ask('排队一');
    const waiting2 = queue.ask('排队二', { priority: 'background' });
    queue.cancelAll();
    await expect(current).resolves.toBeUndefined();
    await expect(waiting1).resolves.toBeUndefined();
    await expect(waiting2).resolves.toBeUndefined();
    // 输入框占屏释放：后续提交走正常输入流（不再被消费为答案）
    expect(queue.pending()).toBe(false);
    expect(queue.handleSubmit('新消息')).toBe(false);
    // 幂等：无提问在身时 no-op 不炸
    expect(() => queue.cancelAll()).not.toThrow();
    // 取消不产生 echo 回显（未答即收——已上屏的 show 行不撤，只收 Promise）
    expect(log).toEqual(['show:在身问题']);
  });
});
