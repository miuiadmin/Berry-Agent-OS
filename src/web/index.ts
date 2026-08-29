/**
 * L3 web — 公开面（官方件 `builtin:web` 件聚落，2026-08-26 web 刀）。
 *
 * 对外词汇：件工厂（builtins 注册）+ 服务/结果类型（组合根与测试取用）。
 * 卫生件与抓取本体（hygiene/fetch-core/html）不直接对外——一切消费经
 * builtin:web 行装配的工具面/服务面。
 */

export { createWebApp, type WebAppOverrides } from './app.js';
export type { WebFetchOptions, WebFetchResult, WebService } from './types.js';
export { WEB_APP_CONFIG_SCHEMA } from './types.js';
