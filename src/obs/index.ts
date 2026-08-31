/**
 * L3 obs — 公开面再导出（obs 官方件：契约篇 §6.9 观测面——聚合 rollup /
 * obs_query 查询 / /obs 命令族；刀二告警与刀三 OTLP 导出随批）。
 */
export { createObsApp } from './app.js';
export { createAggregator, HOST_BUCKET } from './rollup.js';
export type { Aggregator, BucketDelta, EventEnvelope, EnvelopeEvent, RollupTable } from './rollup.js';
export { openRollupStore, renderRollupTable } from './store.js';
export type { RollupQuery, RollupRow, RollupStore } from './store.js';
