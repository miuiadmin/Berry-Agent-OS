/**
 * L1 persist 单元测试（LruBoundedMap——per-session 键域 LRU 帽统策件，会话篇 §6
 * 「可重建性二分」）。三消费面（sessionMeta / ownBoundaries / memory epochs）共用，
 * 语义在此单点锁死：touch-on-use 续驻、超帽逐最旧闲置键、未命中零副作用。
 */

import { describe, expect, it } from 'vitest';
import { LruBoundedMap, SESSION_KEY_CAP } from './bounded-map.js';

describe('LruBoundedMap（LRU 帽统策件）', () => {
  it('超帽逐最旧闲置键（Map 迭代序 = 插入序即闲置序）', () => {
    const m = new LruBoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.set('d', 4); // 超帽：逐最旧的 a
    expect(m.size).toBe(3);
    expect(m.get('a')).toBeUndefined(); // 最旧被逐
    expect(m.get('b')).toBe(2);
    expect(m.get('d')).toBe(4);
  });

  it('get 命中即续驻（touch-on-use）——活跃键不因帽被逐', () => {
    const m = new LruBoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.get('a')).toBe(1); // touch：a 移到最新端
    m.set('d', 4); // 逐的是次旧的 b（非 touch 过的 a）
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBeUndefined();
  });

  it('set 已存键 = 覆写 + 续驻（同 touch 语义）', () => {
    const m = new LruBoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.set('a', 9); // touch + 覆写
    m.set('d', 4);
    expect(m.get('a')).toBe(9);
    expect(m.get('b')).toBeUndefined(); // 被逐的是 b
    expect(m.size).toBe(3);
  });

  it('get 未命中零副作用 + 家族帽值 256', () => {
    const m = new LruBoundedMap<string, number>(SESSION_KEY_CAP);
    expect(m.get('nope')).toBeUndefined();
    expect(m.size).toBe(0);
    // 家族值：jobs 终态帽（运行时骨架 §6.2）/ compaction 分账帽（会话篇 §2）同款
    expect(SESSION_KEY_CAP).toBe(256);
  });
});
