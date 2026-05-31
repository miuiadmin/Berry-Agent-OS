import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmConfig } from './types.js';
import { LlmConfigSchema } from './types.js';
import { resolveModel, getProviderConfig, detectThinkingCapability, buildThinkingBody } from './types.js';

vi.mock('@ai-sdk/anthropic', () => {
  const mockModel = { modelId: 'mock-anthropic', provider: 'anthropic' };
  const factory = vi.fn(() => mockModel);
  return { createAnthropic: vi.fn(() => factory) };
});

vi.mock('@ai-sdk/openai', () => {
  const mockModel = { modelId: 'mock-openai', provider: 'openai' };
  const chatFn = vi.fn(() => mockModel);
  return { createOpenAI: vi.fn(() => ({ chat: chatFn })) };
});

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return LlmConfigSchema.parse(overrides);
}

describe('createProviderModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates Anthropic provider with correct options', async () => {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { createProviderModel } = await import('./providers.js');

    const config = makeConfig({
      provider: 'anthropic',
      apiKey: 'sk-test-key',
      baseUrl: 'https://custom.api.com',
    });

    createProviderModel(config, 'default');

    expect(createAnthropic).toHaveBeenCalledWith({
      baseURL: 'https://custom.api.com/v1',
      apiKey: 'sk-test-key',
    });
  });

  it('creates OpenAI provider with correct options', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { createProviderModel } = await import('./providers.js');

    const config = makeConfig({
      provider: 'openai',
      providers: {
        anthropic: {},
        openai: { apiKey: 'openai-key', baseUrl: 'https://openai.custom.com' },
        'openai-compatible': {},
      },
    });

    createProviderModel(config, 'default');

    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://openai.custom.com/v1',
      apiKey: 'openai-key',
    });
  });

  it('creates openai-compatible provider with name field', async () => {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { createProviderModel } = await import('./providers.js');

    const config = makeConfig({
      provider: 'openai-compatible',
      providers: {
        anthropic: {},
        openai: {},
        'openai-compatible': { apiKey: 'ds-key', baseUrl: 'https://api.deepseek.com' },
      },
    });

    createProviderModel(config, 'default');

    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'ds-key',
      name: 'openai-compatible',
    });
  });
});

describe('resolveModel', () => {
  it('uses tier-specific model from config', () => {
    const config = makeConfig({
      provider: 'anthropic',
      models: { fast: 'claude-haiku-custom' },
    });
    expect(resolveModel(config, 'fast')).toBe('claude-haiku-custom');
  });

  it('falls back to defaultModel when tier not specified', () => {
    const config = makeConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20250514',
    });
    expect(resolveModel(config, 'fast')).toBe('claude-sonnet-4-6-20250514');
  });

  it('falls back to built-in defaults', () => {
    const config = makeConfig({ provider: 'anthropic' });
    expect(resolveModel(config, 'fast')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModel(config, 'default')).toBe('claude-sonnet-4-6-20250514');
    expect(resolveModel(config, 'high')).toBe('claude-opus-4-6-20250514');
  });

  it('resolves openai defaults', () => {
    const config = makeConfig({ provider: 'openai' });
    expect(resolveModel(config, 'fast')).toBe('gpt-4o-mini');
    expect(resolveModel(config, 'default')).toBe('gpt-4o');
    expect(resolveModel(config, 'high')).toBe('gpt-4.1');
  });

  it('resolves openai-compatible defaults', () => {
    const config = makeConfig({ provider: 'openai-compatible' });
    expect(resolveModel(config, 'fast')).toBe('deepseek-chat');
    expect(resolveModel(config, 'high')).toBe('deepseek-reasoner');
  });

  it('provider-specific models override legacy models', () => {
    const config = makeConfig({
      provider: 'anthropic',
      models: { fast: 'legacy-fast' },
      providers: {
        anthropic: { models: { fast: 'provider-fast' } },
        openai: {},
        'openai-compatible': {},
      },
    });
    expect(resolveModel(config, 'fast')).toBe('provider-fast');
  });
});

describe('getProviderConfig', () => {
  it('merges legacy fields into provider config', () => {
    const config = makeConfig({
      provider: 'anthropic',
      baseUrl: 'https://legacy.url',
      apiKey: 'legacy-key',
      model: 'legacy-model',
    });
    const pc = getProviderConfig(config);
    expect(pc.provider).toBe('anthropic');
    expect(pc.baseUrl).toBe('https://legacy.url');
    expect(pc.apiKey).toBe('legacy-key');
    expect(pc.defaultModel).toBe('legacy-model');
  });

  it('provider-specific apiKey overrides legacy', () => {
    const config = makeConfig({
      provider: 'anthropic',
      apiKey: 'legacy-key',
      providers: {
        anthropic: { apiKey: 'specific-key' },
        openai: {},
        'openai-compatible': {},
      },
    });
    const pc = getProviderConfig(config);
    expect(pc.apiKey).toBe('specific-key');
  });

  it('does not leak anthropic baseUrl to openai provider', () => {
    const config = makeConfig({
      provider: 'openai',
      baseUrl: 'https://anthropic-proxy.url',
    });
    const pc = getProviderConfig(config);
    expect(pc.baseUrl).toBeUndefined();
  });
});

describe('detectThinkingCapability', () => {
  it('detects Claude Opus 4.7 as adaptive-only', () => {
    const cap = detectThinkingCapability('claude-opus-4-7-20260101');
    expect(cap.mode).toBe('adaptive-only');
    expect(cap.disableStrategy).toBe('explicit-disabled');
  });

  it('detects Claude Sonnet 4.6 as adaptive-preferred', () => {
    const cap = detectThinkingCapability('claude-sonnet-4-6-20250514');
    expect(cap.mode).toBe('adaptive-preferred');
    expect(cap.disableStrategy).toBe('explicit-disabled');
  });

  it('detects DeepSeek reasoner as manual-only', () => {
    const cap = detectThinkingCapability('deepseek-reasoner');
    expect(cap.mode).toBe('manual-only');
    expect(cap.disableStrategy).toBe('explicit-disabled');
  });

  it('detects DeepSeek v4 as effort-based-max', () => {
    const cap = detectThinkingCapability('deepseek-v4-chat');
    expect(cap.mode).toBe('effort-based-max');
  });

  it('detects GPT models as no thinking', () => {
    const cap = detectThinkingCapability('gpt-4o');
    expect(cap.mode).toBe('none');
    expect(cap.disableStrategy).toBe('omit-field');
  });

  it('unknown models default to none', () => {
    const cap = detectThinkingCapability('some-custom-model');
    expect(cap.mode).toBe('none');
  });
});

describe('buildThinkingBody', () => {
  it('returns adaptive config for adaptive-preferred when enabled', () => {
    const body = buildThinkingBody({ mode: 'adaptive-preferred', disableStrategy: 'explicit-disabled' }, true);
    expect(body).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('returns disabled for explicit-disabled strategy when not enabled', () => {
    const body = buildThinkingBody({ mode: 'adaptive-preferred', disableStrategy: 'explicit-disabled' }, false);
    expect(body).toEqual({ type: 'disabled' });
  });

  it('returns undefined for omit-field strategy when not enabled', () => {
    const body = buildThinkingBody({ mode: 'none', disableStrategy: 'omit-field' }, false);
    expect(body).toBeUndefined();
  });

  it('returns enabled with budget for manual-only', () => {
    const body = buildThinkingBody({ mode: 'manual-only', disableStrategy: 'explicit-disabled' }, true);
    expect(body).toEqual({ type: 'enabled', budget_tokens: 16384 });
  });

  it('returns undefined for none mode even when enabled', () => {
    const body = buildThinkingBody({ mode: 'none', disableStrategy: 'omit-field' }, true);
    expect(body).toBeUndefined();
  });
});
