/**
 * L3 obs — 自管库面（rollup.db：开库 / 件私有迁移链 / 增量落账 / 聚合查询；
 * 契约篇 §6.9 刀一，2026-08-31 观测复盘批）。
 *
 * 私有迁移链（冷读 B1）：obs 的 migrations **不进** collectBuiltinMigrations
 * （主库聚合链——rollup 表建进主库即违红线②）；开库后件内自跑，复用 persist
 * normalizeMigrations 校验框架（目标库 = rollup.db，user_version 链独立）。
 *
 * 开库（冷读 M7）：复用 createAppSqliteFace 的官方件直连形态（缺省无拒开基准
 * ——编译期信任边界；文件库 0600 追打在 face 内）。
 *
 * 落账：增量 upsert（列白名单收窄——dur_ms_max 走 MAX 合并的单调水印，其余
 * 列 += 增量，负值即回退）；查询：表白名单 + groupBy 维度校验 + 有界 limit。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createAppSqliteFace, type DatabaseConnection } from '../persist/index.js';
import { normalizeMigrations, type MigrationSpec } from '../persist/index.js';
import type { BucketDelta, RollupTable } from './rollup.js';

/**
 * 件私有迁移链（v1：四 rollup 表 + alerts 规则表占位 + 维度唯一索引）。
 * alerts 刀一建空表不执法（契约篇 §6.9 刀二拍板定形）。
 */
const MIGRATIONS: readonly MigrationSpec[] = normalizeMigrations(
  [
    {
      version: 1,
      name: 'obs-rollup-v1',
      sql: `
        CREATE TABLE llm_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL, model TEXT NOT NULL, priority TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, retries INTEGER NOT NULL DEFAULT 0,
          tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app, model, priority)
        );
        CREATE TABLE tool_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL, tool TEXT NOT NULL,
          calls INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
          failures INTEGER NOT NULL DEFAULT 0, timeouts INTEGER NOT NULL DEFAULT 0,
          dur_ms_sum INTEGER NOT NULL DEFAULT 0, dur_ms_max INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app, tool)
        );
        CREATE TABLE turn_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL,
          turns INTEGER NOT NULL DEFAULT 0, user_msgs INTEGER NOT NULL DEFAULT 0,
          assistant_msgs INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app)
        );
        CREATE TABLE approval_rollup_hour (
          hour_ts INTEGER NOT NULL, app TEXT NOT NULL,
          asked INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
          rejected INTEGER NOT NULL DEFAULT 0, always INTEGER NOT NULL DEFAULT 0,
          cancel INTEGER NOT NULL DEFAULT 0, unavailable INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour_ts, app)
        );
        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric TEXT NOT NULL, agg TEXT NOT NULL, op TEXT NOT NULL,
          threshold REAL NOT NULL, window_hours INTEGER NOT NULL,
          cooldown_min INTEGER NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 1,
          last_fired_at INTEGER
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
    measures: ['calls', 'retries', 'tokens_in', 'tokens_out', 'cache_read', 'cache_write'],
  },
  tool: {
    dims: ['app', 'tool'],
    measures: ['calls', 'blocked', 'failures', 'timeouts', 'dur_ms_sum'],
    watermark: 'dur_ms_max',
  },
  turn: { dims: ['app'], measures: ['turns', 'user_msgs', 'assistant_msgs', 'tool_calls'] },
  approval: { dims: ['app'], measures: ['asked', 'approved', 'rejected', 'always', 'cancel', 'unavailable'] },
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
    'tokens_in',
    'tokens_out',
    'cache_read',
    'cache_write',
  ],
  tool: ['hour_ts', 'app', 'tool', 'calls', 'blocked', 'failures', 'timeouts', 'dur_ms_sum', 'dur_ms_max'],
  turn: ['hour_ts', 'app', 'turns', 'user_msgs', 'assistant_msgs', 'tool_calls'],
  approval: ['hour_ts', 'app', 'asked', 'approved', 'rejected', 'always', 'cancel', 'unavailable'],
};

/** 预编译 upsert 语句面（better-sqlite3 Statement 的 run 面收窄——动态全列参数用） */
interface UpsertStatement {
  /** 执行并返回受影响行数（结构兼容 RunResult——按名收窄防 unknown 出界） */
  run(...values: unknown[]): { changes: number };
}

/** 聚合查询入参（obs_query 工具与 /obs 命令共用） */
export interface RollupQuery {
  /** 四表名枚举（alerts 不是 metric——冷读 M1） */
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
      `告警 metric 非法「${input.metric}」——闭集 = 表名.度量列（四表：${(Object.keys(TABLE_META) as RollupTable[]).map((t) => `${t}.{${[...TABLE_META[t]!.measures, ...(TABLE_META[t]!.watermark === undefined ? [] : [TABLE_META[t]!.watermark])].join(',')}}`).join(' ')}）`,
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
   * （回调内 emit/notify 由调用方负责——只通知不执法红线）
   */
  apply(deltas: readonly BucketDelta[], onAlert?: (fire: AlertFire) => void): void;
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
 * 打开 rollup 库（官方件直连形态——主库拒开基准不适用；文件库 0600 追打）。
 * 目录惰性建（首开建档）；user_version 私有链自跑（normalizeMigrations 校验）。
 */
export function openRollupStore(dbPath: string): RollupStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  // 官方件直连（无拒开基准）——obs 是宿主侧编译件，威胁模型不覆盖此边界
  const db: DatabaseConnection = createAppSqliteFace().openDatabase(dbPath);
  // 多进程鲁棒性：daemon 常驻与 tick 子进程会同开本库（宿主双开是既定容忍态）——
  // WAL 消读写互斥 + busy_timeout 把瞬时写锁竞争变为等待而非 SQLITE_BUSY 即停
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // 私有迁移链（件内自跑——不进主库聚合链，冷读 B1）
  const current = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
  );
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
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
    apply(deltas: readonly BucketDelta[], onAlert?: (fire: AlertFire) => void): void {
      // 本批触达的表（内联执法只查触达表上的规则——未触达的窗口值未变不重评）
      const touched = new Set(deltas.map((d) => d.table));
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
          db.prepare('UPDATE alerts SET last_fired_at = ? WHERE id = ?').run(now, rule.id);
          onAlert({ rule: { ...rule, lastFiredAt: now }, value });
        }
      })();
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
