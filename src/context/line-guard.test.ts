/**
 * L1 context 单元测试 — NDJSON 行帧字节帽共享件 LineByteGuard。
 *
 * 覆盖：好行零干扰（帽下流量原样过）、单行跨 chunk 累计超限封读、多行同
 * chunk 不误封（逐段过账语义）、恰达帽不封（严格大于）、封读后残余 data
 * 不过账、onSeal 回调先于 destroy 同步跑、字符串 chunk 折字节面计数。
 *
 * 机制背景（契约篇 §1.7 行帧卫生件①；共享件化 = 遗漏大扫 20260903 runtime
 * D1-1）：bridge port-stdio 与 mcp client 两消费面同源——本套即两消费面共同
 * 的行为锁（消费面各自只测接线编舞，计数语义锁在这里）。
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { LineByteGuard, DEFAULT_MAX_LINE_BYTES } from './line-guard.js';

/** 封读事件记录面（overBytes + 时序戳——destroy 前后用序号对证） */
interface SealRecord {
  readonly overBytes: number;
  readonly maxLineBytes: number;
  /** 回调时刻的流 destroyed 状态（false = 回调先于 destroy——契约） */
  readonly streamDestroyedAtCallback: boolean;
}

/** 造一条带记录面的守卫流对（PassThrough 模拟 child.stdout） */
function makeGuarded(maxLineBytes: number): { stream: PassThrough; guard: LineByteGuard; seals: SealRecord[] } {
  const stream = new PassThrough();
  const seals: SealRecord[] = [];
  const guard = new LineByteGuard(stream, {
    maxLineBytes,
    onSeal: (overBytes, cap) =>
      seals.push({ overBytes, maxLineBytes: cap, streamDestroyedAtCallback: stream.destroyed }),
  });
  return { stream, guard, seals };
}

describe('LineByteGuard — 好流量零干扰', () => {
  it('帽下多行流量不封读、isSealed 恒 false', () => {
    const { stream, guard, seals } = makeGuarded(100);
    stream.write('line-one\nline-two\n');
    stream.write('line-three');
    expect(guard.isSealed).toBe(false);
    expect(seals).toEqual([]);
  });

  it('缺省上限 = 8MiB（契约篇 §1.7 行帧卫生件①）', () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('LineByteGuard — 单行超限封读', () => {
  it('单 chunk 单行超限：封读 + onSeal 携累计字节 + 流 destroy', () => {
    const { stream, guard, seals } = makeGuarded(64);
    stream.write(`${'a'.repeat(65)}\n`);
    expect(guard.isSealed).toBe(true);
    expect(seals).toHaveLength(1);
    expect(seals[0]!.overBytes).toBe(65); // 完成行全长（换行不计）
    expect(seals[0]!.maxLineBytes).toBe(64);
    expect(seals[0]!.streamDestroyedAtCallback).toBe(false); // 回调先于 destroy（记账面在流死前可跑）
    expect(stream.destroyed).toBe(true);
  });

  it('跨 chunk 累计：每段都帽下、累计超限即封（无换行续账）', () => {
    const { stream, guard, seals } = makeGuarded(100);
    stream.write('a'.repeat(60)); // 60 < 100 不封
    expect(guard.isSealed).toBe(false);
    stream.write('b'.repeat(60)); // 累计 120 > 100 封
    expect(guard.isSealed).toBe(true);
    expect(seals[0]!.overBytes).toBe(120);
  });

  it('恰达帽不封（严格大于才执法）', () => {
    const { stream, guard, seals } = makeGuarded(64);
    stream.write(`${'a'.repeat(64)}\n`); // 恰 64 = 帽值
    expect(guard.isSealed).toBe(false);
    expect(seals).toEqual([]);
  });

  it('多行同 chunk 不误封：两行各帽下、总跨度超帽（逐段过账语义）', () => {
    const { stream, guard, seals } = makeGuarded(50);
    // 同 chunk 内 40 字节行 + 换行 + 45 字节行——整体跨度 86 > 50，但每行
    // 各在帽下：整体算的旧形会把好流量误封（20260902 #9 实证修法）
    stream.write(`${'a'.repeat(40)}\n${'b'.repeat(45)}\n`);
    expect(guard.isSealed).toBe(false);
    expect(seals).toEqual([]);
  });

  it('行完成点超限即封（换行收尾的完成行，非只尾段执法）', () => {
    const { stream, guard, seals } = makeGuarded(64);
    // 65 字节 + 换行同 chunk：完成行全长 65 > 64——在换行处执法
    stream.write(`${'a'.repeat(65)}\n`);
    expect(guard.isSealed).toBe(true);
    expect(seals[0]!.overBytes).toBe(65);
  });
});

describe('LineByteGuard — 封读后残余窗', () => {
  it('封读后后续 data 不过账、onSeal 不重入（一次性）', () => {
    const { stream, guard, seals } = makeGuarded(10);
    stream.write('x'.repeat(11)); // 封
    expect(seals).toHaveLength(1);
    // PassThrough destroy 后 write 内部缓冲不再触发 data（残余窗模拟：高水位
    // 缓冲已收未派的 chunk）——再写不产生第二次封读
    stream.write('y'.repeat(999));
    expect(seals).toHaveLength(1);
    expect(guard.isSealed).toBe(true);
  });
});

describe('LineByteGuard — chunk 形态', () => {
  it('字符串 chunk 折 UTF-8 字节面计数（多字节字符按字节非字符数）', () => {
    const { stream, guard, seals } = makeGuarded(10);
    // '中' = 3 字节 × 4 = 12 字节（字符数仅 4——字符面计数会漏判）
    stream.write('中中中中');
    expect(guard.isSealed).toBe(true);
    expect(seals[0]!.overBytes).toBe(12);
  });

  it('Buffer chunk 字节面直计', () => {
    const { stream, guard, seals } = makeGuarded(10);
    stream.write(Buffer.from('ab')); // 2 字节不封
    expect(guard.isSealed).toBe(false);
    stream.write(Buffer.concat([Buffer.from('c'.repeat(9))])); // 累计 11 > 10
    expect(guard.isSealed).toBe(true);
    expect(seals[0]!.overBytes).toBe(11);
  });
});
