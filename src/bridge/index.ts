/**
 * bridge — 桥接模块出口（契约篇 §1.7，2026-08-26 第二十七批刀二；external
 * carrier 落码批扩 fork 腿——2026-08-29）。
 *
 * 五件：协议端点纯机制（BridgeEndpoint，两侧同构）/ 域内半入口
 * （worker.ts——svc 三方法 + 代理桩 ctx，worker 线程与 fork 进程两载体复用）
 * / 宿主半装配（spawnWorkerDomain + spawnExternalDomain 两 spawn + 六宿主
 * 处方共享 registerHostHandlers——「不换协议只换 carrier」）/ NDJSON 载体
 * 适配器（StdioBridgePort——fork 腿的传输半）。
 *
 * 心跳监督与 spawn 两时点编舞（boot+/reload）住组合根装配层（K3-c），不入
 * 本模块公开面。
 */
export { BridgeEndpoint } from './session.js';
export type { BridgePort, BridgeHandler, BridgeEndpointOptions } from './session.js';
export { startWorkerRealm } from './worker.js';
export { spawnWorkerDomain, makeRowLoader, workerEntryUrl, registerHostHandlers } from './bootstrap.js';
export type { WorkerDomain, WorkerDomainOptions, RowBinding, HostHandlersTarget } from './bootstrap.js';
export { spawnExternalDomain, externalEntryUrl } from './external-domain.js';
export type { ExternalDomain, ExternalDomainOptions } from './external-domain.js';
export { StdioBridgePort } from './port-stdio.js';
export type { StdioBridgePortOptions } from './port-stdio.js';
