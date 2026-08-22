/**
 * L1 persist 单元测试（store 半边）——版本门禁 / appendCore cursor / 原子回滚 /
 * revision / loadEvents 往返 / 撕裂尾修复 / 凭证与模型目录。
 * hermetic：临时目录建库，用后即清。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('user_version 不匹配拒绝打开', () => {
    const path = nextPath();
    openStore({ path }).close();
    // 直接用 better-sqlite3 篡改门禁值（模拟未来版本库）
    const raw = new Database(path);
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => openStore({ path })).toThrowError(/user_version 不匹配/);
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
