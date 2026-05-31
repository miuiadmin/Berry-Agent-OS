/**
 * 声明式环境变量映射表
 *
 * 替代 env-resolver.ts 中的 if/else 链。
 * 添加新的环境变量只需在此表追加一条记录。
 */

/** 单条环境变量映射 */
export interface EnvMapping {
  /** 环境变量名 */
  env: string;
  /** 配置对象中的点分路径，如 "web.port" */
  path: string;
  /** 可选的值转换函数（如 parseInt） */
  transform?: (value: string) => unknown;
  /**
   * 如果为 true，仅当目标路径尚未有值时才应用。
   * 用于 provider-specific 环境变量的优先级降级。
   */
  fallbackOnly?: boolean;
  /** 可选条件谓词，仅当返回 true 时才应用 */
  condition?: (fileData: Record<string, unknown>) => boolean;
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

/** 按点分路径读取嵌套属性 */
export function getNested(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** 按点分路径设置嵌套属性（原地修改） */
export function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
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

// ─── 环境变量映射表 ──────────────────────────────────────────────────

/**
 * 环境变量 → 配置路径映射
 *
 * 优先级从低到高排列：provider-specific（带 fallbackOnly）排在前面，
 * 通用 LLM_* 变量排在后面（后写的覆盖先写的）。
 */
export const ENV_MAPPINGS: EnvMapping[] = [
  // ─── Web 配置 ─────────────────────────────────────────────
  { env: 'APP_PORT', path: 'web.port', transform: (v) => parseInt(v, 10) },
  { env: 'APP_HOST', path: 'web.host' },

  // ─── LLM 通用配置（先处理，设置顶级字段） ────────────────────
  { env: 'LLM_PROVIDER', path: 'llm.provider' },
  { env: 'LLM_BASE_URL', path: 'llm.baseUrl' },
  { env: 'LLM_API_KEY', path: 'llm.apiKey' },
  { env: 'LLM_MODEL', path: 'llm.model' },
  { env: 'APP_LLM_MODE', path: 'llm.mode' },

  // ─── LLM 模型层级 ──────────────────────────────────────────
  { env: 'LLM_MODEL_FAST', path: 'llm.models.fast' },
  { env: 'LLM_MODEL_DEFAULT', path: 'llm.models.default' },
  { env: 'LLM_MODEL_HIGH', path: 'llm.models.high' },

  // ─── LLM provider-specific（低优先级，后处理） ──────────────
  // 仅当顶级 llm.apiKey / llm.baseUrl 不存在时才生效
  // 由于 LLM_* 在前面已处理，此时数据中已有 LLM_* 的值
  {
    env: 'ANTHROPIC_API_KEY', path: 'llm.providers.anthropic.apiKey',
    condition: (d) => !getNested(d, 'llm.apiKey') && !getNested(d, 'llm.providers.anthropic.apiKey'),
  },
  {
    env: 'ANTHROPIC_BASE_URL', path: 'llm.providers.anthropic.baseUrl',
    condition: (d) => !getNested(d, 'llm.baseUrl') && !getNested(d, 'llm.providers.anthropic.baseUrl'),
  },
  {
    env: 'OPENAI_API_KEY', path: 'llm.providers.openai.apiKey',
    condition: (d) => !getNested(d, 'llm.apiKey') && !getNested(d, 'llm.providers.openai.apiKey'),
  },
  {
    env: 'OPENAI_BASE_URL', path: 'llm.providers.openai.baseUrl',
    condition: (d) => !getNested(d, 'llm.baseUrl') && !getNested(d, 'llm.providers.openai.baseUrl'),
  },
  {
    env: 'OPENAI_COMPATIBLE_API_KEY', path: 'llm.providers.openai-compatible.apiKey',
    condition: (d) => !getNested(d, 'llm.apiKey') && !getNested(d, 'llm.providers.openai-compatible.apiKey'),
  },
  {
    env: 'OPENAI_COMPATIBLE_BASE_URL', path: 'llm.providers.openai-compatible.baseUrl',
    condition: (d) => !getNested(d, 'llm.baseUrl') && !getNested(d, 'llm.providers.openai-compatible.baseUrl'),
  },
];
