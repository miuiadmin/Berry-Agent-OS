/**
 * bridge — 桥接模块出口（契约篇 §1.7，2026-08-26 第二十七批刀二）。
 *
 * 三件：协议端点纯机制（BridgeEndpoint，两侧同构）/ worker 半入口
 * （worker.ts——svc 三方法 + 代理桩 ctx）/ 宿主半装配（spawnWorkerDomain +
 * makeRowLoader——装载管线两半拆分的宿主侧）。
 *
 * 心跳监督与 spawn 两时点编舞（boot+/reload）住组合根装配层（K3-c），不入
 * 本模块公开面。
 */
export { BridgeEndpoint } from './session.js';
export type { BridgePort, BridgeHandler, BridgeEndpointOptions } from './session.js';
export { startWorkerRealm } from './worker.js';
export { spawnWorkerDomain, makeRowLoader } from './bootstrap.js';
export type { WorkerDomain, WorkerDomainOptions } from './bootstrap.js';
