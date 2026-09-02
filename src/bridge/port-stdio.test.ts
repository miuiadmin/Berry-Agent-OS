/**
 * bridge — NDJSON 载体适配器单测（契约篇 §1.7 external 载体，external carrier 落码批）。
 *
 * 纯逻辑面（PassThrough 流对接双向——不 spawn 不 fork）：行协议往返 / 大
 * payload（PoC ⑩ 实证 1MiB 级单行无损）/ 坏行静默跳过 + 观测 / 监听器异常
 * 单点隔离 / 空行跳过。fork 域端到端（真子进程 stdio 管道）在
 * external-domain.test.ts。
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../contracts/errors.js';
import { StdioBridgePort } from './port-stdio.js';

/** 对接一对端口：两条 PassThrough 互为两向（A 读 BA 写 AB；B 读 AB 写 BA） */
function makePair(): { a: StdioBridgePort; b: StdioBridgePort } {
  const ab = new PassThrough(); // A→B 向
  const ba = new PassThrough(); // B→A 向
  return { a: new StdioBridgePort(ba, ab), b: new StdioBridgePort(ab, ba) };
}

/** 等下一帧（流异步面——Promise 化的到达等待） */
function nextMessage(port: StdioBridgePort, ms = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('消息超时未达')), ms);
    port.on('message', (m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
}

describe('StdioBridgePort — NDJSON 行协议（流对接）', () => {
  it('双向往返：一行一 JSON 消息，两向各自成立', async () => {
    const { a, b } = makePair();
    const gotB = nextMessage(b);
    const gotA = nextMessage(a);
    a.postMessage({ kind: 'ask', callId: 1, dir: 'a2b' });
    b.postMessage({ kind: 'result', callId: 9, dir: 'b2a' });
    await expect(gotB).resolves.toEqual({ kind: 'ask', callId: 1, dir: 'a2b' });
    await expect(gotA).resolves.toEqual({ kind: 'result', callId: 9, dir: 'b2a' });
  });

  it('大 payload：1MiB 级单行 JSON 过界无损（PoC ⑩——readline 无行长上限）', async () => {
    const { a, b } = makePair();
    const big = { kind: 'data', blob: 'x'.repeat(1024 * 1024) };
    const got = nextMessage(b);
    a.postMessage(big);
    const received = (await got) as typeof big;
    expect(received.blob.length).toBe(big.blob.length);
    expect(received.blob).toBe(big.blob);
  });

  it('消息字段 JSON 可编码面（PoC ②⑥：symbol 键存活数 = 0——协议纪律单点）', async () => {
    // session.ts 头注纪律：消息一切字段必须 JSON 可编码。本协议面与结构化
    // 克隆通道（worker 腿）等价的判据 = payload 恒纯 JSON 形。
    const { a, b } = makePair();
    const got = nextMessage(b);
    a.postMessage({ at: '2026-08-29T00:00:00.000Z', nested: { list: [1, 2, { ok: true }], none: null } });
    await expect(got).resolves.toEqual({
      at: '2026-08-29T00:00:00.000Z',
      nested: { list: [1, 2, { ok: true }], none: null },
    });
  });

  it('坏行静默跳过 + onBadLine 观测：后续好行仍达（通道活性优先）', async () => {
    // 自持入站流——直接写原始字节模拟对端协议 bug / 管道撕裂形态
    const inbound = new PassThrough();
    const badSeen: string[] = [];
    const port = new StdioBridgePort(inbound, new PassThrough(), {
      onBadLine: (line) => badSeen.push(line),
    });
    const goodArrive = nextMessage(port);
    inbound.write('{broken\n');
    inbound.write('{"kind":"still-alive"}\n');
    await expect(goodArrive).resolves.toEqual({ kind: 'still-alive' });
    expect(badSeen).toEqual(['{broken']);
  });

  it('监听器异常不阻断其余监听器（与宿主 emit 单点隔离同纪律）', async () => {
    const { a, b } = makePair();
    const second = vi.fn();
    const got = nextMessage(b);
    b.on('message', () => {
      throw new Error('第一个监听器炸了——不得影响第二个');
    });
    b.on('message', second);
    a.postMessage({ kind: 'isolate' });
    await got;
    expect(second).toHaveBeenCalledWith({ kind: 'isolate' });
  });

  it('空行跳过（通道 idle 形态不进 JSON.parse）', async () => {
    const inbound = new PassThrough();
    const port = new StdioBridgePort(inbound, new PassThrough());
    const got = nextMessage(port);
    inbound.write('\n   \n');
    inbound.write('{"kind":"after-blank"}\n');
    await expect(got).resolves.toEqual({ kind: 'after-blank' });
  });

  it('【回归锁】单行字节超上限：封读 destroy + onBadLine 合成错误 + 后续行不派发（遗漏大扫 20260902 #9）', async () => {
    // 修前红位：无 maxLineBytes 执法——超限行照常缓冲派发、inbound 不 destroy、
    // onBadLine 零调用。修后：字节计数流面在行完成前截获（跨 chunk 累计）
    const inbound = new PassThrough();
    const badSeen: Array<{ line: string; err: unknown }> = [];
    const port = new StdioBridgePort(inbound, new PassThrough(), {
      maxLineBytes: 64,
      onBadLine: (line, err) => badSeen.push({ line, err }),
    });
    const got: unknown[] = [];
    port.on('message', (m) => got.push(m));
    inbound.write('{"ok":"small"}\n'); // 帽下好行照常过
    inbound.write('x'.repeat(100)); // 无换行跨上限——计数器封读（不待行完成）
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(got).toEqual([{ ok: 'small' }]);
    expect(badSeen).toHaveLength(1);
    expect(String(badSeen[0]!.err)).toContain('超上限');
    expect(inbound.destroyed).toBe(true); // 载体级失败：封读（通道死）
  });

  it('【回归锁】跨 chunk 累计与帽边界（遗漏大扫 20260902 #9）：分块凑超限同封；恰在帽下的行照常进 parse 路径', async () => {
    // 分块累计：单块 40B 帽下、两块合计 80B 超帽——计数器按「距上一换行累计」执法
    const inboundA = new PassThrough();
    const portA = new StdioBridgePort(inboundA, new PassThrough(), { maxLineBytes: 64 });
    const gotA: unknown[] = [];
    portA.on('message', (m) => gotA.push(m));
    inboundA.write('y'.repeat(40));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inboundA.destroyed).toBe(false); // 单块未超——通道活
    inboundA.write('y'.repeat(40)); // 合计 80B 超帽
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inboundA.destroyed).toBe(true);

    // 帽边界：恰 64B 的行不触发封读——计数达帽（running=64）不超（严格大于才
    // 执法），补换行后照常走 parse 坏行路径（garbage 内容 → onBadLine 真行）
    const inboundB = new PassThrough();
    const badB: string[] = [];
    // 构造即接线（计数监听 + readline）——不持引用，onBadLine 闭包自证
    new StdioBridgePort(inboundB, new PassThrough(), {
      maxLineBytes: 64,
      onBadLine: (line) => badB.push(line),
    });
    const line64 = 'z'.repeat(64); // 先无换行写 64B——running 恰达帽（不封）
    inboundB.write(line64);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inboundB.destroyed).toBe(false); // 恰达帽未超——通道活
    inboundB.write('\n'); // 换行重置——行照常emit
    inboundB.write('{"tail":1}\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inboundB.destroyed).toBe(false); // 帽下生命周期完整——不封读
    expect(badB).toEqual([line64]); // 走 parse 坏行观测（非超限合成错误）
  });

  it('编码失败打型（20260901-c #4）：BigInt 载荷 → AppError(BRIDGE_ENCODE_FAILED) 上抛（消息级——载体健康，好消息照常过界）', async () => {
    const { a } = makePair();
    // BigInt 过不了 JSON.stringify：修前裸 TypeError 上抛（端点无从分桶）
    try {
      a.postMessage({ kind: 'ask', args: [1n] });
      expect.unreachable('预期编码失败上抛');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('BRIDGE_ENCODE_FAILED');
      expect((err as AppError).message).toContain('BigInt');
    }
    // 载体本身健康：同向好消息照常过界（打型不伤通道）
    const { a: a2, b } = makePair();
    const got = nextMessage(b);
    a2.postMessage({ kind: 'fine', v: 1 });
    await expect(got).resolves.toEqual({ kind: 'fine', v: 1 });
  });
});
