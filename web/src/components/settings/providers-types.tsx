/**
 * Provider 设置模块的共享类型、常量与小组件。
 *
 * 这些定义被 providers-tab 主组件、ChannelCard、ChannelFormDialog 共用，
 * 单独抽出以避免循环依赖，并让每个文件只关注自己的渲染职责。
 */

import { Zap, Brain, Crown, ChevronDown } from "lucide-react";

// ─── API 数据类型 ──────────────────────────────────────────────────

/** 单个模型条目（来自 provider catalog 或已配置 channel 的模型列表） */
export interface ModelEntry {
  /** 模型 ID（如 claude-opus-4-8） */
  id: string;
  /** 展示名 */
  name: string;
  /** 上下文窗口大小（token 数） */
  contextWindow: number;
  /** 默认最大输出 token 数 */
  defaultMaxTokens: number;
  /** 是否支持 thinking / 扩展思考 */
  supportsThinking: boolean;
  /** 是否支持附件上传 */
  supportsAttachments: boolean;
  /** 每百万输入 token 价格（美元） */
  inputPricePer1M?: number;
  /** 每百万输出 token 价格（美元） */
  outputPricePer1M?: number;
}

/** 已配置的 provider channel（一个渠道对应一组模型） */
export interface ProviderChannel {
  /** 渠道唯一 ID */
  id: string;
  /** 展示名 */
  name: string;
  /** provider 类型（anthropic / openai / openai-compatible / google-gemini …） */
  kind: string;
  /** 自定义 base URL（可选，用于兼容 OpenAI 协议的第三方） */
  baseUrl?: string;
  /** API Key（编辑时服务端会 mask，前端永远不回显真实值） */
  apiKey?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否已完成必要配置（如 API Key 已填） */
  configured: boolean;
  /** 模型数量 */
  modelCount: number;
  /** 该渠道下的模型列表 */
  models: ModelEntry[];
}

/** 单个 tier（fast/default/high）的目标指向 */
export interface TierTarget {
  /** 目标 channel ID */
  channel: string;
  /** 目标 model ID */
  model: string;
}

/** tier 映射表：三档模型档位 → 目标 channel+model */
export interface TierMapping {
  fast?: TierTarget;
  default?: TierTarget;
  high?: TierTarget;
}

// ─── API 响应封装 ──────────────────────────────────────────────────

export interface ChannelsResponse {
  ok: boolean;
  channels: ProviderChannel[];
}

export interface TiersResponse {
  ok: boolean;
  tiers: TierMapping;
}

export interface KindsResponse {
  ok: boolean;
  kinds: string[];
  supported?: string[];
}

export interface CatalogResponse {
  ok: boolean;
  kind: string;
  models: ModelEntry[];
}

// ─── 常量 ──────────────────────────────────────────────────────────

/** provider kind → i18n key 映射（用于把内部 kind 翻译成用户可读名称） */
export const PROVIDER_KIND_LABEL_KEYS: Record<string, string> = {
  anthropic: "providers.anthropic",
  openai: "providers.openai",
  "openai-compatible": "providers.openaiCompatible",
  "google-gemini": "providers.googleGemini",
  "azure-openai": "providers.azureOpenai",
  bedrock: "providers.awsBedrock",
};

/** 三档 tier 的展示配置：图标 + 标签 i18n key + 语义色 */
export const TIER_CONFIG = [
  { key: "fast" as const, labelKey: "providers.tierFast", icon: Zap, color: "text-success" },
  { key: "default" as const, labelKey: "providers.tierDefault", icon: Brain, color: "text-info" },
  { key: "high" as const, labelKey: "providers.tierHigh", icon: Crown, color: "text-warning" },
];

/**
 * 原生 <select> 的统一样式（已废弃，请使用 ui/select-field 组件）。
 * @deprecated 使用 {@link SelectField} 代替
 */
export const SELECT_BASE =
  "w-full rounded-lg border border-input bg-background px-3 py-2 md:py-1.5 text-[16px] md:text-sm min-h-[44px] md:min-h-0 appearance-none pr-8 disabled:opacity-50 transition-all focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30";

/**
 * 原生 <select> 右侧箭头（已废弃，请使用 ui/select-field 组件）。
 * @deprecated 使用 {@link SelectField} 代替
 */
export function SelectChevron() {
  return (
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
  );
}
