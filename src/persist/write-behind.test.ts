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

  it('fork 子会话首队种子核对 SQL 容错（B8——第十一轮遗漏大扫 20260904-b，修前红：enqueue 位于 Session.append 推入内存日志之后，同步 countEvents 抛出即该事件永缺席持久化队列——后续批次建队留 seq 洞，重启 loadEvents 按撕裂尾截断丢活区尾部）', async () => {
    const path = nextPath();
    const p = Persistence.open({ path, windowMs: 10_000 }); // 长窗口：只走显式 flush，排除定时器竞速
    const parent = p.createSession();
    parent.append('turn/start', {});
    parent.append('user/message', { content: '前缀' });
    parent.append('turn/end', { reason: 'completed' });
    await p.flush(parent.header.sessionId);

    const child = p.forkSession(parent); // seedLength = 4（3 前缀 + end-seed），库内子会话零事件
    // 毒化 countEvents：仅对子会话、仅首段（模拟 WAL 争用窗 SQLITE_BUSY 超时）
    const origCountEvents = p.store.countEvents.bind(p.store);
    let poisoned = true;
    (p.store as unknown as { countEvents(id: string): number }).countEvents = (id: string) => {
      if (poisoned && id === child.header.sessionId) throw new Error('poisoned countEvents（模拟 SQLITE_BUSY）');
      return origCountEvents(id);
    };
    // 子会话首笔活体事件：enqueue 路径零 SQL 后不再上抛（修前：append 推日志后
    // emitLive → enqueue → pendingSeed → countEvents 同步抛出炸穿 append）
    expect(() => child.append('user/message', { content: '子会话首笔' })).not.toThrow();
    // 解除毒化：写路径核对（writeBatch 内）重试不再抛
    poisoned = false;
    await p.flush(child.header.sessionId);
    await p.close();

    // 重开全量往返：种子 + 首笔连续落库（无 seq 洞——撕裂尾修复不触发截断）
    const p2 = Persistence.open({ path });
    const back = p2.loadSession(child.header.sessionId)!;
    expect(back.length).toBe(5); // 4 种子 + 1 活区（修前红：毒化窗事件缺席 → 0 条）
    expect(back.events.slice(4).map((e) => e.type)).toEqual(['user/message']);
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

  // 【回归锁·2026-09-01 全面复盘 C-1】跨进程写者冲突：同库第二连接（模拟双开
  // 他进程）先占同 seq 段 → 本批**全量保留不裁剪**、文案如实点名外部成因。
  // 修前库内 maxSeq 被误认「本批已写」：本进程 5 条事件静默蒸发（remainder
  // 滤空）、文案谎报「已写 5 条」、重试错位续写他人日志——三方分叉。
  it('外部写者占用 seq 段：本批全量保留 + 文案分报外部冲突（不蒸发不谎报不错位）', async () => {
    const path = nextPath();
    const mine = Persistence.open({ path, windowMs: 60_000 }); // 本进程（A）——长窗不自动触发
    // 外部写者（B）：同库第二连接，同会话 seq 0-4 先行提交（双开他进程常态形）
    const other = Persistence.open({ path, windowMs: 60_000 });
    const extSession = new Session({ sessionId: 's-dual' });
    for (let i = 0; i < 5; i++) {
      extSession.append('user/message', { content: `他进程 ${i}` });
    }
    other.store.appendCore(
      { sessionId: 's-dual', origin: 'user', parentSession: undefined, seedLength: 0, delegationDepth: 0 },
      extSession.events,
      'inc-external',
    );
    expect(other.store.loadEvents('s-dual')).toHaveLength(5); // 外部行已在库

    // 本进程 A：同会话同 seq 段（0-4）排队 → 首片即撞 cursor 护栏
    const onError = vi.fn();
    const wb = new WriteBehind(mine.store, 'inc-mine', { windowMs: 20, onError });
    const session = new Session({ sessionId: 's-dual' });
    for (let i = 0; i < 5; i++) {
      wb.enqueue(session, session.append('user/message', { content: `本进程 ${i}` }));
    }
    await sleep(60); // 窗口触发 → SESSION_WRITE_CONFLICT（外部行占段）
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].code).toBe(PERSIST_BATCH_WRITE_FAILED);
    // 文案如实分报：点名外部写者成因，绝不把他人 5 行记成本批战果
    expect(onError.mock.calls[0]![0].message).toContain('外部写者');
    expect(onError.mock.calls[0]![0].message).not.toContain('已写 5 条');
    expect(wb.isPaused).toBe(true);

    // 本批全量保留（修前静默蒸发）：显式重试恒撞 cursor 再拒——队列里还有货
    await expect(wb.flush()).rejects.toThrow(/外部写者冲突/);
    expect(onError).toHaveBeenCalledTimes(2);
    // 不错位续写：库内仍是外部 5 行原样（本进程零行落库）
    expect(mine.store.loadEvents('s-dual')).toHaveLength(5);
    expect(mine.store.loadEvents('s-dual').map((e) => (e.data as { content: string }).content)).toEqual(
      extSession.events.map((e) => (e.data as { content: string }).content),
    );
    mine.store.close();
    other.store.close();
  });
  // 【回归锁·遗漏大扫 20260901-b #6】flush 重试成功后 paused 复位——自动调度恢复。
  // 修前：writeBatch 成功路径不复位 paused（唯一复位位 close()）——显式 flush 救回
  // 本批后自动落盘仍永久停摆，此后全部事件只排队不落盘（durable 退化机会性落盘，
  // 直到下一次显式 flush/close 兜底）。
  it('失败恢复：flush 重试成功后 paused 复位——后续事件自动落盘（不永久停摆）', async () => {
    const flaky = { current: 1 };
    const store = makeFlakyStore(flaky);
    const onError = vi.fn();
    const wb = new WriteBehind(store, 'inc-test', { windowMs: 20, onError });
    const session = new Session({ sessionId: 's-resume' });
    wb.enqueue(session, session.append('user/message', { content: 'r1' }));
    await sleep(60); // 窗口触发 → 失败 → paused
    expect(wb.isPaused).toBe(true);
    // 显式 flush 重试成功（故障已移除）
    await wb.flush();
    expect(store.loadEvents('s-resume')).toHaveLength(1);
    // 修前红：成功后 paused 仍 true——自动调度永久停摆
    expect(wb.isPaused).toBe(false);
    // 新事件经窗口自动落盘（无需再显式 flush）
    wb.enqueue(session, session.append('user/message', { content: 'r2' }));
    await sleep(60);
    expect(store.loadEvents('s-resume')).toHaveLength(2); // 修前红：仍 1（只排队不落盘）
    await wb.close();
    store.close();
  });

  it('跨会话恢复：他会话批次成功即解除全局暂停——积压队列即刻灌链', async () => {
    // 定向失败替身：只有 s-stuck 会话恒败（双开冲突形态），健康会话照常落盘
    const real = Persistence.open({ path: nextPath(), windowMs: 60_000 });
    const store = real.store;
    const origAppend = store.appendCore.bind(store);
    (store as unknown as { appendCore: Store['appendCore'] }).appendCore = (reg, batch, inc) => {
      if (reg.sessionId === 's-stuck') throw new Error('模拟该会话恒败（双开冲突形态）');
      return origAppend(reg, batch, inc);
    };
    const onError = vi.fn();
    const wb = new WriteBehind(store, 'inc-test', { windowMs: 20, onError });
    const a = new Session({ sessionId: 's-stuck' });
    const b = new Session({ sessionId: 's-healthy' });
    wb.enqueue(a, a.append('user/message', { content: 'a1' }));
    await sleep(60);
    expect(wb.isPaused).toBe(true);
    // 暂停期 B 入队（只排队）+ A 积压 → 显式 flush：B 批成功 → 全局复位 →
    // A 积压 piggyback 再灌链（再败再暂停——逐次响亮上报，恒败会话不静默）
    wb.enqueue(b, b.append('user/message', { content: 'b1' }));
    wb.enqueue(a, a.append('user/message', { content: 'a2' }));
    await expect(wb.flush()).rejects.toThrow(); // A 批仍败（flush 屏障如实 reject）
    // onError 三次 = 窗口初败 + flush 重试败 + 复位后 piggyback 再试败
    // （修前 2 次：成功不复位 → 无 piggyback——本断言即恢复行为的红锁）
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0]![0].code).toBe(PERSIST_BATCH_WRITE_FAILED);
    expect(wb.isPaused).toBe(true); // A 再败 → 重新暂停（止血与恢复往复，非一次失败终身停摆）
    // 健康会话与故障会话分账：B 已落盘（不被 A 拖死）
    expect(store.loadEvents('s-healthy')).toHaveLength(1);
    // 关停屏障如实上抛（规范：恒败会话 close 的再试也拒——护栏响亮终态非吞错）
    await expect(wb.close()).rejects.toThrow();
    store.close();
  });
});

describe('盘满持续失败 cordon 全链（成熟度扫描 20260901 P1-7——ENOSPC 注入形态）', () => {
  /**
   * 磁盘满替身：前 N 次 appendCore 恒抛 ENOSPC（code/errno 对齐 Node 物理形态；
   * SQLITE_FULL 同类——write-behind 对错误形状零分支，锁一形态即锁该故障类），
   * 之后恢复真写。与 makeFlakyStore 的差异：错误形状物理化 + 多轮持续而非单发。
   */
  function makeFullDiskStore(failRounds: { current: number }): Store {
    const real = Persistence.open({ path: nextPath(), windowMs: 60_000 });
    const store = real.store;
    const origAppend = store.appendCore.bind(store);
    (store as unknown as { appendCore: Store['appendCore'] }).appendCore = (reg, batch, inc) => {
      if (failRounds.current > 0) {
        failRounds.current--;
        throw Object.assign(new Error('mock 磁盘满：no space left on device'), { code: 'ENOSPC', errno: -28 });
      }
      return origAppend(reg, batch, inc);
    };
    return store;
  }

  it('多轮持续失败：零提交文案变体逐次上报/成因链保真/积压不重不丢/解除后 close 屏障全量恢复', async () => {
    const failRounds = { current: 3 }; // 窗口初败 + 两轮显式 flush 重试 = 三轮持续失败
    const store = makeFullDiskStore(failRounds);
    const onError = vi.fn();
    const wb = new WriteBehind(store, 'inc-test', { windowMs: 20, onError });
    const session = new Session({ sessionId: 's-full' });
    wb.enqueue(session, session.append('user/message', { content: 'e0' }));
    wb.enqueue(session, session.append('user/message', { content: 'e1' }));
    await sleep(60); // 窗口触发 → 第 1 轮失败（首片即抛——零提交形态）
    expect(onError).toHaveBeenCalledTimes(1);
    const first = onError.mock.calls[0]![0];
    expect(first.code).toBe(PERSIST_BATCH_WRITE_FAILED);
    // 零提交文案变体：本批一条未落（既有测试只锁过「已写 2 条」片裁剪形与
    // 「外部写者」形——三变体至此收齐）
    expect(first.message).toContain('已写 0 条、剩 2 条保留待重试');
    // 成因链保真：物理故障形态经 AppError cause 透传（「响亮」的可观测底账）
    expect((first.cause as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(wb.isPaused).toBe(true); // cordon 立起：自动调度挂起
    expect(store.loadEvents('s-full')).toHaveLength(0);

    // cordon 期新事件只排队不自动重试（盘满下自动重试只会徒增负担）
    wb.enqueue(session, session.append('user/message', { content: 'e2' }));
    await sleep(60);
    expect(store.loadEvents('s-full')).toHaveLength(0);
    expect(wb.pendingEventCount).toBe(3); // 积压披露如实增长（health 两数数据源）

    // 显式 flush 两轮恒败：逐次响亮（不静默降级）+ 失败回队恰一份（无复制膨胀）
    await expect(wb.flush()).rejects.toThrow(/已写 0 条、剩 3 条/);
    expect(onError).toHaveBeenCalledTimes(2);
    wb.enqueue(session, session.append('user/message', { content: 'e3' }));
    await expect(wb.flush()).rejects.toThrow(/已写 0 条、剩 4 条/);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(wb.pendingEventCount).toBe(4); // 三轮失败后积压恰 4 条——重试面不重不丢
    expect(store.loadEvents('s-full')).toHaveLength(0);

    // 盘满解除（failRounds 耗尽）：close() 最后机会屏障一次灌全——seq 连续、全量恢复
    await wb.close();
    const stored = store.loadEvents('s-full');
    expect(stored.map((e) => (e.data as { content: string }).content)).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(stored.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(wb.pendingEventCount).toBe(0);
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

describe('积压披露与批落打点（基建大扫 #27）', () => {
  it('pendingSessionCount/pendingEventCount：enqueue 计入、flush 屏障归零（health 两数数据源）', async () => {
    // 长窗（10s）不自动触发——enqueue 后 pending 计数稳定可断言
    const p = Persistence.open({ path: nextPath(), windowMs: 10_000 });
    const wb = p.writeBehind;
    expect(wb.pendingSessionCount).toBe(0); // 空态
    expect(wb.pendingEventCount).toBe(0);
    const s1 = p.createSession({ cwd: '/t' });
    s1.append('user/message', { content: 'a1' });
    s1.append('user/message', { content: 'a2' });
    const s2 = p.createSession({ cwd: '/t' });
    s2.append('user/message', { content: 'b1' });
    // 两会话三事件（会话经 onLiveEvent 接线自动 enqueue）
    expect(wb.pendingSessionCount).toBe(2);
    expect(wb.pendingEventCount).toBe(3);
    await p.flush(); // 屏障排空全部
    expect(wb.pendingSessionCount).toBe(0);
    expect(wb.pendingEventCount).toBe(0);
    // 事件确已落库（计数归零非丢弃）
    expect(p.store.loadEvents(s1.header.sessionId)).toHaveLength(2);
    expect(p.store.loadEvents(s2.header.sessionId)).toHaveLength(1);
    await p.close();
  });

  it('onBatchLatency 打点：成功批回调一次带 sessionId/events；失败批零回调（纯测量成功路）', async () => {
    const marks: Array<{ sessionId: string; events: number; ms: number }> = [];
    const p = Persistence.open({ path: nextPath(), windowMs: 10_000, onBatchLatency: (info) => marks.push(info) });
    const s = p.createSession({ cwd: '/t' });
    s.append('user/message', { content: 'x' });
    s.append('user/message', { content: 'y' });
    await p.flush();
    expect(marks).toHaveLength(1); // 单会话单批（per-session 串行链一次灌入）
    expect(marks[0]!.sessionId).toBe(s.header.sessionId);
    expect(marks[0]!.events).toBe(2);
    expect(marks[0]!.ms).toBeGreaterThanOrEqual(0); // 纯测量——耗时非行为断言面
    await p.close();
  });
});

// 尾链结算清理（遗漏大扫 20260902-c #10——会话篇 §6 per-session 键域有界性统策）：
// chains/registrations 只在「批存在或链在飞」时被读——链尾结算后的条目是死重。
// daemon 常驻下每会话各留两键永不回收 = 无界累积；结算删（精确生命周期点，
// 非 LRU 帽）双守卫：仍为尾链（无后继批链上）+ pending 无残余（失败重试批
// 回队时 writeBatch 仍读登记）。
describe('尾链结算清理（遗漏大扫 20260902-c #10）', () => {
  /** 读私有键域尺寸（any 直读——纯结构断言面：清理只动内部账不动行为） */
  const sizes = (wb: WriteBehind): { chains: number; registrations: number } => ({
    chains: (wb as unknown as { chains: Map<string, unknown> }).chains.size,
    registrations: (wb as unknown as { registrations: Map<string, unknown> }).registrations.size,
  });

  it('成功批结算后两键同删；再入队由首队路径重建——修复前必红（两 Map 永久滞留）', async () => {
    const real = Persistence.open({ path: nextPath(), windowMs: 20 });
    const wb = new WriteBehind(real.store, 'inc-test', { windowMs: 20 });
    const session = new Session({ sessionId: 's-clean' });
    wb.enqueue(session, session.append('user/message', { content: 'a' }), { cwd: '/w/clean' });
    await wb.flush('s-clean');
    await sleep(5); // 宏任务一拍：让链尾结算清理续体（微任务链）跑完
    expect(sizes(wb)).toEqual({ chains: 0, registrations: 0 }); // 修前 {chains:1, registrations:1}

    // 清理后再入队：enqueue 首队路径重建两键，落盘照常（登记不丢 cwd）
    wb.enqueue(session, session.append('user/message', { content: 'b' }), { cwd: '/w/clean' });
    await wb.flush('s-clean');
    await sleep(5);
    expect(sizes(wb)).toEqual({ chains: 0, registrations: 0 });
    expect(real.store.loadEvents('s-clean')).toHaveLength(2);
    expect(real.store.sessionRow('s-clean')?.cwd).toBe('/w/clean');
    await wb.close();
    await real.close();
  });

  it('失败批回队期间两键存活（pending 守卫），重试成功后才清理——安全锁', async () => {
    const real = Persistence.open({ path: nextPath(), windowMs: 20 });
    const store = real.store;
    const origAppend = store.appendCore.bind(store);
    let failedOnce = false;
    (store as unknown as { appendCore: Store['appendCore'] }).appendCore = (r, batch, inc) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('模拟批写失败');
      }
      return origAppend(r, batch, inc);
    };
    const wb = new WriteBehind(store, 'inc-test', { windowMs: 20, onError: vi.fn() });
    const session = new Session({ sessionId: 's-fail-clean' });
    wb.enqueue(session, session.append('user/message', { content: 'x' }), { cwd: '/w/f' });
    await sleep(60); // 窗口触发 → 失败 → 残余批回 pending → 尾链吞错结算
    await sleep(5);
    // pending 有残余（重试批）：registrations 仍被 writeBatch 引用——清理必须跳过
    expect(sizes(wb)).toEqual({ chains: 1, registrations: 1 });

    await wb.flush(); // 故障移除后显式重试成功
    await sleep(5);
    expect(sizes(wb)).toEqual({ chains: 0, registrations: 0 }); // 重试批结算 → 清理收口
    expect(store.loadEvents('s-fail-clean')).toHaveLength(1);
    await wb.close();
    await real.close();
  });
});
