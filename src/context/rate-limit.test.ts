/**
 * L1 context 单元测试（RateLimiter 桶域有界——遗漏大扫 20260902-c #11，会话篇
 * §6「时间窗闲置 → 过期清扫」）。sessions 消费面 per-会话桶随会话开张只增不减，
 * daemon 常驻无界累积：闲置 ≥ 回填满桶时长（capacity/perMinute 分钟）的桶删除零损
 * ——惰性回填本会在下次扣费时补满，删后重建 = 满桶同态。清扫摊销：每 256 次
 * tryCharge 全表扫一次。perMinute=0（零回填）结构性免扫。
 *
 * 时钟：tryCharge 只读 Date.now——假钟 toFake:['Date'] 精确控制闲置时长（测试两坑
 * 备案手法）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from './rate-limit.js';

/** 桶域直读（any——纯结构断言面：清扫只动内部账不动扣费语义） */
const buckets = (rl: RateLimiter): Map<string, unknown> => (rl as unknown as { buckets: Map<string, unknown> }).buckets;

describe('RateLimiter 桶域过期清扫（遗漏大扫 20260902-c #11）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('闲置超阈的桶被摊销清扫删除；非闲置桶存活；删后扣费 = 满桶同态——修复前必红（桶永不清扫）', () => {
    // capacity=3, perMinute=3 → staleMs = (3/3) 分钟 = 60_000ms
    const rl = new RateLimiter({ capacity: 3, perMinute: 3 });
    rl.tryCharge('stale'); // t0 建桶扣 1（last = t0）
    vi.setSystemTime(1_060_000); // 闲置整 60s（≥ 阈）
    rl.tryCharge('fresh'); // t1 建桶（last = t1——非闲置）
    // 254 次填充扣费凑满 256 次节拍：第 256 次 tryCharge 触发全表扫
    for (let i = 0; i < 254; i++) rl.tryCharge(`filler-${i}`);
    expect(buckets(rl).has('stale')).toBe(false); // 修前必红：true（永不清扫）
    expect(buckets(rl).has('fresh')).toBe(true); // 非闲置不误伤
    // 删后重建 = 满桶同态（零损）：stale 可立即扣费
    expect(rl.tryCharge('stale')).toBe(true);
  });

  it('perMinute=0（零回填）结构性免扫：空桶永不被删（删空桶 = 白送突发容量）', () => {
    const rl = new RateLimiter({ capacity: 1, perMinute: 0 });
    expect(rl.tryCharge('z')).toBe(true); // 唯一令牌已花
    expect(rl.tryCharge('z')).toBe(false); // 桶空且永不回填
    vi.setSystemTime(1_000_000_000); // 任意久远
    for (let i = 0; i < 300; i++) rl.tryCharge(`filler-${i}`); // 远超 256 节拍
    expect(buckets(rl).has('z')).toBe(true); // 免扫：桶在场
    expect(rl.tryCharge('z')).toBe(false); // 语义保持：空桶即永空（删除则会白送一枚）
  });
});
