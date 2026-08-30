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

/** 记录型出屏回调 + dismiss（刀 A 撤销说明行） */
function recorderWithDismiss() {
  const log: string[] = [];
  const io: PromptIo = {
    show: (q) => log.push(`show:${q}`),
    echo: (a) => log.push(`echo:${a}`),
    dismiss: (q, reason) => log.push(`dismiss:${q}:${reason}`),
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

  /* ---- 刀 A：per-ask 撤销面（channels 批——验收 a/a2/b） ---- */

  it('刀 A (a)：在身提问 abort = resolve undefined + dismiss 撤销说明行 + 输入框释放；后续提问接续出队', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    const controller = new AbortController();
    const first = queue.ask('在身问题', { signal: controller.signal });
    const second = queue.ask('接续问题');
    expect(queue.pending()).toBe(true);
    // abort reason 字符串承载撤销说明文案（如「该审批已在网页端应答」）
    controller.abort('该审批已在网页端应答');
    await expect(first).resolves.toBeUndefined();
    // 输入框释放 + dismiss 撤销说明行上屏（文案 = reason）+ 排队者接续占屏
    expect(queue.pending()).toBe(true); // second 已接续在身
    expect(log).toEqual(['show:在身问题', 'dismiss:在身问题:该审批已在网页端应答', 'show:接续问题']);
    // 接续者可正常应答（撤销不毒队列）
    expect(queue.handleSubmit('接续答案')).toBe(true);
    await expect(second).resolves.toBe('接续答案');
  });

  it('刀 A (a)：waiting 提问 abort = resolve undefined + 静默出队（无 dismiss 行——从未上屏无屏可收）', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    const controller = new AbortController();
    const current = queue.ask('在身问题');
    const waiting = queue.ask('排队问题', { signal: controller.signal });
    controller.abort('已在网页端应答');
    await expect(waiting).resolves.toBeUndefined();
    // 在身者不受牵连（撤销是 per-ask 的，不是 cancelAll）
    expect(queue.pending()).toBe(true);
    // 答掉在身后 advance 直取后续——已撤销的 waiting 不再占屏（静默出队）
    expect(queue.handleSubmit('答案')).toBe(true);
    await expect(current).resolves.toBe('答案');
    expect(queue.pending()).toBe(false);
    expect(log).toEqual(['show:在身问题', 'echo:答案']);
  });

  it('刀 A (a)：无 reason 的 abort（无参 abort() 缺省 DOMException）回落通用撤销文案', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    const controller = new AbortController();
    const p = queue.ask('问题', { signal: controller.signal });
    controller.abort();
    await expect(p).resolves.toBeUndefined();
    expect(log).toEqual(['show:问题', 'dismiss:问题:该提问已被撤销']);
  });

  it('刀 A (a2)：预置已 abort 的 signal 传入 ask = 同步取消结算——不 enqueue 不占屏（三态降级链命中面）', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    const controller = new AbortController();
    controller.abort('该审批已在网页端应答');
    const p = queue.ask('降级链的 confirm 提问', { signal: controller.signal });
    // 同步结算（不 enqueue 不占屏）：无 show 行、pending 仍 false、无 dismiss 行
    await expect(p).resolves.toBeUndefined();
    expect(queue.pending()).toBe(false);
    expect(log).toEqual([]);
    // 队列未受污染：后续提问照常占屏应答
    const next = queue.ask('正常提问');
    expect(log).toEqual(['show:正常提问']);
    expect(queue.handleSubmit('正常答案')).toBe(true);
    await expect(next).resolves.toBe('正常答案');
  });

  it('刀 A (b)：已应答提问的事后 abort = no-op（值不改、无二次撤销行）；迟到 abort 不误伤后续在身提问', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    const controller = new AbortController();
    const first = queue.ask('第一问', { signal: controller.signal });
    expect(queue.handleSubmit('已答')).toBe(true);
    await expect(first).resolves.toBe('已答');
    // 应答先结算：迟到 abort 落在已结算提问上 = no-op
    controller.abort('迟到撤销');
    // 关键回归锁：监听已随结算摘除——abort 不触发 dismiss 路径、不误上撤销行；
    // 且第二问（此刻在身，settled=false）不受 stale 信号影响（信号属第一问）
    const second = queue.ask('第二问');
    expect(queue.pending()).toBe(true);
    expect(log).toEqual(['show:第一问', 'echo:已答', 'show:第二问']);
    expect(queue.handleSubmit('二答')).toBe(true);
    await expect(second).resolves.toBe('二答');
  });

  it('刀 A (b)：cancelAll 收场后的事后 abort = no-op（任何结算路径都摘监听）', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    const controller = new AbortController();
    const p = queue.ask('问题', { signal: controller.signal });
    queue.cancelAll();
    await expect(p).resolves.toBeUndefined();
    controller.abort('迟到撤销');
    // cancelAll 路径已摘监听：无 dismiss 行（cancelAll 本就不出 dismiss——非 abort 路）
    expect(log).toEqual(['show:问题']);
  });

  it('刀 A (c)：无 signal ask 行为不变（回归——既有语义零漂移）', async () => {
    const { io, log } = recorderWithDismiss();
    const queue = createPromptQueue(io);
    // 传 signal: undefined 显式形态也同（结构里 undefined = 缺省）
    const p = queue.ask('无信号问题', { signal: undefined });
    expect(log).toEqual(['show:无信号问题']);
    expect(queue.handleSubmit('答')).toBe(true);
    await expect(p).resolves.toBe('答');
  });
});
