/**
 * L0 contracts — 活体事件目录自检（LIVE_EVENT_CATALOG 自身不变量）。
 *
 * 目录与 src 派发点的三族双向断言在 tools/check-events.mjs（CI 面，挂
 * lint:topology）；此处只锁目录自身的完整性——名字唯一、格式闭集、mode 闭集、
 * 查询面可用。目录是插件作者的公开契约（契约篇 §6.3 第 4 条），先自洽才谈对外。
 */

import { describe, expect, it } from 'vitest';
import { LIVE_EVENT_CATALOG, findLiveEvent } from './events.js';

describe('LIVE_EVENT_CATALOG 目录自检', () => {
  it('名字唯一且全符合词汇格式（小写段 + 下划线/斜线）', () => {
    const names = LIVE_EVENT_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length); // 重名 = 目录自身漂移
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)*$/);
    }
  });

  it('mode 全在四模式闭集；note 非空（目录生成物的最低质量线）', () => {
    for (const entry of LIVE_EVENT_CATALOG) {
      expect(['emit', 'waterfall', 'parallel', 'serial']).toContain(entry.mode);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('findLiveEvent 查询面：命中返回定义、未命中 undefined', () => {
    expect(findLiveEvent('tools_change')?.mode).toBe('emit');
    expect(findLiveEvent('nope/never')).toBeUndefined();
  });
});
