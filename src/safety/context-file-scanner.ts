import { getLogger } from '../utils/logger.js';

const logger = getLogger('context-file-scanner');

const THREAT_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /ignore\s+(previous|all|your|the)\s+(instructions|rules|guidelines|constraints)/i, description: 'prompt override attempt' },
  { pattern: /disregard\s+(rules|safety|guidelines|previous|all)/i, description: 'rule disregard attempt' },
  { pattern: /you\s+are\s+now\s+/i, description: 'identity override attempt' },
  { pattern: /\$\{?[A-Z_]{3,}\}?.*https?:\/\//i, description: 'credential exfiltration to URL' },
  { pattern: /curl\s+.*\$\{?[A-Z_]+/i, description: 'curl with env variable' },
  { pattern: /rm\s+-rf\s+[\/~]/i, description: 'destructive rm command' },
  { pattern: /<!--\s*system:/i, description: 'HTML comment injection' },
  { pattern: /\[system\]\s*:/i, description: 'fake system message injection' },
];

const INVISIBLE_CODEPOINTS = [
  0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0xFEFF,
];

export interface ScanResult {
  safe: boolean;
  threats: string[];
}

export function scanContextFile(content: string): ScanResult {
  const threats: string[] = [];

  // Check for invisible unicode characters
  for (const cp of INVISIBLE_CODEPOINTS) {
    if (content.includes(String.fromCodePoint(cp))) {
      threats.push(`invisible unicode U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      break;
    }
  }

  // Check for threat patterns
  for (const { pattern, description } of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      threats.push(description);
    }
  }

  if (threats.length > 0) {
    logger.warn({ threats }, 'Context file contains potential injection patterns');
  }

  return { safe: threats.length === 0, threats };
}
