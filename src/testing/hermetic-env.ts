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
  berryHome: string;
  cleanup: () => void;
}

export function createHermeticEnv(options?: HermeticEnvOptions): HermeticEnv {
  const berryHome = mkdtempSync(join(tmpdir(), 'berry-test-'));

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
  const savedBerryHome = process.env.BERRY_HOME;
  const savedLlmMode = process.env.BERRY_LLM_MODE;

  process.env.TZ = 'UTC';
  process.env.LANG = 'en_US.UTF-8';
  process.env.BERRY_HOME = berryHome;
  process.env.BERRY_LLM_MODE = options?.llmMode ?? 'mock';

  setAppHome(berryHome);

  return {
    berryHome,
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
      if (savedBerryHome === undefined) delete process.env.BERRY_HOME; else process.env.BERRY_HOME = savedBerryHome;
      if (savedLlmMode === undefined) delete process.env.BERRY_LLM_MODE; else process.env.BERRY_LLM_MODE = savedLlmMode;

      setAppHome(savedBerryHome ?? join(homedir(), '.berryagent'));

      try {
        rmSync(berryHome, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}
