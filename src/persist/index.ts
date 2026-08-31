/**
 * L1 persist — SQLite 物理层模块出口。
 * 对外只暴露：Persistence 门面、Store/WriteBehind（供组合根组装与诊断）、schema 常量、
 * 统一迁移框架（MigrationSpec——业务模块自带 DDL 经此注册，会话篇 §6）。
 */

export { Persistence } from './persistence.js';
export type { PersistenceOptions } from './persistence.js';
export { openStore, Store } from './store.js';
export type { StoreOptions, SessionRow, SessionRegistration, RecentSessionRow } from './store.js';
export { spentBackgroundTokensSince, localDayStartMs, openTurnDepth } from './usage-account.js';
export { WriteBehind } from './write-behind.js';
export type { WriteBehindOptions } from './write-behind.js';
/** 原子写公共件（契约篇 §1.5.1(b)——overlay 写回等落盘面统一用，禁逐应用复刻） */
export { writeAtomicFile } from './atomic-write.js';
export { APPLICATION_ID, SCHEMA_VERSION, CANONICAL_DDL, SESSION_APP_COLUMN_MIGRATION } from './schema.js';
export { normalizeMigrations } from './migrations.js';
export type { MigrationSpec } from './migrations.js';
/** 连接类型再导出（better-sqlite3 归 persist 独占——业务模块经此取类型，不裸依赖） */
export type { DatabaseConnection } from './connection-type.js';
/** 第六键 berryagent/sqlite 注入物工厂（应用自管库——同实例 + 主库拒开，契约篇 §1.2 注记①） */
export { createAppSqliteFace, type AppSqliteFace } from './app-sqlite.js';
/**
 * WAL 连接编舞共享件（主库 openStore 与官方件自管库开库同源——#25 铁律；
 * 2026-09-01 复盘 T-2 抽取，obs rollup 开库消费）
 */
export { prepareWalConnection } from './app-sqlite.js';
