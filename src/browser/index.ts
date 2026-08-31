/**
 * L3 browser — 公开面（官方件 `builtin:browser` 件聚落，契约篇 §6.10）。
 *
 * 对外词汇：件工厂（builtins 注册）+ 服务/引擎类型（组合根与测试取用）。
 * CDP 连接/会话层、发现序、引擎生命周期本体不直接对外——消费面经
 * builtin:browser 行装配的 ctx.browser 服务（刀二工具面同理）。
 */

export { createBrowserApp, type BrowserAppDeps, type BrowserService } from './app.js';
export {
  BrowserEngine,
  type BrowserEngineDeps,
  type EngineChild,
  type EngineRegistryLike,
  type SessionHandle,
} from './engine.js';
export {
  CdpConnection,
  fetchVersionInfo,
  openSessionContext,
  disposeSessionContext,
  type CdpConnectionFactory,
  type CdpRpc,
  type CdpVersionInfo,
} from './cdp.js';
export { discoverEngine } from './discover.js';
// 刀二新增面：a11y 渲染 / 捕获态 / 截图落盘 / 工具面注册
export {
  renderAccessibilitySnapshot,
  INTERACTIVE_ROLES,
  SNAPSHOT_MAX_BYTES,
  type A11yRef,
  type A11ySnapshot,
  type FlatDocNode,
} from './a11y.js';
export { ConsoleRing, SessionCapture, applyCaptureEvent, type ConsoleEntry, type SnapshotRefEntry } from './capture.js';
export { saveScreenshot, SCREENSHOTS_KEEP, type SavedScreenshot } from './screenshots.js';
export { registerBrowserTools, type BrowserToolsDeps } from './tools.js';
export {
  BROWSER_APP_CONFIG_SCHEMA,
  type BrowserAppConfig,
  type BrowserProviderConfig,
  type DiscoveredEngine,
  type EngineSource,
  type EngineStatus,
  type SessionBrowserState,
} from './types.js';
