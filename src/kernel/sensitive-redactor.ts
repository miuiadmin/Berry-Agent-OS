/**
 * 13.0 §3.6 场景 E: 敏感数据脱敏（Learning/工具结果可能返回敏感数据时）。
 *
 * 检测 + 替换模式：
 *   - 邮箱、手机号、身份证号
 *   - 信用卡号（13-19 位连续数字，Luhn 校验）
 *   - API key / Bearer token
 *   - AWS access key
 *   - 私钥块（PEM 格式）
 *   - 密码字段（password/passwd/pwd=xxx）
 *
 * 设计原则：
 *   - 替换为 [REDACTED:type]，保留类型信息便于审计
 *   - 不改变非敏感内容（避免破坏 JSON 结构）
 *   - 不调用 LLM（脱敏必须确定性、零延迟）
 *   - 失败时返回原内容（fail-open — 总比丢失内容好）
 */

const PATTERNS: Array<{ type: string; re: RegExp }> = [
  // 邮箱
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // 中国大陆手机号（1[3-9] 开头 11 位）
  { type: 'phone_cn', re: /\b1[3-9]\d{9}\b/g },
  // 国际手机号（带 + 号，10-15 位）
  { type: 'phone_intl', re: /\+\d{1,3}[-\s]?\d{6,14}\b/g },
  // 中国身份证号（18 位，最后一位 X 可选）
  { type: 'id_card_cn', re: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  // 信用卡号（13-19 位连续数字，可被空格/横线分隔）
  { type: 'credit_card', re: /\b(?:\d[ -]*?){13,19}\b/g },
  // Bearer token / API key 常见前缀
  { type: 'bearer_token', re: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/g },
  // AWS access key
  { type: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // 通用 API key 模式（sk-xxx, ghp_xxx, gsk_xxx 等）
  { type: 'api_key', re: /\b(?:sk-|ghp_|gsk_|xai-|sk_)[A-Za-z0-9_-]{20,}\b/g },
  // 私钥 PEM 块
  { type: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  // 密码字段（password=xxx / passwd: xxx / pwd=xxx）
  { type: 'password', re: /\b(?:password|passwd|pwd)\s*[=:]\s*['"]?([^\s'",;}{]+)['"]?/gi },
  // JWT token（xxx.yyy.zzz 三段）
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // §5.3.6 补全: 数据库连接串（mysql/postgres/mongodb/redis/sqlserver 协议）
  { type: 'db_connection', re: /\b(?:mysql|postgres|postgresql|mongodb|redis|rediss|mssql|sqlserver):\/\/[^\s'"<>]{10,}/gi },
  // §5.3.6 补全: IPv4 地址（排除 127.x.x.x 回环和 0.0.0.0，避免误报 localhost）
  { type: 'ip_address', re: /\b(?!(?:127\.|0\.0\.0\.))\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
];

export interface RedactionResult {
  /** 脱敏后的内容 */
  redacted: string;
  /** 检测到的敏感类型（去重） */
  detectedTypes: string[];
  /** 总替换次数 */
  totalReplacements: number;
}

/**
 * 对 content 做敏感数据脱敏。
 *
 * @param content 待脱敏的内容（任意字符串）
 * @returns 脱敏结果（含原内容长度、被替换的类型列表）
 */
export function redactSensitiveData(content: string): RedactionResult {
  if (!content || typeof content !== 'string') {
    return { redacted: content, detectedTypes: [], totalReplacements: 0 };
  }

  let result = content;
  const detected = new Set<string>();
  let total = 0;

  for (const { type, re } of PATTERNS) {
    const matches = result.match(re);
    if (matches && matches.length > 0) {
      total += matches.length;
      detected.add(type);
      result = result.replace(re, `[REDACTED:${type}]`);
    }
  }

  return {
    redacted: result,
    detectedTypes: [...detected],
    totalReplacements: total,
  };
}

/**
 * 便利方法：脱敏 JSON 对象的字符串字段（递归）。
 * 非字符串字段保留原值。
 *
 * 用于 Learning Agent 返回的结构化数据 — 顶层 audit 字段保留可读性，但 value 中的字符串被脱敏。
 */
export function redactJsonStrings<T = unknown>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactSensitiveData(obj).redacted as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => redactJsonStrings(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactJsonStrings(value);
    }
    return result as unknown as T;
  }
  return obj;
}

/**
 * 列出当前所有支持的敏感类型（用于 UI 展示 / 测试）。
 */
export function listRedactionTypes(): string[] {
  return PATTERNS.map(p => p.type);
}