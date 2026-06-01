import pino from 'pino';
import { join } from 'node:path';
import { mkdirSync, createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { getLogDir } from '../utils/paths.js';
import { redact } from './redaction.js';
import type { LogLevel } from './types.js';

let instance: pino.Logger | null = null;
let instanceLogDir: string | null = null;
type LogCallback = (level: LogLevel, module: string, msg: string, data?: Record<string, unknown>) => void;
const logListeners = new Set<LogCallback>();

const isChildAgent = !!process.env.AGENT_NAME;
const terminalMode = process.env.APP_TERMINAL_MODE ?? 'json';
const isVitest = !!process.env.VITEST;

const PINO_LEVEL_MAP: Record<LogLevel, string> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
};

const PINO_LEVEL_NUMBERS: Record<number, LogLevel> = {
  50: 'error',
  40: 'warn',
  30: 'info',
  20: 'debug',
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

let exclusiveListener: LogCallback | null = null;

export function setRunLogCallback(cb: LogCallback | null): void {
  if (exclusiveListener) logListeners.delete(exclusiveListener);
  exclusiveListener = cb;
  if (cb) logListeners.add(cb);
}

export function getRunLogCallback(): LogCallback | null {
  return exclusiveListener;
}

export function addLogListener(cb: LogCallback): () => void {
  logListeners.add(cb);
  return () => { logListeners.delete(cb); };
}

function createCallbackStream(): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      if (logListeners.size > 0) {
        try {
          const line = chunk.toString();
          const obj = JSON.parse(line);
          const level = PINO_LEVEL_NUMBERS[obj.level] ?? 'info';
          const module = obj.module ?? '';
          const msg = obj.msg ?? '';
          const { level: _l, time: _t, pid: _p, hostname: _h, module: _m, msg: _msg, ...data } = obj;
          const payload = Object.keys(data).length > 0 ? data : undefined;
          for (const listener of logListeners) {
            listener(level, module, msg, payload);
          }
        } catch { /* ignore parse errors */ }
      }
      callback();
    },
  });
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
    const logFilePath = join(logDir, 'berry.log');
    const fileStream = createWriteStream(logFilePath, { flags: 'a' });

    const streams: pino.StreamEntry[] = [
      { level: 'debug' as pino.Level, stream: fileStream },
      { level: 'debug' as pino.Level, stream: createCallbackStream() },
    ];

    if (terminalMode !== 'human' && !isChildAgent) {
      streams.push({
        level: PINO_LEVEL_MAP[effectiveLevel] as pino.Level,
        stream: process.stderr,
      });
    }

    instance = pino({ level: 'debug' }, pino.multistream(streams));
    instanceLogDir = logDir;
  }
  return module ? instance.child({ module }) : instance;
}

export function createModuleLogger(module: string) {
  const pinoLogger = getLogger(module);

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    const safeData = data ? (redact(data) as Record<string, unknown>) : undefined;
    pinoLogger[level]({ ...safeData }, msg);
  }

  return {
    error(msg: string, data?: Record<string, unknown>) { log('error', msg, data); },
    warn(msg: string, data?: Record<string, unknown>) { log('warn', msg, data); },
    info(msg: string, data?: Record<string, unknown>) { log('info', msg, data); },
    debug(msg: string, data?: Record<string, unknown>) { log('debug', msg, data); },
  };
}
