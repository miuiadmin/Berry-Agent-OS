import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRealTestConfig, summarizeRealTestConfig } from '../cli/real-test-profile.js';

describe('real test profile config', () => {
  const saved = {
    APP_TEST_LIVE_BASE_URL: process.env.APP_TEST_LIVE_BASE_URL,
    APP_TEST_LIVE_API_KEY: process.env.APP_TEST_LIVE_API_KEY,
    APP_TEST_LIVE_MODEL: process.env.APP_TEST_LIVE_MODEL,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('builtin profile 使用配置默认值，不读取 APP_TEST_LIVE 覆盖', () => {
    process.env.APP_TEST_LIVE_BASE_URL = 'https://override.example.com';
    process.env.APP_TEST_LIVE_API_KEY = 'sk-override';
    process.env.APP_TEST_LIVE_MODEL = 'override-model';

    const config = resolveRealTestConfig({
      profile: 'builtin',
      dataDir: join(tmpdir(), 'berry-real-builtin'),
    });

    expect(config.profile).toBe('builtin');
    expect(config.baseUrl).not.toBe('https://override.example.com');
    expect(config.model).not.toBe('override-model');
    expect(config.cleanupAppHome).toBe(false);
  });

  it('override profile 优先使用 CLI 参数，其次 APP_TEST_LIVE 环境变量', () => {
    process.env.APP_TEST_LIVE_BASE_URL = 'https://env.example.com';
    process.env.APP_TEST_LIVE_API_KEY = 'sk-env';
    process.env.APP_TEST_LIVE_MODEL = 'env-model';

    const config = resolveRealTestConfig({
      profile: 'override',
      baseUrl: 'https://cli.example.com',
      apiKey: 'sk-cli',
      dataDir: join(tmpdir(), 'berry-real-override'),
    });

    expect(config.baseUrl).toBe('https://cli.example.com');
    expect(config.apiKey).toBe('sk-cli');
    expect(config.model).toBe('env-model');
    expect(config.source.baseUrl).toBe('cli.baseUrl');
    expect(config.source.apiKey).toBe('cli.apiKey');
    expect(config.source.model).toBe('APP_TEST_LIVE_MODEL');
  });

  it('摘要输出会脱敏 API key', () => {
    const config = resolveRealTestConfig({
      profile: 'override',
      baseUrl: 'https://cli.example.com',
      apiKey: 'sk-cli-secret',
      model: 'cli-model',
    });

    const summary = summarizeRealTestConfig(config) as { llm: { apiKey: string } };

    expect(summary.llm.apiKey).toBe('[REDACTED]');
  });
});
