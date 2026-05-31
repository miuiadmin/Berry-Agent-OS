import { describe, it, expect } from 'vitest';
import type { LlmConfig } from '../llm/types.js';
import type { ModelTier } from '../contracts/model.js';
import type { ProviderChannel, TierMapping } from './types.js';
import { migrateLegacyConfig } from './migration.js';
import { buildResolverState, resolveTier, resolveChannelModel } from './resolver.js';
import { getBuiltinCatalog, resolveChannelModels } from './catalogs/index.js';
import { ChannelsConfigSchema } from './schemas.js';
import { normalizeBaseUrl } from './url-normalizer.js';

// ─── Helper: minimal LlmConfig ────────────────────────────────────

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: 'anthropic',
    providers: {
      anthropic: { apiKey: 'sk-ant-test', models: {} },
      openai: { apiKey: '', models: {} },
      'openai-compatible': { apiKey: '', models: {} },
    },
    channelsConfig: { channels: [], tiers: {} },
    baseUrl: '',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-6-20250514',
    models: {},
    mode: 'live',
    maxConcurrentRequests: 10,
    ...overrides,
  };
}

// ─── Catalog Tests ────────────────────────────────────────────────

describe('Built-in Catalogs', () => {
  it('returns models for anthropic', () => {
    const models = getBuiltinCatalog('anthropic');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id.includes('claude'))).toBe(true);
  });

  it('returns models for openai', () => {
    const models = getBuiltinCatalog('openai');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id.includes('gpt'))).toBe(true);
  });

  it('returns empty for unknown kind', () => {
    const models = getBuiltinCatalog('unknown-provider' as any);
    expect(models).toEqual([]);
  });

  it('each model has required fields', () => {
    for (const kind of ['anthropic', 'openai', 'openai-compatible', 'google-gemini'] as const) {
      const models = getBuiltinCatalog(kind);
      for (const m of models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.defaultMaxTokens).toBeGreaterThan(0);
        expect(typeof m.supportsThinking).toBe('boolean');
        expect(typeof m.supportsAttachments).toBe('boolean');
      }
    }
  });
});

describe('resolveChannelModels', () => {
  it('returns builtins when no user models', () => {
    const resolved = resolveChannelModels('anthropic');
    const builtins = getBuiltinCatalog('anthropic');
    expect(resolved).toEqual(builtins);
  });

  it('returns only user models when user defines models (no catalog merge)', () => {
    const userModels = [
      { id: 'mimo-v2-pro', name: 'MiMo v2 Pro', contextWindow: 128000, defaultMaxTokens: 4096, supportsThinking: false, supportsAttachments: false },
    ];
    const resolved = resolveChannelModels('anthropic', userModels);
    // Should ONLY contain user models, NOT built-in Anthropic catalog
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('mimo-v2-pro');
  });

  it('user models are returned as-is without builtin pollution', () => {
    const userModels = [
      { id: 'claude-haiku-4-5-20251001', name: 'My Haiku Override', contextWindow: 999999, defaultMaxTokens: 9999, supportsThinking: true, supportsAttachments: false },
      { id: 'my-custom-model', name: 'Custom', contextWindow: 32768, defaultMaxTokens: 2048, supportsThinking: false, supportsAttachments: false },
    ];
    const resolved = resolveChannelModels('anthropic', userModels);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].id).toBe('claude-haiku-4-5-20251001');
    expect(resolved[0].name).toBe('My Haiku Override');
    expect(resolved[1].id).toBe('my-custom-model');
  });
});

// ─── Migration Tests ──────────────────────────────────────────────

describe('Legacy Config Migration', () => {
  it('creates a channel from active provider', () => {
    const config = makeConfig();
    const result = migrateLegacyConfig(config);
    expect(result.channels.length).toBeGreaterThanOrEqual(1);
    expect(result.channels[0].id).toBe('anthropic-default');
    expect(result.channels[0].kind).toBe('anthropic');
    expect(result.channels[0].apiKey).toBe('sk-ant-test');
  });

  it('derives tier targets from legacy config', () => {
    const config = makeConfig({
      models: { fast: 'claude-haiku-4-5-20251001', default: 'claude-sonnet-4-6-20250514', high: 'claude-opus-4-6-20250514' },
    });
    const result = migrateLegacyConfig(config);
    expect(result.tiers.fast?.model).toBe('claude-haiku-4-5-20251001');
    expect(result.tiers.default?.model).toBe('claude-sonnet-4-6-20250514');
    expect(result.tiers.high?.model).toBe('claude-opus-4-6-20250514');
    expect(result.tiers.fast?.channel).toBe('anthropic-default');
  });

  it('creates channels for other providers with credentials', () => {
    const config = makeConfig({
      providers: {
        anthropic: { apiKey: 'sk-ant-test', models: {} },
        openai: { apiKey: 'sk-oai-test', models: {} },
        'openai-compatible': { apiKey: '', models: {} },
      },
    });
    const result = migrateLegacyConfig(config);
    const ids = result.channels.map(c => c.id);
    expect(ids).toContain('anthropic-default');
    expect(ids).toContain('openai-default');
    // openai-compatible has no apiKey, should not be included
    expect(ids).not.toContain('openai-compatible-default');
  });

  it('does not create channels for providers with whitespace-only credentials', () => {
    const config = makeConfig({
      provider: 'openai-compatible',
      providers: {
        anthropic: { apiKey: '   ', baseUrl: '  ', models: {} },
        openai: { apiKey: '', baseUrl: '   ', models: {} },
        'openai-compatible': { apiKey: 'sk-mimo-test', baseUrl: 'https://mimo.api', models: {} },
      },
    });
    const result = migrateLegacyConfig(config);
    const ids = result.channels.map(c => c.id);
    // Only the active provider should have a channel
    expect(ids).toEqual(['openai-compatible-default']);
    // Whitespace-only credentials should not create channels
    expect(ids).not.toContain('anthropic-default');
    expect(ids).not.toContain('openai-default');
  });
});

// ─── Resolver Tests ───────────────────────────────────────────────

describe('Tier Resolution', () => {
  it('resolves via new tier mapping', () => {
    const config = makeConfig();
    const channels: ProviderChannel[] = [
      {
        id: 'test-anthropic',
        name: 'Test Anthropic',
        kind: 'anthropic',
        apiKey: 'sk-test',
        enabled: true,
      },
    ];
    const tiers: TierMapping = {
      fast: { channel: 'test-anthropic', model: 'claude-haiku-4-5-20251001' },
      default: { channel: 'test-anthropic', model: 'claude-sonnet-4-6-20250514' },
      high: { channel: 'test-anthropic', model: 'claude-opus-4-6-20250514' },
    };

    const state = buildResolverState(config, { channels, tiers });
    const resolved = resolveTier(state, 'default');
    expect(resolved.channel.id).toBe('test-anthropic');
    expect(resolved.model.id).toBe('claude-sonnet-4-6-20250514');
    expect(resolved.providerKind).toBe('anthropic');
  });

  it('returns empty state when no channels configured', () => {
    const config = makeConfig();
    const state = buildResolverState(config, null);
    expect(state.channels.size).toBe(0);
    expect(state.tiers).toEqual({});
  });

  it('throws on tier resolution with no channels', () => {
    const config = makeConfig({ apiKey: '', model: '' });
    const state = buildResolverState(config, null);
    expect(() => resolveTier(state, 'fast')).toThrow();
  });

  it('resolves cross-channel tiers', () => {
    const config = makeConfig();
    const channels: ProviderChannel[] = [
      { id: 'anth', name: 'Anth', kind: 'anthropic', apiKey: 'sk-1', enabled: true },
      { id: 'oai', name: 'OpenAI', kind: 'openai', apiKey: 'sk-2', enabled: true },
    ];
    const tiers: TierMapping = {
      fast: { channel: 'anth', model: 'claude-haiku-4-5-20251001' },
      default: { channel: 'oai', model: 'gpt-4o' },
      high: { channel: 'oai', model: 'gpt-4.1' },
    };

    const state = buildResolverState(config, { channels, tiers });
    const fast = resolveTier(state, 'fast');
    expect(fast.providerKind).toBe('anthropic');
    expect(fast.model.id).toBe('claude-haiku-4-5-20251001');

    const high = resolveTier(state, 'high');
    expect(high.providerKind).toBe('openai');
    expect(high.model.id).toBe('gpt-4.1');
  });

  it('resolves custom user models', () => {
    const config = makeConfig();
    const channels: ProviderChannel[] = [
      {
        id: 'local',
        name: 'Local LLM',
        kind: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'ollama',
        enabled: true,
        models: [
          { id: 'llama3:70b', name: 'Llama 3 70B', contextWindow: 8192, defaultMaxTokens: 4096, supportsThinking: false, supportsAttachments: false },
        ],
      },
    ];
    const tiers: TierMapping = {
      default: { channel: 'local', model: 'llama3:70b' },
    };

    const state = buildResolverState(config, { channels, tiers });
    const resolved = resolveTier(state, 'default');
    expect(resolved.model.id).toBe('llama3:70b');
    expect(resolved.model.contextWindow).toBe(8192);
    expect(resolved.providerKind).toBe('openai-compatible');
  });
});

describe('resolveChannelModel', () => {
  it('resolves a specific channel + model', () => {
    const config = makeConfig();
    const channels: ProviderChannel[] = [
      { id: 'test', name: 'Test', kind: 'openai', apiKey: 'sk-test', enabled: true },
    ];
    const state = buildResolverState(config, { channels, tiers: {} });
    const resolved = resolveChannelModel(state, 'test', 'gpt-4o');
    expect(resolved.model.id).toBe('gpt-4o');
    expect(resolved.providerKind).toBe('openai');
  });

  it('throws for unknown channel', () => {
    const config = makeConfig();
    const state = buildResolverState(config, null);
    expect(() => resolveChannelModel(state, 'nonexistent', 'gpt-4o')).toThrow(/not found/i);
  });
});

// ─── Schema Tests ─────────────────────────────────────────────────

describe('ChannelsConfigSchema', () => {
  it('parses empty config', () => {
    const result = ChannelsConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channels).toEqual([]);
      expect(result.data.tiers).toEqual({});
    }
  });

  it('parses full config', () => {
    const input = {
      channels: [
        {
          id: 'test',
          name: 'Test Channel',
          kind: 'anthropic',
          apiKey: 'sk-test',
          enabled: true,
          models: [
            { id: 'claude-test', name: 'Claude Test', contextWindow: 200000, defaultMaxTokens: 8192 },
          ],
        },
      ],
      tiers: {
        fast: { channel: 'test', model: 'claude-test' },
      },
    };
    const result = ChannelsConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channels).toHaveLength(1);
      expect(result.data.channels[0].kind).toBe('anthropic');
      expect(result.data.tiers.fast?.model).toBe('claude-test');
    }
  });

  it('applies defaults for optional fields', () => {
    const input = {
      channels: [
        { id: 'minimal', name: 'Min', kind: 'openai' },
      ],
    };
    const result = ChannelsConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const ch = result.data.channels[0];
      expect(ch.enabled).toBe(true);
      expect(ch.apiKey).toBe('');
      expect(ch.models).toEqual([]);
    }
  });
});

// ─── normalizeBaseUrl ─────────────────────────────────────────────

describe('normalizeBaseUrl', () => {
  it('appends /v1 for anthropic when missing', () => {
    expect(normalizeBaseUrl('https://proxy/anthropic', 'anthropic'))
      .toBe('https://proxy/anthropic/v1');
  });

  it('appends /v1 for openai when missing', () => {
    expect(normalizeBaseUrl('https://proxy/openai', 'openai'))
      .toBe('https://proxy/openai/v1');
  });

  it('appends /v1 for openai-compatible when missing', () => {
    expect(normalizeBaseUrl('https://proxy/api', 'openai-compatible'))
      .toBe('https://proxy/api/v1');
  });

  it('does not double-append when /v1 already present', () => {
    expect(normalizeBaseUrl('https://proxy/anthropic/v1', 'anthropic'))
      .toBe('https://proxy/anthropic/v1');
  });

  it('preserves /v2 or other version paths', () => {
    expect(normalizeBaseUrl('https://proxy/api/v2', 'openai'))
      .toBe('https://proxy/api/v2');
  });

  it('strips trailing slashes before normalizing', () => {
    expect(normalizeBaseUrl('https://proxy/anthropic/', 'anthropic'))
      .toBe('https://proxy/anthropic/v1');
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeBaseUrl(undefined, 'anthropic')).toBeUndefined();
  });

  it('returns undefined for empty string input', () => {
    expect(normalizeBaseUrl('', 'anthropic')).toBeUndefined();
  });
});
