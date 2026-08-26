/**
 * bridge — 桥接模块出口（契约篇 §1.7，2026-08-26 第二十七批刀二 K3-a）。
 *
 * 本模块 = 协议端点纯机制（BridgeEndpoint，两侧同构）。worker 生命周期与
 * 装载接线（spawn 两时点 / 心跳监督 terminate / 域死回卷 / bootstrap 两半）
 * 住组合根装配层，不入本模块公开面。
 */
export { BridgeEndpoint } from './session.js';
export type { BridgePort, BridgeHandler, BridgeEndpointOptions } from './session.js';
