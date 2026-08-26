/**
 * L1 persist — SQLite 存储核（会话篇 §6 物理层的实现）。
 *
 * 职责：版本门禁（开库即验，宁拒绝不误读）、appendCore（切片多事务批量写入 +
 * cursor 连续性校验 + revision 前进——#13）、loadEvents（读 + 撕裂尾截断修复）、
 * 凭证 read-modify-write 串行化、模型目录 CRUD。
 * 全部 better-sqlite3 同步 API——进程内无并发竞争，跨进程经 BEGIN IMMEDIATE 仲裁。
 */

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as DatabaseConnection } from 'better-sqlite3';
import { AppError, SESSION_FORMAT_UNSUPPORTED, SESSION_WRITE_CONFLICT } from '../contracts/errors.js';
import type { EventQueryOptions, EventQueryResult, EventQueryRow, SessionEvent } from '../contracts/events.js';
import { deepFreeze } from '../session/snapshot.js';
import { normalizeMigrations, type MigrationSpec } from './migrations.js';
import { APPLICATION_ID, CANONICAL_DDL, SCHEMA_VERSION, SESSION_APP_COLUMN_MIGRATION } from './schema.js';

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
  /** 应用域标记（v6 列——NULL = 存量会话 user 态，存量不回填；契约篇 §5.4） */
  app: string | null;
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
  /** 应用域标记（血缘显式打标——缺省 NULL；fork 经 Persistence 继承父域） */
  app?: string;
}

/**
 * 打开（或初始化/升级）一个存储库。
 * 门禁顺序：application_id → user_version（升级方向补跑迁移链，降级方向拒绝）→
 * schema 逐对象比对（基线 DDL ∪ 迁移链产物累积指纹）；任一不匹配拒绝打开
 * （宁拒绝不误读；old-v2 旧库不进此门禁）。
 *
 * 双开冷启动原子性（探矿轮八 #25，2026-08-25）：初始化/门禁段整体包在
 * BEGIN IMMEDIATE 单写事务里——判定（空库与否）与写入同事务，外部连接
 * 永远只见「空库」或「完整库」，半初始化状态不可见；后到进程经 BEGIN
 * IMMEDIATE 的标准锁等待（busy_timeout 有界）串行进入，随后按完整库走
 * 门禁路径。WAL 切换本身不能进事务，其锁通道又不吃 busy_timeout（SQLite
 * 固有——遇对方持锁 1ms 即 BUSY），用幂等探测 + 短退避重试兜微秒级切换窗。
 */
export function openStore(options: StoreOptions): Store {
  // 迁移链先校验排序（装配错误在此即抛，不动任何库文件）。
  // 内核表迁移（sessions 是内核表——DDL 演进直归 persist，业务调用方不感知）：
  // persist 自注入，与业务迁移项合并排序。版本空间共享——内核占用 v6（sessions
  // +app 列），业务模块声明面不得撞号（normalizeMigrations 严格递增校验即执法面）
  const chain = normalizeMigrations([...(options.migrations ?? []), SESSION_APP_COLUMN_MIGRATION], SCHEMA_VERSION);
  const latestVersion = chain.length > 0 ? chain[chain.length - 1]!.version : SCHEMA_VERSION;

  const db = new Database(options.path);
  // 双开姿态四件之①②：WAL 读写不互斥 + 锁等待有界。
  // 顺序铁律（#25）：busy_timeout 必须最先设置——后续一切写操作（含初始化
  // 事务的 BEGIN IMMEDIATE）的锁等待才有界。
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  // WAL 幂等探测：读当前模式不加锁；已是 wal 则跳过设置（幂等路径无锁需求）。
  if ((db.pragma('journal_mode', { simple: true }) as string) !== 'wal') {
    // 真切换需独占访问，且其锁通道不吃 busy_timeout——双开冷启动时后到者
    // 可能撞上先到者微秒级的切换窗。短退避重试（5→15→45→135ms）覆盖之；
    // 对方长持锁（非切换窗）最终仍响亮抛 BUSY，不做无限等待。
    for (let attempt = 0; ; attempt++) {
      try {
        db.pragma('journal_mode = WAL');
        break;
      } catch (err) {
        if (attempt >= 4 || !String((err as Error).message).includes('database is locked')) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 3 ** attempt); // 同步退避（openStore 是同步 API）
      }
    }
  }
  // 拍板：synchronous=FULL（批量事务落盘强度优先；连接级设置，不涉库锁）
  db.pragma('synchronous = FULL');

  // 初始化/门禁/升级段：单写事务（BEGIN IMMEDIATE 开场）。better-sqlite3
  // 事务内抛错自动回滚；applyMigration 的嵌套事务以 savepoint 实现，安全。
  const init = db.transaction(() => {
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
        throw new AppError(
          SESSION_FORMAT_UNSUPPORTED,
          `application_id 不匹配（库内 ${appId}，期望 ${APPLICATION_ID}）——不是本产品的库，拒绝打开`,
        );
      }
      if (userVersion > latestVersion) {
        // 降级方向（未来库/旧宿主开新库）：宁拒绝不误读，永不自动降级
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
  });
  try {
    init.immediate();
  } catch (err) {
    // 门禁拒绝（AppError）或真锁冲突：关连接再上抛——调用方拿到干净错误面
    db.close();
    throw err;
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

/**
 * appendCore 切片参数（契约篇 §1.6 资源护栏族 #13，2026-08-27 刀〇b）：
 * 500 条或累计序列化字节 4MiB 先到者切片多事务顺序提交——better-sqlite3 同步
 * 写长阻塞 event loop 的切片（B3 §9 P6'）。字节计量取自 INSERT 序列化产物
 * 本身（物理层零额外序列化税——预序列化一次，切片与 INSERT 同用）。
 */
const APPEND_SLICE_MAX_ROWS = 500;
const APPEND_SLICE_MAX_BYTES = 4 * 1024 * 1024;

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
   *
   * 切片语义（#13，2026-08-27 刀〇b）：内部按 500 条或累计序列化字节 4MiB
   * 先到者切片，逐片独立 BEGIN IMMEDIATE 事务顺序提交（cursor 连续性校验
   * 逐片自洽——后片起点自然衔接前片落定的 max(seq)）；每片事务内做
   * insert → sessions 行登记 → revision 前进（incarnation 变更即复位为 1）。
   * 片失败 = 已提交片保持 durable（**部分写如实**）、错误穿透上抛——
   * 调用方（write-behind）按库内 maxSeq 裁剪重试面，只重未写部分。
   *
   * @param incarnation 本进程生命周期 UUID（revision 复位边界）
   * @returns 前进后的 revision（= 最后一片落定的值；切片使 revision 按事务数前进）
   */
  appendCore(reg: SessionRegistration, batch: readonly SessionEvent[], incarnation: string): number {
    if (batch.length === 0) {
      return this.currentRevision(reg.sessionId);
    }
    // 预序列化一次（切片字节计量与 INSERT 同用——零额外序列化税）
    const jsons = batch.map((event) => JSON.stringify(event.data));
    let revision = 0;
    for (let start = 0; start < batch.length;) {
      // 切片边界：从 start 起累计至 500 条或 4MiB（首条必进片——单条超界独占一片）
      let end = start + 1;
      let bytes = Buffer.byteLength(jsons[start]!, 'utf8');
      while (end < batch.length && end - start < APPEND_SLICE_MAX_ROWS && bytes < APPEND_SLICE_MAX_BYTES) {
        bytes += Buffer.byteLength(jsons[end]!, 'utf8');
        end += 1;
      }
      revision = this.appendSlice(reg, batch.slice(start, end), jsons.slice(start, end), incarnation);
      start = end;
    }
    return revision;
  }

  /**
   * 单片事务：cursor 连续性校验（片首 seq 必须 = 已存 max(seq)+1——同会话单写者
   * 护栏，双开姿态第③件；切片场景下后片衔接前片落定的 max）→ 批量 insert →
   * sessions 行登记 → revision 前进。片内原子（失败整片回滚，已提交片不受影响）。
   */
  private appendSlice(
    reg: SessionRegistration,
    events: readonly SessionEvent[],
    jsons: readonly string[],
    incarnation: string,
  ): number {
    const run = this.db.transaction(() => {
      const tail = this.stmt('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE session_id = ?').get(
        reg.sessionId,
      ) as { m: number };
      const expectedStart = tail.m + 1;
      if (events[0]!.seq !== expectedStart) {
        throw new AppError(
          SESSION_WRITE_CONFLICT,
          `cursor 断裂：片起始 seq=${events[0]!.seq}，库内 max(seq)+1=${expectedStart}（会话 ${reg.sessionId}）`,
        );
      }
      const insert = this.stmt(
        `INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        insert.run(
          reg.sessionId,
          event.seq,
          event.type,
          event.time,
          jsons[i]!, // 预序列化产物（appendCore 一次算、切片与 INSERT 同用）
          event.sourceEventSeqs ? encodeSeqs(event.sourceEventSeqs) : null,
          event.surfaceOp ? JSON.stringify(event.surfaceOp) : null,
          event.ignorable ? 1 : 0,
        );
      }
      // sessions 行：首次登记（ON CONFLICT 静默——header 以首次登记为准，血缘不改写）
      this.stmt(
        `INSERT INTO sessions (id, schema_version, created_at, cwd, origin, parent_session, seed_length,
           delegation_depth, profile, incarnation, revision, app)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
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
        reg.app ?? null,
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

  /**
   * 库内最大 seq（#13 部分写事实源）：appendCore 片失败后，已提交片的落定边界
   * 从库本身读取——write-behind 以此裁剪重试面（只重未写部分），不靠错误携带
   * 状态。无事件返回 undefined。
   */
  maxSeq(sessionId: string): number | undefined {
    const row = this.stmt('SELECT MAX(seq) AS m FROM events WHERE session_id = ?').get(sessionId) as
      { m: number | null } | undefined;
    return row === undefined || row.m === null ? undefined : row.m;
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
   *
   * 应用域过滤（契约篇 §5.4 第二纵切——冷读裁决两形）：
   * - chat 域（默认入口）`includeNullApp: true`：`app IS NULL OR app = 'chat'`
   *   ——NULL 是 builtin:chat 落地前的存量会话，对话应用续接它们（存量不回填、
   *   但默认入口的域含历史全量）；
   * - 第三方应用严格域：仅 `app = <id>`——不吞他域会话。
   * @returns 无匹配返回 undefined
   */
  latestSessionId(cwd: string, domain?: { app: string; includeNullApp?: boolean }): string | undefined {
    if (domain === undefined) {
      const row = this.stmt('SELECT id FROM sessions WHERE cwd = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(
        cwd,
      ) as { id: string } | undefined;
      return row?.id;
    }
    const clause = domain.includeNullApp === true ? '(app IS NULL OR app = ?)' : 'app = ?';
    const row = this.stmt(
      `SELECT id FROM sessions WHERE cwd = ? AND ${clause} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(cwd, domain.app) as { id: string } | undefined;
    return row?.id;
  }

  /* ---------------- 跨会话有界查询（会话篇 §3.4，2026-08-27 刀 1） ---------------- */

  /** queryEvents 页大小缺省值（会话篇 §3.4） */
  static readonly EVENT_QUERY_DEFAULT_LIMIT = 200;
  /** queryEvents 页大小硬帽（超帽钳到帽且 truncated 置真——会话篇 §3.4） */
  static readonly EVENT_QUERY_MAX_LIMIT = 1000;

  /**
   * 跨会话有界时间窗查询（会话篇 §3.4 唯一原语的物理半边；latestSessionId 的
   * 内核表读脸同族—— sanctioned 直读事实表，不派生状态不攒第二份账）。
   *
   * 序 = time DESC、tie-break (session_id, seq) DESC（日志捞取语义：最新优先
   * 往回翻）；分页用组合游标不用 offset——write-behind 落库期间新事件插到前端，
   * offset 会漂、游标不漂（游标向更旧翻，新事件落在已翻过侧天然不可见）。
   *
   * types 是数据条件非词汇断言（判定句见 contracts/events.ts）：查未注册或
   * 已消失的词返回空不抛。迟滞披露：读物理库，未 flush 尾部不可见——屏障
   * 参数（flushFirst）归服务面（ctx.sessions），本层不管。
   *
   * 索引维持「真实量级再加」裁决：v1 无 time 索引，顺序扫 + LIMIT 在单
   * operator 量级毫秒级；行数上六位数或延迟可感知时 idx_events_time 随迁移链前进。
   */
  queryEvents(opts: EventQueryOptions): EventQueryResult {
    // 页大小钳制（缺省 200 / 硬帽 1000；超帽钳到帽——exec/tool.ts timeoutMs 钳制同款）
    const requested = opts.limit ?? Store.EVENT_QUERY_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(Math.floor(requested), 1), Store.EVENT_QUERY_MAX_LIMIT);
    const clamped = requested > Store.EVENT_QUERY_MAX_LIMIT;

    // 动态 WHERE 装配（条件全组合可列，stmt 缓存按 SQL 文本键控天然复用）
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.sinceMs !== undefined) {
      where.push('e.time >= ?'); // 含端点闭区间（下界）
      params.push(opts.sinceMs);
    }
    if (opts.untilMs !== undefined) {
      where.push('e.time <= ?'); // 含端点闭区间（上界）
      params.push(opts.untilMs);
    }
    if (opts.types !== undefined && opts.types.length > 0) {
      // 空数组 = 无过滤（与 undefined 同义——「不过滤此维」而非「匹配零行」）
      where.push(`e.type IN (${opts.types.map(() => '?').join(', ')})`);
      params.push(...opts.types);
    }
    if (opts.sessionId !== undefined) {
      where.push('e.session_id = ?');
      params.push(opts.sessionId);
    }
    // app 维走 sessions 列（JOIN sessions）；仅声明 app 时才引入 JOIN
    const join = opts.app !== undefined ? 'JOIN sessions s ON s.id = e.session_id' : '';
    if (opts.app !== undefined) {
      where.push('s.app = ?');
      params.push(opts.app);
    }
    // 组合游标：下一页 = 排序意义上严格更旧于游标行（DESC 三段比较直写 SQL）
    if (opts.cursor !== undefined) {
      where.push('(e.time < ? OR (e.time = ? AND (e.session_id < ? OR (e.session_id = ? AND e.seq < ?))))');
      params.push(opts.cursor.time, opts.cursor.time, opts.cursor.sessionId, opts.cursor.sessionId, opts.cursor.seq);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    // 多取一行探测更旧页（nextCursor 判据）——探测行不进本页
    const sql = `SELECT e.session_id AS sessionId, e.seq, e.type, e.time, e.data FROM events e ${join} ${whereSql} ORDER BY e.time DESC, e.session_id DESC, e.seq DESC LIMIT ${limit + 1}`;
    const raw = this.stmt(sql).all(...(params as never[])) as Array<{
      sessionId: string;
      seq: number;
      type: string;
      time: number;
      data: string;
    }>;
    const hasMore = raw.length > limit;
    const page = hasMore ? raw.slice(0, limit) : raw;
    const rows: EventQueryRow[] = page.map((r) => ({
      sessionId: r.sessionId,
      seq: r.seq,
      type: r.type,
      time: r.time,
      data: JSON.parse(r.data) as unknown, // 载荷原样反序列化——呈现截断归工具层
    }));
    const last = page.at(-1);
    return {
      rows,
      ...(hasMore && last !== undefined
        ? { nextCursor: { time: last.time, sessionId: last.sessionId, seq: last.seq } }
        : {}),
      truncated: clamped || hasMore, // 「本页不是全部」总标注：钳制或更旧页任一成立
    };
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
