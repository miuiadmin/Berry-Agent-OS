/**
 * 声明式环境变量映射表
 *
 * 添加新的环境变量覆盖只需增加一行记录，无需编写 if/else 分支。
 * 每条记录声明：哪个环境变量 → 映射到哪个配置路径 → 可选的值转换。
 */

/** 单条环境变量映射 */
export interface EnvMapping {
  /** 环境变量名 */
  env: string;
  /** 配置对象中的点分路径，如 "web.port"、"llm.models.fast" */
  path: string;
  /** 可选的值转换函数（如 parseInt） */
  transform?: (value: string) => unknown;
  /**
   * 仅作为兜底：当目标路径已有值时跳过。
   * 用于 provider-specific 变量（ANTHROPIC_API_KEY 等），它们不应覆盖
   * 更高优先级的通用变量（LLM_API_KEY）。
   */
  fallbackOnly?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** 按点分路径读取嵌套对象值 */
export function getNested(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 按点分路径设置嵌套对象值（就地修改） */
export function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

// ─── Mapping Table ────────────────────────────────────────────────

const int = (v: string) => parseInt(v, 10);

export const ENV_MAPPINGS: readonly EnvMapping[] = [
  // Web
  { env: 'APP_PORT', path: 'web.port', transform: int },
  { env: 'APP_HOST', path: 'web.host' },

  // LLM — 通用（最高优先级）
  { env: 'LLM_PROVIDER', path: 'llm.provider' },
  { env: 'LLM_BASE_URL', path: 'llm.baseUrl' },
  { env: 'LLM_API_KEY', path: 'llm.apiKey' },
  { env: 'LLM_MODEL', path: 'llm.model' },
  { env: 'APP_LLM_MODE', path: 'llm.mode' },

  // LLM — 模型分级
  { env: 'LLM_MODEL_FAST', path: 'llm.models.fast' },
  { env: 'LLM_MODEL_DEFAULT', path: 'llm.models.default' },
  { env: 'LLM_MODEL_HIGH', path: 'llm.models.high' },

  // LLM — Provider-specific（兜底：仅当通用变量未设置且文件中也无值时生效）
  { env: 'ANTHROPIC_API_KEY', path: 'llm.providers.anthropic.apiKey', fallbackOnly: true },
  { env: 'ANTHROPIC_BASE_URL', path: 'llm.providers.anthropic.baseUrl', fallbackOnly: true },
  { env: 'OPENAI_API_KEY', path: 'llm.providers.openai.apiKey', fallbackOnly: true },
  { env: 'OPENAI_BASE_URL', path: 'llm.providers.openai.baseUrl', fallbackOnly: true },
  { env: 'OPENAI_COMPATIBLE_API_KEY', path: 'llm.providers.openai-compatible.apiKey', fallbackOnly: true },
  { env: 'OPENAI_COMPATIBLE_BASE_URL', path: 'llm.providers.openai-compatible.baseUrl', fallbackOnly: true },
];
