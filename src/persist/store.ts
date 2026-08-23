/**
 * L1 persist — SQLite 存储核（会话篇 §6 物理层的实现）。
 *
 * 职责：版本门禁（开库即验，宁拒绝不误读）、appendCore（单事务批量写入 +
 * cursor 连续性校验 + revision 前进）、loadEvents（读 + 撕裂尾截断修复）、
 * 凭证 read-modify-write 串行化、模型目录 CRUD。
 * 全部 better-sqlite3 同步 API——进程内无并发竞争，跨进程经 BEGIN IMMEDIATE 仲裁。
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import { AppError, SESSION_FORMAT_UNSUPPORTED, SESSION_WRITE_CONFLICT } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import { deepFreeze } from '../session/snapshot.js';
import { normalizeMigrations, type MigrationSpec } from './migrations.js';
import { APPLICATION_ID, CANONICAL_DDL, SCHEMA_VERSION } from './schema.js';

/** 打开参数 */
export interface StoreOptions {
  /** 库文件路径（':memory:' 供测试） */
  path: string;
  /** 锁等待上限（毫秒，默认 5000——允许双开姿态下的写竞争有界等待） */
  busyTimeoutMs?: number;
  /**
   * 业务模块注册的迁移链（统一迁移框架，会话篇 §6 落码形态 2026-08-24）。
   * 缺省 = 空链（纯基线库）；组合根聚合各模块迁移项传入（如 memory 表族 v2）。
   */
  migrations?: readonly MigrationSpec[];
}

/** sessions 表行（血缘 header + 变更检测） */
export interface SessionRow {
  id: string;
  schema_version: number;
  created_at: number;
  cwd: string | null;
  origin: string;
  parent_session: string | null;
  seed_length: number | null;
  delegation_depth: number;
  profile: string | null;
  incarnation: string;
  revision: number;
}

/** appendCore 需要的会话登记信息（首次写入时落 sessions 行） */
export interface SessionRegistration {
  sessionId: string;
  origin: string;
  parentSession?: string;
  seedLength: number;
  delegationDepth: number;
  cwd?: string;
  profile?: string;
}

/**
 * 打开（或初始化/升级）一个存储库。
 * 门禁顺序：application_id → user_version（升级方向补跑迁移链，降级方向拒绝）→
 * schema 逐对象比对（基线 DDL ∪ 迁移链产物累积指纹）；任一不匹配拒绝打开
 * （宁拒绝不误读；old-v2 旧库不进此门禁）。
 */
export function openStore(options: StoreOptions): Store {
  // 迁移链先校验排序（装配错误在此即抛，不动任何库文件）
  const chain = normalizeMigrations(options.migrations ?? [], SCHEMA_VERSION);
  const latestVersion = chain.length > 0 ? chain[chain.length - 1]!.version : SCHEMA_VERSION;

  const db = new Database(options.path);
  // 双开姿态四件之①②：WAL 读写不互斥 + 锁等待有界
  db.pragma(`journal_mode = WAL`);
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  // 拍板：synchronous=FULL（批量事务落盘强度优先）
  db.pragma('synchronous = FULL');

  const appId = db.pragma('application_id', { simple: true }) as number;
  const userVersion = db.pragma('user_version', { simple: true }) as number;
  const isEmpty = tableCount(db) === 0;

  if (isEmpty) {
    // 全新库：基线 DDL + 迁移链一次到位 + 写入门禁值 + 单例状态行
    db.exec(CANONICAL_DDL);
    for (const m of chain) {
      applyMigration(db, m);
    }
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${latestVersion}`);
    db.prepare('INSERT INTO store_state (id, store_id, schema_version) VALUES (1, ?, ?)').run(
      randomUUID(),
      latestVersion,
    );
  } else {
    // 存量库：application_id 门禁 → 升降级判定 → 补跑缺口 → 累积指纹比对
    if (appId !== APPLICATION_ID) {
      db.close();
      throw new AppError(
        SESSION_FORMAT_UNSUPPORTED,
        `application_id 不匹配（库内 ${appId}，期望 ${APPLICATION_ID}）——不是本产品的库，拒绝打开`,
      );
    }
    if (userVersion > latestVersion) {
      // 降级方向（未来库/旧宿主开新库）：宁拒绝不误读，永不自动降级
      db.close();
      throw new AppError(
        SESSION_FORMAT_UNSUPPORTED,
        `user_version 高于宿主已知（库内 ${userVersion}，宿主最新 ${latestVersion}）——降级不支持，拒绝打开`,
      );
    }
    for (const m of chain) {
      if (m.version > userVersion) applyMigration(db, m);
    }
    verifySchema(db, chain);
  }

  const storeId = (db.prepare('SELECT store_id FROM store_state WHERE id = 1').get() as { store_id: string }).store_id;
  return new Store(db, storeId);
}

/**
 * 执行单个迁移：DDL 单事务 + user_version 前进（两步同事务——半迁移状态不可见）。
 * pre-release 迁移只前进 user_version，不写迁移历史表（指纹比对即完整校验面）。
 */
function applyMigration(db: DatabaseConnection, m: MigrationSpec): void {
  const run = db.transaction(() => {
    db.exec(m.sql);
    db.pragma(`user_version = ${m.version}`);
  });
  run.immediate();
}

/** 库内对象计数（判断是否全新库；仅数表，索引等随表建） */
function tableCount(db: DatabaseConnection): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number };
  return row.n;
}

/**
 * schema 逐对象比对：把库内 CREATE 语句与「基线 DDL + 迁移链在内存库执行后的语句」
 * 各自 normalize 后比对集合——比对的就是执行产物，不吃 SQL 文本缓存的漂移；
 * 比对覆盖迁移链全部对象（表/索引/触发器，sqlite_master 全量）。
 */
function verifySchema(db: DatabaseConnection, chain: readonly MigrationSpec[] = []): void {
  const reference = new Database(':memory:');
  try {
    reference.exec(CANONICAL_DDL);
    for (const m of chain) {
      reference.exec(m.sql);
    }
    const expected = schemaFingerprint(reference);
    const actual = schemaFingerprint(db);
    const missing = [...expected].filter((e) => !actual.has(e));
    const extra = [...actual].filter((a) => !expected.has(a));
    if (missing.length > 0 || extra.length > 0) {
      const detail = [
        missing.length > 0 ? `缺失/变形：${missing.join(' | ')}` : '',
        extra.length > 0 ? `多出：${extra.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('；');
      throw new AppError(SESSION_FORMAT_UNSUPPORTED, `schema 与规范不一致（${detail}），拒绝打开`);
    }
  } finally {
    reference.close();
  }
}

/** normalize 后的 schema 对象指纹集合（type:name:normalize(sql)） */
function schemaFingerprint(db: DatabaseConnection): Set<string> {
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")
    .all() as Array<{ type: string; name: string; sql: string }>;
  return new Set(rows.map((r) => `${r.type}:${r.name}:${normalizeSql(r.sql)}`));
}

/** SQL 文本 normalize：压空白、去注释、统一大小写关键字过严——压空白+trim 足够比对执行产物 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ') // 去行注释（DDL 内的中文段注释不参与比对）
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .trim();
}

/** 存储库句柄（构造只经 openStore——门禁必须先过） */
export class Store {
  readonly storeId: string;
  private readonly db: DatabaseConnection;
  /** 运行期准备语句缓存（同名只编一次） */
  private readonly statements = new Map<string, Database.Statement>();

  constructor(db: DatabaseConnection, storeId: string) {
    this.db = db;
    this.storeId = storeId;
  }

  /** 预取准备语句（缓存） */
  private stmt(sql: string): Database.Statement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /**
   * 底层连接引用（业务模块 DAO 面，会话篇 §6 迁移框架落码形态 2026-08-24）：
   * 经统一迁移框架建表的业务模块（如 memory 表族）在此自行 prepared statement——
   * 物理层与语义层分工：语义在业务模块、编码与连接治理在 persist。
   * 仅供宿主装配的业务模块使用（事件写入仍走 appendCore 唯一入口，不旁路）。
   */
  get connection(): DatabaseConnection {
    return this.db;
  }

  /** 关闭库（调用方保证此前已 flush 全部批次） */
  close(): void {
    this.db.close();
  }

  /**
   * 批量写入一个会话的事件（write-behind 链第 4-5 步）。
   * BEGIN IMMEDIATE 单事务：cursor 连续性校验（断裂 = 第二写者/误用，响亮拒绝）
   * → 批量 insert → sessions 行登记 → revision 前进（incarnation 变更即复位为 1）。
   * 事务原子性即「批量写失败回滚」——物理删除两例外之一，无需额外代码。
   * @param incarnation 本进程生命周期 UUID（revision 复位边界）
   * @returns 前进后的 revision
   */
  appendCore(reg: SessionRegistration, batch: readonly SessionEvent[], incarnation: string): number {
    if (batch.length === 0) {
      return this.currentRevision(reg.sessionId);
    }
    const run = this.db.transaction(() => {
      // cursor 校验：新批起始 seq 必须等于已存 max(seq)+1（同会话单写者护栏，双开姿态第③件）
      const tail = this.stmt('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE session_id = ?').get(
        reg.sessionId,
      ) as { m: number };
      const expectedStart = tail.m + 1;
      if (batch[0]!.seq !== expectedStart) {
        throw new AppError(
          SESSION_WRITE_CONFLICT,
          `cursor 断裂：批起始 seq=${batch[0]!.seq}，库内 max(seq)+1=${expectedStart}（会话 ${reg.sessionId}）`,
        );
      }
      const insert = this.stmt(
        `INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of batch) {
        insert.run(
          reg.sessionId,
          event.seq,
          event.type,
          event.time,
          JSON.stringify(event.data),
          event.sourceEventSeqs ? encodeSeqs(event.sourceEventSeqs) : null,
          event.surfaceOp ? JSON.stringify(event.surfaceOp) : null,
          event.ignorable ? 1 : 0,
        );
      }
      // sessions 行：首次登记（ON CONFLICT 静默——header 以首次登记为准，血缘不改写）
      this.stmt(
        `INSERT INTO sessions (id, schema_version, created_at, cwd, origin, parent_session, seed_length,
           delegation_depth, profile, incarnation, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        reg.sessionId,
        SCHEMA_VERSION,
        Date.now(),
        reg.cwd ?? null,
        reg.origin,
        reg.parentSession ?? null,
        reg.seedLength,
        reg.delegationDepth,
        reg.profile ?? null,
        incarnation,
      );
      // revision 前进：incarnation 变更（新进程接管）= 复位边界，revision 重计 1
      const next =
        this.stmt(
          `UPDATE sessions
             SET revision = CASE WHEN incarnation = ? THEN revision + 1 ELSE 1 END,
                 incarnation = ?
           WHERE id = ?
           RETURNING revision`,
        ).get(incarnation, incarnation, reg.sessionId) ?? {};
      return (next as { revision: number }).revision;
    });
    // immediate：BEGIN IMMEDIATE（双开姿态第②件：写竞争经事务互斥仲裁）
    return run.immediate() as number;
  }

  /** 当前 revision（会话未登记返回 0） */
  currentRevision(sessionId: string): number {
    const row = this.stmt('SELECT revision FROM sessions WHERE id = ?').get(sessionId) as
      { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  /** revision 字符串（storeIdentity:incarnation:revision——跨进程变更检测的轻量指纹） */
  revisionString(sessionId: string, incarnation: string): string {
    return `${this.storeId}:${incarnation}:${this.currentRevision(sessionId)}`;
  }

  /** 读会话元数据行（不存在返回 undefined） */
  sessionRow(sessionId: string): SessionRow | undefined {
    return this.stmt('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  }

  /**
   * 读会话事件（loadStored 的物理半边）+ 撕裂尾截断修复。
   * 撕裂尾 = 日志中间出现 seq 跳档（外因损坏；appendCore 的 cursor 校验保证正常
   * 路径不可能制造跳档）——断档及之后全部截除（物理删除两例外之二），保留连续前缀。
   * @returns 连续前缀事件（data 已冻结，可直接作 Session 种子）
   */
  loadEvents(sessionId: string): SessionEvent[] {
    const rows = this.stmt(
      'SELECT seq, type, time, data, source_event_seqs, surface_op, ignorable FROM events WHERE session_id = ? ORDER BY seq',
    ).all(sessionId) as Array<{
      seq: number;
      type: string;
      time: number;
      data: string;
      source_event_seqs: Buffer | null;
      surface_op: string | null;
      ignorable: number;
    }>;

    const kept: SessionEvent[] = [];
    let expected = 0;
    let tornFrom: number | null = null;
    for (const row of rows) {
      if (row.seq !== expected) {
        tornFrom = row.seq;
        break; // 断档起为撕裂尾，不再信任后续
      }
      kept.push(decodeEvent(row));
      expected++;
    }
    if (tornFrom !== null) {
      // 截除断档起的全部行（单事务原子完成）
      this.stmt('DELETE FROM events WHERE session_id = ? AND seq >= ?').run(sessionId, tornFrom);
    }
    return kept;
  }

  /** 会话已存事件数（fork 种子是否需要物理复制的判据） */
  countEvents(sessionId: string): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sessionId) as {
      n: number;
    };
    return row.n;
  }

  /** 全部会话 id（诊断/列表用） */
  listSessionIds(): string[] {
    return (this.stmt('SELECT id FROM sessions ORDER BY created_at').all() as Array<{ id: string }>).map((r) => r.id);
  }

  /**
   * 某工作区（cwd）的最新会话 id（TUI 启动续接策略的取数面，技术栈篇 §5）。
   * created_at 毫秒可同值——同刻并列时 rowid 兜底取后建者（自增近似时序）。
   * @returns 无匹配返回 undefined
   */
  latestSessionId(cwd: string): string | undefined {
    const row = this.stmt('SELECT id FROM sessions WHERE cwd = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(
      cwd,
    ) as { id: string } | undefined;
    return row?.id;
  }

  /* ---------------- 凭证（pi-ai CredentialStore 的 SQLite 承载） ---------------- */

  /** 列全部凭证元数据（不含 data——pi-ai list 契约「不暴露密钥」；app 适配器消费） */
  listCredentialEntries(): Array<{ provider: string; kind: string; updatedAt: number }> {
    // updated_at AS updatedAt：SQL 列名映射驼峰返回形状
    return this.stmt(
      'SELECT provider, kind, updated_at AS updatedAt FROM credentials ORDER BY provider',
    ).all() as Array<{
      provider: string;
      kind: string;
      updatedAt: number;
    }>;
  }

  /** 读凭证（不存在返回 undefined；明文存储——拍板 #4） */
  getCredential(provider: string): { kind: string; data: unknown; updatedAt: number } | undefined {
    const row = this.stmt('SELECT kind, data, updated_at FROM credentials WHERE provider = ?').get(provider) as
      { kind: string; data: string; updated_at: number } | undefined;
    if (!row) {
      return undefined;
    }
    return { kind: row.kind, data: JSON.parse(row.data), updatedAt: row.updated_at };
  }

  /**
   * 凭证 read-modify-write（唯一写路径且串行化——pi-ai 关键契约，防并发双刷新）。
   * @param mutator 收当前值（undefined = 无凭证），返回新值（undefined = 删除）
   * @param opts.kind 凭证类别覆盖（缺省沿用原行 / 新行 'api-key'）——写入 OAuth
   *   凭证时调用方传 'oauth'，否则 kind 列与 data.type 漂移
   */
  modifyCredential(
    provider: string,
    mutator: (current: unknown) => unknown,
    opts?: { kind?: string },
  ): { data: unknown; updatedAt: number } | undefined {
    const run = this.db.transaction((p: string) => {
      const row = this.stmt('SELECT kind, data FROM credentials WHERE provider = ?').get(p) as
        { kind: string; data: string } | undefined;
      const kind = opts?.kind ?? row?.kind ?? 'api-key';
      const next = mutator(row ? JSON.parse(row.data) : undefined);
      if (next === undefined) {
        this.stmt('DELETE FROM credentials WHERE provider = ?').run(p);
        return undefined;
      }
      const json = JSON.stringify(next);
      const now = Date.now();
      this.stmt(
        `INSERT INTO credentials (provider, kind, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET kind = excluded.kind, data = excluded.data, updated_at = excluded.updated_at`,
      ).run(p, kind, json, now);
      return { data: next, updatedAt: now };
    });
    return run.immediate(provider);
  }

  /* ---------------- 模型目录（pi-ai ModelsStore + 用户覆盖） ---------------- */

  /** 写入/覆盖一条模型目录（source: bundled | fetched | user-override） */
  upsertModel(provider: string, modelId: string, data: unknown, source: string): void {
    this.stmt(
      `INSERT INTO model_catalog (provider, model_id, data, source, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, model_id) DO UPDATE SET data = excluded.data, source = excluded.source, updated_at = excluded.updated_at`,
    ).run(provider, modelId, JSON.stringify(data), source, Date.now());
  }

  /** 读单条/列全部（provider 缺省 = 跨商全列） */
  getModel(provider: string, modelId: string): { data: unknown; source: string } | undefined {
    const row = this.stmt('SELECT data, source FROM model_catalog WHERE provider = ? AND model_id = ?').get(
      provider,
      modelId,
    ) as { data: string; source: string } | undefined;
    return row ? { data: JSON.parse(row.data), source: row.source } : undefined;
  }

  listModels(provider?: string): Array<{ provider: string; modelId: string; data: unknown; source: string }> {
    const rows = (
      provider
        ? this.stmt('SELECT provider, model_id, data, source FROM model_catalog WHERE provider = ?')
        : this.stmt('SELECT provider, model_id, data, source FROM model_catalog')
    ).all(...(provider ? [provider] : [])) as Array<{
      provider: string;
      model_id: string;
      data: string;
      source: string;
    }>;
    return rows.map((r) => ({ provider: r.provider, modelId: r.model_id, data: JSON.parse(r.data), source: r.source }));
  }

  /** 删除一条模型目录（用户撤销覆盖） */
  deleteModel(provider: string, modelId: string): void {
    this.stmt('DELETE FROM model_catalog WHERE provider = ? AND model_id = ?').run(provider, modelId);
  }
}

/** seq 数组 → 紧凑 BLOB（Uint32LE，遮蔽溯源列的物理编码） */
function encodeSeqs(seqs: readonly number[]): Buffer {
  const buf = Buffer.alloc(seqs.length * 4);
  seqs.forEach((seq, i) => buf.writeUInt32LE(seq, i * 4));
  return buf;
}

/** BLOB → seq 数组 */
function decodeSeqs(blob: Buffer): number[] {
  const out: number[] = [];
  for (let offset = 0; offset + 4 <= blob.length; offset += 4) {
    out.push(blob.readUInt32LE(offset));
  }
  return out;
}

/** 物理行 → SessionEvent 信封（data 深冻结，可直接作种子共享） */
function decodeEvent(row: {
  seq: number;
  type: string;
  time: number;
  data: string;
  source_event_seqs: Buffer | null;
  surface_op: string | null;
  ignorable: number;
}): SessionEvent {
  return {
    type: row.type,
    seq: row.seq,
    time: row.time,
    data: deepFreeze(JSON.parse(row.data)),
    ...(row.ignorable ? { ignorable: true } : {}),
    ...(row.surface_op
      ? { surfaceOp: JSON.parse(row.surface_op) as { op: 'replace'; start: number; end: number } }
      : {}),
    ...(row.source_event_seqs ? { sourceEventSeqs: decodeSeqs(row.source_event_seqs) } : {}),
  };
}
