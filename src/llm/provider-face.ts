/**
 * L1 llm — 第五键 `berryagent/llm` 注入物（契约篇 §1.2 注记①，2026-08-26 挖矿批 P0-2）。
 *
 * provider 插件的正路（四包移植挖矿实证：三家 provider 类插件全在自拼传输层
 * 绕过宿主）：pi-ai 的 provider 工厂族经虚拟面背书导出——插件用**宿主同版本**
 * 的 createProvider / api 工厂造 provider，再经 ctx.llm.registerProvider 入册，
 * 不自捆 pi-ai（双实例 = 传输层行为分叉的温床）、不自拼 fetch。
 *
 * 拓扑护栏：本面对象由组合根经参数注入加载器（context 模块）——context 不
 * import llm，模块 DAG 不变。
 */

import { createProvider, hasApi, lazyApi } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

/**
 * 第五键注入物：pi-ai provider 工厂族再导出对象。
 *
 * - createProvider / hasApi（models.ts 出口）：造 provider 实例 + Model 的 api
 *   收窄守卫——插件 registerProvider 路径的两件套；
 * - lazyApi（api/lazy.ts 出口）：动态 api 模块包装器（首调用才加载）；
 * - anthropicMessagesApi（Anthropic-first 直取便捷键）：其余 provider 的 lazy
 *   工厂（openai/google/...共 10 家）经 pi-ai 子路径 `@earendil-works/pi-ai/api/<name>.lazy`
 *   可达——插件应优先走 createProvider 全链而非裸拿 api 流；确需扩展时按需
 *   增键（单键解决一个 provider 的诉求，成批抄全 = 面无纪律）。
 */
export const providerApiFace = {
  createProvider,
  hasApi,
  lazyApi,
  anthropicMessagesApi,
} as const;
