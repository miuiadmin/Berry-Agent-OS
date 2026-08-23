#!/usr/bin/env node
/**
 * 真模型端到端冒烟（dev 工具，不入产品码——拓扑门禁只扫 src/，与测试文件同豁免口径）。
 *
 * 用途：M1 验收形态「真模型端到端」的可重复冒烟。走 **真插件注册面**——
 * runtime.llm.registerProvider 注册一个 Anthropic 兼容代理 provider（Claude Code
 * 同款环境约定 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN），与 M2 provider 插件
 * 将来走的 seam 完全一致（顺带实证注册面 + 模型解析 + streamFn 每调用解析）。
 *
 * pi-ai 内置 anthropic provider 不认 ANTHROPIC_BASE_URL（baseUrl 烧死在目录里），
 * 故代理场景必须自定义 provider——这正是 registerProvider 存在的理由。
 *
 * 用法：
 *   ANTHROPIC_BASE_URL=http://… ANTHROPIC_AUTH_TOKEN=sk-… \
 *     npx tsx tools/smoke-real.mjs "提示词" [模型id（缺省 glm-5.3）]
 *
 * 环境变量（全部可选）：
 *   SMOKE_DATA_DIR   数据目录（缺省 mktemp 临时目录——不污染 ~/.berry）
 *   SMOKE_WORKSPACE  工作区（缺省 mktemp 临时目录）
 *
 * 安全纪律：凭证只从环境读取、绝不回显；输出零脱敏需求。
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBerryRuntime } from '../src/app/assembly.js';
import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

/* ---------------- 环境与参数 ---------------- */

/** 代理端点（Claude Code 约定；缺省即退出——本脚本只为代理场景存在） */
const baseUrl = process.env['ANTHROPIC_BASE_URL'];
/** Bearer 凭证（Claude Code 约定；只读不回显） */
const token = process.env['ANTHROPIC_AUTH_TOKEN'];
/** 提示词（argv[2]） */
const prompt = process.argv[2];
/** 模型 id（argv[3]，缺省 glm-5.3——本环境代理的缺省服务模型） */
const modelId = process.argv[3] ?? 'glm-5.3';
/** 自定义 provider id（模型标识 = `${providerId}/${modelId}`） */
const providerId = 'anthropic-proxy';

if (!baseUrl || !token || !prompt) {
  console.error('用法: ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=… npx tsx tools/smoke-real.mjs "提示词" [模型id]');
  process.exit(2);
}

/* ---------------- 临时目录（realpath 归一——macOS /var 前缀差异教训） ---------------- */

const smokeData = process.env['SMOKE_DATA_DIR'] ?? mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-data-'));
const smokeWorkspace = process.env['SMOKE_WORKSPACE'] ?? mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-ws-'));

/* ---------------- provider 构造（与 pi-ai anthropicProvider 同形，仅 baseUrl/认证来源不同） ---------------- */

const provider = createProvider({
  id: providerId,
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
      provider: providerId,
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

/* ---------------- 装配 + 注册 + 单轮 ---------------- */

const runtime = createBerryRuntime({
  model: `${providerId}/${modelId}`,
  dbPath: join(smokeData, 'sessions.db'),
  workspace: smokeWorkspace,
  // homeDir 指到空目录：技能扫描零噪音（隔离 old-v2 存量 ~/.berry/skills）
  homeDir: mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-home-')),
});

// 真插件面注册（M2 provider 插件同 seam）；resolveModel 每调用解析——注册后即生效
runtime.llm.registerProvider(provider);
// 顺带实证 ctx.llm 具名服务与底层运行时同源
const service = runtime.ctx.tryGet('llm');
console.log(`[smoke] provider 注册 ✓  ctx.llm 服务 ${service ? '✓' : '✗（缺 provide）'}`);

try {
  const result = await runtime.conversation.submitOnce(prompt);
  const types = (runtime.session?.events ?? []).map((e) => e.type);
  console.log(`[smoke] 事件序: ${types.join(' → ')}`);
  const last = result?.messages.at(-1);
  const text =
    last && last.role === 'assistant'
      ? (last.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
      : '(无 assistant 文本)';
  console.log(`[smoke] status=${result?.status}  回答: ${text.slice(0, 300)}`);
  console.log(`[smoke] data=${smokeData}  workspace=${smokeWorkspace}`);
  // 会话驱动完成即落库（write-behind 在 shutdown flush——下方 finally 保证）
  process.exitCode = result?.status === 'completed' ? 0 : 1;
} catch (error) {
  console.error(`[smoke] 未预期异常: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // 优雅关停：run 结算 → flush 屏障 → 关库 → ctx 回卷（骨架篇 §1.3）
  await runtime.shutdown();
  // 落库自检：重开库读事件数（崩溃恢复链的读侧）
  try {
    const { Persistence } = await import('../src/persist/index.js');
    const reopened = Persistence.open({ path: join(smokeData, 'sessions.db') });
    const ids = reopened.store.listSessionIds();
    const firstId = ids[0];
    const events = firstId ? (reopened.loadSession(firstId)?.events ?? []) : [];
    console.log(`[smoke] 重开库: ${ids.length} 会话 / ${events.length} 事件`);
    await reopened.close();
  } catch (error) {
    console.error(`[smoke] 重开库自检失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// （重开库自检即结束——文件写入断言由外部 shell 按需检查 workspace）
