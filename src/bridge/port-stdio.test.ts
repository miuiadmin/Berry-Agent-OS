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
