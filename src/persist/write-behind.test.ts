/**
 * L1 persist 单元测试（write-behind + 门面半边）——批量窗口 / per-session 串行 /
 * 失败保留批次暂停重试 / createSession-loadSession 往返 / 恢复协议持久化。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSIST_BATCH_WRITE_FAILED } from '../contracts/errors.js';
import { Persistence } from './index.js';
import { WriteBehind } from './write-behind.js';
import type { Store } from './store.js';
import { Session } from '../session/index.js';

/** 临时库目录 */
let dir: string;
let seq = 0;
const nextPath = (): string => join(dir, `wb-${seq++}.db`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'persist-wb-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 临时等待（窗口触发用；不依赖 fake timers 以贴近真实行为） */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Persistence 门面：接线与往返', () => {
  it('createSession → append → 窗口自动落盘；close 后重开可 loadSession', async () => {
    const path = nextPath();
    const p = Persistence.open({ path, windowMs: 20 });
    const s = p.createSession({ cwd: '/tmp/work' });
    s.append('turn/start', {});
    s.append('user/message', { content: '第一句' });
    s.append('assistant/message', { content: [{ type: 'text', text: '收到' }] });
    s.append('turn/end', { reason: 'completed' });
    // 窗口自动落盘（不等显式 flush）
    await sleep(60);
    await p.close();

    // 重开恢复：事件全量往返 + 血缘 header 还原
    const p2 = Persistence.open({ path });
    const restored = p2.loadSession(s.header.sessionId);
    expect(restored).toBeDefined();
    expect(restored!.events.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ]);
    expect(restored!.header.sessionId).toBe(s.header.sessionId);
    expect(restored!.header.origin).toBe('user');
    expect(p2.store.sessionRow(s.header.sessionId)?.cwd).toBe('/tmp/work');
    await p2.close();
  });

  it('flush 屏障：返回时数据已持久（无需等窗口）', async () => {
    const p = Persistence.open({ path: nextPath(), windowMs: 10_000 }); // 长窗口：只能靠屏障
    const s = p.createSession();
    s.append('user/message', { content: 'barrier' });
    await p.flush(); // 屏障先于窗口
    const row = p.store.sessionRow(s.header.sessionId);
    expect(row).toBeDefined();
    expect(p.store.loadEvents(s.header.sessionId)).toHaveLength(1);
    await p.close();
  });

  it('恢复协议持久化：中断会话 loadSession → recover → flush → 重读闭合且幂等', async () => {
    const path = nextPath();
    const p = Persistence.open({ path, windowMs: 20 });
    const s = p.createSession();
    s.append('turn/start', {});
    s.append('user/message', { content: '跑个工具' });
    s.append('tool/call', { toolCallId: 'tc-1', name: 'bash', arguments: '{}' });
    // 模拟崩溃：不闭合，窗口内强 flush 后直接关停
    await p.flush(s.header.sessionId);
    await p.close();

    const p2 = Persistence.open({ path, windowMs: 20 });
    const s2 = p2.loadSession(s.header.sessionId)!;
    const appended = s2.recoverFromInterruption();
    expect(appended.map((e) => e.type)).toEqual(['tool/result', 'turn/end']);
    await p2.flush(s.header.sessionId);
    await p2.close();

    // 再读：合成事件已在库中，恢复幂等（第二遍不追加）
    const p3 = Persistence.open({ path });
    const s3 = p3.loadSession(s.header.sessionId)!;
    expect(s3.recoverFromInterruption()).toEqual([]);
    const tail = s3.events.slice(-2).map((e) => e.type);
    expect(tail).toEqual(['tool/result', 'turn/end']);
    await p3.close();
  });

  it('fork 子会话持久化：种子物理复制到子会话名下，seedLength 血缘以 sessions 表为准', async () => {
    const path = nextPath();
    const p = Persistence.open({ path, windowMs: 20 });
    const parent = p.createSession({ cwd: '/tmp/parent' });
    parent.append('turn/start', {});
    parent.append('user/message', { content: 'q' });
    parent.append('turn/end', { reason: 'completed' });
    await p.flush(parent.header.sessionId);

    // 经门面 fork：接线到子会话自身队列；裸 fork 无 emit（session 层契约）
    const child = p.forkSession(parent); // seedLength = 4（3 前缀 + end-seed）
    child.append('user/message', { content: '子会话第一句' }); // 活区事件 seq=4
    await p.flush(child.header.sessionId);
    await p.close();

    const p2 = Persistence.open({ path });
    const back = p2.loadSession(child.header.sessionId)!;
    expect(back.length).toBe(5); // 4 种子 + 1 活区
    expect(back.header.seedLength).toBe(4); // 血缘边界不因种子数组变长而漂移
    expect(back.events.slice(4).map((e) => e.type)).toEqual(['user/message']);
    // 子会话自包含：种子在子会话名下，不依赖父会话行
    expect(p2.store.countEvents(child.header.sessionId)).toBe(5);
    expect(p2.store.sessionRow(child.header.sessionId)?.parent_session).toBe(parent.header.sessionId);
    // 元数据继承：cwd 随血缘带下（forkSession 缺省继承父会话）
    expect(p2.store.sessionRow(child.header.sessionId)?.cwd).toBe('/tmp/parent');
    await p2.close();
  });

  it('跨会话并行互不阻塞：flush() 全量屏障覆盖多个会话', async () => {
    const p = Persistence.open({ path: nextPath(), windowMs: 20 });
    const a = p.createSession();
    const b = p.createSession();
    a.append('user/message', { content: 'a1' });
    b.append('user/message', { content: 'b1' });
    a.append('user/message', { content: 'a2' });
    await p.flush();
    expect(p.store.loadEvents(a.header.sessionId)).toHaveLength(2);
    expect(p.store.loadEvents(b.header.sessionId)).toHaveLength(1);
    await p.close();
  });
});

describe('write-behind 失败语义（响亮失败，不静默丢批）', () => {
  /** 可注入失败的 Store 替身（够 appendCore 语义即可） */
  function makeFlakyStore(failFirstN: { current: number }): Store {
    const real = Persistence.open({ path: nextPath(), windowMs: 60_000 });
    const store = real.store;
    const origAppend = store.appendCore.bind(store);
    (store as unknown as { appendCore: Store['appendCore'] }).appendCore = (reg, batch, inc) => {
      if (failFirstN.current > 0) {
        failFirstN.current--;
        throw new Error('模拟磁盘错误');
      }
      return origAppend(reg, batch, inc);
    };
    return store;
  }

  it('失败：批次保留 + 暂停自动重试 + onError 上报；显式 flush 重试成功', async () => {
    const flaky = { current: 1 };
    const store = makeFlakyStore(flaky);
    const onError = vi.fn();
    const wb = new WriteBehind(store, 'inc-test', { windowMs: 20, onError });
    const session = new Session({ sessionId: 's-fail' });
    wb.enqueue(session, session.append('user/message', { content: 'x1' }));
    wb.enqueue(session, session.append('user/message', { content: 'x2' }));
    // 窗口触发 → 写入失败 → 暂停
    await sleep(60);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].code).toBe(PERSIST_BATCH_WRITE_FAILED);
    expect(wb.isPaused).toBe(true);
    expect(store.loadEvents('s-fail')).toHaveLength(0); // 未落盘

    // 暂停后新事件只排队不自动重试
    wb.enqueue(session, session.append('user/message', { content: 'x3' }));
    await sleep(60);
    expect(store.loadEvents('s-fail')).toHaveLength(0);

    // 显式 flush 重试（故障已移除）：三事件按序全量落盘
    await wb.flush();
    const stored = store.loadEvents('s-fail');
    expect(stored.map((e) => (e.data as { content: string }).content)).toEqual(['x1', 'x2', 'x3']);
    await wb.close();
    store.close();
  });

  // 部分写裁剪（契约篇 §1.6 资源护栏族 #13 **强制不变式**，2026-08-27 刀〇b）：
  // appendCore 片化后「已提交片保持 durable」——失败回队只回未写部分（库内
  // maxSeq 是事实源）。修前全批原样回放，重试批首 seq 撞片首 cursor 连续性
  // 校验 SESSION_WRITE_CONFLICT，该会话队列永久卡死（m-5 冷读死锁陷阱）。
  it('部分写裁剪：片失败只回队未写部分，flush 重试不撞 cursor（不重不丢）', async () => {
    // 替身形态：首次 appendCore 真写批前缀（模拟片 1 已提交）后抛错（模拟片 2 失败）
    const real = Persistence.open({ path: nextPath(), windowMs: 60_000 });
    const store = real.store;
    const origAppend = store.appendCore.bind(store);
    let failedOnce = false;
    (store as unknown as { appendCore: Store['appendCore'] }).appendCore = (r, batch, inc) => {
      if (!failedOnce) {
        failedOnce = true;
        origAppend(r, batch.slice(0, 2), inc); // 片 1：前缀真提交（部分写如实）
        throw new Error('模拟片 2 失败');
      }
      return origAppend(r, batch, inc);
    };
    const onError = vi.fn();
    const wb = new WriteBehind(store, 'inc-test', { windowMs: 20, onError });
    const session = new Session({ sessionId: 's-partial' });
    for (let i = 0; i < 4; i++) {
      wb.enqueue(session, session.append('user/message', { content: `p${i}` }));
    }
    await sleep(60); // 窗口触发：前缀 2 条已 durable、后 2 条保留待重试
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].code).toBe(PERSIST_BATCH_WRITE_FAILED);
    expect(onError.mock.calls[0]![0].message).toContain('已写 2 条'); // 裁剪面如实上报
    expect(store.loadEvents('s-partial')).toHaveLength(2); // 片 1 durable 保持
    expect(wb.isPaused).toBe(true);

    // 显式 flush 重试（故障已移除）：只重 seq>1 尾部——修前此处撞 cursor 永久卡死
    await wb.flush();
    const stored = store.loadEvents('s-partial');
    expect(stored.map((e) => (e.data as { content: string }).content)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2, 3]); // 不重不丢
    await wb.close();
    store.close();
  });
});

describe('顺序保证', () => {
  it('per-session promise chain：单会话批量事件严格按 seq 落盘', async () => {
    const p = Persistence.open({ path: nextPath(), windowMs: 15 });
    const s = p.createSession();
    for (let i = 0; i < 50; i++) {
      s.append('user/message', { content: `m${i}` });
    }
    await p.flush(s.header.sessionId);
    const stored = p.store.loadEvents(s.header.sessionId);
    expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    await p.close();
  });
});
