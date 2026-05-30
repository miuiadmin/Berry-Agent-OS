import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function readConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf-8');
  return (parseYaml(raw) as Record<string, unknown>) ?? {};
}

export function writeConfig(configPath: string, updates: unknown): { ok: boolean; error?: string } {
  if (!isObject(updates)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const filtered = filterKnownKeys(updates as Record<string, unknown>);
  if (Object.keys(filtered).length === 0) {
    return { ok: false, error: 'No valid config keys provided' };
  }
  const current = readConfig(configPath);
  const merged = deepMerge(current, filtered);
  writeFileSync(configPath, stringifyYaml(merged, { lineWidth: 120 }), 'utf-8');
  return { ok: true };
}

const ALLOWED_TOP_KEYS = new Set([
  'llm', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'requestTimeoutMs',
  'permissionMode', 'toolLoop', 'memory', 'skills', 'observability',
  'budget', 'channels', 'streaming', 'web', 'cron', 'mcp',
]);

function filterKnownKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (ALLOWED_TOP_KEYS.has(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (isObject(srcVal) && isObject(tgtVal)) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
