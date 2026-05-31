import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { setAppHome } from '../utils/paths.js';

const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_API_KEY',
];

const CREDENTIAL_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'OPENAI_'];

export interface HermeticEnvOptions {
  llmMode?: 'mock' | 'takeover' | 'live';
}

export interface HermeticEnv {
  appHome: string;
  cleanup: () => void;
}

export function createHermeticEnv(options?: HermeticEnvOptions): HermeticEnv {
  const appHome = mkdtempSync(join(tmpdir(), 'agent-test-'));

  const savedEnv: Record<string, string | undefined> = {};

  if (options?.llmMode !== 'live') {
    for (const key of Object.keys(process.env)) {
      if (CREDENTIAL_PREFIXES.some((p) => key.startsWith(p))) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    for (const key of CREDENTIAL_ENV_KEYS) {
      if (!(key in savedEnv) && process.env[key] !== undefined) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  }

  const savedTz = process.env.TZ;
  const savedLang = process.env.LANG;
  const savedAppHome = process.env.SERVICE_HOME;
  const savedLlmMode = process.env.APP_LLM_MODE;

  process.env.TZ = 'UTC';
  process.env.LANG = 'en_US.UTF-8';
  process.env.SERVICE_HOME = appHome;
  process.env.APP_LLM_MODE = options?.llmMode ?? 'mock';

  setAppHome(appHome);

  return {
    appHome,
    cleanup() {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
      if (savedLang === undefined) delete process.env.LANG; else process.env.LANG = savedLang;
      if (savedAppHome === undefined) delete process.env.SERVICE_HOME; else process.env.SERVICE_HOME = savedAppHome;
      if (savedLlmMode === undefined) delete process.env.APP_LLM_MODE; else process.env.APP_LLM_MODE = savedLlmMode;

      setAppHome(savedAppHome ?? join(homedir(), '.agent-home'));

      try {
        rmSync(appHome, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}
