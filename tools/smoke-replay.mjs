#!/usr/bin/env node
/**
 * 金样回放冒烟（dev 工具，不入产品码——拓扑门禁只扫 src/）。
 *
 * 2026-08-24 演进史读码行动 5 挂账兑现（record-once / replay-deterministic）：
 * 把一次性真模型端到端冒烟变成 **无 key 可重复回归**。录制的金样（真模型在
 * streamFn seam 的逐调用终态 AssistantMessage）在这里逐调用回放——除模型层外
 * 全真：真装载（默认层四行）、真工具（三段管道过守门）、真委派子会话、真 goal
 * 状态机、真 memory 差分注入、真 durable 落库与重开库自检。
 *
 * 验收流与 smoke-real.mjs 同文共用（tools/smoke-flow.mjs）——同一段逻辑两种
 * 模型层来源。判定汇总 + 金样消费计数（恰好用尽 = 录制/回放同构；耗尽或剩余
 * = 流程与录制时发散，回归信号）双闸出口码。
 *
 * 确定性边界：回放索引按调用序（第 N 次模型调用 ← 第 N 条金样）；请求内容不
 * 参与匹配（工作区临时目录名/时间戳天然逐跑不同，响应固定故流程仍确定）。
 * ctx.llm.complete（memory 周期 review 路直通 pi-ai，不经 streamFn）在回放侧
 * 无 provider 同步失败——fire-and-forget 吞进日志，不影响流程与判定。
 * 实证（2026-08-25 录制/回放对账）：录制主会话 llm/usage 多 1 条 background
 * 侧账（callId 非 turn: 前缀 = review 真调），其余 19 条逐位一致——差源即
 * complete 不入样的确定性边界，属预期。
 *
 * 用法：
 *   npx tsx tools/smoke-replay.mjs [金样路径（缺省 tools/golden/smoke-glm53.jsonl）]
 */

import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/app/assembly.js';
import { runSmokeFlow } from './smoke-flow.mjs';

/* ---------------- 金样装载 ---------------- */

const goldenPath = process.argv[2] ?? fileURLToPath(new URL('./golden/smoke-glm53.jsonl', import.meta.url));
const rawLines = readFileSync(goldenPath, 'utf8').trim().split('\n');
/** 首行 _meta（模型/提示词/录制时刻）；其余每行一条 { i, model, message } */
const meta = JSON.parse(rawLines[0])._meta;
const golden = rawLines.slice(1).map((line) => JSON.parse(line));
console.log(
  `[replay] 金样装载: ${golden.length} 条  模型 ${meta.model}  录于 ${meta.recordedAt}（${meta.berryCommit}）`,
);

/* ---------------- 回放 streamFn（replay-deterministic） ---------------- */

/** 已消费指针（第 N 次调用取第 N 条——与录制序同构） */
let cursor = 0;
/** 每次调用的请求上下文留档（诊断面：发散时可比对调用现场） */
const contexts = [];

/** 合成流（start → done/error 两帧；与全栈测试 scripted 习语同形） */
function syntheticStream(message) {
  const isError = message.stopReason === 'error' || message.stopReason === 'aborted';
  const events = [
    { type: 'start', partial: { ...message, content: [] } },
    isError
      ? { type: 'error', reason: message.stopReason, error: message }
      : { type: 'done', reason: message.stopReason, message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < events.length
            ? Promise.resolve({ value: events[index++], done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
    result: async () => message,
  };
}

/** 金样耗尽的响亮失败流（永不抛错契约——错误编码为 error 终态消息） */
function exhaustedStream(callNo) {
  const message = {
    role: 'assistant',
    content: [{ type: 'text', text: `金样耗尽：第 ${callNo} 次模型调用无录制条目——回放流程与录制时发散（回归信号）` }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: 'error',
    timestamp: 0,
    errorMessage: 'GOLDEN_EXHAUSTED',
  };
  return syntheticStream(message);
}

/** 回放 streamFn：按调用序取条；上下文留档不参与匹配 */
const streamFn = (context, _options) => {
  contexts.push(context);
  const entry = golden[cursor];
  cursor += 1;
  return entry ? syntheticStream(entry.message) : exhaustedStream(cursor);
};

/* ---------------- 装配 + 跑流（无 key 无网） ---------------- */

const smokeData = mkdtempSync(join(realpathSync(tmpdir()), 'berry-replay-data-'));
const smokeWorkspace = mkdtempSync(join(realpathSync(tmpdir()), 'berry-replay-ws-'));

const runtime = await createRuntime({
  model: meta.model,
  streamFn,
  dbPath: join(smokeData, 'sessions.db'),
  workspace: smokeWorkspace,
  homeDir: mkdtempSync(join(realpathSync(tmpdir()), 'berry-replay-home-')),
  // 组合树目录显式隔离：缺省会回落真实 ~/.berry（dataDir() 不认 homeDir——
  // paths.ts 只读 APP_DATA_DIR env），用户装机历史（探矿 overlay 行）一旦存在
  // 即污染回放装配、破坏确定性。临时目录不存在 = 空 overlay，composition 侧
  // existsSync 全防御零炸（2026-08-27 金样轨确定性封口）
  compositionDir: join(smokeData, 'composition'),
});

const flow = await runSmokeFlow({ runtime, prompt: meta.prompt, smokeData });

/* ---------------- 双闸出口：流程判定 + 消费计数 ---------------- */

const consumedExactly = cursor === golden.length;
console.log(
  `[replay] 金样消费: ${Math.min(cursor, golden.length)}/${golden.length} 条${consumedExactly ? '（恰好用尽——录制/回放同构）' : cursor > golden.length ? '（耗尽——流程多出调用，发散）' : '（剩余——流程少跑调用，发散）'}`,
);
console.log(`[replay] data=${smokeData}  workspace=${smokeWorkspace}`);
process.exit(flow.ok && consumedExactly ? 0 : 1);
