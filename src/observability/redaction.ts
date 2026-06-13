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
/**
 * 对话内容子串级 secret 清洗的正则规则表（15.0 存储层加固）。
 *
 * **单源原则**：本表是全仓 secret 模式的唯一真相源。`src/kernel/sensitive-redactor.ts`
 * （PII+secret 脱敏）复用本表做 secret 检测，避免两套正则双写漂移（历史曾因此漏匹配 PGP
 * `PRIVATE KEY BLOCK` 后缀，见 `redaction.test.ts` 的 PGP 用例）。新增 secret 前缀只改本表，
 * 两处 redact 同步生效。
 *
 * 顺序敏感：PEM 块必须最先匹配（其 base64 正文若被 long_hex 等部分吞掉会破坏整体边界）；
 * anthropic 必须排在 openai 之前（sk-ant- 前缀会被 sk- 正则部分吞掉）。
 */
export const SECRET_CONTENT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // PEM 私钥块必须最先匹配：其 base64 正文若被后续模式（long_hex 等）部分吞掉会破坏整体边界。
  // 覆盖 RSA / EC / OPENSSH / ENCRYPTED / 无算法前缀（PKCS#8）/ PGP（带 BLOCK 后缀）等 PRIVATE KEY 块。
  // 注意 PGP 私钥是 `-----BEGIN PGP PRIVATE KEY BLOCK-----`（多一个 BLOCK 后缀），故尾部需 `(?: BLOCK)?`。
  { name: 'pem_private_key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
  // anthropic 必须排在 openai 之前：sk-ant- 前缀会被 sk- 正则部分吞掉
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', re: /sk-(?!ant-)[A-Za-z0-9]{20,}/g },
  { name: 'github_pat', re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'aws_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack_token', re: /xox[abpsa]-[A-Za-z0-9-]{10,}/g },
  // 其他厂商 API key 前缀（Groq gsk_ / xAI xai- / 通用 sk_）——与 sensitive-redactor 旧实现合并时补入，
  // 避免单源化后丢失这几类覆盖。sk_ 用下划线区分于 sk-（连字符，openai_key 已覆盖）。
  { name: 'api_key_other', re: /\b(?:gsk_|xai-|sk_)[A-Za-z0-9_-]{20,}/g },
  // JWT：三段 base64url，header 几乎必以 eyJ（"{" 的 base64）开头——强信号、低误报
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9\-._~+/]+={0,2}/g },
  // Authorization 头：Basic / Token / Digest 等「非 Bearer」方案（Bearer 方案已被上一条整段吃掉，
  // 故本条在已 redact 的 "Authorization: [REDACTED:bearer_token]" 上因 '[' 不匹配 scheme 而跳过，幂等）
  { name: 'authorization_header', re: /Authorization:\s*[A-Za-z][A-Za-z0-9_-]*\s+[^\s,]+/gi },
  // 长 hex（疑似私钥 / secret）。阈值 64：避开 SHA1(40) / 短哈希的常见误报（日志里的 git SHA、文件摘要），
  // 仅留极长 hex secret 作兜底。注意 SHA256 恰为 64 位——若你的场景里 SHA256 频繁出现在对话正文且不应被
  // 清洗，可进一步提高阈值；当前 64 是「清洗极长 hex secret」与「不动短哈希」的折中。
  { name: 'long_hex', re: /\b[a-f0-9]{64,}\b/gi },
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
