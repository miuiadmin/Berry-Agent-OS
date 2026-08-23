/**
 * L3 memory 集成测试（MemoryStore DAO）——经 persist 统一迁移框架建表族后全栈真库
 * （:memory: SQLite，无 mock）：三分支落库 / 软删恢复 / FTS 检索转义 / 简报排序限额。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../persist/index.js';
import { MEMORY_MIGRATION, MemoryStore, projectOwnerKey } from './index.js';

/** 当前测试库（每用例新建 :memory:——迁移框架一次到位后交 DAO） */
let store: Store;
let db: MemoryStore;

beforeEach(() => {
  store = openStore({ path: ':memory:', migrations: [MEMORY_MIGRATION] });
  db = new MemoryStore(store.connection);
});

/** 标准写入素材（owner/kind 可覆写） */
function write(over: Partial<Parameters<MemoryStore['addMemory']>[0]> = {}) {
  return db.addMemory({
    ownerKey: 'global',
    kind: 'preference',
    summary: '用户偏好 pnpm 作为包管理器',
    content: '2026-08-24 会话中用户明确表示本项目统一用 pnpm。',
    confidence: 0.7,
    sourceRefs: [{ sessionId: 's1', seq: 12 }],
    ...over,
  });
}

describe('addMemory 三分支持落库', () => {
  it('全新插入：字段齐全、uuid v7 形态、缺省 confidence 0.5', () => {
    const out = write({});
    expect(out.outcome).toBe('inserted');
    if (out.outcome !== 'inserted') return;
    const m = out.memory;
    expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(m.status).toBe('active');
    expect(m.evidenceCount).toBe(1);
    expect(m.sourceRefs).toEqual([{ sessionId: 's1', seq: 12 }]);
    // 缺省 confidence 走 0.5
    const d = db.addMemory({ ownerKey: 'global', kind: 'fact', summary: 'x', content: 'y' });
    if (d.outcome === 'inserted') expect(d.memory.confidence).toBe(0.5);
  });

  it('精确合并：证据 +1、confidence 取 max、refs 去重追加', () => {
    write({});
    const out = write({
      confidence: 0.4,
      sourceRefs: [
        { sessionId: 's1', seq: 12 },
        { sessionId: 's2', seq: 3 },
      ],
    });
    expect(out.outcome).toBe('merged');
    if (out.outcome !== 'merged') return;
    expect(out.via).toBe('exact');
    expect(out.memory.evidenceCount).toBe(2);
    expect(out.memory.confidence).toBe(0.7); // max(0.7, 0.4)
    // 同 ref 去重 + 新 ref 追加（序 = 先旧后新）
    expect(out.memory.sourceRefs).toEqual([
      { sessionId: 's1', seq: 12 },
      { sessionId: 's2', seq: 3 },
    ]);
  });

  it('模糊合并：近同摘要（Jaccard ≥ 0.74）走 merged/fuzzy', () => {
    write({ summary: 'user prefers pnpm as package manager always' });
    const out = write({ summary: 'user prefers pnpm as package manager' });
    expect(out.outcome).toBe('merged');
    if (out.outcome === 'merged') expect(out.via).toBe('fuzzy');
  });

  it('精确优先于模糊：候选群里精确匹配在最前也必须赢', () => {
    write({ summary: 'a b c d' }); // 与候选二 fuzzy
    write({ summary: 'x y z w' }); // 与待写 exact
    const out = write({ summary: 'x y z w' });
    expect(out.outcome).toBe('merged');
    if (out.outcome === 'merged') expect(out.via).toBe('exact');
    // 且 fuzzy 候选未被误合并（证据数仍 1）
    const all = db.list(['global']);
    expect(all.find((m) => m.summary === 'a b c d')?.evidenceCount).toBe(1);
  });

  it('极性冲突新胜：旧条 dismissed(auto_resolved)、新条继承双方证据计数', () => {
    write({ summary: '用户喜欢自动提交', confidence: 0.6 });
    const out = write({ summary: '用户不喜欢自动提交', confidence: 0.6 }); // 相等 → 新胜
    expect(out.outcome).toBe('superseded');
    if (out.outcome !== 'superseded') return;
    expect(out.memory.evidenceCount).toBe(2); // 旧 1 + 新 1
    const old = db.get(out.supersededId)!;
    expect(old.status).toBe('dismissed');
    expect(old.supersededBy).toBe('auto_resolved');
  });

  it('极性冲突旧胜（库内 confidence 更高）：候选驳回、库内无痕', () => {
    write({ summary: '用户喜欢自动提交', confidence: 0.9 });
    const out = write({ summary: '用户不喜欢自动提交', confidence: 0.5 });
    expect(out.outcome).toBe('rejected');
    if (out.outcome !== 'rejected') return;
    const existing = db.get(out.existingId)!;
    expect(existing.status).toBe('active');
    expect(existing.evidenceCount).toBe(1); // 矛盾不增证据
    expect(db.list(['global'])).toHaveLength(1); // 候选未入库
  });

  it('kind 隔离：同摘要不同 kind = 两条独立条目', () => {
    write({ kind: 'preference' });
    const out = write({ kind: 'convention' });
    expect(out.outcome).toBe('inserted');
    expect(db.list(['global'])).toHaveLength(2);
  });

  it('owner 隔离：global 与 project 互不合并', () => {
    write({});
    const out = write({ ownerKey: 'project:abc' });
    expect(out.outcome).toBe('inserted');
  });

  it('空 summary/content 拒收（写入面自防御）', () => {
    expect(() => write({ summary: '  ' })).toThrowError(/不得为空/);
    expect(() => write({ content: '' })).toThrowError(/不得为空/);
  });
});

describe('forget / restore（软删与恢复）', () => {
  it('软删后不在 active 面、可恢复、superseded_by 清空', () => {
    const out = write({});
    if (out.outcome !== 'inserted') return;
    const id = out.memory.id;
    expect(db.forget(id)).toBe(true);
    expect(db.list(['global'])).toHaveLength(0);
    expect(db.get(id)?.status).toBe('dismissed');
    expect(db.get(id)?.supersededBy).toBe('user');
    expect(db.restore(id)).toBe(true);
    expect(db.get(id)?.status).toBe('active');
    expect(db.get(id)?.supersededBy).toBeNull();
    // 不存在的 id → false 不抛
    expect(db.forget('nope')).toBe(false);
  });

  it('软删后 FTS 检索不再命中', () => {
    const out = write({});
    if (out.outcome !== 'inserted') return;
    expect(db.search('pnpm', ['global'])).toHaveLength(1);
    db.forget(out.memory.id);
    expect(db.search('pnpm', ['global'])).toHaveLength(0);
  });
});

describe('search（FTS5 投影 + 转义）', () => {
  it('命中按相关度返回、owner 范围隔离', () => {
    write({});
    write({ ownerKey: 'project:zzz' });
    expect(db.search('pnpm', ['global'])).toHaveLength(1);
    expect(db.search('pnpm', ['global', 'project:zzz'])).toHaveLength(2);
    expect(db.search('pnpm', [])).toHaveLength(0);
  });
  it('用户输入标点/操作符不可能炸 MATCH（转义 + trigram 忽略 <3 字符垃圾 token）', () => {
    write({});
    // " OR 1=1 -- 注入形态：逐 token 引号转义后语法安全；短垃圾 token 被 trigram 忽略，pnpm 仍命中
    expect(db.search('pnpm " OR 1=1 --', ['global'])).toHaveLength(1);
    expect(db.search('!!! ???', ['global'])).toHaveLength(0); // 无 token → 空
  });
  it('多词隐式 AND：两词都在才命中', () => {
    write({});
    expect(db.search('pnpm 包管理器', ['global'])).toHaveLength(1);
    expect(db.search('pnpm 不存在词', ['global'])).toHaveLength(0);
  });
});

describe('briefing（常驻简报取数）', () => {
  it('kind 优先级先于得分：preference 压过 fact', () => {
    write({ kind: 'fact', summary: '事实条目高分测试', confidence: 0.99 });
    write({ kind: 'preference', summary: '偏好条目', confidence: 0.4 });
    const { records } = db.briefing(['global']);
    expect(records[0]!.kind).toBe('preference');
  });
  it('得分 = confidence × ln(evidence+1)：多证据抬升', () => {
    write({ summary: 's1 低分多次', confidence: 0.4 });
    write({ summary: 's1 低分多次', confidence: 0.4 }); // evidence → 2
    write({ summary: 's2 高分一次', confidence: 0.9 });
    const { records } = db.briefing(['global']);
    // 0.4×ln3 ≈ 0.44 vs 0.9×ln2 ≈ 0.62 → s2 仍先；再造一轮把 s1 顶上去
    write({ summary: 's1 低分多次', confidence: 0.4 }); // evidence → 3：0.4×ln4 ≈ 0.55
    write({ summary: 's1 低分多次', confidence: 0.4 });
    write({ summary: 's1 低分多次', confidence: 0.4 }); // evidence → 5：0.4×ln6 ≈ 0.72 > 0.62
    const again = db.briefing(['global']).records;
    expect(again[0]!.summary).toBe('s1 低分多次');
    expect(records.length).toBeGreaterThanOrEqual(2);
  });
  it('双限额截断可见（truncated = true）', () => {
    for (let i = 0; i < 8; i++) {
      write({ summary: `条目 ${i} `.repeat(6).trim(), confidence: 0.5 });
    }
    const limited = db.briefing(['global'], { maxEntries: 3 });
    expect(limited.records).toHaveLength(3);
    expect(limited.truncated).toBe(true);
    const byChars = db.briefing(['global'], { maxChars: 30 });
    expect(byChars.truncated).toBe(true);
    expect(byChars.records.length).toBeLessThan(8);
  });
  it('空 owner = 空简报', () => {
    expect(db.briefing([]).records).toEqual([]);
  });
});

describe('projectOwnerKey（两层归属）', () => {
  it('同路径稳定、异路径不同', () => {
    expect(projectOwnerKey('/a/b')).toBe(projectOwnerKey('/a/b'));
    expect(projectOwnerKey('/a/b')).not.toBe(projectOwnerKey('/a/c'));
    expect(projectOwnerKey('/a/b')).toMatch(/^project:[0-9a-f]{12}$/);
  });
});

describe('重开库（迁移幂等 + 数据存活）', () => {
  it('v2 库再开同链不重跑、条目完好', () => {
    write({});
    // :memory: 无法复开——用文件库走一遍迁移幂等 + 数据存活
    const path = joinTmp();
    const s1 = openStore({ path, migrations: [MEMORY_MIGRATION] });
    const file = new MemoryStore(s1.connection);
    file.addMemory({ ownerKey: 'global', kind: 'fact', summary: '文件库条目', content: 'c' });
    s1.close();
    const s2 = openStore({ path, migrations: [MEMORY_MIGRATION] });
    const reloaded = new MemoryStore(s2.connection);
    expect(reloaded.list(['global'])).toHaveLength(1);
    expect(reloaded.search('文件库', ['global'])).toHaveLength(1); // FTS 触发器产物跨开存活
    s2.close();
  });
});

/** 文件库临时目录（重开测试专用，全文件共享） */
let tmpDir: string | undefined;
let tmpSeq = 0;
function joinTmp(): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'memory-test-'));
  return join(tmpDir, `m-${tmpSeq++}.db`);
}
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});
