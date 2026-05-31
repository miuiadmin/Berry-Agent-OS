/**
 * 环境变量覆盖解析器
 *
 * 纯函数：接收文件数据和 process.env，返回合并后的数据。
 * 可独立单测，不依赖任何运行时状态。
 */

/**
 * 从环境变量解析覆盖值，合并到文件数据上
 *
 * 覆盖优先级（由低到高）：
 * 1. YAML 文件值
 * 2. Zod schema 默认值
 * 3. 环境变量（最高优先级）
 */
export function resolveEnvOverrides(
  fileData: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  // ─── Web 配置 ─────────────────────────────────────────────
  if (env.APP_PORT || env.APP_HOST) {
    overrides.web = {
      ...((fileData.web as Record<string, unknown>) ?? {}),
      ...(env.APP_PORT && { port: parseInt(env.APP_PORT, 10) }),
      ...(env.APP_HOST && { host: env.APP_HOST }),
    };
  }

  // ─── LLM 配置 ─────────────────────────────────────────────
  if (env.LLM_BASE_URL || env.LLM_API_KEY || env.LLM_MODEL || env.APP_LLM_MODE
    || env.LLM_MODEL_FAST || env.LLM_MODEL_DEFAULT || env.LLM_MODEL_HIGH
    || env.LLM_PROVIDER || env.OPENAI_API_KEY || env.OPENAI_BASE_URL
    || env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL
    || env.OPENAI_COMPATIBLE_BASE_URL || env.OPENAI_COMPATIBLE_API_KEY) {
    const fileLlm = (fileData.llm as Record<string, unknown>) ?? {};
    const fileModels = (fileLlm.models as Record<string, unknown>) ?? {};
    const fileProviders = (fileLlm.providers as Record<string, unknown>) ?? {};
    const fileAnthropic = (fileProviders.anthropic as Record<string, unknown>) ?? {};
    const fileOpenai = (fileProviders.openai as Record<string, unknown>) ?? {};
    const fileCompat = (fileProviders['openai-compatible'] as Record<string, unknown>) ?? {};

    overrides.llm = {
      ...fileLlm,
      ...(env.LLM_PROVIDER && { provider: env.LLM_PROVIDER }),
      ...(env.LLM_BASE_URL && { baseUrl: env.LLM_BASE_URL }),
      ...(env.LLM_API_KEY && { apiKey: env.LLM_API_KEY }),
      ...(env.LLM_MODEL && { model: env.LLM_MODEL }),
      ...(env.APP_LLM_MODE && { mode: env.APP_LLM_MODE }),
      models: {
        ...fileModels,
        ...(env.LLM_MODEL_FAST && { fast: env.LLM_MODEL_FAST }),
        ...(env.LLM_MODEL_DEFAULT && { default: env.LLM_MODEL_DEFAULT }),
        ...(env.LLM_MODEL_HIGH && { high: env.LLM_MODEL_HIGH }),
      },
      providers: {
        anthropic: {
          ...fileAnthropic,
          ...(!env.LLM_BASE_URL && !fileLlm.baseUrl && !fileAnthropic.baseUrl && env.ANTHROPIC_BASE_URL && { baseUrl: env.ANTHROPIC_BASE_URL }),
          ...(!env.LLM_API_KEY && !fileLlm.apiKey && !fileAnthropic.apiKey && env.ANTHROPIC_API_KEY && { apiKey: env.ANTHROPIC_API_KEY }),
        },
        openai: {
          ...fileOpenai,
          ...(!env.LLM_BASE_URL && !fileLlm.baseUrl && !fileOpenai.baseUrl && env.OPENAI_BASE_URL && { baseUrl: env.OPENAI_BASE_URL }),
          ...(!env.LLM_API_KEY && !fileLlm.apiKey && !fileOpenai.apiKey && env.OPENAI_API_KEY && { apiKey: env.OPENAI_API_KEY }),
        },
        'openai-compatible': {
          ...fileCompat,
          ...(!env.LLM_BASE_URL && !fileLlm.baseUrl && !fileCompat.baseUrl && env.OPENAI_COMPATIBLE_BASE_URL && { baseUrl: env.OPENAI_COMPATIBLE_BASE_URL }),
          ...(!env.LLM_API_KEY && !fileLlm.apiKey && !fileCompat.apiKey && env.OPENAI_COMPATIBLE_API_KEY && { apiKey: env.OPENAI_COMPATIBLE_API_KEY }),
        },
      },
    };
  }

  return { ...fileData, ...overrides };
}
