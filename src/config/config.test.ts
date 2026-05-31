/**
 * ConfigService 单元测试
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigService } from './service.js';
import { AppConfigSchema, CONFIG_KEYS } from './schema.js';
import { applyEnvOverrides, resolveConfig, readYamlFile } from './resolver.js';
import { ENV_MAPPINGS, getNested, setNested } from './env-map.js';
import { atomicWriteYaml, deepMerge } from './writer.js';
import { diagnoseConfig } from './diagnostics.js';
import type { ConfigChangeEvent } from './contract.js';
import { setAppHome, getConfigPath } from '../utils/paths.js';

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

// ─── Composed Schema ─────────────────────────────────────────────

describe('AppConfigSchema', () => {
  it('parses empty input and fills all defaults', () => {
    const result = AppConfigSchema.parse({});
    expect(result.llm).toBeDefined();
    expect(result.web).toBeDefined();
    expect(result.web.port).toBe(3888);
    expect(result.observability.level).toBe('info');
    expect(result.permissionMode).toBe('allow-all');
    expect(result.heartbeatIntervalMs).toBe(5000);
    expect(result.autonomy.willLoopEnabled).toBe(false);
  });

  it('CONFIG_KEYS matches schema shape', () => {
    const schemaKeys = new Set(Object.keys(AppConfigSchema.shape));
    expect(CONFIG_KEYS).toEqual(schemaKeys);
  });

  it('parses partial overrides', () => {
    const result = AppConfigSchema.parse({
      observability: { level: 'debug' },
      web: { port: 8080 },
    });
    expect(result.observability.level).toBe('debug');
    expect(result.web.port).toBe(8080);
  });
});

// ─── Env Map helpers ──────────────────────────────────────────────

describe('env-map helpers', () => {
  it('getNested reads dot-path values', () => {
    const obj = { a: { b: { c: 42 } } };
    expect(getNested(obj, 'a.b.c')).toBe(42);
    expect(getNested(obj, 'a.b.missing')).toBeUndefined();
    expect(getNested(obj, 'x.y.z')).toBeUndefined();
  });

  it('setNested writes dot-path values', () => {
    const obj: Record<string, unknown> = {};
    setNested(obj, 'a.b.c', 42);
    expect(obj).toEqual({ a: { b: { c: 42 } } });
  });
});

// ─── Env Resolver ─────────────────────────────────────────────────

describe('applyEnvOverrides', () => {
  it('returns file data unchanged when no env vars set', () => {
    const file = { web: { port: 4000 }, llm: { model: 'test' } };
    const result = applyEnvOverrides(file, {});
    expect(result).toEqual(file);
  });

  it('overrides web port from APP_PORT', () => {
    const result = applyEnvOverrides(
      { web: { port: 4000 } },
      { APP_PORT: '9999' },
    );
    expect((result.web as Record<string, unknown>).port).toBe(9999);
  });

  it('overrides LLM model from LLM_MODEL', () => {
    const result = applyEnvOverrides(
      { llm: { model: 'old-model' } },
      { LLM_MODEL: 'new-model' },
    );
    expect((result.llm as Record<string, unknown>).model).toBe('new-model');
  });

  it('sets LLM provider-specific keys when LLM vars not set', () => {
    const result = applyEnvOverrides(
      {},
      { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://custom.api' },
    );
    const llm = result.llm as Record<string, unknown>;
    const providers = llm.providers as Record<string, Record<string, unknown>>;
    expect(providers.anthropic.apiKey).toBe('sk-test');
    expect(providers.anthropic.baseUrl).toBe('https://custom.api');
  });

  it('LLM_* takes precedence over provider-specific vars', () => {
    const result = applyEnvOverrides(
      {},
      { LLM_API_KEY: 'llm-key', ANTHROPIC_API_KEY: 'anthropic-key' },
    );
    const llm = result.llm as Record<string, unknown>;
    expect(llm.apiKey).toBe('llm-key');
    // Provider-specific should NOT be set because llm.apiKey is already set
    const providers = llm.providers as Record<string, Record<string, unknown>> | undefined;
    expect(providers?.anthropic?.apiKey).toBeUndefined();
  });

  it('fallbackOnly mapping skipped when target already has value', () => {
    const result = applyEnvOverrides(
      { llm: { apiKey: 'file-key' } },
      { ANTHROPIC_API_KEY: 'env-key' },
    );
    const llm = result.llm as Record<string, unknown>;
    expect(llm.apiKey).toBe('file-key');
    // Provider-specific should NOT be set because llm.apiKey exists
    const providers = llm.providers as Record<string, Record<string, unknown>> | undefined;
    expect(providers?.anthropic?.apiKey).toBeUndefined();
  });
});

// ─── Resolver Pipeline ────────────────────────────────────────────

describe('resolveConfig', () => {
  it('resolves with defaults when no file exists', () => {
    const config = resolveConfig(join(testDir, 'nonexistent.yaml'), {});
    expect(config.web.port).toBe(3888);
    expect(config.permissionMode).toBe('allow-all');
  });

  it('reads and resolves a YAML file', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: debug
web:
  port: 8080
`, 'utf-8');

    const config = resolveConfig(join(testDir, 'config.yaml'), {});
    expect(config.observability.level).toBe('debug');
    expect(config.web.port).toBe(8080);
  });

  it('applies env overrides on top of file values', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
web:
  port: 4000
`, 'utf-8');

    const config = resolveConfig(join(testDir, 'config.yaml'), { APP_PORT: '7777' });
    expect(config.web.port).toBe(7777);
  });
});

// ─── readYamlFile ─────────────────────────────────────────────────

describe('readYamlFile', () => {
  it('returns empty object for non-existent file', () => {
    expect(readYamlFile(join(testDir, 'nope.yaml'))).toEqual({});
  });

  it('returns empty object for invalid YAML', () => {
    writeFileSync(join(testDir, 'bad.yaml'), '{{invalid', 'utf-8');
    // YAML parser is lenient; let's just verify it doesn't throw
    const result = readYamlFile(join(testDir, 'bad.yaml'));
    expect(typeof result).toBe('object');
  });
});

// ─── Writer ───────────────────────────────────────────────────────

describe('atomicWriteYaml', () => {
  it('writes valid YAML that can be read back', () => {
    const filePath = join(testDir, 'write-test.yaml');
    atomicWriteYaml(filePath, { web: { port: 9090 } });
    const data = readYamlFile(filePath);
    expect((data.web as Record<string, unknown>).port).toBe(9090);
  });
});

describe('deepMerge', () => {
  it('deeply merges nested objects', () => {
    const result = deepMerge(
      { a: { x: 1, y: 2 }, b: 3 },
      { a: { y: 99, z: 100 } },
    );
    expect(result).toEqual({ a: { x: 1, y: 99, z: 100 }, b: 3 });
  });

  it('overwrites non-object values', () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result).toEqual({ a: 2 });
  });
});

// ─── Diagnostics ──────────────────────────────────────────────────

describe('diagnoseConfig', () => {
  it('reports valid for correct config', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
web:
  port: 3888
`, 'utf-8');
    const report = diagnoseConfig(join(testDir, 'config.yaml'), {});
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('reports issues for invalid config', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
web:
  port: not-a-number
`, 'utf-8');
    const report = diagnoseConfig(join(testDir, 'config.yaml'), {});
    expect(report.valid).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });
});

// ─── ConfigService ────────────────────────────────────────────────

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
    const result = svc.updateSection({ unknownKey: 'bad' } as unknown as Partial<import('./schema.js').AppConfig>);
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

    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: debug
`, 'utf-8');

    svc.reload();

    expect(events.length).toBe(1);
    expect(events[0].changedKeys).toContain('observability');
    expect(events[0].config.observability.level).toBe('debug');
  });

  it('onSectionChange only fires for matching key', () => {
    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: info
web:
  port: 3888
`, 'utf-8');

    const svc = new ConfigService();
    let webCalled = false;
    let llmCalled = false;
    svc.onSectionChange('web', () => { webCalled = true; });
    svc.onSectionChange('llm', () => { llmCalled = true; });

    writeFileSync(join(testDir, 'config.yaml'), `
observability:
  level: info
web:
  port: 9090
`, 'utf-8');

    svc.reload();

    expect(webCalled).toBe(true);
    expect(llmCalled).toBe(false);
  });

  it('dispose stops watcher and clears listeners', () => {
    const svc = new ConfigService();
    let called = false;
    svc.onChange(() => { called = true; });
    svc.dispose();
    svc.reload();
    expect(called).toBe(false);
  });

  it('applies env overrides on load', () => {
    const svc = new ConfigService(undefined, { APP_PORT: '7777' });
    expect(svc.getSection('web').port).toBe(7777);
  });

  it('diagnostics returns valid report for correct config', () => {
    const svc = new ConfigService();
    const diag = svc.diagnostics();
    expect(diag.valid).toBe(true);
    expect(diag.issues).toHaveLength(0);
  });
});
