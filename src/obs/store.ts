/**
 * L3 obs — 自管库面（rollup.db：开库 / 件私有迁移链 / 增量落账 / 聚合查询；
 * 契约篇 §6.9 刀一，2026-08-31 观测复盘批）。
 *
 * 私有迁移链（冷读 B1）：obs 的 migrations **不进** collectBuiltinMigrations
 * （主库聚合链——rollup 表建进主库即违红线②）；开库后件内自跑，复用 persist
 * normalizeMigrations 校验框架（目标库 = rollup.db，user_version 链独立）。
 *
 * 开库（冷读 M7）：复用 createAppSqliteFace 的官方件直连形态（缺省无拒开基准
 * ——编译期信任边界；文件库 0600 追打在 face 内〔主文件〕，-wal/-shm 边车
 * 存在性追打在 openRollupStore 尾段——遗漏大扫 20260902 #2，零锁姿势）。
 *
 * 落账：增量 upsert（列白名单收窄——dur_ms_max 走 MAX 合并的单调水印，其余
 * 列 += 增量，负值即回退）；查询：表白名单 + groupBy 维度校验 + 有界 limit。
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createAppSqliteFace, prepareWalConnection, type DatabaseConnection } from '../persist/index.js';
import { normalizeMigrations, type MigrationSpec } from '../persist/index.js';
import type { BucketDelta, RollupTable } from './rollup.js';

/**
 * 件私有迁移链（v1：四 rollup 表 + alerts 规则表占位 + 维度唯一索引；v2：失败
 * 信号/耗时扩列；v3：deprecation_rollup_hour 废弃遥测第五表——批 3 API 治理）。
 * alerts 刀一建空表不执法（契约篇 §6.9 刀二拍板定形）。
 * DDL 全带 IF NOT EXISTS 幂等（2026-09-01 复盘 R-3）：迁移事务外崩溃残留
 * （表已建、user_version 归零）重开补跑无害——判定读 user_version 保持事务外
 * 零锁读（WAL 读不阻塞），写侧幂等即安全。
 */
const MIGRATIONS: readonly MigrationSpec[] = normalizeMigrations(
  [
    {
      version: 1,
      name: 'obs-rollup-v1',
      sql: `
        CREATE TABLE IF NOT EXISTS llm_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL, model TEXT NOT NULL, priority TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
          tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app, model, priority)
        );
        CREATE TABLE IF NOT EXISTS tool_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL, tool TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0, timeouts INTEGER NOT NULL DEFAULT 0,
          dur_ms_sum INTEGER NOT NULL DEFAULT 0, dur_ms_max INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app, tool)
        );
        CREATE TABLE IF NOT EXISTS turn_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL,
          turns INTEGER NOT NULL DEFAULT 0, user_msgs INTEGER NOT NULL DEFAULT 0,
          assistant_msgs INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app)
        );
        CREATE TABLE IF NOT EXISTS approval_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL,
          asked INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
          rejected INTEGER NOT NULL DEFAULT 0, always INTEGER NOT NULL DEFAULT 0,
          cancel INTEGER NOT NULL DEFAULT 0, unavailable INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app)
        );
        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric TEXT NOT NULL, agg TEXT NOT NULL, op TEXT NOT NULL,
          threshold REAL NOT NULL, window_hours INTEGER NOT NULL,
          cooldown_min INTEGER NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 1,
          last_fired_at INTEGER
        );
      `,
    },
    {
      // v2（基建大扫 #13/#26/#50）：失败信号与耗时扩列——llm 表 + exhausted/
      // dur_ms_sum/dur_ms_max（退避耗尽计数 + elapsedMs 聚合）、turn 表 +
      // turn_failures/dur_ms_sum/dur_ms_max（轮失败计数 + start×end 配对时长）。
      // ALTER ADD COLUMN 在迁移事务内原子（崩溃回滚列也回滚——与 DDL 幂等同
      // 判定语义：版本未走即列未立，重开补跑无害）
      version: 2,
      name: 'obs-rollup-v2-failure-duration',
      sql: `
        ALTER TABLE llm_rollup_hour ADD COLUMN exhausted INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE llm_rollup_hour ADD COLUMN dur_ms_sum INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE llm_rollup_hour ADD COLUMN dur_ms_max INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE turn_rollup_hour ADD COLUMN turn_failures INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE turn_rollup_hour ADD COLUMN dur_ms_sum INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE turn_rollup_hour ADD COLUMN dur_ms_max INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      // v3（第八十七批批 3 API 治理·废弃遥测，契约篇 §6.9 表族五 + §6.13.7）：
      // 废弃使用聚合表——`apps/deprecation-used` 事件的小时粒度计数（维度
      // app × DEP 编号）。纯建表 DDL 带 IF NOT EXISTS 幂等（与 v1 同判语义，
      // 无 v2 式 ALTER 自愈需求）
      version: 3,
      name: 'obs-rollup-v3-deprecation',
      sql: `
        CREATE TABLE IF NOT EXISTS deprecation_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL, dep TEXT NOT NULL,
          uses INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app, dep)
        );
      `,
    },
  ],
  0,
);

/** 表元数据白名单：维度列（含 hour 虚拟维）/ 增量度量列 / 水印列（冷读 M1） */
const TABLE_META: Readonly<
  Record<
    RollupTable,
    { readonly dims: readonly string[]; readonly measures: readonly string[]; readonly watermark?: string }
  >
> = {
  llm: {
    dims: ['app', 'model', 'priority'],
    // v2 扩列（基建大扫 #13/#26）：exhausted 失败信号 + elapsedMs 耗时聚合
    measures: ['calls', 'retries', 'exhausted', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write', 'dur_ms_sum'],
    watermark: 'dur_ms_max',
  },
  tool: {
    dims: ['app', 'tool'],
    measures: ['calls', 'blocked', 'failures', 'timeouts', 'dur_ms_sum'],
    watermark: 'dur_ms_max',
  },
  // v2 扩列（基建大扫 #13/#50）：turn_failures 失败信号 + start×end 配对时长
  turn: {
    dims: ['app'],
    measures: ['turns', 'turn_failures', 'user_msgs', 'assistant_msgs', 'tool_calls', 'dur_ms_sum'],
    watermark: 'dur_ms_max',
  },
  approval: { dims: ['app'], measures: ['asked', 'approved', 'rejected', 'always', 'cancel', 'unavailable'] },
  // v3（第八十七批批 3）：废弃遥测聚合——app × DEP 编号双维，uses 单计数列
  deprecation: { dims: ['app', 'dep'], measures: ['uses'] },
};

/** 各表全列序（upsert 归一用——增量缺列补 0，语句静态化） */
const TABLE_COLUMNS: Readonly<Record<RollupTable, readonly string[]>> = {
  llm: [
    'hour_ts',
    'app',
    'model',
    'priority',
    'calls',
    'retries',
    'exhausted',
    'tokens_in',
    'tokens_out',
    'cache_read',
    'cache_write',
    'dur_ms_sum',
    'dur_ms_max',
  ],
  tool: ['hour_ts', 'app', 'tool', 'calls', 'blocked', 'failures', 'timeouts', 'dur_ms_sum', 'dur_ms_max'],
  turn: [
    'hour_ts',
    'app',
    'turns',
    'turn_failures',
    'user_msgs',
    'assistant_msgs',
    'tool_calls',
    'dur_ms_sum',
    'dur_ms_max',
  ],
  approval: ['hour_ts', 'app', 'asked', 'approved', 'rejected', 'always', 'cancel', 'unavailable'],
  deprecation: ['hour_ts', 'app', 'dep', 'uses'],
};

/** 预编译 upsert 语句面（better-sqlite3 Statement 的 run 面收窄——动态全列参数用） */
interface UpsertStatement {
  /** 执行并返回受影响行数（结构兼容 RunResult——按名收窄防 unknown 出界） */
  run(...values: unknown[]): { changes: number };
}

/** 聚合查询入参（obs_query 工具与 /obs 命令共用） */
export interface RollupQuery {
  /** 五表名枚举（alerts 不是 metric——冷读 M1；v3 增 deprecation） */
  readonly metric: RollupTable;
  /** 起始毫秒（含） */
  readonly fromMs: number;
  /** 结束毫秒（含） */
  readonly toMs: number;
  /** 分组维度（合法集 = 表维度 ∪ 'hour'；缺省 = 表全维度；空数组 = 总计单行） */
  readonly groupBy?: readonly string[];
  /** 行帽（缺省 50、硬顶 500） */
  readonly limit?: number;
}

/** 查询产物单行：维度键值 + 度量键值 */
export interface RollupRow {
  readonly dims: Readonly<Record<string, string | number>>;
  readonly measures: Readonly<Record<string, number>>;
}

/** 告警规则行（alerts 表——契约篇 §6.9 刀二；只通知不执法红线见规范） */
export interface AlertRule {
  readonly id: number;
  /** 度量闭集「表名.度量列」（llm.tokens_in 式——冷读 M1；白名单 = TABLE_META 派生） */
  readonly metric: string;
  /** 窗口聚合（sum=窗口合计 / avg=小时桶均值 / max=小时桶最大） */
  readonly agg: 'sum' | 'avg' | 'max';
  /** 比较算子（> / >=） */
  readonly op: '>' | '>=';
  readonly threshold: number;
  /** 窗口小时数（滚动窗 = now − windowHours → now，UTC 小时桶对齐） */
  readonly windowHours: number;
  /** 冷却分钟（触发后该窗内不重触——防每 flush 重复通知） */
  readonly cooldownMin: number;
  readonly enabled: boolean;
  /** 上次触发时刻（毫秒；null = 未触发过） */
  readonly lastFiredAt: number | null;
}

/** 规则新增入参（id / lastFiredAt 由库生成） */
export type AlertRuleInput = Omit<AlertRule, 'id' | 'lastFiredAt' | 'enabled'> & { readonly enabled?: boolean };

/** 触发回执（apply 内联执法的回调载荷——app 侧三件触发：emit/notify/回写） */
export interface AlertFire {
  readonly rule: AlertRule;
  /** 窗口聚合实测值（过阈即触发） */
  readonly value: number;
}

/** 度量闭集校验：metric = 表名.度量列（白名单派生自 TABLE_META——含水印列） */
export function parseAlertMetric(metric: string): { table: RollupTable; column: string } | undefined {
  const dot = metric.indexOf('.');
  if (dot <= 0 || dot === metric.length - 1) return undefined;
  const table = metric.slice(0, dot) as RollupTable;
  const column = metric.slice(dot + 1);
  const meta = TABLE_META[table];
  if (meta === undefined) return undefined;
  const columns = [...meta.measures, ...(meta.watermark === undefined ? [] : [meta.watermark])];
  return columns.includes(column) ? { table, column } : undefined;
}

/** 规则入参校验（非法抛错——命令壳兜底为通知，模型/人都可修笔重试） */
export function validateAlertInput(input: AlertRuleInput): AlertRuleInput {
  if (parseAlertMetric(input.metric) === undefined) {
    throw new Error(
      `告警 metric 非法「${input.metric}」——闭集 = 表名.度量列（五表：${(Object.keys(TABLE_META) as RollupTable[]).map((t) => `${t}.{${[...TABLE_META[t]!.measures, ...(TABLE_META[t]!.watermark === undefined ? [] : [TABLE_META[t]!.watermark])].join(',')}}`).join(' ')}）`,
    );
  }
  if (input.agg !== 'sum' && input.agg !== 'avg' && input.agg !== 'max') {
    throw new Error(`告警 agg 非法「${input.agg}」——sum | avg | max`);
  }
  if (input.op !== '>' && input.op !== '>=') {
    throw new Error(`告警 op 非法「${input.op}」——> | >=`);
  }
  if (!Number.isFinite(input.threshold)) throw new Error('告警 threshold 须为有限数值');
  if (!Number.isInteger(input.windowHours) || input.windowHours < 1 || input.windowHours > 24 * 366) {
    throw new Error('告警 window_hours 须为 1..8784 的整数（小时）');
  }
  if (!Number.isInteger(input.cooldownMin) || input.cooldownMin < 0 || input.cooldownMin > 60 * 24 * 30) {
    throw new Error('告警 cooldown_min 须为 0..43200 的整数（分钟；0 = 每 flush 可重触）');
  }
  return input;
}

/** alerts 表行的窄化读取（better-sqlite3 动态行 → AlertRule） */
function alertRowOf(row: Record<string, unknown>): AlertRule {
  return {
    id: Number(row['id']),
    metric: String(row['metric']),
    agg: String(row['agg']) as AlertRule['agg'],
    op: String(row['op']) as AlertRule['op'],
    threshold: Number(row['threshold']),
    windowHours: Number(row['window_hours']),
    cooldownMin: Number(row['cooldown_min']),
    enabled: Number(row['enabled']) === 1,
    lastFiredAt:
      row['last_fired_at'] === null || row['last_fired_at'] === undefined ? null : Number(row['last_fired_at']),
  };
}

/** 自管库面（件 apply 期构造，随行作用域回卷 close） */
export interface RollupStore {
  /**
   * 增量落账（单事务；dur_ms_max 走 MAX 合并，其余列 += 增量）。
   * onAlert 在场时**同事务内联执法**（契约篇 §6.9 刀二）：本批触达的表上有
   * 启用规则 → 算窗口聚合值 → 过阈且冷却窗外 → 回写 last_fired_at + 回调
   * （回调内 emit/notify/留账由调用方负责——只通知不执法红线）。
   * canFire 在场时为**观众探针前置**（2026-09-01 复盘 R-2）：触发四件整笔
   * 前先问——探针假（无头 run/tick 进程）→ 整笔跳过：不回写 last_fired_at、
   * 不回调（冷却只被有观众的进程消耗，daemon 常驻面下次 flush 重评重发）。
   */
  apply(deltas: readonly BucketDelta[], onAlert?: (fire: AlertFire) => void, canFire?: () => boolean): void;
  /** 规则清单（全量——含禁用行） */
  listAlerts(): readonly AlertRule[];
  /** 新增规则（校验闭集与值域——非法抛错）；返回含库生成 id 的完整行 */
  addAlert(input: AlertRuleInput): AlertRule;
  /** 删除规则（不存在 = false） */
  removeAlert(id: number): boolean;
  /** 启停规则（不存在 = false） */
  setAlertEnabled(id: number, enabled: boolean): boolean;
  /** 聚合查询（白名单校验——非法 groupBy 抛错由调用面呈现） */
  query(q: RollupQuery): readonly RollupRow[];
  /** 关库（行回卷路——未落账增量随弃，≤flushMs 丢窗为规范既定） */
  close(): void;
}

/**
 * v2 迁移已生效探测（R-3 自愈）：llm 表已携带 exhausted 列即视为 v2 全部落定
 * （六列同迁移事务加——单列在场 = 全列在场）。SQLite 的 ALTER ADD COLUMN 无
 * IF NOT EXISTS 形态，人工归零 user_version 的残留重开靠此探测自愈。
 */
function v2ColumnsLanded(db: DatabaseConnection): boolean {
  const cols = db.prepare('PRAGMA table_info(llm_rollup_hour)').all() as { name?: unknown }[];
  return cols.some((col) => col.name === 'exhausted');
}

/**
 * 打开 rollup 库（官方件直连形态——主库拒开基准不适用；文件库 0600 追打）。
 * 目录惰性建（首开建档）；user_version 私有链自跑（normalizeMigrations 校验）。
 * @param options.busyTimeoutMs 撞锁等待上限毫秒（缺省 5000——openStore 同款
 *   注入位，基建大扫 #17：行 config 旋钮透传点，测试缝降档用）
 */
export function openRollupStore(dbPath: string, options?: { busyTimeoutMs?: number }): RollupStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  // 官方件直连（无拒开基准）——obs 是宿主侧编译件，威胁模型不覆盖此边界
  const db: DatabaseConnection = createAppSqliteFace().openDatabase(dbPath);
  // 多进程鲁棒性：daemon 常驻与 tick 子进程会同开本库（宿主双开是既定容忍态）。
  // 编舞与主库 openStore 同源共享件（2026-09-01 复盘 T-2——#25 顺序铁律）：
  // busy_timeout 最先 + WAL 幂等探测 + 短退避重试（WAL 切换锁通道不吃
  // busy_timeout 是 SQLite 固有——他进程持写锁时不再 ~0ms 即崩）
  prepareWalConnection(db, { busyTimeoutMs: options?.busyTimeoutMs });
  // 私有迁移链（件内自跑——不进主库聚合链，冷读 B1）
  const current = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
  );
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    // R-3 自愈扩展（v2 起）：ALTER ADD COLUMN 无 IF NOT EXISTS 幂等形态——
    // 「列已建而 user_version 未记」的人工残留（版本回零）重开补跑会炸；
    // 跑前探测已生效即只补版本号（与 v1 的 IF NOT EXISTS 同自愈性质）
    if (migration.version === 2 && v2ColumnsLanded(db)) {
      db.pragma('user_version = 2');
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  // ---- 边车 0600 存在性追打（遗漏大扫 20260902 #2，镜像主库三件模式）----
  // 零锁姿势（T-2 开库编舞不变式：他进程持写锁时开库读侧零锁——不得引入写
  // 需求）：不作物化写事务。边车在场性由两条既有路径自然保证——首开形态迁移
  // 事务已物化；重开形态 WAL 旗标库的读者（user_version 读）即物化 -wal/-shm。
  // chmod 按存在性追打兜平台差异（persist 同款注释：SQLite open(0644) 吃 umask
  // 且不暴露 fd，路径追打是唯一可靠姿势；face 内只 chmod 主文件——边车归此点）。
  // ':memory:' 零文件身份（face 内同款早退口径）——跳过
  if (dbPath !== ':memory:') {
    chmodSync(dbPath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      const side = `${dbPath}${suffix}`;
      if (existsSync(side)) chmodSync(side, 0o600);
    }
  }
  // upsert 语句缓存（表 → 预编译 insert-or-update）
  const upserts = new Map<RollupTable, UpsertStatement>();
  for (const table of Object.keys(TABLE_COLUMNS) as RollupTable[]) {
    const columns = TABLE_COLUMNS[table];
    const placeholders = columns.map(() => '?').join(', ');
    const watermark = TABLE_META[table].watermark;
    // UPDATE 集排除全部主键列（hour_ts + 该表维度列）——维度列进 SET 会在冲突
    // 路损坏主键（llm 三维主键尤其：priority 字符串相加归零）
    const keyColumns = new Set(['hour_ts', ...TABLE_META[table].dims]);
    const updates = columns
      .filter((col) => !keyColumns.has(col))
      .map((col) =>
        watermark !== undefined && col === watermark
          ? `${col} = MAX(${col}, excluded.${col})` // 单调水印——只升不降
          : `${col} = ${col} + excluded.${col}`,
      )
      .join(', ');
    upserts.set(
      table,
      // SAFETY: better-sqlite3 Statement.run 的重载元组签名不接受动态展开——此处
      // 收窄为 rest 参数面；参数序与列序由 TABLE_COLUMNS 单源保证（apply 侧同源映射），
      // RunResult 结构满足 { changes } 收窄面
      db.prepare(
        `INSERT INTO ${table}_rollup_hour (${columns.join(', ')}) VALUES (${placeholders}) ` +
          `ON CONFLICT DO UPDATE SET ${updates}`,
      ) as UpsertStatement,
    );
  }

  /** 读全量规则（含禁用——内联执法与命令清单共用取数面） */
  // SAFETY: better-sqlite3 Statement 泛型重载不收动态列集——按行面收窄为
  // Record<string, unknown>[]（alertRowOf 逐字段窄化）；与 UpsertStatement 同款信任边界
  const listAlertsStmt = db.prepare('SELECT * FROM alerts ORDER BY id') as unknown as {
    all(): Record<string, unknown>[];
  };
  const listAlertRows = (): AlertRule[] => listAlertsStmt.all().map(alertRowOf);

  return {
    apply(deltas: readonly BucketDelta[], onAlert?: (fire: AlertFire) => void, canFire?: () => boolean): void {
      // 本批触达的表（内联执法只查触达表上的规则——未触达的窗口值未变不重评）
      const touched = new Set(deltas.map((d) => d.table));
      // 触发集先收集、事务提交后出膛（遗漏大扫 20260902 #1）：事务内只做窗口读与
      // last_fired_at 回写；onAlert 三件副作用（emit/notify/alerts.jsonl 留账）移到
      // 提交后——修前回调在事务内出膛，同事务后续语句盘级错误（SQLITE_FULL/
      // IOERR）回滚时通知与留账已发生且无补偿，重启后同窗重复通知+重复留账。
      // 语义换挡：at-least-once（回滚重发）→ at-most-once（提交后崩溃丢单次通知）
      // ——后者与停摄取纪律一致（观测可用性优先，宁漏一次通知不重复打扰）。
      const fired: AlertFire[] = [];
      db.transaction(() => {
        for (const delta of deltas) {
          const columns = TABLE_COLUMNS[delta.table];
          const values = columns.map((col) => {
            if (col === 'hour_ts') return delta.hourTs;
            const dimIndex = TABLE_META[delta.table].dims.indexOf(col);
            if (dimIndex >= 0) return delta.dims[dimIndex] ?? '(unknown)';
            return delta.cols[col] ?? 0;
          });
          upserts.get(delta.table)!.run(...values); // 参数序 = TABLE_COLUMNS 全列归一
        }
        // ---- 刀二内联执法（同事务——窗口读可见本批未提交增量）----
        if (onAlert === undefined || touched.size === 0) return;
        const now = Date.now();
        for (const rule of listAlertRows()) {
          if (!rule.enabled) continue;
          const parsed = parseAlertMetric(rule.metric);
          if (parsed === undefined || !touched.has(parsed.table)) continue;
          const windowFrom = Math.floor((now - rule.windowHours * 3_600_000) / 3_600_000) * 3_600_000;
          const fn = rule.agg === 'sum' ? 'SUM' : rule.agg === 'avg' ? 'AVG' : 'MAX';
          const hit = db
            .prepare(`SELECT ${fn}(${parsed.column}) AS v FROM ${parsed.table}_rollup_hour WHERE hour_ts >= ?`)
            .get(windowFrom) as { v: number | null } | undefined;
          const value = Number(hit?.v ?? 0);
          const overThreshold = rule.op === '>' ? value > rule.threshold : value >= rule.threshold;
          const cooldownFree = rule.lastFiredAt === null || now - rule.lastFiredAt >= rule.cooldownMin * 60_000;
          if (!overThreshold || !cooldownFree) continue;
          // 观众探针前置（复盘 R-2）：无头进程（无 ui 后端）整笔跳过——不回写
          // last_fired_at、不回调。冷却只被有观众的进程消耗；daemon 常驻面
          // 下次 flush 对同窗口重评重发（阈值还在，观众在场即触发）
          if (canFire !== undefined && !canFire()) continue;
          db.prepare('UPDATE alerts SET last_fired_at = ? WHERE id = ?').run(now, rule.id);
          fired.push({ rule: { ...rule, lastFiredAt: now }, value });
        }
      })();
      // 提交后出膛（#1）：此刻 last_fired_at 已落盘可见——回调内观察者（他连接/
      // 重启恢复形态）读到的冷却基准与通知语义一致。fired 空集（无规则过阈/
      // 无观众整笔跳过）时零回调
      if (onAlert !== undefined) for (const fire of fired) onAlert(fire);
    },
    listAlerts(): readonly AlertRule[] {
      return listAlertRows();
    },
    addAlert(input: AlertRuleInput): AlertRule {
      validateAlertInput(input);
      const info = db
        .prepare(
          'INSERT INTO alerts (metric, agg, op, threshold, window_hours, cooldown_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.metric,
          input.agg,
          input.op,
          input.threshold,
          input.windowHours,
          input.cooldownMin,
          input.enabled === false ? 0 : 1,
        );
      const id = Number(info.lastInsertRowid);
      return listAlertRows().find((rule) => rule.id === id)!;
    },
    removeAlert(id: number): boolean {
      return db.prepare('DELETE FROM alerts WHERE id = ?').run(id).changes > 0;
    },
    setAlertEnabled(id: number, enabled: boolean): boolean {
      return db.prepare('UPDATE alerts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
    },
    query(q: RollupQuery): readonly RollupRow[] {
      const meta = TABLE_META[q.metric];
      const allowed = new Set([...meta.dims, 'hour']);
      const groupBy = q.groupBy ?? meta.dims;
      for (const dim of groupBy) {
        if (!allowed.has(dim)) {
          throw new Error(`groupBy 非法维度「${dim}」（${q.metric} 表合法集：${[...allowed].join('、')}）`);
        }
      }
      const selectDims = groupBy.map((d) => (d === 'hour' ? 'hour_ts' : d));
      const measures = [...meta.measures.map((m) => `SUM(${m}) AS ${m}`)];
      if (meta.watermark !== undefined) measures.push(`MAX(${meta.watermark}) AS ${meta.watermark}`);
      const grouping = selectDims.length > 0 ? ` GROUP BY ${selectDims.join(', ')}` : '';
      const ordering = selectDims.length > 0 ? ` ORDER BY ${selectDims.join(', ')}` : '';
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
      const rows = db
        .prepare(
          `SELECT ${[...selectDims, ...measures].join(', ')} FROM ${q.metric}_rollup_hour ` +
            `WHERE hour_ts >= ? AND hour_ts <= ?${grouping}${ordering} LIMIT ${limit}`,
        )
        .all(Math.floor(q.fromMs / 3_600_000) * 3_600_000, Math.floor(q.toMs / 3_600_000) * 3_600_000) as Record<
        string,
        string | number
      >[];
      return rows.map((row) => {
        const dims: Record<string, string | number> = {};
        for (const dim of groupBy) dims[dim] = row[dim === 'hour' ? 'hour_ts' : dim]!;
        const measuresOut: Record<string, number> = {};
        for (const measure of [...meta.measures, ...(meta.watermark === undefined ? [] : [meta.watermark])]) {
          measuresOut[measure] = Number(row[measure] ?? 0);
        }
        return { dims, measures: measuresOut };
      });
    },
    close(): void {
      db.close();
    },
  };
}

/** 查询产物 → 文本表格（obs_query 工具回执与 /obs 命令共用呈现） */
export function renderRollupTable(
  metric: RollupTable,
  rows: readonly RollupRow[],
  opts?: { readonly extraMeasures?: readonly string[] },
): string {
  if (rows.length === 0) return `（${metric}：该时间窗无聚合数据）`;
  const meta = TABLE_META[metric];
  const measures = [
    ...meta.measures,
    ...(opts?.extraMeasures ?? (meta.watermark === undefined ? [] : [meta.watermark])),
  ];
  const dimKeys = Object.keys(rows[0]!.dims);
  const header = [...dimKeys, ...measures].join(' | ');
  const lines = rows.map((row) => {
    const dimCells = dimKeys.map((key) => String(row.dims[key]));
    const measureCells = measures.map((measure) => String(row.measures[measure] ?? 0));
    return [...dimCells, ...measureCells].join(' | ');
  });
  return [header, ...lines].join('\n');
}
