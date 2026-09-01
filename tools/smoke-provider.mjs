/**
 * 冒烟代理 provider 共享层（dev 工具，不入产品码——拓扑门禁只扫 src/）。
 *
 * 真模型冒烟（smoke-real.mjs）与双载体冒烟（smoke-carrier.mjs）的 provider
 * 构造此前逐字重复 ~34 行（基建大扫 #34：样板两处漂移风险——一处改认证形
 * 另一处忘跟）。抽单点：env 约定读取 + 缺参用法退出 + provider 构造。
 *
 * 与 pi-ai 内置 anthropic provider 同形，仅 baseUrl/认证来源不同：pi-ai 内置
 * 不认 ANTHROPIC_BASE_URL（baseUrl 烧死在模型目录里），冒烟走 Claude Code
 * 代理约定（ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN Bearer）。
 *
 * 安全纪律：凭证只从环境读取、绝不回显。
 */

import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

/** 自定义 provider id（两冒烟同值——模型标识 = `${PROXY_PROVIDER_ID}/${modelId}`；
 *  导出供驱动侧拼 CLI/金样 _meta 的模型引用串） */
export const PROXY_PROVIDER_ID = 'anthropic-proxy';

/** 读代理环境约定（Claude Code 约定；只读不回显） */
export function readProxyEnv() {
  return {
    baseUrl: process.env['ANTHROPIC_BASE_URL'],
    token: process.env['ANTHROPIC_AUTH_TOKEN'],
  };
}

/**
 * 缺参即用法退出（exit 2）——返回补齐后的 { baseUrl, token }，调用方免再判空。
 * @param usage 用法行里的脚本调用形（如 `tools/smoke-real.mjs "提示词" [模型id]`）
 */
export function requireProxyEnv(usage) {
  const { baseUrl, token } = readProxyEnv();
  if (!baseUrl || !token) {
    console.error(`用法: ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=… npx tsx ${usage}`);
    process.exit(2);
  }
  return { baseUrl, token };
}

/**
 * 构造 Anthropic 兼容代理 provider（单模型目录——成本零占位，冒烟不核算）。
 * @param baseUrl 代理端点（requireProxyEnv 已校验非空）
 * @param token Bearer 凭证（只进认证头，绝不回显）
 * @param modelId 模型 id（驱动侧 argv 已解析——缺省值语义属各脚本，不在此收编）
 */
export function buildProxyProvider({ baseUrl, token, modelId }) {
  return createProvider({
    id: PROXY_PROVIDER_ID,
    name: 'Anthropic 兼容代理（Claude Code 环境约定）',
    baseUrl,
    auth: {
      // 单一 api-key 认证位：resolve 返回 Bearer 头（与 pi-ai anthropic 的
      // ANTHROPIC_AUTH_TOKEN 分支同形——存储凭证优先级在此不适用，冒烟只走 env）
      apiKey: {
        name: 'ANTHROPIC_AUTH_TOKEN (Bearer)',
        login: async () => {
          throw new Error('冒烟 provider 不支持交互登录');
        },
        resolve: async () => ({
          auth: { headers: { Authorization: `Bearer ${token}` } },
          source: 'ANTHROPIC_AUTH_TOKEN',
        }),
      },
    },
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'anthropic-messages',
        provider: PROXY_PROVIDER_ID,
        baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ],
    api: anthropicMessagesApi(),
  });
}
