/**
 * L1 persist — SQLite 物理层模块出口。
 * 对外只暴露：Persistence 门面、Store/WriteBehind（供组合根组装与诊断）、schema 常量。
 */

export { Persistence } from './persistence.js';
export type { PersistenceOptions } from './persistence.js';
export { openStore, Store } from './store.js';
export type { StoreOptions, SessionRow, SessionRegistration } from './store.js';
export { WriteBehind } from './write-behind.js';
export type { WriteBehindOptions } from './write-behind.js';
/** 原子写公共件（契约篇 §1.5.1(b)——overlay 写回等落盘面统一用，禁逐插件复刻） */
export { writeAtomicFile } from './atomic-write.js';
export { APPLICATION_ID, SCHEMA_VERSION, CANONICAL_DDL } from './schema.js';
