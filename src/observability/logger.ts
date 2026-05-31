import pino from 'pino';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getLogDir } from '../utils/paths.js';
import { redact } from './redaction.js';
import type { LogLevel } from './types.js';

let instance: pino.Logger | null = null;
let instanceLogDir: string | null = null;
let runLogCallback: ((level: LogLevel, module: string, msg: string, data?: Record<string, unknown>) => void) | null = null;

const isChildAgent = !!process.env.AGENT_NAME;
const terminalMode = process.env.APP_TERMINAL_MODE ?? 'json';
const isVitest = !!process.env.VITEST;

const PINO_LEVEL_MAP: Record<LogLevel, string> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
};

export function resolveEffectiveLevel(): LogLevel {
  const levels: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  const cliLevel = process.env.APP_CLI_LOG_LEVEL;
  const envLevel = process.env.APP_LOG_LEVEL ?? process.env.LOG_LEVEL;
  const configLevel = process.env.APP_CONFIG_LOG_LEVEL;
  const modeDefault = process.env.APP_TEST === '1' ? 'debug' : 'info';

  for (const candidate of [cliLevel, envLevel, configLevel]) {
    if (candidate && levels.includes(candidate as LogLevel)) {
      return candidate as LogLevel;
    }
  }
  return modeDefault as LogLevel;
}

export function setRunLogCallback(cb: ((level: LogLevel, module: string, msg: string, data?: Record<string, unknown>) => void) | null): void {
  runLogCallback = cb;
}

export function getLogger(module?: string): pino.Logger {
  const logDir = getLogDir();
  if (isVitest) {
    if (!instance) {
      instance = pino({ level: 'silent' });
      instanceLogDir = logDir;
    }
    return module ? instance.child({ module }) : instance;
  }

  if (!instance || instanceLogDir !== logDir) {
    mkdirSync(logDir, { recursive: true });

    const effectiveLevel = resolveEffectiveLevel();

    const targets: pino.TransportTargetOptions[] = [
      {
        target: 'pino/file',
        options: { destination: join(logDir, 'berry.log'), mkdir: true },
        level: 'debug',
      },
    ];

    if (terminalMode !== 'human' && !isChildAgent) {
      targets.push({
        target: 'pino/file',
        options: { destination: 2 },
        level: PINO_LEVEL_MAP[effectiveLevel],
      });
    }

    instance = pino({
      level: 'debug',
      transport: { targets },
    });
    instanceLogDir = logDir;
  }
  return module ? instance.child({ module }) : instance;
}

export function createModuleLogger(module: string) {
  const pinoLogger = getLogger(module);

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const safeData = data ? (redact(data) as Record<string, unknown>) : undefined;
    pinoLogger[level]({ ...safeData }, msg);
    runLogCallback?.(level, module, msg, data);
  }

  return {
    error(msg: string, data?: Record<string, unknown>) { log('error', msg, data); },
    warn(msg: string, data?: Record<string, unknown>) { log('warn', msg, data); },
    info(msg: string, data?: Record<string, unknown>) { log('info', msg, data); },
    debug(msg: string, data?: Record<string, unknown>) { log('debug', msg, data); },
  };
}
