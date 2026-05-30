import type { LogLevel } from './types.js';

const SENSITIVE_KEYS = /api_key|token|authorization|cookie|password|secret|credential/i;
const SENSITIVE_URL_PARAMS = /[?&](token|key|secret|access_token|api_key|auth)=[^&]*/gi;
const SECRET_PREFIXES = /^(sk-|ghp_|gho_|ghu_|ghs_|ghr_|xoxb-|xoxp-|xoxs-|xoxa-|AKIA|tp-)/;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g;

export function isLikelySecret(key: string): boolean {
  return SENSITIVE_KEYS.test(key);
}

export function redactString(str: string): string {
  let result = str.replace(SENSITIVE_URL_PARAMS, (match) => {
    const eqIdx = match.indexOf('=');
    return match.slice(0, eqIdx + 1) + '[REDACTED]';
  });
  result = result.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  return result;
}

export function redact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    if (SECRET_PREFIXES.test(obj)) return '[REDACTED]';
    return redactString(obj);
  }
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isLikelySecret(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redact(value);
      }
    }
    return result;
  }
  return obj;
}

export function resolveLogLevel(opts?: {
  cliLevel?: string;
  envLevel?: string;
  configLevel?: string;
  modeDefault?: LogLevel;
}): LogLevel {
  const levels: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  const check = (v?: string): LogLevel | undefined => {
    if (v && levels.includes(v as LogLevel)) return v as LogLevel;
    return undefined;
  };
  return (
    check(opts?.cliLevel) ??
    check(opts?.envLevel) ??
    check(opts?.configLevel) ??
    opts?.modeDefault ??
    'info'
  );
}
