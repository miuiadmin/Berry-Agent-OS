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

/**
 * 对话内容子串级 secret 清洗（15.0 存储层加固）。
 *
 * 与 redact()（日志 key-value 场景，整值替换）不同，本函数针对自然语言
 * 对话内容——secret 可能内嵌在文本中间（如"我的 key 是 sk-ant-xxx"），
 * 需要子串模式匹配后替换为占位符，保留其余正文。
 *
 * 落盘前对 conversations / dialogue_messages / agent_chat_messages 的
 * content 字段调用，保证 API key / token / 私钥不明文入库。
 *
 * 注意：这是误操作防护（用户误发 key 后历史不泄露），不是密码学安全。
 * 真正安全依赖传输加密 / 静态加密 / 数据库访问控制。
 *
 * @param input 原始文本
 * @returns secret 被替换为 [REDACTED:name] 的文本；input 为空则原样返回
 */
const SECRET_CONTENT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // anthropic 必须排在 openai 之前：sk-ant- 前缀会被 sk- 正则部分吞掉
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', re: /sk-(?!ant-)[A-Za-z0-9]{20,}/g },
  { name: 'github_pat', re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'aws_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack_token', re: /xox[abpsa]-[A-Za-z0-9-]{10,}/g },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9\-._~+/]+={0,2}/g },
  // 长 hex（疑似私钥 / secret，40+ 位）
  { name: 'long_hex', re: /\b[a-f0-9]{40,}\b/gi },
];

export function redactSecrets(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let result = input;
  for (const { name, re } of SECRET_CONTENT_PATTERNS) {
    result = result.replace(re, `[REDACTED:${name}]`);
  }
  return result;
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
