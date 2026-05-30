import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { loadConfig } from '../kernel/config.js';
import { setAppHome } from '../utils/paths.js';

export type RealTestProfile = 'builtin' | 'override';

export interface ResolveRealTestConfigOptions {
  profile?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dataDir?: string;
}

export interface RealTestConfig {
  profile: RealTestProfile;
  berryHome: string;
  cleanupBerryHome: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  source: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

export interface AppliedRealTestEnv {
  config: RealTestConfig;
  cleanup: () => void;
}

export function resolveRealTestConfig(opts: ResolveRealTestConfigOptions): RealTestConfig {
  const profile = parseProfile(opts.profile);
  const appConfig = loadConfig();
  const berryHome = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'berry-real-test-'));
  const cleanupBerryHome = !opts.dataDir;

  if (profile === 'builtin') {
    return {
      profile,
      berryHome,
      cleanupBerryHome,
      baseUrl: appConfig.llm.baseUrl,
      apiKey: appConfig.llm.apiKey,
      model: appConfig.llm.model,
      source: {
        baseUrl: 'config/default',
        apiKey: 'config/default',
        model: 'config/default',
      },
    };
  }

  const baseUrl = firstDefined(opts.baseUrl, process.env.BERRY_TEST_LIVE_BASE_URL, process.env.LLM_BASE_URL, appConfig.llm.baseUrl);
  const apiKey = firstDefined(opts.apiKey, process.env.BERRY_TEST_LIVE_API_KEY, process.env.LLM_API_KEY, appConfig.llm.apiKey);
  const model = firstDefined(opts.model, process.env.BERRY_TEST_LIVE_MODEL, process.env.LLM_MODEL, appConfig.llm.model);

  return {
    profile,
    berryHome,
    cleanupBerryHome,
    baseUrl,
    apiKey,
    model,
    source: {
      baseUrl: sourceOf('baseUrl', opts.baseUrl, process.env.BERRY_TEST_LIVE_BASE_URL, process.env.LLM_BASE_URL),
      apiKey: sourceOf('apiKey', opts.apiKey, process.env.BERRY_TEST_LIVE_API_KEY, process.env.LLM_API_KEY),
      model: sourceOf('model', opts.model, process.env.BERRY_TEST_LIVE_MODEL, process.env.LLM_MODEL),
    },
  };
}

export function applyRealTestEnv(config: RealTestConfig): AppliedRealTestEnv {
  const savedEnv: Record<string, string | undefined> = {
    BERRY_HOME: process.env.BERRY_HOME,
    BERRY_LLM_MODE: process.env.BERRY_LLM_MODE,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
    TZ: process.env.TZ,
    LANG: process.env.LANG,
  };

  process.env.BERRY_HOME = config.berryHome;
  process.env.BERRY_LLM_MODE = 'live';
  process.env.LLM_BASE_URL = config.baseUrl;
  process.env.LLM_API_KEY = config.apiKey;
  process.env.LLM_MODEL = config.model;
  process.env.TZ = 'UTC';
  process.env.LANG = 'zh_CN.UTF-8';
  setAppHome(config.berryHome);

  return {
    config,
    cleanup() {
      restoreEnv(savedEnv);
      setAppHome(savedEnv.BERRY_HOME ?? join(homedir(), '.berryagent'));
      if (config.cleanupBerryHome) {
        try {
          rmSync(config.berryHome, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    },
  };
}

export function summarizeRealTestConfig(config: RealTestConfig): Record<string, unknown> {
  return {
    profile: config.profile,
    berryHome: config.berryHome,
    llm: {
      baseUrl: redactUrl(config.baseUrl),
      apiKey: redactSecret(config.apiKey),
      model: config.model,
      source: config.source,
    },
  };
}

function parseProfile(profile?: string): RealTestProfile {
  const value = profile ?? 'builtin';
  if (value === 'builtin' || value === 'override') return value;
  throw new Error(`未知真实测试 profile: ${value}`);
}

function firstDefined(...values: Array<string | undefined>): string {
  const value = values.find((v) => v !== undefined && v !== '');
  if (!value) throw new Error('真实测试缺少 LLM 配置');
  return value;
}

function sourceOf(name: string, cli?: string, testEnv?: string, llmEnv?: string): string {
  if (cli) return `cli.${name}`;
  if (testEnv) return `BERRY_TEST_LIVE_${envName(name)}`;
  if (llmEnv) return `LLM_${envName(name)}`;
  return 'config/default';
}

function envName(name: string): string {
  if (name === 'baseUrl') return 'BASE_URL';
  if (name === 'apiKey') return 'API_KEY';
  return 'MODEL';
}

function restoreEnv(savedEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function redactSecret(value: string): string {
  return value ? '[REDACTED]' : '';
}

function redactUrl(value: string): string {
  return value.replace(/([?&](?:token|key|secret|access_token|api_key|auth)=)[^&]*/gi, '$1[REDACTED]');
}
