/**
 * 分层配置解析管线
 *
 * 纯函数组合：defaults → file → env → CLI
 * 每层可独立单测，不依赖任何运行时状态。
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';
import { ENV_MAPPINGS, getNested, setNested, type EnvMapping } from './env-map.js';
import { getLogger } from '../observability/logger.js';

const logger = getLogger('config-resolver');

// ─── Layer 1: File ────────────────────────────────────────────────

/** 读取 YAML 文件原始数据，文件不存在或解析失败返回 {} */
export function readYamlFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return (parseYaml(raw) as Record<string, unknown>) ?? {};
  } catch (err) {
    logger.error({ err, configPath }, '配置文件解析失败，使用默认值');
    return {};
  }
}

// ─── Layer 2: Env ─────────────────────────────────────────────────

/**
 * 应用环境变量覆盖
 *
 * 遍历映射表，将环境变量值设置到配置数据的对应路径。
 * fallbackOnly 类型的映射仅在目标路径无已有值时生效。
 */
export function applyEnvOverrides(
  data: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  mappings: readonly EnvMapping[] = ENV_MAPPINGS,
): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(data);

  for (const mapping of mappings) {
    const raw = env[mapping.env];
    if (raw === undefined || raw === '') continue;

    // fallbackOnly：provider-specific 变量仅在通用值未设置时生效
    if (mapping.fallbackOnly) {
      // 检查同语义层级（apiKey / baseUrl）的通用值是否已存在
      // 通用值可来自：(1) 通用环境变量 LLM_API_KEY / LLM_BASE_URL
      //            (2) 文件中的 llm.apiKey / llm.baseUrl
      const hasGenericApiKey = (env.LLM_API_KEY !== undefined && env.LLM_API_KEY !== '')
        || (getNested(result, 'llm.apiKey') !== undefined && getNested(result, 'llm.apiKey') !== '');
      const hasGenericBaseUrl = (env.LLM_BASE_URL !== undefined && env.LLM_BASE_URL !== '')
        || (getNested(result, 'llm.baseUrl') !== undefined && getNested(result, 'llm.baseUrl') !== '');

      if (mapping.path.includes('.apiKey') && hasGenericApiKey) continue;
      if (mapping.path.includes('.baseUrl') && hasGenericBaseUrl) continue;
    }

    const value = mapping.transform ? mapping.transform(raw) : raw;
    setNested(result, mapping.path, value);
  }

  return result;
}

// ─── Layer 3: CLI (reserved) ──────────────────────────────────────

/** CLI 参数覆盖（预留，当前 passthrough） */
export function applyCliOverrides(
  data: Record<string, unknown>,
  _cliArgs: Record<string, unknown>,
): Record<string, unknown> {
  return data;
}

// ─── Full Pipeline ────────────────────────────────────────────────

/** 完整解析管线：file → env → CLI → schema parse */
export function resolveConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const fileData = readYamlFile(configPath);
  const withEnv = applyEnvOverrides(fileData, env);
  const withCli = applyCliOverrides(withEnv, {});
  return AppConfigSchema.parse(withCli) as AppConfig;
}
