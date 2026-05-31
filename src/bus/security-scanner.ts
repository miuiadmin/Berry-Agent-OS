import { getLogger } from '../utils/logger.js';

const logger = getLogger('bus:security-scanner');

const MALICIOUS_PATTERNS = [
  /ignore\s+(previous|all|prior)\s+(instructions?|prompts?)/i,
  /you\s+are\s+now\s+a/i,
  /forget\s+(everything|all|your)/i,
  /disregard\s+(all|previous|your)/i,
  /new\s+instructions?:\s/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /base64\s*(decode|encode)/i,
  /child_process/i,
  /process\.env/i,
  /require\s*\(\s*['"]fs['"]\s*\)/i,
  /<script\b/i,
  /\bFunction\s*\(/i,
];

export interface ScanResult {
  safe: boolean;
  warnings: string[];
  blockers: string[];
}

export function scanCapabilityDescription(description: string, systemPrompt?: string): ScanResult {
  const warnings: string[] = [];
  const blockers: string[] = [];

  const textToScan = systemPrompt ? `${description}\n${systemPrompt}` : description;

  for (const pattern of MALICIOUS_PATTERNS) {
    if (pattern.test(textToScan)) {
      const match = textToScan.match(pattern)?.[0] ?? '';
      blockers.push(`Suspicious pattern detected: "${match}" (${pattern.source})`);
    }
  }

  if (textToScan.length > 10000) {
    warnings.push(`Unusually long description/prompt (${textToScan.length} chars) — may contain hidden instructions`);
  }

  if (/[\x00-\x08\x0e-\x1f]/.test(textToScan)) {
    warnings.push('Contains control characters — possible encoding attack');
  }

  const safe = blockers.length === 0;
  if (!safe) {
    logger.warn({ blockers, description: description.slice(0, 100) }, 'Security scan found malicious patterns');
  }

  return { safe, warnings, blockers };
}

export function scanAgentYaml(yaml: { name: string; system_prompt?: string; capabilities_required?: string[] }): ScanResult {
  const warnings: string[] = [];
  const blockers: string[] = [];

  if (yaml.system_prompt) {
    const promptScan = scanCapabilityDescription(yaml.system_prompt);
    warnings.push(...promptScan.warnings);
    blockers.push(...promptScan.blockers);
  }

  const BRAIN_ONLY_CAPABILITIES = ['create_agent', 'destroy_agent'];
  if (yaml.capabilities_required) {
    for (const cap of yaml.capabilities_required) {
      if (BRAIN_ONLY_CAPABILITIES.includes(cap)) {
        blockers.push(`Dynamic agent cannot require Brain-only capability: "${cap}"`);
      }
    }
  }

  return { safe: blockers.length === 0, warnings, blockers };
}
