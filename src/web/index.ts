/**
 * L3 web — 公开面（官方件 `builtin:web` 件聚落，2026-08-26 web 刀）。
 *
 * 对外词汇：件工厂（builtins 注册）+ 服务/结果类型（组合根与测试取用）。
 * 卫生件与抓取本体（hygiene/fetch-core/html）默认不直接对外——一切消费经
 * builtin:web 行装配的工具面/服务面。
 *
 * 卫生三件再导出（2026-08-31 第四十九批，契约篇 §6.10 冷读 M3 裁决——原
 * 「不直接对外」政策对官方兄弟件废止）：browser 件导航入口与 fetch 同一份
 * URL 安全线（assertPublicHost 私网判定 / isReservedAddress / requireHttpUrl
 * 协议白名单），单源再导出防两处分叉；消费面限定官方件（拓扑边执法），
 * 应用面消费仍走 ctx.fetch 服务。
 */

export { createWebApp, type WebAppOverrides } from './app.js';
export type { WebFetchOptions, WebFetchResult, WebService } from './types.js';
export { WEB_APP_CONFIG_SCHEMA } from './types.js';
// 卫生三件单源再导出（browser 件第三消费面——契约篇 §6.10）
export { assertPublicHost, isReservedAddress } from './hygiene.js';
export { requireHttpUrl } from './fetch-core.js';
