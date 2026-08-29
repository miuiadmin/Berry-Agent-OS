#!/usr/bin/env node
/**
 * 真模型端到端冒烟（dev 工具，不入产品码——拓扑门禁只扫 src/，与测试文件同豁免口径）。
 *
 * 用途：M1/M2 验收形态「真模型端到端」的可重复冒烟。走 **真应用注册面**——
 * runtime.llm.registerProvider 注册一个 Anthropic 兼容代理 provider（Claude Code
 * 同款环境约定 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN），与 M2 provider 应用
 * 将来走的 seam 完全一致（顺带实证注册面 + 模型解析 + streamFn 每调用解析）。
 *
 * pi-ai 内置 anthropic provider 不认 ANTHROPIC_BASE_URL（baseUrl 烧死在目录里），
 * 故代理场景必须自定义 provider——这正是 registerProvider 存在的理由。
 *
 * 五轮验收流与重开库自检住 tools/smoke-flow.mjs（与金样回放 smoke-replay.mjs
 * 同文共用——同一段验收逻辑无 key 可重复跑，2026-08-24 演进史读码行动 5 兑现）。
 *
 * 金样录制（record-once）：设 SMOKE_GOLDEN_RECORD=<路径.jsonl> 即在 StreamFn
 * seam 逐调用录制终态 AssistantMessage——每次模型调用一行（按调用序号 i），
 * 末尾按 i 排序落盘并校验连续。录制只吃 streamFn 面：ctx.llm.complete（memory
 * 周期 review 走的那条路）不经过本 seam，不进金样——回放侧该路无 provider
 * 同步失败被 fire-and-forget 吞掉，不影响流程确定性。
 *
 * 用法：
 *   ANTHROPIC_BASE_URL=http://… ANTHROPIC_AUTH_TOKEN=sk-… \
 *     npx tsx tools/smoke-real.mjs "提示词" [模型id（缺省 glm-5.3）]
 *   # 带金样录制：
 *   SMOKE_GOLDEN_RECORD=tools/golden/smoke-glm53.jsonl npx tsx tools/smoke-real.mjs "提示词"
 *
 * 环境变量（全部可选）：
 *   SMOKE_DATA_DIR    数据目录（缺省 mktemp 临时目录——不污染 ~/.berry；
 *                     复用同目录可冒烟跨会话记忆/检索/召回链）
 *   SMOKE_WORKSPACE   工作区（缺省 mktemp 临时目录）
 *   SMOKE_GOLDEN_RECORD  金样输出路径（设了才录制；目录须已存在）
 *
 * 安全纪律：凭证只从环境读取、绝不回显；输出零脱敏需求。
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createRuntime } from '../src/app/assembly.js';
import { createLlmRuntime, createStreamFn } from '../src/llm/index.js';
import { runSmokeFlow } from './smoke-flow.mjs';
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
/** 金样录制路径（可选——设了才逐调用录制） */
const goldenPath = process.env['SMOKE_GOLDEN_RECORD'];

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

/* ---------------- 金样录制包装（record-once；SMOKE_GOLDEN_RECORD 设了才装） ---------------- */

/** 已录条目（乱序到达按 i 归位——result() 结算序即到达序） */
const recordEntries = [];
/** 调用序号分配器（streamFn 被调即分配——与回放侧消费序同构） */
let recordSeq = 0;

/** 把真 streamFn 包成「透传 + result() 侧录」的录制版：迭代事件原样直通，只在最终消息结算时落一行 */
function recordWrap(inner) {
  return async (context, options, signal) => {
    const stream = await inner(context, options, signal);
    const i = recordSeq++;
    const origResult = stream.result.bind(stream);
    const iterator = stream[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }),
      result: async () => {
        const message = await origResult();
        recordEntries.push({ i, model: options.model, message });
        return message;
      },
    };
  };
}

/**
 * 落盘金样：按 i 排序 + 连续性校验（断裂 = 有调用未被 result() 结算，回放必失步
 * ——录制侧响亮失败优于回放侧静默错位），首行 _meta 供回放侧取模型/提示词。
 */
function finalizeGolden() {
  recordEntries.sort((a, b) => a.i - b.i);
  for (let k = 0; k < recordEntries.length; k += 1) {
    if (recordEntries[k].i !== k) {
      throw new Error(`金样索引断裂：${recordEntries.map((e) => e.i).join(',')}（存在未结算调用）`);
    }
  }
  const meta = {
    _meta: {
      recordedAt: new Date().toISOString(),
      model: `${providerId}/${modelId}`,
      prompt,
      entryCount: recordEntries.length,
      berryCommit: execSync('git rev-parse --short HEAD', { cwd: new URL('..', import.meta.url).pathname })
        .toString()
        .trim(),
      note: 'record-once 金样：streamFn seam 逐调用终态；回放 = npx tsx tools/smoke-replay.mjs',
    },
  };
  const lines = [JSON.stringify(meta), ...recordEntries.map((e) => JSON.stringify(e))];
  writeFileSync(goldenPath, `${lines.join('\n')}\n`);
  console.log(`[golden] 已录制 ${recordEntries.length} 条 → ${goldenPath}`);
}

/* ---------------- 装配 + 注册 + 跑流 ---------------- */

// 录制模式：自持 llm 运行时构造真 streamFn 再包录制层（组装根的 streamFn 覆盖位
// 注入——子代理工厂同享此 streamFn，委派轮一并入样）。非录制模式不带 streamFn
// 覆盖——组装根自建，行为与历史冒烟完全一致。
const streamFn = goldenPath ? recordWrap(createStreamFn(createLlmRuntime({ providers: [provider] }))) : undefined;

const runtime = await createRuntime({
  model: `${providerId}/${modelId}`,
  ...(streamFn ? { streamFn } : {}),
  dbPath: join(smokeData, 'sessions.db'),
  workspace: smokeWorkspace,
  // homeDir 指到空目录：技能扫描零噪音（隔离 old-v2 存量 ~/.berry/skills）
  homeDir: mkdtempSync(join(realpathSync(tmpdir()), 'berry-smoke-home-')),
  // 组合树目录显式隔离（与 smoke-replay 同款）：缺省回落真实 ~/.berry——用户
  // 装机历史（overlay 行）会污染录制装配，金样与回放从此两读两漂
  compositionDir: join(smokeData, 'composition'),
});

// 真装载面注册（M2 provider 应用同 seam）；resolveModel 每调用解析——注册后即生效。
// 录制模式下 host 侧也照注册：ctx.llm.complete（周期 review 路不走 streamFn）仍可真调。
runtime.llm.registerProvider(provider);

console.log(`[smoke] provider 注册 ✓${goldenPath ? '（金样录制中：SMOKE_GOLDEN_RECORD）' : ''}`);

const flow = await runSmokeFlow({ runtime, prompt, smokeData });
console.log(`[smoke] data=${smokeData}  workspace=${smokeWorkspace}`);

if (goldenPath) finalizeGolden();
process.exit(flow.ok ? 0 : 1);
