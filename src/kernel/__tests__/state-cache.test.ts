/**
 * StateCache 单元测试 — 验证统一状态缓存的核心行为。
 *
 * 覆盖场景：
 *   1. 基本 set/get/delete
 *   2. 命名空间隔离
 *   3. deleteByKey / deleteByNamespace 批量清理
 *   4. JSON 序列化/反序列化
 *   5. 覆盖写入
 *   6. has / keys / size 查询
 *   7. 清空所有状态
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StateCache } from '../../kernel/state-cache.js';

describe('StateCache', () => {
  let cache: StateCache;

  beforeEach(() => {
    cache = new StateCache();
  });

  // ─── 基本读写 ───

  it('应该能 set 和 get 值', () => {
    cache.set('intent_anchor', 'sess-1', { goal: '改密码' });
    const result = cache.get<{ goal: string }>('intent_anchor', 'sess-1');
    expect(result).toEqual({ goal: '改密码' });
  });

  it('get 不存在的 key 应返回 undefined', () => {
    expect(cache.get('intent_anchor', 'nonexistent')).toBeUndefined();
  });

  it('get 不存在的 namespace 应返回 undefined', () => {
    cache.set('other', 'key', 'value');
    expect(cache.get('nonexistent', 'key')).toBeUndefined();
  });

  // ─── 命名空间隔离 ───

  it('不同 namespace 可以有相同的 key 但值独立', () => {
    cache.set('intent_anchor', 'sess-1', { goal: 'A' });
    cache.set('correction', 'sess-1', { instruction: '纠偏A' });
    cache.set('behavior_note', 'sess-1', '不要读 .env');

    expect(cache.get<{ goal: string }>('intent_anchor', 'sess-1')?.goal).toBe('A');
    expect(cache.get<{ instruction: string }>('correction', 'sess-1')?.instruction).toBe('纠偏A');
    expect(cache.get<string>('behavior_note', 'sess-1')).toBe('不要读 .env');
  });

  // ─── 删除操作 ───

  it('delete 应移除指定条目', () => {
    cache.set('correction', 'sess-1:t-1', { instruction: 'test' });
    cache.delete('correction', 'sess-1:t-1');
    expect(cache.get('correction', 'sess-1:t-1')).toBeUndefined();
  });

  it('delete 不存在的 key 不应报错', () => {
    expect(() => cache.delete('nonexistent', 'key')).not.toThrow();
  });

  it('delete 应清理空命名空间', () => {
    cache.set('test', 'k1', 'v1');
    cache.delete('test', 'k1');
    expect(cache.size('test')).toBe(0);
  });

  // ─── 批量清理 ───

  it('deleteByKey 应清除所有 namespace 下的指定 key', () => {
    cache.set('intent_anchor', 'sess-1', 'A');
    cache.set('correction', 'sess-1', 'B');
    cache.set('behavior_note', 'sess-1', 'C');
    cache.set('intent_anchor', 'sess-2', 'D'); // 不同的 key，不应被删除

    cache.deleteByKey('sess-1');

    expect(cache.get('intent_anchor', 'sess-1')).toBeUndefined();
    expect(cache.get('correction', 'sess-1')).toBeUndefined();
    expect(cache.get('behavior_note', 'sess-1')).toBeUndefined();
    expect(cache.get('intent_anchor', 'sess-2')).toBe('D');
  });

  it('deleteByNamespace 应清除整个 namespace', () => {
    cache.set('correction', 'sess-1:t-1', 'A');
    cache.set('correction', 'sess-1:t-2', 'B');
    cache.set('correction', 'sess-2:t-1', 'C');

    cache.deleteByNamespace('correction');

    expect(cache.get('correction', 'sess-1:t-1')).toBeUndefined();
    expect(cache.get('correction', 'sess-1:t-2')).toBeUndefined();
    expect(cache.get('correction', 'sess-2:t-1')).toBeUndefined();
  });

  // ─── JSON 序列化 ───

  it('应该正确序列化和反序列化复杂对象', () => {
    const complex = {
      instruction: '不要修改 .env',
      severity: 'high' as const,
      scopeUpdate: {
        blockPaths: ['.env', 'config/'],
        blockTools: ['write_file'],
      },
      createdAt: Date.now(),
    };
    cache.set('correction', 'sess-1:t-1', complex);
    const result = cache.get<typeof complex>('correction', 'sess-1:t-1');
    expect(result).toEqual(complex);
  });

  it('应该正确处理数组值', () => {
    cache.set('test', 'arr', [1, 2, 3]);
    expect(cache.get<number[]>('test', 'arr')).toEqual([1, 2, 3]);
  });

  // ─── 覆盖写入 ───

  it('set 同一个 key 应覆盖旧值', () => {
    cache.set('test', 'key', 'old');
    cache.set('test', 'key', 'new');
    expect(cache.get('test', 'key')).toBe('new');
  });

  // ─── 查询方法 ───

  it('has 应正确判断条目是否存在', () => {
    expect(cache.has('test', 'key')).toBe(false);
    cache.set('test', 'key', 'value');
    expect(cache.has('test', 'key')).toBe(true);
  });

  it('keys 应返回指定 namespace 下的所有 key', () => {
    cache.set('test', 'k1', 'v1');
    cache.set('test', 'k2', 'v2');
    cache.set('other', 'k3', 'v3');

    const keys = cache.keys('test');
    expect(keys).toEqual(expect.arrayContaining(['k1', 'k2']));
    expect(keys).toHaveLength(2);
  });

  it('size 应返回正确的条目数量', () => {
    expect(cache.size('test')).toBe(0);
    cache.set('test', 'k1', 'v1');
    cache.set('test', 'k2', 'v2');
    expect(cache.size('test')).toBe(2);
    cache.delete('test', 'k1');
    expect(cache.size('test')).toBe(1);
  });

  // ─── 清空 ───

  it('clear 应清除所有状态', () => {
    cache.set('ns1', 'k1', 'v1');
    cache.set('ns2', 'k2', 'v2');
    cache.clear();
    expect(cache.get('ns1', 'k1')).toBeUndefined();
    expect(cache.get('ns2', 'k2')).toBeUndefined();
    expect(cache.size('ns1')).toBe(0);
    expect(cache.size('ns2')).toBe(0);
  });
});
