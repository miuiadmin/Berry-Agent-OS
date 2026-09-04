/**
 * L0 contracts — 跨模块公共契约（零依赖层，拓扑检查强制：不得 import 任何其他模块；三方包仅 typebox 再导出面）。
 * 词汇纪律见内核篇 §5：新词先进词汇表再用，禁止双词汇漂移。
 * 本导出面同时是应用虚拟模块 `berryagent` 的运行时面（契约篇 §1.2——加载器注入）。
 */

export * from './errors.js';
/**
 * api.ts 分桶收面（契约篇 §6.13.4 公开根分桶——API 治理进化刀 A，2026-09-04）：
 * api.ts 顶层导出分两桶，本处只转出**可见桶**十四名（十型 + 两目录 + 两纯函数
 * ——应用作者可消费面）；internal 机制桶七符号（VIRTUAL_API_KEYS /
 * SERVICE_CATALOG / API_ENFORCEMENT_IGNITED / adjudicateApiGate /
 * assertExperimentalDeclared / requireCapabilities / materializeHostFace）不进
 * 公开根——它们是宿主治理机制非应用 API，内核消费全深导 contracts/api.js。
 * 本桶面即应用虚拟模块 `berryagent` 的运行时面（§1.2——loader 注入物），分桶 =
 * 真实运行时收面（星出时代机制符号实测标 stable 进面——内部重构将判伪 MAJOR）。
 * 分桶不变式由抽取器 assertApiBucketPartition fail-loud 执法：api.ts 新顶层
 * 导出未分桶即炸（白名单单点 tools/extract-api-surface.mjs INTERNAL_API_EXPORTS）。
 * 类型十名走 export type（verbatimModuleSyntax 纪律——值面只含两目录两函数）。
 */
export type {
  ApiTier,
  FormFactor,
  VirtualApiKeyEntry,
  ServiceCatalogEntry,
  DescriptorKeyEntry,
  CapabilityEntry,
  ApiBlock,
  ApiGateResult,
  HostFace,
  HostFaceData,
} from './api.js';
export { DATA_DESCRIPTOR_API_KEYS, CAPABILITIES, compareApiVersions, isValidApiVersion } from './api.js';
export * from './events.js';
export * from './llm.js';
export * from './messages.js';
export * from './session-events.js';
export * from './tools.js';
export * from './app.js';
export * from './typebox.js';
export * from './jobs.js';
export * from './subagent.js';
export * from './exec.js';
export * from './skills.js';
export * from './channels.js';
