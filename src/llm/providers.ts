import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { LlmConfig } from './types.js';
import type { ModelTier } from '../contracts/model.js';
import { getProviderConfig, resolveModel } from './types.js';

export function createProviderModel(config: LlmConfig, tier: ModelTier): LanguageModelV3 {
  const pc = getProviderConfig(config);
  const modelId = resolveModel(config, tier);

  switch (pc.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        baseURL: pc.baseUrl,
        apiKey: pc.apiKey,
      });
      return anthropic(modelId);
    }

    case 'openai': {
      const openai = createOpenAI({
        baseURL: pc.baseUrl,
        apiKey: pc.apiKey,
      });
      return openai.chat(modelId);
    }

    case 'openai-compatible': {
      const openaiCompat = createOpenAI({
        baseURL: pc.baseUrl,
        apiKey: pc.apiKey,
        name: 'openai-compatible',
      });
      return openaiCompat.chat(modelId);
    }
  }
}
