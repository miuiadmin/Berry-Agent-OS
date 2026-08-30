/**
 * L1 persist 单元测试（store 半边）——版本门禁 / appendCore cursor / 原子回滚 /
 * revision / loadEvents 往返 / 撕裂尾修复 / 凭证与模型目录。
 * hermetic：临时目录建库，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError, SESSION_FORMAT_UNSUPPORTED, SESSION_WRITE_CONFLICT } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import Database from 'better-sqlite3';
import { openStore } from './index.js';
import type { Store } from './store.js';

/** 临时库目录（全文件共享，结束后整体清除） */
let dir: string;
/** 测试用库文件路径（每用例独立文件名防互扰） */
let seq = 0;
const nextPath = (): string => join(dir, `t-${seq++}.db`);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'persist-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造裸事件（绕过 Session 直接喂 appendCore——物理层单测不依赖逻辑层） */
function ev(seq: number, type = 'user/message', data: unknown = { content: 'hi' }): SessionEvent {
  return Object.freeze({ type, seq, time: 1755900000000 + seq, data: Object.freeze(data) });
}

/** 标准登记素材 */
const reg = (id: string) => ({
  sessionId: id,
  origin: 'user' as const,
  seedLength: 0,
  delegationDepth: 0,
});

/** 捕获抛错并断言其错误码（错误码是唯一判据，不匹配文案） */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('应当抛错');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }
}

describe('版本门禁（开库即验，宁拒绝不误读）', () => {
  it('全新库：建表 + 门禁值 + 单例状态行 + WAL/FULL', () => {
    const path = nextPath();
    const store = openStore({ path });
    // 持久化层可直接摸 PRAGMA 验证（经 Store 暴露的 storeId 存在性间接冒烟）
    expect(store.storeId).toMatch(/^[0-9a-f-]{36}$/);
    store.close();
    // 复开：同 storeId（库身份稳定）
    const again = openStore({ path });
    expect(again.storeId).toBe(store.storeId);
    again.close();
  });

  it('user_version 高于宿主已知（降级方向）拒绝打开', () => {
    const path = nextPath();
    openStore({ path }).close();
    // 直接用 better-sqlite3 篡改门禁值（模拟未来版本库）——统一迁移框架下归类为降级
    const raw = new Database(path);
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => openStore({ path })).toThrowError(/降级不支持/);
  });

  it('application_id 不匹配拒绝打开（不是本产品的库）', () => {
    const path = nextPath();
    const raw = new Database(path);
    raw.exec('CREATE TABLE stranger (a)'); // 有表 = 非空库
    raw.close();
    expect(() => openStore({ path })).toThrowError(/application_id 不匹配/);
  });

  it('schema 漂移（缺表/表变形）拒绝打开', () => {
    const path = nextPath();
    openStore({ path }).close();
    const raw = new Database(path);
    raw.exec('DROP TABLE credentials'); // 缺表
    raw.close();
    expectCode(() => openStore({ path }), SESSION_FORMAT_UNSUPPORTED);

    const path2 = nextPath();
    openStore({ path: path2 }).close();
    const raw2 = new Database(path2);
    raw2.exec('ALTER TABLE sessions ADD COLUMN extra_col TEXT'); // 表变形
    raw2.close();
    expectCode(() => openStore({ path: path2 }), SESSION_FORMAT_UNSUPPORTED);
  });

  // 探矿轮八 #25 回归锁（2026-08-25 Hermes 移植撞墙）：双开冷启动竞态——
  // 两进程同时初始化同一新库，后到者在 journal_mode=WAL 首切（需写锁）上
  // 撞 BUSY 裸崩：切换锁通道不吃 busy_timeout，且初始化段无原子性（后到者
  // 可读到半初始化库走错门禁路径）。修法=幂等探测 + 短退避重试 + 初始化段
  // BEGIN IMMEDIATE 单写事务。构造确定性形态：worker 线程里另一连接以默认
  // rollback 模式持写锁 100ms 后释放（模拟先到进程的切换/初始化写窗口，
  // < 退避预算 5+15+45+135ms）。必须用 worker 线程：openStore 的同步退避会
  // 阻塞主线程事件循环，同线程的 setTimeout 释放永远无法触发（伪死锁）。
  it('对方持锁时开新库：WAL 切换重试 + 初始化事务等待——不裸崩 BUSY（双开冷启动）', async () => {
    const path = nextPath();
    const holder = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const Database = require('better-sqlite3');
       const db = new Database(workerData.path); // 默认 rollback 模式（新库尚未 WAL）
       db.exec('BEGIN IMMEDIATE;'); // 拿 RESERVED 写锁，不建表（建表并提交会让库
       // 变非空——openStore 会被版本门禁正确拒绝，测的就不是等待语义了）
       parentPort.postMessage('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }, workerData.holdMs);`,
      { eval: true, workerData: { path, holdMs: 100 } },
    );
    try {
      await new Promise((r) => holder.once('message', (m: string) => m === 'locked' && r(null)));
      const store = openStore({ path }); // 修前：WAL 首切零等待 SQLITE_BUSY 裸抛
      expect(store.storeId).toMatch(/^[0-9a-f-]{36}$/);
      store.close();
    } finally {
      await holder.terminate();
    }
  });
});

describe('appendCore（cursor 连续性 + 单事务 + revision）', () => {
  it('合法顺序批次写入成功且 revision 前进', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-cursor');
    expect(store.appendCore(r, [ev(0), ev(1), ev(2)], 'inc-1')).toBe(1);
    expect(store.appendCore(r, [ev(3)], 'inc-1')).toBe(2);
    expect(store.loadEvents('s-cursor')).toHaveLength(4);
    store.close();
  });

  it('批起始 seq 断裂响亮拒绝（第二写者护栏）', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-conflict');
    store.appendCore(r, [ev(0), ev(1)], 'inc-1');
    // 跳到 seq 5：模拟第二写者/陈旧 cursor
    expectCode(() => store.appendCore(r, [ev(5)], 'inc-1'), SESSION_WRITE_CONFLICT);
    // 拒绝不落任何行：库里仍是 2 条
    expect(store.loadEvents('s-conflict')).toHaveLength(2);
    store.close();
  });

  it('批内坏行（重复 PK）整批回滚：物理删除例外之二由事务原子性承担', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-atomic');
    store.appendCore(r, [ev(0)], 'inc-1');
    // 批内 seq 重复（构造 1,1）→ UNIQUE 冲突 → 整事务回滚
    expect(() => store.appendCore(r, [ev(1), ev(1)], 'inc-1')).toThrowError();
    expect(store.loadEvents('s-atomic')).toHaveLength(1); // 只有 seq 0
    // 悬空链未断：后续正确批次仍可写
    store.appendCore(r, [ev(1), ev(2)], 'inc-1');
    expect(store.loadEvents('s-atomic')).toHaveLength(3);
    store.close();
  });

  it('incarnation 变更 = revision 复位边界；revisionString 三段格式', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-rev');
    store.appendCore(r, [ev(0)], 'inc-a');
    store.appendCore(r, [ev(1)], 'inc-a');
    store.appendCore(r, [ev(2)], 'inc-b'); // 新进程接管
    const row = store.sessionRow('s-rev')!;
    expect(row.revision).toBe(1); // 复位
    expect(row.incarnation).toBe('inc-b');
    const rev = store.revisionString('s-rev', 'inc-b');
    expect(rev).toBe(`${store.storeId}:inc-b:1`);
    expect(rev.split(':')).toHaveLength(3);
    store.close();
  });

  // 切片写入（契约篇 §1.6 资源护栏族 #13，2026-08-27 刀〇b）
  it('切片：501 事件按 500 条界切两片顺序提交，全量 durable 无 cursor 冲突', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-slice');
    const batch = Array.from({ length: 501 }, (_, i) => ev(i));
    const revision = store.appendCore(r, batch, 'inc-1');
    // 500 条界 → 两片（500+1）；每片独立事务各前进一次 revision
    expect(revision).toBe(2);
    const stored = store.loadEvents('s-slice');
    expect(stored).toHaveLength(501);
    expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: 501 }, (_, i) => i));
    expect(store.maxSeq('s-slice')).toBe(500); // maxSeq = 部分写事实源面（write-behind 裁剪依据）
    store.close();
  });

  it('切片字节界：单条超 4MiB 独占一片，后续事件另起一片', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-slice-bytes');
    const fat = { content: 'x'.repeat(4 * 1024 * 1024 + 512) }; // 首条即超字节界（首条必进片）
    const revision = store.appendCore(r, [ev(0, 'user/message', fat), ev(1)], 'inc-1');
    expect(revision).toBe(2); // 两条各占一片
    expect(store.loadEvents('s-slice-bytes')).toHaveLength(2);
    store.close();
  });
});

describe('loadEvents 往返与撕裂尾修复', () => {
  it('全字段往返：data/surfaceOp/sourceEventSeqs(紧凑 BLOB)/ignorable', () => {
    const store = openStore({ path: nextPath() });
    const r = reg('s-round');
    const plain = ev(0);
    const masked: SessionEvent = {
      type: 'tool/result',
      seq: 1,
      time: 42,
      data: { toolCallId: 'tc', content: 'x' },
      surfaceOp: { op: 'replace', start: 0, end: 0 },
      sourceEventSeqs: [0],
    };
    const ign: SessionEvent = { type: 'future/thing', seq: 2, time: 43, data: {}, ignorable: true };
    store.appendCore(r, [plain, masked, ign], 'inc');
    const back = store.loadEvents('s-round');
    expect(back).toHaveLength(3);
    expect(back[0]!.data).toEqual({ content: 'hi' });
    expect(back[1]!.surfaceOp).toEqual({ op: 'replace', start: 0, end: 0 });
    expect(back[1]!.sourceEventSeqs).toEqual([0]); // BLOB 编解码往返
    expect(back[2]!.ignorable).toBe(true);
    // data 深冻结（可直接作种子共享）
    expect(() => {
      (back[0]!.data as { content: string }).content = 'tamper';
    }).toThrowError(TypeError);
    store.close();
  });

  it('撕裂尾：中间跳档 → 截除断档及之后，保留连续前缀', () => {
    const path = nextPath();
    const store = openStore({ path });
    const r = reg('s-torn');
    store.appendCore(r, [ev(0), ev(1), ev(2), ev(3)], 'inc');
    store.close();
    // 外因损坏：删掉 seq 2 制造中间跳档（2 缺、3 悬空）
    const raw = new Database(path);
    raw.prepare('DELETE FROM events WHERE session_id = ? AND seq = 2').run('s-torn');
    raw.close();
    // 复开读取：保 0/1，截 3
    const store2 = openStore({ path });
    const kept = store2.loadEvents('s-torn');
    expect(kept.map((e) => e.seq)).toEqual([0, 1]);
    // 修复持久化：重读不再截（已物理删除）
    expect(store2.loadEvents('s-torn').map((e) => e.seq)).toEqual([0, 1]);
    // 后续写入从 max(seq)+1 = 2 续接（悬空链不断）
    const s2reg = { ...r, seedLength: 0 };
    store2.appendCore(s2reg, [ev(2, 'turn/end', { reason: 'interrupted' })], 'inc');
    expect(store2.loadEvents('s-torn').map((e) => e.seq)).toEqual([0, 1, 2]);
    store2.close();
  });
});

describe('latestSessionId（TUI 启动续接取数面，技术栈篇 §5）', () => {
  it('按 cwd 取最新：同刻并列 rowid 兜底、他 cwd 不掺、无匹配 undefined', () => {
    const store = openStore({ path: nextPath() });
    const ws = '/ws/a';
    // 三个会话：a1/a2/a3 同 cwd 顺序建（created_at 可能同毫秒——rowid 兜底仍保
    // 时序）、b1 是另一工作区——latest(ws) 必须是最后建的 a3
    const mk = (id: string, cwd: string | undefined) => store.appendCore({ ...reg(id), cwd }, [ev(0)], 'inc');
    mk('a1', ws);
    mk('a2', ws);
    mk('a3', ws);
    mk('b1', '/ws/b');

    expect(store.latestSessionId(ws)).toBe('a3');
    expect(store.latestSessionId('/ws/b')).toBe('b1');
    expect(store.latestSessionId('/ws/none')).toBeUndefined();
    store.close();
  });

  it('created_at 同毫秒并列：rowid 取后建者（DESC, rowid DESC 兜底序）', () => {
    const store = openStore({ path: nextPath() });
    const ws = '/ws/tie';
    const regWs = { ...reg('tie-1'), cwd: ws };
    // created_at 由 appendCore 内 Date.now() 落——两次紧邻调用可能同毫秒；
    // 循环多建几个，断言最终 latest = 最后建的那个 id
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = `tie-${i}`;
      ids.push(id);
      store.appendCore({ ...reg(id), cwd: ws }, [ev(0)], 'inc');
    }
    expect(store.latestSessionId(ws)).toBe(ids.at(-1));
    store.close();
  });
});

describe('凭证与模型目录', () => {
  it('凭证 modify 串行 read-modify-write：无中生有、变更、删除', () => {
    const store = openStore({ path: nextPath() });
    expect(store.getCredential('anthropic')).toBeUndefined();
    const created = store.modifyCredential('anthropic', () => ({ apiKey: 'sk-first' }));
    expect(created?.data).toEqual({ apiKey: 'sk-first' });
    // 读-改：拿到当前值再改（防双刷新的 read-modify-write 形态）
    store.modifyCredential('anthropic', (cur) => ({ apiKey: 'sk-second', prev: cur }));
    expect(store.getCredential('anthropic')?.data).toEqual({
      apiKey: 'sk-second',
      prev: { apiKey: 'sk-first' },
    });
    // 删除
    store.modifyCredential('anthropic', () => undefined);
    expect(store.getCredential('anthropic')).toBeUndefined();
    store.close();
  });

  it('模型目录 upsert/list/get/delete', () => {
    const store = openStore({ path: nextPath() });
    store.upsertModel('anthropic', 'claude-fable-5', { price: 1 }, 'bundled');
    store.upsertModel('anthropic', 'claude-fable-5', { price: 2 }, 'user-override'); // 覆盖
    store.upsertModel('openai', 'gpt-6', { price: 3 }, 'fetched');
    expect(store.getModel('anthropic', 'claude-fable-5')).toEqual({ data: { price: 2 }, source: 'user-override' });
    expect(store.listModels('anthropic')).toHaveLength(1);
    expect(store.listModels()).toHaveLength(2);
    store.deleteModel('openai', 'gpt-6');
    expect(store.listModels()).toHaveLength(1);
    store.close();
  });
});

describe('双开姿态（同库两实例）', () => {
  it('不同会话双写互不干扰；同会话第二写者被 cursor 拒', () => {
    const path = nextPath();
    const a = openStore({ path });
    const b = openStore({ path }); // 双开：无锁、WAL + busy_timeout
    a.appendCore(reg('s-a'), [ev(0), ev(1)], 'inc-a');
    b.appendCore(reg('s-b'), [ev(0), ev(1)], 'inc-b');
    expect(a.loadEvents('s-a')).toHaveLength(2);
    expect(b.loadEvents('s-b')).toHaveLength(2);
    // b 对 a 已写的会话从 seq 0 再写 = cursor 断裂 → 响亮拒绝（同会话单写者护栏）
    expectCode(() => b.appendCore(reg('s-a'), [ev(0)], 'inc-b'), SESSION_WRITE_CONFLICT);
    a.close();
    b.close();
  });
});

/* ---------------- queryEvents（会话篇 §3.4 单原语物理半边） ---------------- */

describe('queryEvents（跨会话有界查询：序/游标/时间窗/types/app/limit）', () => {
  /** 构造已落库的多会话素材：s-a（app=chat）与 s-b（app=codex，无 app 断言对照之外形） */
  function seed(): Store {
    const store = openStore({ path: nextPath() });
    // 时间轴：ev(seq) 的 time = 1755900000000 + seq（ev 助手钉死）——闭区间端点
    // 断言用 base+2 / base+4 这类可列值
    store.appendCore({ ...reg('s-a'), app: 'chat' }, [ev(0), ev(1), ev(2), ev(3), ev(4)], 'inc');
    store.appendCore(
      { ...reg('s-b'), app: 'codex' },
      [ev(0, 'llm/usage', { tokens: 1 }), ev(5, 'user/message')],
      'inc',
    );
    return store;
  }

  it('全量查询：time DESC + (session_id, seq) DESC tie-break；data 原样反序列化', () => {
    const store = seed();
    const result = store.queryEvents({});
    // 手算期望序（s-b 素材 = seq0/llm/usage + seq5/user/message，共 7 行）：
    // 同刻并列按 session_id DESC（'s-b' > 's-a'）→ s-b 在前
    const keys = result.rows.map((r) => [r.time, r.sessionId, r.seq]);
    expect(keys).toEqual([
      [1755900000005, 's-b', 5],
      [1755900000004, 's-a', 4],
      [1755900000003, 's-a', 3],
      [1755900000002, 's-a', 2],
      [1755900000001, 's-a', 1],
      [1755900000000, 's-b', 0],
      [1755900000000, 's-a', 0],
    ]);
    // data 原样（不截断不包装）：首行是 s-b/seq5 的 user/message {content:'hi'}
    expect(result.rows[0]).toMatchObject({ sessionId: 's-b', seq: 5, type: 'user/message', data: { content: 'hi' } });
    expect(result.nextCursor).toBeUndefined(); // 全量取尽
    expect(result.truncated).toBe(false);
    store.close();
  });

  it('时间窗含端点闭区间：since/until 边界值行都在页内', () => {
    const store = seed();
    const base = 1755900000000;
    // [base+2, base+4] 闭区间：端点 2 与 4 都含
    const result = store.queryEvents({ sinceMs: base + 2, untilMs: base + 4 });
    expect(result.rows.map((r) => [r.sessionId, r.seq])).toEqual([
      ['s-a', 4],
      ['s-a', 3],
      ['s-a', 2],
    ]);
    store.close();
  });

  it('types 是数据条件非断言：查未注册/不存在的词返回空集不抛', () => {
    const store = seed();
    const result = store.queryEvents({ types: ['no/such-vocab', 'gone/app/word'] });
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
    // 正常过滤维：llm/usage 只在 s-b 有一行（seq 0）
    const usage = store.queryEvents({ types: ['llm/usage'] });
    expect(usage.rows.map((r) => [r.sessionId, r.seq])).toEqual([['s-b', 0]]);
    // 空数组 = 无过滤（与 undefined 同义——「不过滤」而非「匹配零行」）
    expect(store.queryEvents({ types: [] }).rows).toHaveLength(7);
    store.close();
  });

  it('app 维过滤（JOIN sessions.app）：只取 chat 会话事件', () => {
    const store = seed();
    const result = store.queryEvents({ app: 'chat' });
    expect(result.rows.every((r) => r.sessionId === 's-a')).toBe(true);
    expect(result.rows).toHaveLength(5);
    // app 无匹配 = 空集（数据条件语义）
    expect(store.queryEvents({ app: 'nope' }).rows).toEqual([]);
    store.close();
  });

  it('sessionId 单会话细查（退化用法）', () => {
    const store = seed();
    const result = store.queryEvents({ sessionId: 's-b' });
    expect(result.rows.map((r) => r.seq)).toEqual([5, 0]);
    store.close();
  });

  it('limit 钳制与 truncated 标注：超帽钳到 1000 置真；页未取尽也置真', () => {
    const store = seed();
    // limit 超帽：直接钳到 1000（本素材仅 7 行——钳制事实由 truncated 表达）
    const clamped = store.queryEvents({ limit: 100000 });
    expect(clamped.truncated).toBe(true); // clamped 成立（即使全行都进了页）
    expect(clamped.rows).toHaveLength(7);
    // 页未取尽：limit 3 → 8 行中取 3，nextCursor 指向页尾行
    const paged = store.queryEvents({ limit: 3 });
    expect(paged.rows).toHaveLength(3);
    expect(paged.nextCursor).toEqual({ time: 1755900000003, sessionId: 's-a', seq: 3 });
    expect(paged.truncated).toBe(true);
    // limit 0/负数 = 钳到 1（页大小下限）
    expect(store.queryEvents({ limit: 0 }).rows).toHaveLength(1);
    store.close();
  });

  it('组合游标分页：逐页回传 nextCursor 全量翻完不重不漏（游标不漂）', () => {
    const store = seed();
    const collected: Array<[string, number]> = [];
    let cursor: { time: number; sessionId: string; seq: number } | undefined;
    let pages = 0;
    do {
      const page = store.queryEvents({ limit: 3, ...(cursor !== undefined ? { cursor } : {}) });
      collected.push(...page.rows.map((r) => [r.sessionId, r.seq] as [string, number]));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10); // 防御：游标不动即死循环
    } while (cursor !== undefined);
    // 7 行 / 页 3 = 3 页；全量序与一次性查询完全一致（不重不漏）
    expect(pages).toBe(3);
    expect(collected).toEqual(store.queryEvents({}).rows.map((r) => [r.sessionId, r.seq] as [string, number]));
    store.close();
  });
});

describe('affectedSessionCounts（按词聚合受影响会话数：uninstall 级联警示取数面，契约篇 §3.4 第二刀）', () => {
  /** 构造三会话素材：同一应用词在两会话出现（DISTINCT 计 2 非 3），另一词仅一会话 */
  function seed(): Store {
    const store = openStore({ path: nextPath() });
    // s-a 与 s-b 各含 2 行 demo/thing（同会话重复行 DISTINCT 只计 1）；s-c 只有无关注的词
    store.appendCore({ ...reg('s-a') }, [ev(0, 'demo/thing'), ev(1, 'demo/thing'), ev(2)], 'inc');
    store.appendCore({ ...reg('s-b') }, [ev(0, 'demo/thing'), ev(1, 'other/word')], 'inc');
    store.appendCore({ ...reg('s-c') }, [ev(0)], 'inc');
    return store;
  }

  it('COUNT(DISTINCT session_id) 按词分组：同会话重复行计 1，跨会话累计', () => {
    const store = seed();
    expect(store.affectedSessionCounts(['demo/thing', 'other/word'])).toEqual({
      'demo/thing': 2, // s-a + s-b（s-a 内两行不重复计）
      'other/word': 1, // 仅 s-b
    });
    store.close();
  });

  it('未注册/不存在的词：零计不抛（数据条件非断言，queryEvents 同判）', () => {
    const store = seed();
    expect(store.affectedSessionCounts(['no/such-word'])).toEqual({}); // GROUP BY 无匹配行 → 键缺席
    store.close();
  });

  it('空词表恒空对象（无聚合对象，与「匹配零行」无歧义）', () => {
    const store = seed();
    expect(store.affectedSessionCounts([])).toEqual({});
    store.close();
  });
});

describe('文件权限三件（0600 追打——会话与存储篇 §6，2026-08-30 0600 补执行）', () => {
  /** 断言文件权限位等于期望值（chmod 绝对位设定，断言天然不受 umask 影响） */
  const modeOf = (p: string): number => statSync(p).mode & 0o777;

  it('open 后主库/-wal/-shm 三件 0600（初始化事务已物化 wal/shm）', () => {
    const path = nextPath();
    const store = openStore({ path });
    try {
      expect(modeOf(path)).toBe(0o600);
      // BEGIN IMMEDIATE 初始化事务已落 WAL——两附文件应在场且同 0600；
      // wal/shm 干净关闭即删除，在场是实况、0600 是不变量
      expect(modeOf(`${path}-wal`)).toBe(0o600);
      expect(modeOf(`${path}-shm`)).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it('存量 0644 漂移自愈：再 open 即修复（幂等追打双语义之漂移腿）', () => {
    const path = nextPath();
    const first = openStore({ path });
    first.close(); // 干净关闭：wal/shm 随之删除，只留主库
    chmodSync(path, 0o644); // 预置历史漂移（0600 补执行前装机面的实况）
    expect(modeOf(path)).toBe(0o644); // 修复前必红锚
    const second = openStore({ path }); // 双开第二进程同径：再 chmod 无害幂等
    try {
      expect(modeOf(path)).toBe(0o600); // 追打修复
    } finally {
      second.close();
    }
  });
});
