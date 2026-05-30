import { getLogger } from '../utils/logger.js';

const logger = getLogger('mcp-security');

// ─── Prompt Injection Detection ─────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /you are now/i,
  /your new role/i,
  /ignore (previous|all|above) instructions/i,
  /forget (previous|all|your) instructions/i,
  /system:/i,
  /<system>/i,
  /do not (tell|mention|reveal|disclose)/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /import\s+(os|subprocess|shutil)/i,
  /base64[._]decode/i,
];

export function scanToolDescription(serverName: string, toolName: string, description: string): string[] {
  const matches = INJECTION_PATTERNS
    .filter(p => p.test(description))
    .map(p => p.source);

  if (matches.length > 0) {
    logger.warn(
      { serverName, toolName, patterns: matches, descriptionPreview: description.slice(0, 200) },
      'MCP 工具描述中检测到潜在注入模式',
    );
  }
  return matches;
}

// ─── Credential Sanitization ────────────────────────────────────

const CREDENTIAL_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9_]{1,255}/g,
  /gho_[A-Za-z0-9_]{1,255}/g,
  /github_pat_[A-Za-z0-9_]{1,255}/g,
  /sk-[A-Za-z0-9_]{20,255}/g,
  /Bearer\s+\S{10,}/gi,
  /x]?api[_-]?key[=:]\s*\S+/gi,
  /(token|password|secret|credential)[=:]\s*\S+/gi,
];

export function sanitizeCredentials(text: string): string {
  let result = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ─── Output Truncation ──────────────────────────────────────────

export function truncateOutput(text: string, maxChars = 100_000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return `${text.slice(0, half)}\n\n[... 省略 ${omitted} 字符 ...]\n\n${text.slice(-half)}`;
}

// ─── Environment Variable Filtering ─────────────────────────────

const ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'NODE_PATH', 'NODE_ENV',
]);

const ENV_DENYLIST_SUFFIXES = [
  '_KEY', '_SECRET', '_TOKEN', '_PASSWORD', '_CREDENTIAL',
  '_API_KEY', '_APIKEY',
];

export function buildSafeEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (ENV_ALLOWLIST.has(key)) {
      safe[key] = value;
      continue;
    }
    if (key.startsWith('XDG_')) {
      safe[key] = value;
      continue;
    }
  }

  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      const upper = key.toUpperCase();
      const isDenied = ENV_DENYLIST_SUFFIXES.some(s => upper.endsWith(s));
      if (isDenied) {
        logger.warn({ key }, 'MCP 环境变量被拒绝（匹配敏感后缀）');
        continue;
      }
      safe[key] = value;
    }
  }

  return safe;
}
