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

import { SECRET_CONTENT_PATTERNS } from '../observability/redaction.js';

/**
 * PII 模式（仅本模块覆盖——对话内容 redact 用 `redactSecrets` 只脱敏 secret 不脱敏 PII；
 * 本模块用于 Learning Agent / Brain 决策数据，需 PII + secret 双重脱敏）。
 *
 * 注意：secret 类模式（API key / Bearer / PEM / JWT / AWS / 长 hex）不再在此重复定义——
 * 统一复用 `redaction.ts` 的 {@link SECRET_CONTENT_PATTERNS} 单源，避免两套正则双写漂移
 * （历史曾因此漏匹配 PGP `PRIVATE KEY BLOCK` 后缀）。
 */
const PII_PATTERNS: Array<{ type: string; re: RegExp }> = [
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
  // 密码字段（password=xxx / passwd: xxx / pwd=xxx）
  { type: 'password', re: /\b(?:password|passwd|pwd)\s*[=:]\s*['"]?([^\s'",;}{]+)['"]?/gi },
  // §5.3.6 补全: 数据库连接串（mysql/postgres/mongodb/redis/sqlserver 协议）
  { type: 'db_connection', re: /\b(?:mysql|postgres|postgresql|mongodb|redis|rediss|mssql|sqlserver):\/\/[^\s'"<>]{10,}/gi },
  // §5.3.6 补全: IPv4 地址（排除 127.x.x.x 回环和 0.0.0.0，避免误报 localhost）
  { type: 'ip_address', re: /\b(?!(?:127\.|0\.0\.0\.))\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
];

/**
 * 全量脱敏模式 = secret（单源，复用 `redaction.ts`）+ PII（本模块独有）。
 *
 * 顺序：secret 在前（PEM 块必须最先匹配，否则其 base64 正文会被 long_hex / ip_address 等
 * 部分吞掉破坏边界——见 redaction.ts 注释）；PII 在 secret 清洗后叠加，避免 PII 正则误吃
 * 已脱敏的占位符或 secret 残片。
 */
const PATTERNS: Array<{ type: string; re: RegExp }> = [
  ...SECRET_CONTENT_PATTERNS.map((p) => ({ type: p.name, re: p.re })),
  ...PII_PATTERNS,
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