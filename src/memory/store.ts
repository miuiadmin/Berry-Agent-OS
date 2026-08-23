/**
 * L3 memory — 记忆库 DAO（记忆与自进化篇 §3/§5/§6 的表族语义层）。
 *
 * 经 persist 连接面（Store.connection）自行 prepared statement——物理层与语义层分工：
 * 语义在 memory、编码与连接治理在 persist（会话篇 §6 迁移框架落码形态）。
 * 写路径唯一：addMemory 内单事务跑三分支合并管线，没有绕过合并的直通道（§4 铁律）。
 */

import { createHash } from 'node:crypto';
import type { DatabaseConnection } from '../persist/index.js';
import { classifyMerge } from './merge.js';
import { uuidV7 } from './id.js';

/** kind 七值（记忆篇 §3：preference/fact/convention/correction/failure/insight/profile） */
export type MemoryKind = 'preference' | 'fact' | 'convention' | 'correction' | 'failure' | 'insight' | 'profile';

/** 条目状态：active 在册 / dismissed 软删（可恢复）/ superseded 被裁决替代 */
export type MemoryStatus = 'active' | 'dismissed' | 'superseded';

/** 溯源引用：记忆条目可回放到事件（铁律 5——全程可追溯） */
export interface MemorySourceRef {
  readonly sessionId: string;
  readonly seq: number;
}

/** 记忆条目（行形态的语义化映射：source_refs 已解析、字段驼峰） */
export interface MemoryRecord {
  readonly id: string;
  readonly ownerKey: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly content: string;
  readonly confidence: number;
  readonly evidenceCount: number;
  readonly status: MemoryStatus;
  readonly supersededBy: string | null;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 写入入参（addMemory 唯一写面的载荷；confidence 缺省 0.5 起草值） */
export interface MemoryInput {
  readonly ownerKey: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly content: string;
  readonly confidence?: number;
  readonly sourceRefs?: readonly MemorySourceRef[];
}

/** addMemory 三分支持结果（四态：全新插入/合并增强/极性裁决新胜/极性裁决旧胜驳回） */
export type AddMemoryOutcome =
  | { readonly outcome: 'inserted'; readonly memory: MemoryRecord }
  | { readonly outcome: 'merged'; readonly memory: MemoryRecord; readonly via: 'exact' | 'fuzzy' }
  | { readonly outcome: 'superseded'; readonly memory: MemoryRecord; readonly supersededId: string }
  | { readonly outcome: 'rejected'; readonly reason: 'lower-confidence'; readonly existingId: string };

/** source_refs 追加上限（防无界增长；超出保最近——起草值随实测调） */
const SOURCE_REFS_CAP = 50;

/** 物理行（snake_case + source_refs JSON 文本） */
interface MemoryRow {
  id: string;
  owner_key: string;
  kind: string;
  summary: string;
  content: string;
  confidence: number;
  evidence_count: number;
  status: string;
  superseded_by: string | null;
  source_refs: string;
  created_at: number;
  updated_at: number;
}

/** 行 → 语义记录（source_refs 解析；异常 JSON 防御为空数组——旧库脏数据不炸读面） */
function toRecord(row: MemoryRow): MemoryRecord {
  let refs: MemorySourceRef[] = [];
  try {
    refs = JSON.parse(row.source_refs) as MemorySourceRef[];
  } catch {
    refs = [];
  }
  return {
    id: row.id,
    ownerKey: row.owner_key,
    kind: row.kind as MemoryKind,
    summary: row.summary,
    content: row.content,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    status: row.status as MemoryStatus,
    supersededBy: row.superseded_by,
    sourceRefs: refs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 合并两份溯源引用（sessionId+seq 去重，保最近 SOURCE_REFS_CAP 条） */
function mergeRefs(a: readonly MemorySourceRef[], b: readonly MemorySourceRef[]): string {
  const seen = new Set<string>();
  const merged: MemorySourceRef[] = [];
  for (const ref of [...a, ...b]) {
    const key = `${ref.sessionId}:${ref.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return JSON.stringify(merged.slice(-SOURCE_REFS_CAP));
}

/**
 * 项目归属键：'project:<根路径哈希>'（两层归属——global + 项目，Hermes 实证）。
 * @param cwd 项目根绝对路径
 */
export function projectOwnerKey(cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return `project:${hash}`;
}

/**
 * 记忆库 DAO。构造只经 createMemoryStore（表族必须已建——经统一迁移框架）。
 */
export class MemoryStore {
  private readonly db: DatabaseConnection;

  constructor(db: DatabaseConnection) {
    this.db = db;
  }

  /** 活跃条目取数（简报/检索/工具读面的共同底座） */
  private activeByOwners(ownerKeys: readonly string[]): MemoryRow[] {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM memories WHERE status = 'active' AND owner_key IN (${placeholders})`)
      .all(...ownerKeys) as MemoryRow[];
  }

  /**
   * 唯一写入面：候选过三分支合并管线，单事务落库（§4/§5——提取与工具共用，无绕过路径）。
   * 分支优先级跨候选成立：先扫全部候选找精确匹配，再扫模糊，最后极性（防「先遇到的
   * 模糊匹配合并、漏掉后面的精确匹配」）。
   */
  addMemory(input: MemoryInput, nowMs: number = Date.now()): AddMemoryOutcome {
    if (input.summary.trim() === '' || input.content.trim() === '') {
      throw new Error('记忆条目 summary/content 不得为空（写入面拒收——空条目无合并与注入价值）');
    }
    const confidence = input.confidence ?? 0.5;

    const run = this.db.transaction((): AddMemoryOutcome => {
      const candidates = this.db
        .prepare(`SELECT * FROM memories WHERE owner_key = ? AND kind = ? AND status = 'active'`)
        .all(input.ownerKey, input.kind) as MemoryRow[];

      // 第一遍：精确合并（同 summary 全等 → 证据 +1、confidence 取 max）
      const exact = candidates.find((c) => c.summary === input.summary);
      if (exact) {
        return this.mergeInto(exact, confidence, input, nowMs, 'exact');
      }
      // 第二遍：模糊合并（Jaccard ≥ 0.74）
      const fuzzy = candidates.find(
        (c) =>
          classifyMerge({ summary: c.summary, confidence: c.confidence }, { summary: input.summary, confidence })
            .type === 'fuzzy',
      );
      if (fuzzy) {
        return this.mergeInto(fuzzy, confidence, input, nowMs, 'fuzzy');
      }
      // 第三遍：极性冲突裁决（高 confidence 胜、相等新胜）
      const conflict = candidates.find(
        (c) =>
          classifyMerge({ summary: c.summary, confidence: c.confidence }, { summary: input.summary, confidence })
            .type === 'polarity',
      );
      if (conflict) {
        if (confidence >= conflict.confidence) {
          // 新胜：旧条 dismissed（auto_resolved）、新条入库并继承双方证据计数
          this.db
            .prepare(
              `UPDATE memories SET status = 'dismissed', superseded_by = 'auto_resolved', updated_at = ? WHERE id = ?`,
            )
            .run(nowMs, conflict.id);
          const record = this.insert(input, confidence, conflict.evidence_count + 1, nowMs, conflict.id);
          return { outcome: 'superseded', memory: record, supersededId: conflict.id };
        }
        // 旧胜（高 confidence 在库）：候选驳回——矛盾不增证据，静默落 rejected 供调用方观测
        return { outcome: 'rejected', reason: 'lower-confidence', existingId: conflict.id };
      }
      // 无匹配：全新条目
      return { outcome: 'inserted', memory: this.insert(input, confidence, 1, nowMs) };
    });
    return run.immediate() as AddMemoryOutcome;
  }

  /** 合并落库（exact/fuzzy 共用）：证据 +1、confidence 取 max（保强证据不被均值稀释）、refs 追加 */
  private mergeInto(
    row: MemoryRow,
    candidateConfidence: number,
    input: MemoryInput,
    nowMs: number,
    via: 'exact' | 'fuzzy',
  ): AddMemoryOutcome {
    this.db
      .prepare(
        `UPDATE memories
           SET confidence = MAX(confidence, ?), evidence_count = evidence_count + 1,
               source_refs = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        candidateConfidence,
        mergeRefs(JSON.parse(row.source_refs) as MemorySourceRef[], input.sourceRefs ?? []),
        nowMs,
        row.id,
      );
    const memory = this.get(row.id);
    if (!memory) throw new Error(`合并后读回失败（${row.id}）——事务内不可达，防御断言`);
    return { outcome: 'merged', memory, via };
  }

  /** 插入新条目（uuid v7 主键；继承证据计数用于极性新胜） */
  private insert(
    input: MemoryInput,
    confidence: number,
    evidenceCount: number,
    nowMs: number,
    supersedeOf?: string,
  ): MemoryRecord {
    const id = uuidV7(nowMs);
    this.db
      .prepare(
        `INSERT INTO memories (id, owner_key, kind, summary, content, confidence, evidence_count,
           status, superseded_by, source_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerKey,
        input.kind,
        input.summary,
        input.content,
        confidence,
        evidenceCount,
        // 新条目非终态：superseded_by 仅在被替代时写；此处登记「替代了谁」不入列（终态来源语义）
        null,
        JSON.stringify(input.sourceRefs ?? []),
        nowMs,
        nowMs,
      );
    void supersedeOf; // 极性新胜的旧条 id 仅事务内使用（上面已先 UPDATE 旧行），此处不落列
    const memory = this.get(id);
    if (!memory) throw new Error(`插入后读回失败（${id}）——事务内不可达，防御断言`);
    return memory;
  }

  /** 单条读取（含 dismissed/superseded——审计与恢复面要看全量状态） */
  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** 按归属列条目（status 缺省 active；工具/审计读面） */
  list(ownerKeys: readonly string[], status: MemoryStatus = 'active'): MemoryRecord[] {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE owner_key IN (${placeholders}) AND status = ? ORDER BY updated_at DESC`)
      .all(...ownerKeys, status) as MemoryRow[];
    return rows.map(toRecord);
  }

  /** 软删（status=dismissed；by 缺省 'user'——用户终审手权最大，§8.4） */
  forget(id: string, by: string = 'user', nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare(`UPDATE memories SET status = 'dismissed', superseded_by = ?, updated_at = ? WHERE id = ?`)
      .run(by, nowMs, id);
    return result.changes > 0;
  }

  /** 恢复软删条目（superseded_by 一并清空——回到在册态） */
  restore(id: string, nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare(`UPDATE memories SET status = 'active', superseded_by = NULL, updated_at = ? WHERE id = ?`)
      .run(nowMs, id);
    return result.changes > 0;
  }

  /**
   * 老化降置信（§5 consolidation 落地件）：confidence × factor（下限 0 保底）。
   * 不刷新 updated_at——降权不是新证据，老化判定基准（最后证据时间）不动，
   * 反复 decay 不会把条目「洗新」出老化候选集。
   */
  decayConfidence(id: string, factor: number): boolean {
    const result = this.db
      .prepare(`UPDATE memories SET confidence = MAX(0, confidence * ?) WHERE id = ?`)
      .run(factor, id);
    return result.changes > 0;
  }

  /**
   * FTS 检索（memory_fts 投影，trigram 分词；仅 active）。查询词逐 token 加引号转义后
   * 空格连接（FTS5 隐式 AND；trigram 下 <3 字符 token 在查询中被忽略）——用户输入的
   * 标点/操作符不可能炸 MATCH 语法。
   * @returns 按相关度排序的条目（limit 缺省 5）
   */
  search(query: string, ownerKeys: readonly string[], limit: number = 5): MemoryRecord[] {
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0 || ownerKeys.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    const placeholders = ownerKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_fts f
           JOIN memories m ON m.rowid = f.rowid
          WHERE memory_fts MATCH ?
            AND m.status = 'active'
            AND m.owner_key IN (${placeholders})
          ORDER BY rank LIMIT ?`,
      )
      .all(match, ...ownerKeys, limit) as MemoryRow[];
    return rows.map(toRecord);
  }

  /**
   * 常驻简报取数（记忆篇 §6 注入通道 1）：owner 匹配的 active 条目，
   * 排序 = kind 优先级（preference/profile/convention 先）→ confidence × log(evidence+1) 降序；
   * 条数与字符双限额（maxEntries/maxChars 起草值随实测调，结构不随调）。
   * @returns 入选条目 + 是否触限额截断（截断可见——ref-7「禁止静默截断」）
   */
  briefing(
    ownerKeys: readonly string[],
    opts: { maxEntries?: number; maxChars?: number } = {},
  ): { records: MemoryRecord[]; truncated: boolean } {
    const maxEntries = opts.maxEntries ?? 20;
    const maxChars = opts.maxChars ?? 2000;
    const kindPriority: Record<MemoryKind, number> = {
      preference: 0,
      profile: 1,
      convention: 2,
      fact: 3,
      correction: 3,
      failure: 3,
      insight: 3,
    };
    const scored = this.activeByOwners(ownerKeys)
      .map(toRecord)
      .sort((a, b) => {
        const byKind = kindPriority[a.kind] - kindPriority[b.kind];
        if (byKind !== 0) return byKind;
        // 得分 = confidence × ln(evidence+1)：多次独立证据显著抬升（对数防单条刷爆）
        return b.confidence * Math.log(b.evidenceCount + 1) - a.confidence * Math.log(a.evidenceCount + 1);
      });
    const records: MemoryRecord[] = [];
    let used = 0;
    let truncated = false;
    for (const record of scored) {
      if (records.length >= maxEntries) {
        truncated = true;
        break;
      }
      const cost = record.summary.length + 1; // 简报行 = 一条 summary + 换行
      if (used + cost > maxChars) {
        truncated = true;
        break;
      }
      records.push(record);
      used += cost;
    }
    return { records, truncated };
  }
}
