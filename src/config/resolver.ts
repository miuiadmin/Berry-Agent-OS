/**
 * 分层配置解析管线
 *
 * 每层是独立可测的纯函数：
 *   defaults (Zod) → file (YAML) → env vars → CLI args
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';
import { ENV_MAPPINGS, type EnvMapping } from './env-map.js';

// ─── Layer 1: 读取 YAML 文件 ──────────────────────────────────────

/**
 * 读取原始 YAML 文件数据
 * 文件不存在或解析失败时返回空对象
 */
export function readYamlFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

// ─── Layer 2: 环境变量覆盖 ─────────────────────────────────────────

/**
 * 将环境变量应用到配置数据上
 * 按映射表顺序迭代，后面的覆盖前面的
 */
export function applyEnvOverrides(
  fileData: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  mappings: EnvMapping[] = ENV_MAPPINGS,
): Record<string, unknown> {
  const result: Record<string, unknown> = JSON.parse(JSON.stringify(fileData));

  for (const mapping of mappings) {
    const raw = env[mapping.env];
    if (raw === undefined || raw === '') continue;

    if (mapping.fallbackOnly) {
      const existing = getNestedValue(result, mapping.path);
      if (existing !== undefined) continue;
    }

    if (mapping.condition && !mapping.condition(result)) continue;

    setNestedValue(result, mapping.path, mapping.transform ? mapping.transform(raw) : raw);
  }

  return result;
}

// ─── Layer 3: CLI 参数覆盖（预留） ──────────────────────────────────

export function applyCliOverrides(
  data: Record<string, unknown>,
  _cliArgs: Record<string, unknown>,
): Record<string, unknown> {
  return data;
}

// ─── 完整管线 ───────────────────────────────────────────────────────

/**
 * 完整配置解析：file → env → cli → Zod 校验
 *
 * @param configPath 配置文件路径
 * @param env 环境变量（默认 process.env）
 * @returns 校验后的完整配置
 */
export function resolveConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const fileData = readYamlFile(configPath);
  const withEnv = applyEnvOverrides(fileData, env);
  const withCli = applyCliOverrides(withEnv, {});
  return AppConfigSchema.parse(withCli) as AppConfig;
}

// ─── 内部辅助 ───────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = current[key];
    if (next === undefined || next === null || typeof next !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}
