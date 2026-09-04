/**
 * L3 memory 集成测试（§3 持有面五件，第三十二批）——TTL 留存 / frozen 冻结 /
 * 版本链 / 访问流水 / 文件导入导出。真 :memory: 库全栈（迁移三链一次到位），
 * 无 mock；时钟全部显式注入（TTL 判定不取墙钟——确定性钉死）。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../persist/index.js';
import { MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION } from './schema.js';
import { MemoryStore } from './store.js';
import type { MemoryExportRow } from './store.js';
import { exportMemoryText, importMemoryText, isPathInsideRoots, writeExportFile } from './io.js';

/** 一天毫秒数（TTL 钟换算） */
const DAY = 24 * 60 * 60 * 1000;

/** 固定基准时钟（一切 nowMs 从此偏移——确定性） */
const T0 = 1_800_000_000_000;

/** 当前测试库（每用例新建 :memory:） */
let db: MemoryStore;

beforeEach(() => {
  db = new MemoryStore(
    openStore({ path: ':memory:', migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION] })
      .connection,
  );
});

/** 写一条并取 id（失败即测试前置崩——不吞） */
function seed(over: Record<string, unknown> = {}, ts: number = T0): string {
  const out = db.addMemory(
    {
      ownerKey: 'global',
      kind: 'preference',
      summary: '用户偏好 pnpm',
      content: '会话中确认统一用 pnpm。',
      ...over,
    } as Parameters<MemoryStore['addMemory']>[0],
    ts,
  );
  if (out.outcome !== 'inserted') throw new Error(`前置失败：${out.outcome}`);
  return out.memory.id;
}

/* ---------------- 第一件：TTL 留存 ---------------- */

describe('TTL（写入起算 + setTtl + 可见谓词 + 清扫物化）', () => {
  it('写入带 ttlDays 即起钟；setTtl 可改可清；missing 报缺', () => {
    const id = seed({ ttlDays: 30 });
    const row = db.get(id)!;
    expect(row.ttlDays).toBe(30);
    expect(row.expiresAt).toBe(T0 + 30 * DAY); // 写入时点起算

    // 改策略：钟按 setTtl 时点重算
    expect(db.setTtl(id, 10, T0 + DAY)).toEqual({ ok: true });
    expect(db.get(id)!.ttlDays).toBe(10);
    expect(db.get(id)!.expiresAt).toBe(T0 + DAY + 10 * DAY);

    // 清策略：永久（钟清空）
    expect(db.setTtl(id, null, T0 + 2 * DAY)).toEqual({ ok: true });
    expect(db.get(id)!.ttlDays).toBeNull();
    expect(db.get(id)!.expiresAt).toBeNull();

    expect(db.setTtl('不存在的-id', 5, T0)).toEqual({ ok: false, reason: 'missing' });
  });

  it('钟过未清扫行在读面统一不可见（list/search/briefing 前置谓词）；FTS 同罩', () => {
    const id = seed({ ttlDays: 1, summary: '临时项目约定' });
    const later = T0 + 2 * DAY; // 钟已过、尚未清扫
    expect(db.list(['global'], 'active', later)).toHaveLength(0);
    expect(db.search('临时项目约定', ['global'], 5, later)).toHaveLength(0);
    expect(db.briefing(['global'], { now: () => later }).records).toHaveLength(0);
    expect(db.idsByPrefix(id.slice(0, 8), later)).toEqual([]); // 引用解析面同罩
    // 行仍在库（未清扫非删除）——get 全状态直读可见
    expect(db.get(id)!.status).toBe('active');
  });

  it('sweepExpired 物化：status=expired、来源=ttl、清钟、不动 updated_at；frozen 行跳过', () => {
    const idShort = seed({ ttlDays: 1, summary: '短留存条' });
    const idFrozen = seed({ ttlDays: 1, summary: '冻结豁免条' });
    db.setFrozen(idFrozen, true, T0);
    const later = T0 + 2 * DAY;
    const before = db.get(idShort)!.updatedAt;

    expect(db.sweepExpired(later)).toBe(1); // 只物化未冻结的短钟行
    const swept = db.get(idShort)!;
    expect(swept.status).toBe('expired');
    expect(swept.supersededBy).toBe('ttl');
    expect(swept.expiresAt).toBeNull(); // 判定源交接给 status——裸钟谓词恒真漏洞已堵
    expect(swept.updatedAt).toBe(before); // 过期不是新证据

    // frozen 行未被清扫（免过期物化义）
    expect(db.get(idFrozen)!.status).toBe('active');
    // 物化行可审计（list 显式传 'expired'）
    expect(db.list(['global'], 'expired')).toHaveLength(1);
    // 幂等：再扫零行
    expect(db.sweepExpired(later + DAY)).toBe(0);
  });

  it('复活唯 restore：物化 expired 行 setTtl 不复活、restore 复活并按策略重算钟', () => {
    const id = seed({ ttlDays: 1 });
    db.sweepExpired(T0 + 2 * DAY);
    expect(db.get(id)!.status).toBe('expired');

    // setTtl 只改策略不动 status——过期行不因此复活
    db.setTtl(id, 30, T0 + 3 * DAY);
    expect(db.get(id)!.status).toBe('expired');

    // restore 复活 + 重算钟（ttl_days 30 天、复活时点起算）
    expect(db.restore(id, T0 + 3 * DAY)).toEqual({ restored: true });
    const revived = db.get(id)!;
    expect(revived.status).toBe('active');
    expect(revived.expiresAt).toBe(T0 + 3 * DAY + 30 * DAY);
    // 复活即回到可见面
    expect(db.list(['global'], 'active', T0 + 3 * DAY)).toHaveLength(1);
  });
});

/* ---------------- 第二件：frozen 冻结 ---------------- */

describe('frozen（冻结豁免面 + 恒驻简报）', () => {
  it('forget 拒冻结条（解冻-再忘是唯一路径）；解冻后可删', () => {
    const id = seed();
    db.setFrozen(id, true, T0);
    expect(db.forget(id)).toBe('frozen');
    expect(db.get(id)!.status).toBe('active'); // 未被软删
    db.setFrozen(id, false, T0);
    expect(db.forget(id)).toBe('ok');
  });

  it('合并候选豁免：冻结条同摘要再写走独立新条目（免覆写义）', () => {
    const id = seed({ summary: '用户偏好 pnpm' });
    db.setFrozen(id, true, T0);
    const out = db.addMemory(
      { ownerKey: 'global', kind: 'preference', summary: '用户偏好 pnpm', content: '新证据' },
      T0 + DAY,
    );
    // 不与冻结条合并（exact 也不合）——新证据独立成条
    expect(out.outcome).toBe('inserted');
    expect(db.get(id)!.evidenceCount).toBe(1); // 冻结条证据不动
  });

  it('恒驻简报：frozen 豁免 30 天未用排除、不占双限额、不触发截断', () => {
    // 冻结条：写入时点在排除窗外（40 天前）——frozen 豁免排除
    const frozenId = seed({ summary: '钉住的旧约定' }, T0 - 40 * DAY);
    db.setFrozen(frozenId, true, T0 - 40 * DAY);
    // 竞争面条目：maxEntries=1 之外还有两条（摘要词面全异——防中文近似触发模糊合并）
    seed({ summary: 'competitive alpha entry' }, T0);
    seed({ summary: 'unrelated beta item' }, T0);

    const brief = db.briefing(['global'], { maxEntries: 1, now: () => T0 });
    expect(brief.frozenCount).toBe(1);
    // frozen 恒驻 + 竞争面恰 1 条（名额判断扣除 frozen）
    expect(brief.records).toHaveLength(2);
    expect(brief.records.some((r) => r.id === frozenId)).toBe(true);
    expect(brief.truncated).toBe(true); // 截断只由竞争面触发（竞争面有溢出）
  });

  it('冻结清钟、解冻重算（有策略时）；无策略行解冻钟仍空', () => {
    const id = seed({ ttlDays: 30 });
    db.setFrozen(id, true, T0 + DAY);
    expect(db.get(id)!.expiresAt).toBeNull(); // 冻结 = 免 TTL 的物化面

    db.setFrozen(id, false, T0 + 2 * DAY);
    expect(db.get(id)!.expiresAt).toBe(T0 + 2 * DAY + 30 * DAY); // 按解冻时点重算（不补冻结期的账）

    const idNoTtl = seed({ summary: '永久条' });
    db.setFrozen(idNoTtl, true, T0);
    db.setFrozen(idNoTtl, false, T0 + DAY);
    expect(db.get(idNoTtl)!.expiresAt).toBeNull(); // 无策略解冻不造钟
  });
});

/* ---------------- 第三件：版本链 ---------------- */

describe('版本链（append-only 内容面快照 + 回滚）', () => {
  it('四成因按序成链：insert → merge → decay → rollback（revision 单调 +1）', () => {
    const id = seed({ summary: '用户偏好 pnpm', content: '初版内容' });
    expect(db.listVersions(id)).toHaveLength(1);
    expect(db.listVersions(id)[0]).toMatchObject({ revision: 1, cause: 'insert' });

    // 合并：内容面落变（confidence/evidence）→ 拍照 merge
    db.addMemory(
      { ownerKey: 'global', kind: 'preference', summary: '用户偏好 pnpm', content: '第二证据', confidence: 0.9 },
      T0 + DAY,
    );
    // 老化降权 → 拍照 decay
    db.decayConfidence(id, 0.5, T0 + 2 * DAY);
    // 回滚到第 1 版 → 拍照 rollback（回滚也是内容面变更）
    expect(db.restore(id, T0 + 3 * DAY, 1)).toEqual({ restored: true });

    const chain = db.listVersions(id);
    expect(chain.map((v) => v.cause)).toEqual(['insert', 'merge', 'decay', 'rollback']);
    expect(chain.map((v) => v.revision)).toEqual([1, 2, 3, 4]);
    // 回滚后现行值 == 第 1 版内容面（快照六列回写主表）
    const current = db.get(id)!;
    const v1 = db.versionAt(id, 1)!;
    expect(current.summary).toBe(v1.summary);
    expect(current.content).toBe(v1.content);
    expect(current.confidence).toBe(v1.confidence);
    expect(current.evidenceCount).toBe(v1.evidenceCount);
    // 版本号不存在 → restore 报 revision
    expect(db.restore(id, T0, 99)).toEqual({ restored: false, reason: 'revision' });
  });

  it('纯状态/计量变更不拍照：frozen/ttl/usage 动而链不长', () => {
    const id = seed();
    db.setFrozen(id, true, T0);
    db.setTtl(id, 10, T0);
    db.markUsed([id], T0 + DAY, 's1');
    db.setFrozen(id, false, T0 + 2 * DAY);
    expect(db.listVersions(id)).toHaveLength(1); // 仍只有首版
  });

  it('versionAt 快照全文与摘要面一致；未知 id 空链不抛', () => {
    const id = seed({ summary: '快照核对条', content: '内容全文' });
    const snap = db.versionAt(id, 1)!;
    expect(snap.content).toBe('内容全文');
    expect(snap.kind).toBe('preference');
    expect(db.listVersions('不存在的-id')).toEqual([]);
    expect(db.versionAt('不存在的-id', 1)).toBeUndefined();
  });
});

/* ---------------- 第四件：访问流水 ---------------- */

describe('访问流水（recordAccess + markUsed cite + 查询聚合）', () => {
  it('markUsed 三合一：usage/续期/cite 流水同事务；usage_count ≡ cite 行数（清扫前·累计口径恒等——90 天窗口清扫只删流水不回退聚合）', () => {
    const idTtl = seed({ ttlDays: 30, summary: '有留存条' });
    const idFrozen = seed({ ttlDays: 30, summary: '冻结计量条' });
    db.setFrozen(idFrozen, true, T0);

    // 有 TTL 非 frozen：钟按引用时点续期（使用中的证据即留存正当性）
    db.markUsed([idTtl], T0 + 10 * DAY, 's1');
    expect(db.get(idTtl)!.expiresAt).toBe(T0 + 10 * DAY + 30 * DAY);
    // frozen：usage 照计但钟不动（冻结期免过期也免续期）
    db.markUsed([idFrozen], T0 + 10 * DAY, 's1');
    expect(db.get(idFrozen)!.usageCount).toBe(1);
    expect(db.get(idFrozen)!.expiresAt).toBeNull(); // 冻结清钟形态保持

    // 物化 expired 行跳过（引用救不回终态）
    const idDead = seed({ ttlDays: 1, summary: '已过期条' });
    db.sweepExpired(T0 + 2 * DAY);
    expect(db.markUsed([idDead], T0 + 5 * DAY)).toBe(0);
    expect(db.get(idDead)!.usageCount).toBe(0);

    // cite 流水落账 + sessionId：聚合面与审计面同源
    const cites = db.accessLog({ op: 'cite' });
    expect(cites).toHaveLength(2);
    expect(cites.every((r) => r.op === 'cite' && r.sessionId === 's1')).toBe(true);
  });

  it('recordAccess 记 recall/search 流水（不进聚合）；accessLog 过滤面 + ts 降序', () => {
    // uuid v7 前 8 位 hex = 时间戳高 32 位（~56 天窗内同前缀）——两 id 分开 60 天种子，前缀查询才有区分度
    const idA = seed({ summary: '条目甲' }, T0);
    const idB = seed({ summary: '条目乙' }, T0 + 60 * DAY);
    db.recordAccess(
      [
        { memoryId: idA, op: 'search' },
        { memoryId: idA, op: 'recall', sessionId: 's9' },
        { memoryId: idB, op: 'search' },
      ],
      T0,
    );
    db.markUsed([idA], T0 + DAY, 's1'); // cite

    // 全量：ts 降序（cite 最新在前）
    const all = db.accessLog({});
    expect(all.map((r) => r.op)).toEqual(['cite', 'search', 'recall', 'search']);

    // op 过滤
    expect(db.accessLog({ op: 'search' })).toHaveLength(2);
    // 精确 id
    expect(db.accessLog({ memoryId: idB })).toHaveLength(1);
    // 前缀（短 id 同形——只圈住 idA 的三行流水）
    expect(db.accessLog({ prefix: idA.slice(0, 8) })).toHaveLength(3);
    // 时间窗（cite 在 T0+DAY、其余在 T0）
    expect(db.accessLog({ sinceMs: T0 + 1 })).toHaveLength(1);
    expect(db.accessLog({ untilMs: T0 })).toHaveLength(3);
    // limit
    expect(db.accessLog({ limit: 2 })).toHaveLength(2);
    // 聚合不随流水：usage 只认 cite
    expect(db.get(idA)!.usageCount).toBe(1);
    expect(db.get(idB)!.usageCount).toBe(0);
  });

  it('topByUsage：usage 降序、次键最近引用；只含可见行', () => {
    const idA = seed({ summary: '高频条' });
    const idB = seed({ summary: '低频条' });
    seed({ ttlDays: 1, summary: '过期不计条' });
    for (let i = 0; i < 3; i += 1) db.markUsed([idA], T0 + i * DAY, 's1');
    db.markUsed([idB], T0, 's1');
    db.sweepExpired(T0 + 2 * DAY); // idDead 物化

    const top = db.topByUsage(['global'], 10, T0 + 3 * DAY);
    expect(top.map((r) => r.id)).toEqual([idA, idB]); // expired 不进聚合面
  });

  it('【回归锁 OS 三大管理面研究 20260904】sweepAccessLog 90 天窗口清扫：窗外流水删、窗内留、聚合列不回退', () => {
    // 修前：MemoryStore 无 sweepAccessLog 面——记忆与自进化.md §3「清扫与 TTL
    // expired 同节拍同拍」拍板未落码，流水表无界增长（90 天窗口留存条款空头）
    const idA = seed({ summary: '老流水条' });
    const idB = seed({ summary: '新流水条' });
    db.markUsed([idA], T0, 's1'); // cite 流水 @T0（窗外——清扫基准 T0+95d，窗界 T0+5d）
    db.recordAccess([{ memoryId: idA, op: 'search' }], T0 + 2 * DAY); // 仍窗外
    db.recordAccess([{ memoryId: idB, op: 'recall' }], T0 + 10 * DAY); // 窗内

    const swept = db.sweepAccessLog(T0 + 95 * DAY);
    expect(swept).toBe(2); // 只删窗外两行（修前：方法不存在即红）
    expect(db.accessLog({})).toHaveLength(1); // 窗内 recall 留存
    expect(db.accessLog({})[0]!.op).toBe('recall');
    // 聚合列不回退：idA 的 cite 计量在窗外流水删除后原样（权威计量面与可丢弃审计面分离）
    expect(db.get(idA)!.usageCount).toBe(1);
    expect(db.get(idA)!.lastUsedAt).toBe(T0);
    // 幂等：再扫零命中零开销
    expect(db.sweepAccessLog(T0 + 95 * DAY)).toBe(0);
  });
});

/* ---------------- 第五件：文件导入导出 ---------------- */

describe('文件导入导出（JSONL 编排件）', () => {
  /** 造一条可直接导入的行形态（17 列 snake_case 与库同构） */
  function exportRow(over: Partial<MemoryExportRow> = {}): MemoryExportRow {
    return {
      id: '0a1b2c3d-0000-7000-8000-000000000001',
      owner_key: 'global',
      kind: 'preference',
      summary: '导入条目',
      content: '内容',
      confidence: 0.7,
      evidence_count: 2,
      usage_count: 3,
      last_used_at: null,
      status: 'active',
      superseded_by: null,
      source_refs: '[]',
      created_at: T0,
      updated_at: T0,
      frozen: 0,
      ttl_days: null,
      expires_at: null,
      ...over,
    };
  }

  /** 导出文本的首行 header（JSON 形态直读——构造导入侧用例） */
  function headerLine(): string {
    return JSON.stringify({
      format: 'berryagent-memory',
      formatVersion: 1,
      exportedAt: T0,
      ownerScope: null,
      ownerRoots: [],
    });
  }

  it('exportMemoryText：header + 全状态行（含终态行）；ownerScope 过滤', () => {
    seed({ summary: '活跃条' });
    const deadId = seed({ summary: '终态条' });
    db.forget(deadId);
    const text = exportMemoryText(db, undefined, ['/proj']);
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(3); // header + 2 行
    const header = JSON.parse(lines[0]!) as { format: string; formatVersion: number; ownerRoots: string[] };
    expect(header.format).toBe('berryagent-memory');
    expect(header.formatVersion).toBe(1);
    expect(header.ownerRoots).toEqual(['/proj']);
    // 终态行原样在文件（迁移面要完整状态机）
    const statuses = lines.slice(1).map((l) => (JSON.parse(l) as MemoryExportRow).status);
    expect(statuses.sort()).toEqual(['active', 'dismissed']);

    const scoped = exportMemoryText(db, 'global');
    expect(scoped.split('\n').filter((l) => l.trim() !== '')).toHaveLength(3);
    const none = exportMemoryText(db, 'project:zzz');
    expect(none.split('\n').filter((l) => l.trim() !== '')).toHaveLength(1); // 只剩 header
  });

  it('导入恢复式幂等：新入 → 再导全跳过（按 id 零合并）；状态面直插保全计量与终态', () => {
    const row = exportRow({ usage_count: 5, status: 'dismissed', superseded_by: 'user' });
    const text = [headerLine(), JSON.stringify(row)].join('\n');
    expect(importMemoryText(db, text)).toEqual({ imported: 1, skippedExisting: 0, skippedSecret: 0, invalid: 0 });
    const stored = db.get(row.id)!;
    expect(stored.usageCount).toBe(5); // 计量随行落库（恢复义——非内容面新写）
    expect(stored.status).toBe('dismissed');
    // 再导入：id 命中全跳过
    expect(importMemoryText(db, text)).toEqual({ imported: 0, skippedExisting: 1, skippedSecret: 0, invalid: 0 });
  });

  it('header 校验整体拒导：格式/版本不符零行入账', () => {
    const row = JSON.stringify(exportRow());
    const badFormat = [JSON.stringify({ format: '别的格式', formatVersion: 1 }), row].join('\n');
    expect(importMemoryText(db, badFormat)).toMatchObject({ rejected: 'format', imported: 0 });
    const badVersion = [JSON.stringify({ format: 'berryagent-memory', formatVersion: 2 }), row].join('\n');
    expect(importMemoryText(db, badVersion)).toMatchObject({ rejected: 'format', imported: 0 });
    const notJson = ['根本不是 JSON', row].join('\n');
    expect(importMemoryText(db, notJson)).toMatchObject({ rejected: 'format', imported: 0 });
    expect(db.list(['global'])).toHaveLength(0); // 拒导 = 库无痕迹
  });

  it('逐行校验：缺列 invalid / secret 行跳过计数；好行不中断', () => {
    const good = exportRow({ id: '0a1b2c3d-0000-7000-8000-0000000000aa' });
    const missing = exportRow({ id: '0a1b2c3d-0000-7000-8000-0000000000bb' });
    delete (missing as { ttl_days?: number | null }).ttl_days; // 手改缺列
    const secret = exportRow({ id: '0a1b2c3d-0000-7000-8000-0000000000cc', summary: 'token = ' + 'a'.repeat(24) });
    const text = [headerLine(), JSON.stringify(good), JSON.stringify(missing), JSON.stringify(secret)].join('\n');
    // #11 后 invalid > 0 时明细在场——缺列行（文件第 3 行）入明细
    expect(importMemoryText(db, text)).toEqual({
      imported: 1,
      skippedExisting: 0,
      skippedSecret: 1,
      invalid: 1,
      invalidDetails: [{ line: 3, reason: 'missing column' }],
    });
    expect(db.get(good.id)).toBeDefined(); // 好行照入
  });

  it('行级失败明细（基建大扫 #11）：invalid 行披露原始文件行号与原因短语，帽 10 条', () => {
    // 手改/截断文件的运维定位线索：坏 JSON 行与缺列行各报一条明细——行号必须是
    // 原始文件行号（空行被过滤后序号会漂移——用户按行号打开文件须能对上位置）
    const badJson = '根本不是 JSON 的数据行';
    const missing = exportRow({ id: '0a1b2c3d-0000-7000-8000-0000000000dd' });
    // frozen 列在库导出面是 number（0/1）——按 unknown 转形删键模拟手改缺列
    delete (missing as unknown as { frozen?: unknown }).frozen;
    const text = [headerLine(), badJson, '', JSON.stringify(missing)].join('\n'); // 第 2 行坏、第 3 行空、第 4 行缺列
    const report = importMemoryText(db, text);
    expect(report.invalid).toBe(2);
    // 修前红：现状只计数无明细——invalid 行不可定位（行号/原因零披露）
    expect(report.invalidDetails).toEqual([
      { line: 2, reason: expect.stringContaining('JSON') },
      { line: 4, reason: expect.stringContaining('missing column') },
    ]);
    // 明细帽 10 条防刷屏（对齐 bash-path.ts:126 probed.slice(0,8) 先例）——计数不受帽影响
    const rows = Array.from({ length: 12 }, (_, i) => `坏行 ${i}`);
    const flood = [headerLine(), ...rows].join('\n');
    const capped = importMemoryText(db, flood);
    expect(capped.invalid).toBe(12);
    expect(capped.invalidDetails).toHaveLength(10);
  });

  it('全好行零明细键：invalidDetails 不在场（报告形状最小——既有消费面零扰动）', () => {
    const row = exportRow({ id: '0a1b2c3d-0000-7000-8000-0000000000ee' });
    const text = [headerLine(), JSON.stringify(row)].join('\n');
    expect(importMemoryText(db, text)).toEqual({ imported: 1, skippedExisting: 0, skippedSecret: 0, invalid: 0 });
  });

  it('writeExportFile 真落盘（明文 JSONL 可直读回放）', async () => {
    seed({ summary: '落盘核对条' });
    const path = joinTmp('export-roundtrip.jsonl');
    await writeExportFile(path, exportMemoryText(db));
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
  });

  it('isPathInsideRoots：根内命中/越根拒绝/文件系统根通配', () => {
    expect(isPathInsideRoots('/w/sub/file.jsonl', ['/w'])).toBe(true);
    expect(isPathInsideRoots('/w', ['/w'])).toBe(true); // 根本身边份
    expect(isPathInsideRoots('/etc/passwd', ['/w'])).toBe(false);
    expect(isPathInsideRoots('/w2/file', ['/w'])).toBe(false); // 前缀串根不误伤（/w2 ≠ /w 下）
    expect(isPathInsideRoots('/any/where', ['/'])).toBe(true); // sep 根 = 任意绝对路径
  });
});

/** 文件落盘临时目录（全文件共享，afterAll 清理） */
let tmpDir: string | undefined;
let tmpSeq = 0;
function joinTmp(name: string): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'memory-holding-test-'));
  return join(tmpDir, `${tmpSeq++}-${name}`);
}
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});
