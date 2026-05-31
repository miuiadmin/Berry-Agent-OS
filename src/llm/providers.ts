import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LlmConfig } from './types.js';
import type { ModelTier } from '../contracts/model.js';
import { getProviderConfig, resolveModel } from './types.js';
import { normalizeBaseUrl } from '../providers/url-normalizer.js';

export class ModelNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`模型尚未配置。请在设置中添加 ${provider} 的 API 密钥，或在配置文件中设置 llm.providers.${provider}.apiKey。`);
    this.name = 'ModelNotConfiguredError';
  }
}

export function createProviderModel(config: LlmConfig, tier: ModelTier): LanguageModelV3 {
  const pc = getProviderConfig(config);
  const modelId = resolveModel(config, tier);

  if (!pc.apiKey || pc.apiKey.trim() === '') {
    throw new ModelNotConfiguredError(pc.provider);
  }

  switch (pc.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        baseURL: normalizeBaseUrl(pc.baseUrl, 'anthropic'),
        apiKey: pc.apiKey,
      });
      return anthropic(modelId);
    }

    case 'openai': {
      const openai = createOpenAI({
        baseURL: normalizeBaseUrl(pc.baseUrl, 'openai'),
        apiKey: pc.apiKey,
      });
      return openai.chat(modelId);
    }

    case 'openai-compatible': {
      const openaiCompat = createOpenAI({
        baseURL: normalizeBaseUrl(pc.baseUrl, 'openai-compatible'),
        apiKey: pc.apiKey,
        name: 'openai-compatible',
      });
      return openaiCompat.chat(modelId);
    }
  }
}
