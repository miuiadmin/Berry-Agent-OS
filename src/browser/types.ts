/**
 * L3 browser — 契约面（契约篇 §6.10 第四十九批第一刀）。
 *
 * 行 config（typebox schema 同构——与 mcp/lsp 行 config 同族）：
 * - `executablePath`：引擎显式覆盖（env APP_BROWSER_PATH 同族 env 位——fd/bash 先例）；
 * - `headless`：缺省 true（--headless=new）；本地调试可关；
 * - `cdpEndpoint`：attach 形态（连用户既有引擎不 spawn）——与 executablePath 互斥；
 * - `providers`：云端占位（browserbase/browseruse 各带 apiKey，明文自担位）。
 *
 * 引擎发现序/生命周期/会话层机制全录契约篇 §6.10——本文件只落类型与常量。
 */

import { Type } from '../contracts/typebox.js';

/**
 * 云端 provider 占位（契约篇 §6.10「云端 provider 占位」段）。
 * v1 只做凭证检测 + 优先级链数据面；执行面零接（真云接入挂账）。
 */
export interface BrowserProviderConfig {
  /** browserbase API key（明文自担位——obs 刀三 OTLP 同款注记；env 引用机制挂账） */
  readonly browserbase?: { readonly apiKey?: string };
  /** browseruse API key（优先级链首位——BrowserUse > Browserbase > local） */
  readonly browseruse?: { readonly apiKey?: string };
}

/** browser 行 config schema（typebox 同构——装载面校验用） */
export const BROWSER_APP_CONFIG_SCHEMA = Type.Object({
  /** 引擎显式覆盖（绝对路径；env APP_BROWSER_PATH 同义 env 位） */
  executablePath: Type.Optional(Type.String({ description: '浏览器引擎可执行文件绝对路径（缺省走发现序）' })),
  /** 无头模式（缺省 true——--headless=new；本地调试可观窗） */
  headless: Type.Optional(Type.Boolean()),
  /** attach 既有引擎的 CDP 端点（host:port 或 ws url——与 executablePath 互斥） */
  cdpEndpoint: Type.Optional(Type.String()),
  /** 云端 provider 占位（凭证检测 + 优先级链数据面；v1 执行面零接） */
  providers: Type.Optional(
    Type.Object({
      browserbase: Type.Optional(Type.Object({ apiKey: Type.Optional(Type.String()) })),
      browseruse: Type.Optional(Type.Object({ apiKey: Type.Optional(Type.String()) })),
    }),
  ),
});

/** browser 行 config 的 TS 类型（schema 推导） */
export type BrowserAppConfig = {
  executablePath?: string;
  headless?: boolean;
  cdpEndpoint?: string;
  providers?: BrowserProviderConfig;
};

/** 引擎来源档位（发现序四段——契约篇 §6.10 引擎发现序段） */
export type EngineSource = 'config' | 'system' | 'downloaded';

/** 发现序产物：可执行路径 + 来源档位 + 回退标注（首选缺席落到次选时非空） */
export interface DiscoveredEngine {
  readonly path: string;
  readonly source: EngineSource;
  /** 发现序回退标注（题库 025 的 fallback_warning 是运行期质量回退，彼挂账——此为发现序自述语义） */
  readonly fallbackWarning?: string;
}

/** 会话级浏览器态（context 路由键 = sessionId——契约篇 §6.10 会话隔离段） */
export interface SessionBrowserState {
  /** CDP BrowserContext id（cookies/storage/缓存隔离容器） */
  readonly browserContextId: string;
  /** attach 后的 flat sessionId（page 级命令路由键） */
  readonly sessionId: string;
  /** context 内唯一 page 的 targetId */
  readonly targetId: string;
}

/** 引擎运行态（诊断面——boot 通知/日志；不落 durable〔零新 durable 词汇〕） */
export type EngineStatus =
  | { readonly state: 'idle' } // 未起（首次浏览器工具调用才 spawn）
  | { readonly state: 'starting' } // spawn 后等 DevToolsActivePort/握手中
  | { readonly state: 'running'; readonly enginePath: string; readonly attach: boolean } // 活引擎（attach=true 为外接形态）
  | { readonly state: 'closed' }; // 已关停（闲置回收/effect 回卷后）
