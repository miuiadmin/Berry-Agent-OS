/**
 * L3 memory 集成测试（MemoryStore DAO）——经 persist 统一迁移框架建表族后全栈真库
 * （:memory: SQLite，无 mock）：三分支落库 / 软删恢复 / FTS 检索转义 / 简报排序限额。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../persist/index.js';
import {
  MEMORY_MIGRATION,
  MEMORY_UTILITY_MIGRATION,
  MEMORY_HOLDING_MIGRATION,
  MemoryStore,
  projectOwnerKey,
  utilityScore,
} from './index.js';

/** 当前测试库（每用例新建 :memory:——迁移框架一次到位后交 DAO） */
let store: Store;
let db: MemoryStore;

beforeEach(() => {
  store = openStore({
    path: ':memory:',
    migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION],
  });
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
    write({
      summary: '用户喜欢自动提交',
      confidence: 0.6,
      sourceRefs: [
        { sessionId: 'old1', seq: 1 },
        { sessionId: 'old1', seq: 2 },
      ],
    });
    const out = write({
      summary: '用户不喜欢自动提交',
      confidence: 0.6, // 相等 → 新胜
      sourceRefs: [{ sessionId: 'new1', seq: 9 }],
    });
    expect(out.outcome).toBe('superseded');
    if (out.outcome !== 'superseded') return;
    expect(out.memory.evidenceCount).toBe(2); // 旧 1 + 新 1
    // 血缘继承（第十四批 A 组）：新条 source_refs = 旧条并集 ∪ 新入参（条目消亡溯源不死）
    expect(out.memory.sourceRefs).toEqual([
      { sessionId: 'old1', seq: 1 },
      { sessionId: 'old1', seq: 2 },
      { sessionId: 'new1', seq: 9 },
    ]);
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

describe('intakeWatermark（摄入水位——consolidation 变更短路判据）', () => {
  it('空 owner 返回 null（与 0 可区分）；写入后 = max(updated_at)', () => {
    expect(db.intakeWatermark('global')).toBeNull();
    write({});
    const w = db.intakeWatermark('global');
    expect(typeof w).toBe('number');
    // 再写一条更晚的（nowMs 注入后写）——水位取最大
    db.addMemory(
      {
        ownerKey: 'global',
        kind: 'fact',
        summary: '更晚的一条',
        content: '内容',
      },
      1_800_000_000_000,
    );
    expect(db.intakeWatermark('global')).toBe(1_800_000_000_000);
  });

  it('恰只捕捉摄入：decay 与 markUsed 不动水位', () => {
    write({});
    const w0 = db.intakeWatermark('global')!;
    db.decayConfidence(db.list(['global'])[0]!.id, 0.5);
    db.markUsed([db.list(['global'])[0]!.id], w0 + 100_000);
    expect(db.intakeWatermark('global')).toBe(w0); // 整理与引用不重开合并窗
  });

  it('owner 隔离：水位按 owner 查询', () => {
    write({ ownerKey: 'global' });
    expect(db.intakeWatermark('project:other')).toBeNull();
  });
});

describe('forget / restore（软删与恢复）', () => {
  it('软删后不在 active 面、可恢复、superseded_by 清空', () => {
    const out = write({});
    if (out.outcome !== 'inserted') return;
    const id = out.memory.id;
    expect(db.forget(id)).toBe('ok');
    expect(db.list(['global'])).toHaveLength(0);
    expect(db.get(id)?.status).toBe('dismissed');
    expect(db.get(id)?.supersededBy).toBe('user');
    expect(db.restore(id)).toEqual({ restored: true });
    expect(db.get(id)?.status).toBe('active');
    expect(db.get(id)?.supersededBy).toBeNull();
    // 不存在的 id → 'missing' 不抛
    expect(db.forget('nope')).toBe('missing');
    expect(db.restore('nope')).toEqual({ restored: false, reason: 'missing' });
  });

  it('软删后 FTS 检索不再命中', () => {
    const out = write({});
    if (out.outcome !== 'inserted') return;
    expect(db.search('pnpm', ['global'])).toHaveLength(1);
    db.forget(out.memory.id);
    expect(db.search('pnpm', ['global'])).toHaveLength(0);
  });

  it('终态短路（第七轮 M-2）：已 dismissed 行再 forget 不覆写 superseded_by——返 dismissed 幂等', () => {
    const out = write({});
    if (out.outcome !== 'inserted') return;
    const id = out.memory.id;
    expect(db.forget(id, 'user')).toBe('ok');
    // 修前：无条件 UPDATE 把用户终审 'user' 覆写成后到的 'llm:x'（审计面被重写）
    expect(db.forget(id, `llm:${id}`)).toBe('dismissed');
    expect(db.get(id)?.supersededBy).toBe('user');
    // 用户手权重 forget 同律幂等（不刷 updated_at 也不换终审来源）
    expect(db.forget(id)).toBe('dismissed');
    expect(db.get(id)?.supersededBy).toBe('user');
    // restore 后 forget 重新可用（终态短路不绑架复活路径）
    expect(db.restore(id)).toEqual({ restored: true });
    expect(db.forget(id, `llm:${id}`)).toBe('ok');
    expect(db.get(id)?.supersededBy).toBe(`llm:${id}`);
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

/* ---------------- 效用维度（§5 + §6 引用回写，user_version=4） ---------------- */

/** 一天毫秒数（未用阈值换算用） */
const DAY = 24 * 60 * 60 * 1000;

describe('markUsed + idsByPrefix（引用回写 DAO 面）', () => {
  it('markUsed：usage_count 累加、last_used_at 落值；未知 id 无效果', () => {
    const out = write({});
    if (out.outcome !== 'inserted') throw new Error('前置失败');
    const id = out.memory.id;
    expect(out.memory.usageCount).toBe(0); // 新条目零引用
    expect(out.memory.lastUsedAt).toBeNull(); // 从未被引用

    expect(db.markUsed([id], 1000)).toBe(1);
    const used = db.get(id)!;
    expect(used.usageCount).toBe(1);
    expect(used.lastUsedAt).toBe(1000);
    db.markUsed([id], 2000);
    expect(db.get(id)!.usageCount).toBe(2); // 累加不覆盖
    expect(db.get(id)!.lastUsedAt).toBe(2000);

    expect(db.markUsed(['不存在的-id'], 3000)).toBe(0); // 未知 id 静默零效
    expect(db.markUsed([], 3000)).toBe(0); // 空列表零效
  });

  it('idsByPrefix：短 id 前缀解析——恰一命中归属；非法前缀拒收', () => {
    const out = write({});
    if (out.outcome !== 'inserted') throw new Error('前置失败');
    const id = out.memory.id;
    const short = id.slice(0, 8);
    expect(db.idsByPrefix(short)).toEqual([id]); // 恰一命中
    expect(db.idsByPrefix('00000000')).toEqual([]); // 零命中（未知引用）
    // 非法形态拒收（citation 正则同形双保险——大写/短字/非 hex）
    expect(db.idsByPrefix('ABCDEF12')).toEqual([]);
    expect(db.idsByPrefix('abc')).toEqual([]);
    expect(db.idsByPrefix("ab'--")).toEqual([]);
  });
});

describe('utilityScore（效用综合分公式钉死）', () => {
  it('confidence × ln(evidence+1) × (1 + ln(usage+1))：引用 0 = 基线 ×1', () => {
    const base = { confidence: 0.8, evidenceCount: 3, usageCount: 0 };
    expect(utilityScore(base)).toBeCloseTo(0.8 * Math.log(4) * 1, 10);
    const used = { ...base, usageCount: 3 };
    expect(utilityScore(used)).toBeCloseTo(0.8 * Math.log(4) * (1 + Math.log(4)), 10);
    // 单调性：confidence / evidence / usage 任一上升分数上升
    expect(utilityScore({ ...used, usageCount: 9 })).toBeGreaterThan(utilityScore(used));
    expect(utilityScore({ ...used, evidenceCount: 9 })).toBeGreaterThan(utilityScore(used));
  });
});

describe('briefing 效用维度（30 天未用强排除 + 复活 + 排序抬升）', () => {
  it('未用超阈强排除（活动锚 = max(last_used_at, updated_at)）；新证据保活', () => {
    const now = 1_800_000_000_000; // 固定时钟（不取墙钟）——addMemory 的 nowMs 控制写入钟，markUsed 控制引用钟
    const store2 = openStore({
      path: ':memory:',
      migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION],
    });
    const db2 = new MemoryStore(store2.connection);
    const t40 = now - 40 * DAY;
    const add = (summary: string, ts: number) =>
      db2.addMemory({ ownerKey: 'global', kind: 'preference', summary, content: 'c', confidence: 0.7 }, ts);
    const a = add('四十天前的旧偏好甲', t40);
    const b = add('四十天前但近期被引用的偏好乙', t40);
    const c = add('三天前的新偏好丙', now - 3 * DAY);
    if (a.outcome !== 'inserted' || b.outcome !== 'inserted' || c.outcome !== 'inserted') {
      throw new Error('前置失败');
    }
    // 乙在 5 天前被引用（活动锚 = max(引用, 证据) = 5 天前 → 在 30 天窗内）
    db2.markUsed([b.memory.id], now - 5 * DAY);

    const brief = db2.briefing(['global'], { now: () => now });
    const summaries = brief.records.map((r) => r.summary);
    expect(summaries).not.toContain('四十天前的旧偏好甲'); // 强排除：锚 40 天 > 30 天窗
    expect(summaries).toContain('四十天前但近期被引用的偏好乙'); // 引用保活
    expect(summaries).toContain('三天前的新偏好丙'); // 从未被引用的新条目不被误伤

    // 复活链：甲被引用（markUsed 刷锚）→ 回简报；FTS 仍命中排除态条目（离开常驻面 ≠ 离开库）
    expect(db2.search('四十天前的旧偏好甲', ['global'])).toHaveLength(1);
    db2.markUsed([a.memory.id], now);
    expect(db2.briefing(['global'], { now: () => now }).records.map((r) => r.summary)).toContain('四十天前的旧偏好甲');
    // 未用排除不是截断（truncated 不因排除置位）
    expect(brief.truncated).toBe(false);
    store2.close();
  });

  it('排序抬升：同 confidence/evidence 下，被引用条目排前（utilityScore 同尺）', () => {
    const outA = write({ summary: '零引用的偏好A' });
    const outB = write({ summary: '被引用三次的偏好B' });
    if (outA.outcome !== 'inserted' || outB.outcome !== 'inserted') throw new Error('前置失败');
    for (let i = 0; i < 3; i += 1) db.markUsed([outB.memory.id], Date.now());

    const brief = db.briefing(['global']);
    expect(brief.records[0]!.summary).toBe('被引用三次的偏好B'); // usage 抬分压过写入序
  });

  it('v2→v4→v11 升格：存量库补跑 ALTER 不丢数据、新列就位', () => {
    // 模拟「旧宿主建的 v2 库」：旧宿主不知内核 v6/v10——现宿主开库（自带 app +
    // importer 列，uv 直达 10）后经 store.connection 退回 v2 形态（撤两列 + 回拨
    // user_version），再以全链重开 = 业务缺口（v4/v11）与内核缺口（v6/v10）同补。
    // 旧宿主写行 = 裸 SQL（现 store 代码依赖 v11 列，不能跑在 v2 形态上——测试
    // 模拟的是「旧版本宿主」，当然用旧版本时代的写路径形态）
    const path = joinTmp();
    const s1 = openStore({ path, migrations: [MEMORY_MIGRATION] });
    const legacyTs = Date.now(); // 现行写入时点（简报 30 天未用排除不误伤）
    s1.connection
      .prepare(
        `INSERT INTO memories (id, owner_key, kind, summary, content, confidence, evidence_count, status, source_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy-0001', 'global', 'fact', '升格前条目', 'c', 0.5, 1, 'active', '[]', legacyTs, legacyTs);
    s1.connection.exec('ALTER TABLE sessions DROP COLUMN importer');
    s1.connection.exec('ALTER TABLE sessions DROP COLUMN app');
    s1.connection.pragma('user_version = 2');
    s1.close();
    const s2 = openStore({ path, migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION] });
    const upgraded = new MemoryStore(s2.connection);
    const rows = upgraded.list(['global']);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usageCount).toBe(0); // 存量行回填缺省：零引用
    expect(rows[0]!.lastUsedAt).toBeNull();
    expect(rows[0]!.frozen).toBe(false); // v11 持有面三列回填：未冻结
    expect(rows[0]!.ttlDays).toBeNull(); // 无 TTL——存量条目行为零变
    expect(rows[0]!.expiresAt).toBeNull();
    expect(upgraded.briefing(['global']).records.map((r) => r.summary)).toContain('升格前条目');
    s2.close();
  });
});

describe('重开库（迁移幂等 + 数据存活）', () => {
  it('v2 库再开同链不重跑、条目完好', () => {
    write({});
    // :memory: 无法复开——用文件库走一遍迁移幂等 + 数据存活
    const path = joinTmp();
    const s1 = openStore({ path, migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION] });
    const file = new MemoryStore(s1.connection);
    file.addMemory({ ownerKey: 'global', kind: 'fact', summary: '文件库条目', content: 'c' });
    s1.close();
    const s2 = openStore({ path, migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION] });
    const reloaded = new MemoryStore(s2.connection);
    expect(reloaded.list(['global'])).toHaveLength(1);
    expect(reloaded.search('文件库', ['global'])).toHaveLength(1); // FTS 触发器产物跨开存活
    s2.close();
  });
});

/** 取落库后的条目 id（本组用例只走 inserted/merged 支——rejected 无 memory） */
function writeId(over: Parameters<typeof write>[0] = {}): string {
  const out = write(over);
  return out.outcome === 'rejected' ? '' : out.memory.id;
}

describe('briefing 晋升候选（§9.1 第 1 项，第四十二批——候选出场位 = 被限额截断的 scored 尾部）', () => {
  it('kind 闭集 + 反复命中判据：failure 攒双证据入候选；preference 不入；单证据不入', () => {
    write({ kind: 'preference', summary: '偏好 pnpm', content: 'x' });
    write({ kind: 'failure', summary: 'abi 不匹配', content: 'x' });
    write({ kind: 'failure', summary: 'abi 不匹配', content: 'y' }); // 精确合并 → evidence 2
    write({ kind: 'insight', summary: '单证据洞察', content: 'x' });
    // maxEntries:1 → 正文只收 preference（kindPriority 0），failure/insight 截断出正文
    const { records, candidates } = db.briefing(['global'], { maxEntries: 1 });
    expect(records.map((r) => r.kind)).toEqual(['preference']);
    expect(candidates.map((c) => c.kind)).toEqual(['failure']); // insight 单证据不入
  });

  it('usage ≥ 1（cite 判据）也入候选', () => {
    write({ kind: 'preference', summary: '偏好 pnpm', content: 'x' });
    const a = writeId({ kind: 'failure', summary: '被引用过的教训', content: 'x' });
    db.markUsed([a], Date.now());
    const { candidates } = db.briefing(['global'], { maxEntries: 1 });
    expect(candidates.some((c) => c.id === a)).toBe(true);
  });

  it('frozen 排除候选但恒驻正文（时间胶囊不搬家——§9.1 第 3 项同律）', () => {
    const a = writeId({ kind: 'failure', summary: '普通教训', content: 'x' });
    write({ kind: 'failure', summary: '普通教训', content: 'x' });
    const b = writeId({ kind: 'failure', summary: '冻结教训', content: 'x' });
    write({ kind: 'failure', summary: '冻结教训', content: 'x' });
    db.setFrozen(b, true);
    // maxEntries:0 → 竞争面空：frozen 恒驻正文（免竞争义），非冻结全数截断
    const { records, candidates } = db.briefing(['global'], { maxEntries: 0 });
    expect(records.map((r) => r.id)).toEqual([b]); // frozen 恒驻正文
    expect(candidates.map((c) => c.id)).toEqual([a]); // frozen 不入候选，普通教训入
  });

  it('正文已列条目去重（face 内同 id 双行 = 指纹与差分比较面污染，冷读 M1）', () => {
    // convention kindPriority=2 先入正文；同判据下 failure 截断出正文 → 只点名 failure
    write({ kind: 'convention', summary: '提交信息用中文', content: 'x' });
    write({ kind: 'convention', summary: '提交信息用中文', content: 'x' });
    write({ kind: 'failure', summary: '环依赖炸了', content: 'x' });
    write({ kind: 'failure', summary: '环依赖炸了', content: 'x' });
    const { records, candidates } = db.briefing(['global'], { maxEntries: 1 });
    expect(records.map((r) => r.kind)).toEqual(['convention']);
    expect(candidates.map((c) => c.kind)).toEqual(['failure']); // convention 在正文 → 不重复列
  });

  it('M2 回归锁：未用排除条目不因 usage ≥ 1 判据捞回候选（死 = 离开常驻面）', () => {
    const a = writeId({ kind: 'failure', summary: '老的教训', content: 'x' });
    write({ kind: 'failure', summary: '老的教训', content: 'x' });
    db.markUsed([a], Date.now()); // 被引用过（cite 判据成立）——但 30 天未用照样出局
    // 40 天后取简报：未用强排除先于候选判据（同一 scored 流——冷读 M2 拍板）
    const future = Date.now() + 40 * 24 * 60 * 60 * 1000;
    const { records, candidates } = db.briefing(['global'], { maxEntries: 0, now: () => future });
    expect(records.some((r) => r.id === a)).toBe(false);
    expect(candidates.some((r) => r.id === a)).toBe(false);
  });

  it('排序 = 效用综合分降序 + 上限截断', () => {
    for (let i = 0; i < 4; i++) {
      write({ kind: 'failure', summary: `失败模式 ${i}`, content: 'x', confidence: 0.9 - i * 0.2 });
      write({ kind: 'failure', summary: `失败模式 ${i}`, content: 'x', confidence: 0.9 - i * 0.2 });
    }
    const { candidates } = db.briefing(['global'], { maxEntries: 0 });
    expect(candidates).toHaveLength(3);
    expect(candidates[0]!.summary).toBe('失败模式 0');
    expect(candidates[2]!.summary).toBe('失败模式 2');
  });

  it('软删退场条目不入候选（activeByOwners 可见谓词前置）', () => {
    writeId({ kind: 'failure', summary: '已晋升的教训', content: 'x' });
    const b = writeId({ kind: 'failure', summary: '已晋升的教训', content: 'x' });
    db.forget(b, 'skill:pdf-tools');
    const { candidates } = db.briefing(['global'], { maxEntries: 0 });
    expect(candidates).toHaveLength(0);
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
