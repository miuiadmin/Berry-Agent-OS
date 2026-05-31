/**
 * ConfigService 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService, createDefaultRegistry } from './index.js';
import { resolveEnvOverrides } from './env-resolver.js';
import type { AppConfig } from './types.js';
import { setAppHome } from '../utils/paths.js';

let testDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  testDir = join(tmpdir(), `config-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  savedHome = process.env.SERVICE_HOME;
  process.env.SERVICE_HOME = testDir;
  setAppHome(testDir);
});

afterEach(() => {
  if (savedHome) process.env.SERVICE_HOME = savedHome;
  else delete process.env.SERVICE_HOME;
  setAppHome(savedHome ?? join(tmpdir(), 'config-test-reset'));
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Schema Registry ────────────────────────────────────────────

describe('ConfigSchemaRegistry', () => {
  it('creates default registry with all known keys', () => {
    const registry = createDefaultRegistry();
    const keys = registry.getKnownKeys();
    expect(keys.has('llm')).toBe(true);
    expect(keys.has('web')).toBe(true);
    expect(keys.has('memory')).toBe(true);
    expect(keys.has('cron')).toBe(true);
    expect(keys.has('mcp')).toBe(true);
    expect(keys.has('observability')).toBe(true);
    expect(keys.has('budget')).toBe(true);
    expect(keys.has('daemon')).toBe(true);
    expect(keys.has('autonomy')).toBe(true);
  });

  it('builds a valid schema that parses empty input with defaults', () => {
    const registry = createDefaultRegistry();
    const schema = registry.buildSchema();
    const result = schema.parse({});
    expect(result.llm).toBeDefined();
    expect(result.web).toBeDefined();
    expect(result.web.port).toBe(3888);
    expect(result.observability.level).toBe('info');
  });
});

// ─── Env Resolver ───────────────────────────────────────────────

describe('resolveEnvOverrides', () => {
  it('returns file data unchanged when no env vars set', () => {
    const file = { web: { port: 4000 }, llm: { model: 'test' } };
    const result = resolveEnvOverrides(file, {});
    expect(result).toEqual(file);
  });

  it('overrides web port from APP_PORT', () => {
    const result = resolveEnvOverrides(
      { web: { port: 4000 } },
      { APP_PORT: '9999' },
    );
    expect((result.web as Record<string, unknown>).port).toBe(9999);
  });

  it('overrides LLM model from LLM_MODEL', () => {
    const result = resolveEnvOverrides(
      { llm: { model: 'old-model' } },
      { LLM_MODEL: 'new-model' },
    );
    expect((result.llm as Record<string, unknown>).model).toBe('new-model');
  });

  it('sets LLM provider-specific keys when LLM vars not set', () => {
    const result = resolveEnvOverrides(
      {},
      { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://custom.api' },
    );
    const llm = result.llm as Record<string, unknown>;
    const providers = llm.providers as Record<string, Record<string, unknown>>;
    expect(providers.anthropic.apiKey).toBe('sk-test');
    expect(providers.anthropic.baseUrl).toBe('https://custom.api');
  });

  it('LLM_* takes precedence over provider-specific vars', () => {
    const result = resolveEnvOverrides(
      {},
      { LLM_API_KEY: 'llm-key', ANTHROPIC_API_KEY: 'anthropic-key' },
    );
    const llm = result.llm as Record<string, unknown>;
    // LLM_API_KEY sets top-level, ANTHROPIC_API_KEY should NOT set provider-level
    expect(llm.apiKey).toBe('llm-key');
    const providers = llm.providers as Record<string, Record<string, unknown>>;
    expect(providers.anthropic.apiKey).toBeUndefined();
  });
});

// ─── ConfigService ──────────────────────────────────────────────

describe('ConfigService', () => {
  it('loads with defaults when no config file exists', () => {
    const svc = new ConfigService();
    const config = svc.get();
    expect(config.web.port).toBe(3888);
    expect(config.observability.level).toBe('info');
    expect(config.permissionMode).toBe('allow-all');
  });

  it('loads and parses a YAML config file', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: debug
web:
  port: 8080
`, 'utf-8');

    const svc = new ConfigService();
    expect(svc.getSection('observability').level).toBe('debug');
    expect(svc.getSection('web').port).toBe(8080);
  });

  it('returns config path and app home', () => {
    const svc = new ConfigService();
    expect(svc.getAppHome()).toBe(testDir);
    expect(svc.getConfigPath()).toBe(join(testDir, 'config.yaml'));
  });

  it('updateSection writes to config.yaml', () => {
    const svc = new ConfigService();
    const result = svc.updateSection({ web: { port: 9999, host: '0.0.0.0', enabled: true, secret: '' } });
    expect(result.ok).toBe(true);

    // Verify file was written
    const svc2 = new ConfigService();
    expect(svc2.getSection('web').port).toBe(9999);
  });

  it('updateSection rejects unknown keys', () => {
    const svc = new ConfigService();
    const result = svc.updateSection({ unknownKey: 'bad' } as unknown as Partial<AppConfig>);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No valid config keys');
  });

  it('onChange fires on reload', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: info
`, 'utf-8');

    const svc = new ConfigService();
    const events: ConfigChangeEvent[] = [];
    svc.onChange(e => events.push(e));

    // Write new config
    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: debug
`, 'utf-8');

    svc.reload();

    expect(events.length).toBe(1);
    expect(events[0].changedKeys).toContain('observability');
    expect(events[0].config.observability.level).toBe('debug');
  });

  it('dispose stops watcher and clears listeners', () => {
    const svc = new ConfigService();
    let called = false;
    svc.onChange(() => { called = true; });
    svc.dispose();
    // After dispose, reload should not notify
    svc.reload();
    expect(called).toBe(false);
  });

  it('applies env overrides on load', () => {
    const svc = new ConfigService(
      createDefaultRegistry(),
      { ...process.env, APP_PORT: '7777' },
    );
    expect(svc.getSection('web').port).toBe(7777);
  });
});
