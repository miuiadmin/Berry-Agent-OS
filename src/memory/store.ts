/**
 * L3 memory — 记忆库 DAO（记忆与自进化篇 §3/§5/§6 的表族语义层 + §3 持有面块）。
 *
 * 经 persist 连接面（Store.connection）自行 prepared statement——物理层与语义层分工：
 * 语义在 memory、编码与连接治理在 persist（会话篇 §6 迁移框架落码形态）。
 * 写路径纪律：addMemory 内单事务跑三分支合并管线，没有绕过合并的直通道（§4 铁律）
 * ——内容面插入/合并路径唯一；importRow 是**状态面**恢复直插（§3 文件导入：按 id
 * 幂等零合并），与「内容面唯一写路径」不冲突（第三十二批冷读边界注记）。
 *
 * 持有面不变式（§3，第三十二批）：主表 = 现行值权威、memory_versions = append-only
 * 内容面快照链（内容面变更单事务双写，纯状态/计量变更不拍照）；TTL 过期判定单一
 * 来源交接——未清扫行一切读面统一可见谓词，清扫物化 status='expired' 并清钟，
 * 复活唯 restore；frozen 压倒：读面跳过 TTL 过滤、清扫跳过、合并候选豁免、forget 拒。
 */

import { createHash } from 'node:crypto';
import type { DatabaseConnection } from '../persist/index.js';
import { classifyMerge } from './merge.js';
import { uuidV7 } from './id.js';

/** kind 七值（记忆篇 §3：preference/fact/convention/correction/failure/insight/profile） */
export type MemoryKind = 'preference' | 'fact' | 'convention' | 'correction' | 'failure' | 'insight' | 'profile';

/**
 * 条目状态：active 在册 / dismissed 软删（可恢复）/ superseded 被裁决替代 /
 * expired 过期物化（TTL 清扫产物——持有策略软终态非删除：行与溯源永在、restore
 * 可复活；与 dismissed 分界 = TTL 无否决者，第三十二批冷读词汇注记）。
 */
export type MemoryStatus = 'active' | 'dismissed' | 'superseded' | 'expired';

/** 访问日志操作闭集（§3 memory_access.op）：recall=按需检索注入 / search=工具检索命中 / cite=引用回写 */
export type MemoryAccessOp = 'recall' | 'search' | 'cite';

/** 版本链快照成因闭集（§3 memory_versions.cause——机器判定词，与合并管线人读 reason 分词） */
export type MemoryVersionCause = 'insert' | 'merge' | 'decay' | 'rollback';

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
  /** 被模型引用次数（效用维度计量面——引用回写累加，永不归零；聚合只随 cite） */
  readonly usageCount: number;
  /** 最近被引用时间（Unix 毫秒；null = 从未被引用） */
  readonly lastUsedAt: number | null;
  readonly status: MemoryStatus;
  readonly supersededBy: string | null;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 冻结位（§3 frozen：恒简报/免 TTL/免覆写/免整理——豁免+恒驻义，纯状态变更不拍照） */
  readonly frozen: boolean;
  /** 留存策略天数（null = 永久缺省）；标记/续期/复活以此重算钟 */
  readonly ttlDays: number | null;
  /** 过期钟（Unix 毫秒；null = 不过期或已清扫物化——判定源已交接给 status） */
  readonly expiresAt: number | null;
}

/** 版本链摘要行（memory_read 版本链展示面——内容全量在快照表，摘要只披露元信息） */
export interface MemoryVersionSummary {
  readonly revision: number;
  readonly cause: MemoryVersionCause;
  readonly summary: string;
  readonly confidence: number;
  readonly createdAt: number;
}

/** 单条版本快照全文（restore 指定版本与审计深读面） */
export interface MemoryVersionSnapshot {
  readonly revision: number;
  readonly cause: MemoryVersionCause;
  readonly ownerKey: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly content: string;
  readonly confidence: number;
  readonly evidenceCount: number;
  readonly createdAt: number;
}

/** 访问日志行（memory_access 查询面形态） */
export interface MemoryAccessRow {
  readonly memoryId: string;
  readonly op: MemoryAccessOp;
  /** 发生会话；search 行恒 NULL（ToolCtx 无会话键——扩面挂第二消费者，冷读注记） */
  readonly sessionId: string | null;
  readonly ts: number;
}

/** 访问日志查询入参（memory_access_log 工具参数面） */
export interface AccessLogQuery {
  /** 精确条目 id（与 prefix 二选一，都缺省 = 全部条目） */
  readonly memoryId?: string;
  /** 条目 id 前缀（8 位十六进制短 id 同形，LIKE 前缀匹配——查询面歧义展开多行非忽略） */
  readonly prefix?: string;
  /** 操作过滤（缺省全部三态） */
  readonly op?: MemoryAccessOp;
  /** 时间窗下界（Unix 毫秒，含） */
  readonly sinceMs?: number;
  /** 时间窗上界（Unix 毫秒，含） */
  readonly untilMs?: number;
  /** 返回条数（缺省 50，起草值） */
  readonly limit?: number;
}

/** 写入入参（addMemory 唯一写面的载荷；confidence 缺省 0.5 起草值） */
export interface MemoryInput {
  readonly ownerKey: string;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly content: string;
  readonly confidence?: number;
  readonly sourceRefs?: readonly MemorySourceRef[];
  /** 留存天数（§3 TTL：缺省/undefined = 永久〔继承 owner 无钟语义〕；null 显式永久同效） */
  readonly ttlDays?: number | null;
}

/** addMemory 三分支持结果（四态：全新插入/合并增强/极性裁决新胜/极性裁决旧胜驳回） */
export type AddMemoryOutcome =
  | { readonly outcome: 'inserted'; readonly memory: MemoryRecord }
  | { readonly outcome: 'merged'; readonly memory: MemoryRecord; readonly via: 'exact' | 'fuzzy' }
  | { readonly outcome: 'superseded'; readonly memory: MemoryRecord; readonly supersededId: string }
  | { readonly outcome: 'rejected'; readonly reason: 'lower-confidence'; readonly existingId: string };

/** restore 结果态：成功 / 条目不存在 / 指定版本不在链上 */
export type RestoreOutcome =
  { readonly restored: true } | { readonly restored: false; readonly reason: 'missing' | 'revision' };

/** setTtl 结果态：成功 / 条目不存在 */
export type SetTtlOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: 'missing' };

/** 文件导出行（JSONL 载荷形态——主表现行值全列快照，§3 文件导入导出；v1 不含版本链与流水） */
export interface MemoryExportRow {
  readonly id: string;
  readonly owner_key: string;
  readonly kind: string;
  readonly summary: string;
  readonly content: string;
  readonly confidence: number;
  readonly evidence_count: number;
  readonly usage_count: number;
  readonly last_used_at: number | null;
  readonly status: string;
  readonly superseded_by: string | null;
  readonly source_refs: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly frozen: number;
  readonly ttl_days: number | null;
  readonly expires_at: number | null;
}

/** source_refs 追加上限（防无界增长；超出保最近——起草值随实测调） */
const SOURCE_REFS_CAP = 50;

/** 毫秒/天换算（TTL 钟计算唯一来源） */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 访问日志滚动窗口（毫秒）——起草 90 天（记忆与自进化.md §3 访问日志留存条款：
 * 「清扫与 TTL expired 同节拍同拍」）。窗外流水整批可弃：聚合列 usage_count/
 * last_used_at 权威且不随窗口清扫回退，流水只是可丢弃的审计展开面
 */
const ACCESS_LOG_WINDOW_MS = 90 * MS_PER_DAY;

/** 物理行（snake_case + source_refs JSON 文本；持有面三列随 v11 迁移入位） */
interface MemoryRow {
  id: string;
  owner_key: string;
  kind: string;
  summary: string;
  content: string;
  confidence: number;
  evidence_count: number;
  usage_count: number;
  last_used_at: number | null;
  status: string;
  superseded_by: string | null;
  source_refs: string;
  created_at: number;
  updated_at: number;
  frozen: number;
  ttl_days: number | null;
  expires_at: number | null;
}

/**
 * 可见谓词（§3 TTL 语义——一切 active 读面前置）：status 段挡已物化行（钟被清、
 * 裸钟谓词恒真会让 expired 复活可见——冷读修正），钟段挡未清扫过期行；frozen
 * 压倒钟段（冻结条目永不过期）。调用方拼接 owner/kind 等业务段。
 * @param nowMs 判定时点（Unix 毫秒）
 */
function visiblePredicate(nowMs: number): string {
  return `status = 'active' AND (frozen = 1 OR expires_at IS NULL OR expires_at > ${nowMs})`;
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
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
    status: row.status as MemoryStatus,
    supersededBy: row.superseded_by,
    sourceRefs: refs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    frozen: row.frozen === 1,
    ttlDays: row.ttl_days,
    expiresAt: row.expires_at,
  };
}

/**
 * 效用综合分（公式落码定稿，记忆篇 §5）：confidence × ln(evidence+1) × (1 + ln(usage+1))。
 * 三因子各有单调增益、对数防刷爆：引用 0 次 = ×1 基线不动（新条目不被惩罚）；
 * 引用 3 次 ≈ ×2.4；证据与引用独立计功（被引用的强证据条目最难被整理）。
 * 常驻简报排序（§6）与 consolidation 溢出选取（§5）共用同一把尺。
 */
export function utilityScore(record: Pick<MemoryRecord, 'confidence' | 'evidenceCount' | 'usageCount'>): number {
  return record.confidence * Math.log(record.evidenceCount + 1) * (1 + Math.log(record.usageCount + 1));
}

/** 晋升候选 kind 闭集（§9.1 第 1 项，第四十二批——§9 原文口径：failure/insight/convention；correction 是对模型行为的纠正不进候选） */
const PROMOTION_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>(['failure', 'insight', 'convention']);

/** 晋升候选判据阈值：独立证据攒到第二次，或被引用过至少一次（usage ≡ cite 行数）——起草值随实测调 */
const PROMOTION_MIN_EVIDENCE = 2;
const PROMOTION_MIN_USAGE = 1;

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

/** 行内 source_refs JSON 文本 → 引用数组（脏数据防御为空——与 toRecord 同语义） */
function parseRefs(json: string): MemorySourceRef[] {
  try {
    return JSON.parse(json) as MemorySourceRef[];
  } catch {
    return [];
  }
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

  /** 活跃条目取数（简报/检索/工具读面的共同底座——可见谓词前置：物化与未清扫过期行都不出） */
  private activeByOwners(ownerKeys: readonly string[], nowMs: number): MemoryRow[] {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM memories WHERE ${visiblePredicate(nowMs)} AND owner_key IN (${placeholders})`)
      .all(...ownerKeys) as MemoryRow[];
  }

  /**
   * 版本链快照落账（§3 单事务双写的私件）：拍**变更后**现行值——insert 拍初值、
   * merge/decay/rollback 拍各自变更后值，链条即历次现行值轨迹。revision = 条目内
   * MAX+1（1 起）。纯状态/计量变更（frozen/ttl/usage）不调用本件。
   */
  private appendSnapshot(row: MemoryRow, cause: MemoryVersionCause, nowMs: number): void {
    const max = this.db.prepare('SELECT MAX(revision) AS r FROM memory_versions WHERE memory_id = ?').get(row.id) as {
      r: number | null;
    };
    this.db
      .prepare(
        `INSERT INTO memory_versions (id, memory_id, revision, owner_key, kind, summary, content,
           confidence, evidence_count, cause, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidV7(nowMs),
        row.id,
        (max.r ?? 0) + 1,
        row.owner_key,
        row.kind,
        row.summary,
        row.content,
        row.confidence,
        row.evidence_count,
        cause,
        nowMs,
      );
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
      // 候选池三重过滤（§3 持有面）：可见谓词挡物化与未清扫过期行（过期条目不吸收
      // 新证据——新证据走独立新条目），frozen = 0 挡冻结条目（冻结 = 免覆写，新
      // 证据同样走独立新条目），owner+kind 业务段照旧
      const candidates = this.db
        .prepare(
          `SELECT * FROM memories WHERE ${visiblePredicate(nowMs)} AND frozen = 0 AND owner_key = ? AND kind = ?`,
        )
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
          // 新胜：旧条 dismissed（auto_resolved）、新条入库并继承双方证据计数与
          // 双方 source_refs 并集（血缘继承——条目消亡溯源不死，第十四批 A 组）
          this.db
            .prepare(
              `UPDATE memories SET status = 'dismissed', superseded_by = 'auto_resolved', updated_at = ? WHERE id = ?`,
            )
            .run(nowMs, conflict.id);
          const record = this.insert(
            input,
            confidence,
            conflict.evidence_count + 1,
            nowMs,
            conflict.id,
            parseRefs(conflict.source_refs),
          );
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

  /** 合并落库（exact/fuzzy 共用）：证据 +1、confidence 取 max（保强证据不被均值稀释）、refs 追加；内容面落变拍照 cause='merge' */
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
      .run(candidateConfidence, mergeRefs(parseRefs(row.source_refs), input.sourceRefs ?? []), nowMs, row.id);
    // 快照拍合并后现行值（evidence_count/confidence/source_refs 三面落变——单事务双写）
    const snapshotRow = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(row.id) as MemoryRow | undefined;
    if (!snapshotRow) throw new Error(`合并后读回失败（${row.id}）——事务内不可达，防御断言`);
    this.appendSnapshot(snapshotRow, 'merge', nowMs);
    const memory = toRecord(snapshotRow);
    return { outcome: 'merged', memory, via };
  }

  /** 插入新条目（uuid v7 主键；继承证据计数用于极性新胜）；TTL 钟随入参起算；插入即落首版快照 cause='insert' */
  private insert(
    input: MemoryInput,
    confidence: number,
    evidenceCount: number,
    nowMs: number,
    supersedeOf?: string,
    /** 血缘继承：极性新胜时旧条的全部溯源引用（与新入参 refs 去重并集后落列） */
    inheritedRefs?: readonly MemorySourceRef[],
  ): MemoryRecord {
    const id = uuidV7(nowMs);
    // TTL 钟起算：入参带 ttlDays 才有钟（undefined/null 同为永久——owner 无钟语义缺省）
    const ttlDays = input.ttlDays ?? null;
    const expiresAt = ttlDays !== null ? nowMs + ttlDays * MS_PER_DAY : null;
    this.db
      .prepare(
        `INSERT INTO memories (id, owner_key, kind, summary, content, confidence, evidence_count,
           status, superseded_by, source_refs, created_at, updated_at, frozen, ttl_days, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?)`,
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
        // 有继承面时并集（mergeRefs 去重 + 50 条上限同罩），否则新入参原样
        inheritedRefs ? mergeRefs(inheritedRefs, input.sourceRefs ?? []) : JSON.stringify(input.sourceRefs ?? []),
        nowMs,
        nowMs,
        ttlDays,
        expiresAt,
      );
    void supersedeOf; // 极性新胜的旧条 id 仅事务内使用（上面已先 UPDATE 旧行），此处不落列
    // 插入即落首版（revision=1，cause='insert'——链上第一版即插入时刻的现行值）
    const inserted = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    if (!inserted) throw new Error(`插入后读回失败（${id}）——事务内不可达，防御断言`);
    this.appendSnapshot(inserted, 'insert', nowMs);
    return toRecord(inserted);
  }

  /**
   * 摄入水位（§5 consolidation 变更短路判据，第十四批 A 组）：owner 内活跃与
   * 终态条目的 `max(updated_at)`。恰只捕捉「摄入」——insert/merge 皆刷
   * updated_at，而 decay（刻意不刷）与 markUsed（只动 usage 列）都不动——
   * 整理与引用不重开合并窗。空 owner 返回 null（与 0 可区分：从未有任何条目）。
   */
  intakeWatermark(ownerKey: string): number | null {
    const row = this.db.prepare('SELECT MAX(updated_at) AS w FROM memories WHERE owner_key = ?').get(ownerKey) as
      { w: number | null } | undefined;
    return row?.w ?? null;
  }

  /** 单条读取（含 dismissed/superseded——审计与恢复面要看全量状态） */
  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** 按归属列条目（status 缺省 active 走可见谓词——物化与未清扫过期行不出；显式传 'expired' 可查物化行——审计面） */
  list(ownerKeys: readonly string[], status: MemoryStatus = 'active', nowMs: number = Date.now()): MemoryRecord[] {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map(() => '?').join(', ');
    // active 缺省 = 可见谓词（含 TTL 钟段）；其余终态值（dismissed/superseded/expired）裸 status 段——审计要看全量
    const predicate = status === 'active' ? visiblePredicate(nowMs) : `status = '${status}'`;
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE owner_key IN (${placeholders}) AND ${predicate} ORDER BY updated_at DESC`)
      .all(...ownerKeys) as MemoryRow[];
    return rows.map(toRecord);
  }

  /**
   * 软删（status=dismissed；by 缺省 'user'——用户终审手权最大，§8.4）。
   * 冻结条目拒删（§3 frozen 免覆写义——解冻-再忘是唯一路径）：返回 'frozen'。
   * 终态短路（定向复扫 20260902 第七轮 M-2）：已 dismissed 行幂等短路不覆写
   * `superseded_by`——返 'dismissed'。先前无条件 UPDATE 会把用户终审 'user'
   * 覆写成后到的 'llm:<id>'（consolidation 消费陈旧快照时的竞速腿）——终审
   * 来源是审计面不是可重写位。restore 复活后 forget 重新可用。
   */
  forget(id: string, by: string = 'user', nowMs: number = Date.now()): 'ok' | 'missing' | 'frozen' | 'dismissed' {
    const row = this.db.prepare('SELECT frozen, status FROM memories WHERE id = ?').get(id) as
      { frozen: number; status: string } | undefined;
    if (!row) return 'missing';
    if (row.frozen === 1) return 'frozen';
    if (row.status === 'dismissed') return 'dismissed';
    this.db
      .prepare(`UPDATE memories SET status = 'dismissed', superseded_by = ?, updated_at = ? WHERE id = ?`)
      .run(by, nowMs, id);
    return 'ok';
  }

  /**
   * 恢复条目（§3）：两形态共用一件——
   * - 无 revision：现行值直接复活（ dismissed/superseded/expired 皆可——expired 复活
   *   即 TTL 语义的「复活唯 restore」）；
   * - 带 revision：主表内容面六列回写到该版快照（版本链的回滚消费面），并拍照
   *   cause='rollback'（回滚也是内容面变更——链append-only，回滚不删历史）。
   * 复活一律重算 TTL 钟（有 ttl_days 且非 frozen 时 expires_at = now + ttl_days 天；
   * 清扫物化时钟被清，复活后以策略与复活时点重建——§3 标记/续期时点语义）。
   * status='active'、superseded_by 清空；frozen 位不动（独立通道）。
   */
  restore(id: string, nowMs: number = Date.now(), revision?: number): RestoreOutcome {
    const run = this.db.transaction((): RestoreOutcome => {
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
      if (!row) return { restored: false, reason: 'missing' } as const;
      if (revision !== undefined) {
        const snap = this.db
          .prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND revision = ?')
          .get(id, revision) as
          | {
              owner_key: string;
              kind: string;
              summary: string;
              content: string;
              confidence: number;
              evidence_count: number;
            }
          | undefined;
        if (!snap) return { restored: false, reason: 'revision' } as const;
        this.db
          .prepare(
            `UPDATE memories SET owner_key = ?, kind = ?, summary = ?, content = ?, confidence = ?,
               evidence_count = ?, status = 'active', superseded_by = NULL, updated_at = ?,
               expires_at = CASE WHEN ttl_days IS NOT NULL AND frozen = 0 THEN ? + ttl_days * ${MS_PER_DAY} ELSE expires_at END
             WHERE id = ?`,
          )
          .run(
            snap.owner_key,
            snap.kind,
            snap.summary,
            snap.content,
            snap.confidence,
            snap.evidence_count,
            nowMs,
            nowMs,
            id,
          );
        // 回滚后现行值拍照（append-only——回滚版本成为链上最新一版，被回滚掉的版本仍在链上）
        const rolled = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
        if (rolled) this.appendSnapshot(rolled, 'rollback', nowMs);
        return { restored: true } as const;
      }
      // 无 revision：现行值复活 + 重算钟
      this.db
        .prepare(
          `UPDATE memories SET status = 'active', superseded_by = NULL, updated_at = ?,
             expires_at = CASE WHEN ttl_days IS NOT NULL AND frozen = 0 THEN ? + ttl_days * ${MS_PER_DAY} ELSE expires_at END
           WHERE id = ?`,
        )
        .run(nowMs, nowMs, id);
      return { restored: true } as const;
    });
    return run.immediate();
  }

  /**
   * 冻结/解冻（§3 frozen——纯状态变更：不动 updated_at、不拍版本快照）。
   * 解冻重算 TTL 钟（冻结期免过期，解冻后以策略与解冻时点重建——不补冻结期的账）。
   * @returns 条目不存在返回 false
   */
  setFrozen(id: string, frozen: boolean, nowMs: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE memories SET frozen = ?,
           expires_at = CASE
             WHEN frozen = 0 AND ? = 1 THEN NULL                      -- 冻结：清钟（免 TTL 的物化面——解冻时重建）
             WHEN frozen = 1 AND ? = 0 AND ttl_days IS NOT NULL THEN ? + ttl_days * ${MS_PER_DAY}  -- 解冻：重算钟
             ELSE expires_at
           END
         WHERE id = ?`,
      )
      .run(frozen ? 1 : 0, frozen ? 1 : 0, frozen ? 1 : 0, nowMs, id);
    return result.changes > 0;
  }

  /**
   * 标记/清除留存策略（§3 TTL——纯策略变更：不动 updated_at、不动 status）。
   * days=null 清策略清钟（永久）；days 正整数设策略并起算钟。已物化 expired 行
   * 不因此复活（status 压倒——复活唯 restore）；新钟只在未来 restore/续期时点生效。
   */
  setTtl(id: string, days: number | null, nowMs: number = Date.now()): SetTtlOutcome {
    const row = this.db.prepare('SELECT id FROM memories WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return { ok: false, reason: 'missing' };
    this.db
      .prepare(
        `UPDATE memories SET ttl_days = ?,
           expires_at = CASE WHEN ? IS NOT NULL AND frozen = 0 THEN ? + ? * ${MS_PER_DAY} ELSE NULL END
         WHERE id = ?`,
      )
      .run(days, days, nowMs, days, id);
    return { ok: true };
  }

  /**
   * TTL 清扫（§3——周期路与读面前置谓词双保险的物化侧）：active 且非冻结且钟已过
   * 的行物化 status='expired'、superseded_by='ttl'（终态来源）、**清钟**（判定源
   * 单一交接给 status——裸钟谓词在钟空时恒真，不清钟 expired 会在读面复活，冷读
   * 修正）。不动 updated_at（过期不是新证据——老化判定基准不漂移）。
   * @returns 本次物化行数
   */
  sweepExpired(nowMs: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE memories SET status = 'expired', superseded_by = 'ttl', expires_at = NULL
          WHERE status = 'active' AND frozen = 0 AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(nowMs);
    return result.changes;
  }

  /**
   * 老化降置信（§5 consolidation 落地件）：confidence × factor（下限 0 保底）。
   * 不刷新 updated_at——降权不是新证据，老化判定基准（最后证据时间）不动，
   * 反复 decay 不会把条目「洗新」出老化候选集。内容面落变（confidence 在快照
   * 六列）单事务拍照 cause='decay'。
   */
  decayConfidence(id: string, factor: number, nowMs: number = Date.now()): boolean {
    const run = this.db.transaction((): boolean => {
      const result = this.db
        .prepare(`UPDATE memories SET confidence = MAX(0, confidence * ?) WHERE id = ?`)
        .run(factor, id);
      if (result.changes === 0) return false;
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
      if (row) this.appendSnapshot(row, 'decay', nowMs);
      return true;
    });
    return run.immediate();
  }

  /**
   * 引用回写（§6 效用闭环 + §3 持有面续期）：命中条目 usage_count + 1、
   * last_used_at = now、**TTL 续期**（有 ttl_days 且非 frozen 时钟 = now + ttl_days 天
   * ——「使用中」的证据即留存正当性）；同事务落 cite 流水（聚合只随 cite——
   * usage_count ≡ cite 行数，审计面与计量面同源）。物化 expired 行跳过（过期条目
   * 不因引用复活——复活唯 restore）；冻结行照计 usage 但钟不动（frozen 压倒 TTL）。
   * 由应用在 assistant 消息文本解析出引用标记后批量调用（一条消息对一条记忆
   * 计一次——去重归调用方）。副作用即「复活」：last_used_at 刷新使 30 天未用
   * 排除判据重新放行，条目自动回到常驻简报（离开常驻面 ≠ 离开记忆库）。
   * @param ids 完整条目 id 列表（未知/终态 id 静默无效果——尽力而为）
   * @param nowMs 回写时间戳（Unix 毫秒）
   * @param sessionId 发生会话（流水落账；缺省 null）
   * @returns 实际更新的行数
   */
  markUsed(ids: readonly string[], nowMs: number, sessionId?: string): number {
    if (ids.length === 0) return 0;
    const run = this.db.transaction((): number => {
      const placeholders = ids.map(() => '?').join(', ');
      // 只挑 active 行（物化 expired/dismissed/superseded 都不回写——引用救不回终态）
      const hits = this.db
        .prepare(`SELECT id FROM memories WHERE status = 'active' AND id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string }>;
      if (hits.length === 0) return 0;
      const hitPlaceholders = hits.map(() => '?').join(', ');
      const hitIds = hits.map((h) => h.id);
      this.db
        .prepare(
          `UPDATE memories SET usage_count = usage_count + 1, last_used_at = ?,
             expires_at = CASE WHEN ttl_days IS NOT NULL AND frozen = 0 THEN ? + ttl_days * ${MS_PER_DAY} ELSE expires_at END
           WHERE id IN (${hitPlaceholders})`,
        )
        .run(nowMs, nowMs, ...hitIds);
      // cite 流水与聚合同事务（§3——计量面与审计面不脱钩）
      const insertAccess = this.db.prepare(
        `INSERT INTO memory_access (id, memory_id, op, session_id, ts) VALUES (?, ?, 'cite', ?, ?)`,
      );
      for (const memoryId of hitIds) insertAccess.run(uuidV7(nowMs), memoryId, sessionId ?? null, nowMs);
      return hitIds.length;
    });
    return run.immediate();
  }

  /**
   * 访问流水写入（§3 recall/search 只记流水不进聚合）：批量单事务。调用方 =
   * 按需检索注入（recall）与工具检索命中（search）两写点。
   */
  recordAccess(
    entries: readonly { memoryId: string; op: MemoryAccessOp; sessionId?: string }[],
    nowMs: number = Date.now(),
  ): void {
    if (entries.length === 0) return;
    this.db
      .transaction(() => {
        const stmt = this.db.prepare(
          `INSERT INTO memory_access (id, memory_id, op, session_id, ts) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const e of entries) stmt.run(uuidV7(nowMs), e.memoryId, e.op, e.sessionId ?? null, nowMs);
      })
      .immediate();
  }

  /**
   * 访问日志窗口清扫（§3 留存条款——90 天滚动窗，与 TTL expired 清扫同节拍
   * 同拍）：窗外流水行整批删除。幂等 DELETE（零行命中即零开销）；聚合列
   * usage_count/last_used_at 不动（权威计量面与可丢弃审计面分离——清扫不回退
   * 计量）。全表按 ts 扫可接受（索引注释同判——90 天窗口量级）。
   * @returns 本次删除行数
   */
  sweepAccessLog(nowMs: number = Date.now()): number {
    const result = this.db.prepare(`DELETE FROM memory_access WHERE ts <= ? - ${ACCESS_LOG_WINDOW_MS}`).run(nowMs);
    return result.changes;
  }

  /**
   * 访问日志查询（memory_access_log 工具面）：按条目（id/前缀）× 操作 × 时间窗
   * 过滤，ts 降序（最新在前）。前缀走 LIKE 前缀匹配——查询面歧义展开多行（与
   * 引用回写解析侧 idsByPrefix 的「歧义全忽略」分语义：那边防错误归属，这边要看得全）。
   */
  accessLog(query: AccessLogQuery): MemoryAccessRow[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (query.memoryId !== undefined) {
      conditions.push('memory_id = ?');
      params.push(query.memoryId);
    } else if (query.prefix !== undefined) {
      conditions.push("memory_id LIKE ? || '%'");
      params.push(query.prefix);
    }
    if (query.op !== undefined) {
      conditions.push('op = ?');
      params.push(query.op);
    }
    if (query.sinceMs !== undefined) {
      conditions.push('ts >= ?');
      params.push(query.sinceMs);
    }
    if (query.untilMs !== undefined) {
      conditions.push('ts <= ?');
      params.push(query.untilMs);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT memory_id, op, session_id, ts FROM memory_access${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, query.limit ?? 50) as Array<{
      memory_id: string;
      op: string;
      session_id: string | null;
      ts: number;
    }>;
    return rows.map((r) => ({ memoryId: r.memory_id, op: r.op as MemoryAccessOp, sessionId: r.session_id, ts: r.ts }));
  }

  /** 被用条目聚合面（memory_access_log 工具的 top-N 段）：usage_count 降序、次键最近引用 */
  topByUsage(ownerKeys: readonly string[], limit: number = 10, nowMs: number = Date.now()): MemoryRecord[] {
    if (ownerKeys.length === 0) return [];
    const placeholders = ownerKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${visiblePredicate(nowMs)} AND owner_key IN (${placeholders})
          ORDER BY usage_count DESC, last_used_at DESC LIMIT ?`,
      )
      .all(...ownerKeys, limit) as MemoryRow[];
    return rows.map(toRecord);
  }

  /** 版本链摘要（memory_read 版本链展示面——revision 升序） */
  listVersions(id: string): MemoryVersionSummary[] {
    const rows = this.db
      .prepare(
        'SELECT revision, cause, summary, confidence, created_at FROM memory_versions WHERE memory_id = ? ORDER BY revision',
      )
      .all(id) as Array<{ revision: number; cause: string; summary: string; confidence: number; created_at: number }>;
    return rows.map((r) => ({
      revision: r.revision,
      cause: r.cause as MemoryVersionCause,
      summary: r.summary,
      confidence: r.confidence,
      createdAt: r.created_at,
    }));
  }

  /** 单版快照全文（restore 指定版本的核对面与审计深读） */
  versionAt(id: string, revision: number): MemoryVersionSnapshot | undefined {
    const row = this.db
      .prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND revision = ?')
      .get(id, revision) as
      | {
          revision: number;
          cause: string;
          owner_key: string;
          kind: string;
          summary: string;
          content: string;
          confidence: number;
          evidence_count: number;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      revision: row.revision,
      cause: row.cause as MemoryVersionCause,
      ownerKey: row.owner_key,
      kind: row.kind as MemoryKind,
      summary: row.summary,
      content: row.content,
      confidence: row.confidence,
      evidenceCount: row.evidence_count,
      createdAt: row.created_at,
    };
  }

  /**
   * 文件导出取数（§3 文件导入导出——io 编排的行源）：主表现行值全列（含终态行）
   * 按 id 升序（uuid v7 时间序——文件内时间线可读）。v1 不含版本链与访问流水
   * （文件最小面；历史与流水随库走）。
   * @param ownerKey 归属过滤（缺省 = 全部归属——跨机器迁移面）
   */
  exportRows(ownerKey?: string): MemoryExportRow[] {
    const sql = 'SELECT * FROM memories' + (ownerKey !== undefined ? ' WHERE owner_key = ?' : '') + ' ORDER BY id';
    const rows =
      ownerKey !== undefined
        ? (this.db.prepare(sql).all(ownerKey) as MemoryRow[])
        : (this.db.prepare(sql).all() as MemoryRow[]);
    return rows.map((row) => ({ ...row }));
  }

  /**
   * 文件导人行恢复式幂等直插（§3：按 id 零合并——导入不产生新语义，只搬状态；
   * 已存在 id 静默跳过）。**状态面直通道**：不经 addMemory 三分支（内容面唯一
   * 写路径不破——导入行自带终态/计量/持有面列，合并管线无从谈起）。格式与
   * secret 校验在 io 编排层（本件只管幂等落库）。
   * @returns true = 新插入 / false = 已存在跳过
   */
  importRow(row: MemoryExportRow): boolean {
    const exists = this.db.prepare('SELECT id FROM memories WHERE id = ?').get(row.id) as { id: string } | undefined;
    if (exists) return false;
    this.db
      .prepare(
        `INSERT INTO memories (id, owner_key, kind, summary, content, confidence, evidence_count,
           usage_count, last_used_at, status, superseded_by, source_refs, created_at, updated_at, frozen, ttl_days, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.owner_key,
        row.kind,
        row.summary,
        row.content,
        row.confidence,
        row.evidence_count,
        row.usage_count,
        row.last_used_at,
        row.status,
        row.superseded_by,
        row.source_refs,
        row.created_at,
        row.updated_at,
        row.frozen,
        row.ttl_days,
        row.expires_at,
      );
    return true;
  }

  /**
   * 短 id 前缀解析（引用回写解析侧）：`[m:8位hex]` → 完整 id 候选。
   * 零命中 = 未知引用（忽略）；多命中 = 前缀歧义（调用方应全部忽略，防错误归属）；
   * 恰一命中 = 唯一归属。入参钉死 8 位十六进制（citation 正则同形——双保险）。
   * 可见谓词前置：过期/终态行不在任何注入面 → 新引用不可能合法指向它（按规范
   * 字面全谓词——损失为零）。
   */
  idsByPrefix(prefix: string, nowMs: number = Date.now()): string[] {
    if (!/^[0-9a-f]{8}$/.test(prefix)) return [];
    const rows = this.db
      .prepare(`SELECT id FROM memories WHERE ${visiblePredicate(nowMs)} AND id LIKE ? || '%'`)
      .all(prefix) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * FTS 检索（memory_fts 投影，trigram 分词；仅可见行——物化与未清扫过期行不出）。
   * 查询词逐 token 加引号转义后空格连接（FTS5 隐式 AND；trigram 下 <3 字符 token
   * 在查询中被忽略）——用户输入的标点/操作符不可能炸 MATCH 语法。
   * @returns 按相关度排序的条目（limit 缺省 5）
   */
  search(query: string, ownerKeys: readonly string[], limit: number = 5, nowMs: number = Date.now()): MemoryRecord[] {
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0 || ownerKeys.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    const placeholders = ownerKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_fts f
           JOIN memories m ON m.rowid = f.rowid
          WHERE memory_fts MATCH ?
            AND m.${visiblePredicate(nowMs)}
            AND m.owner_key IN (${placeholders})
          ORDER BY rank LIMIT ?`,
      )
      .all(match, ...ownerKeys, limit) as MemoryRow[];
    return rows.map(toRecord);
  }

  /**
   * 常驻简报取数（记忆篇 §6 注入通道 1 + §5 效用维度 + §3 frozen 恒驻）：
   * owner 匹配的可见行，排序 = kind 优先级（preference/profile/convention 先）→
   * 效用综合分（utilityScore）降序；**30 天未用强排除**（活动锚 = max(last_used_at,
   * updated_at) 距今超 unusedDays 的条目不进简报——排除在 top-N 之外的第二道闸，
   * 被检索引用后 markUsed 刷新锚点自动复活；**frozen 行豁免本排除**——冻结即用户
   * 钉住的常驻，不因不用而离开）；条数与字符双限额（起草值随实测调，结构不随调）。
   * **frozen 恒驻免竞争**（§3）：冻结行不占 maxEntries/maxChars 限额、不触发截断
   * （与竞争面的「免竞争」义）；非冻结行照常竞争。truncated 只由竞争面触发。
   * 活动锚取两数之 max：新证据（updated_at）与被引用（last_used_at）都算「在用」
   * ——只看 last_used_at 会误伤从未被引用的新条目，只看 updated_at 则引用保活失效。
   * @returns 入选条目（含 frozen 常驻行）+ frozen 行数（前段常驻——face 层消毒
   *          剔除计数用）+ 是否触限额截断（截断可见——ref-7「禁止静默截断」；
   *          未用排除不是截断，不计入 truncated）
   */
  briefing(
    ownerKeys: readonly string[],
    opts: {
      maxEntries?: number;
      maxChars?: number;
      unusedDays?: number;
      /** 晋升候选上限（§9.1 第 1 项，第四十二批——起草值 3 随实测调） */
      maxCandidates?: number;
      now?: () => number;
    } = {},
  ): { records: MemoryRecord[]; truncated: boolean; frozenCount: number; candidates: MemoryRecord[] } {
    const maxEntries = opts.maxEntries ?? 20;
    const maxChars = opts.maxChars ?? 2000;
    const unusedDays = opts.unusedDays ?? 30;
    const maxCandidates = opts.maxCandidates ?? 3;
    const now = opts.now?.() ?? Date.now();
    const activeCutoff = now - unusedDays * 24 * 60 * 60 * 1000;
    const kindPriority: Record<MemoryKind, number> = {
      preference: 0,
      profile: 1,
      convention: 2,
      fact: 3,
      correction: 3,
      failure: 3,
      insight: 3,
    };
    const scored = this.activeByOwners(ownerKeys, now)
      .map(toRecord)
      // 未用强排除（§5：死 = 离开常驻面，非删除——FTS 检索仍可命中并经引用复活）；
      // frozen 豁免（§3 恒驻义——冻结条目不因未用而离开简报）
      .filter((r) => r.frozen || Math.max(r.lastUsedAt ?? 0, r.updatedAt) >= activeCutoff)
      .sort((a, b) => {
        const byKind = kindPriority[a.kind] - kindPriority[b.kind];
        if (byKind !== 0) return byKind;
        // 效用综合分（utilityScore——confidence × ln(evidence+1) × (1 + ln(usage+1))）
        return utilityScore(b) - utilityScore(a);
      });
    const records: MemoryRecord[] = [];
    let used = 0;
    let truncated = false;
    let frozenCount = 0;
    for (const record of scored) {
      const cost = record.summary.length + 1; // 简报行 = 一条 summary + 换行
      if (record.frozen) {
        // 冻结常驻：不占双限额、不触发截断（免竞争义）；不受竞争面触顶影响——
        // 扫满不 break（§3「直接常驻」语义：frozen 排在 scored 深位也不得被竞争
        // 面的截断截掉；第四十二批晋升候选测试锁出的回归，随批修复）
        records.push(record);
        frozenCount += 1;
        continue;
      }
      if (records.length - frozenCount >= maxEntries || used + cost > maxChars) {
        // 触顶后 continue 不 break：深位 frozen 条目仍要收（恒驻），竞争面就此止步
        truncated = true;
        continue;
      }
      records.push(record);
      used += cost;
    }
    // 晋升候选（§9.1 第 1 项，第四十二批）：同一 scored 流取数——未用排除之后
    // （冷读 M2：晋升候选 ⊆ 简报资格集，「死 = 离开常驻面」纪律不被判据绕过——
    // 未用死条目不因「被引用过一次」捞回常驻面）；kind 三类 + 反复命中判据
    // （evidence ≥ 2 ∨ usage ≥ 1，usage ≡ cite 行数）+ frozen 排除（时间胶囊不搬家）；
    // 正文已列条目去重（冷读 M1：face 内同 id 双行污染指纹与差分比较面）；排序 =
    // 效用综合分降序（§5 同一把尺），截 top N。
    const bodyIds = new Set(records.map((r) => r.id));
    const candidates = scored
      .filter(
        (r) =>
          PROMOTION_KINDS.has(r.kind) &&
          !r.frozen &&
          !bodyIds.has(r.id) &&
          (r.evidenceCount >= PROMOTION_MIN_EVIDENCE || r.usageCount >= PROMOTION_MIN_USAGE),
      )
      .sort((a, b) => utilityScore(b) - utilityScore(a))
      .slice(0, maxCandidates);
    return { records, truncated, frozenCount, candidates };
  }
}
