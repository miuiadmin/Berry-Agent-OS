#!/usr/bin/env node
/**
 * 真模型端到端冒烟（dev 工具，不入产品码——拓扑门禁只扫 src/，与测试文件同豁免口径）。
 *
 * 用途：M1/M2 验收形态「真模型端到端」的可重复冒烟。走 **真插件注册面**——
 * runtime.llm.registerProvider 注册一个 Anthropic 兼容代理 provider（Claude Code
 * 同款环境约定 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN），与 M2 provider 插件
 * 将来走的 seam 完全一致（顺带实证注册面 + 模型解析 + streamFn 每调用解析）。
 *
 * pi-ai 内置 anthropic provider 不认 ANTHROPIC_BASE_URL（baseUrl 烧死在目录里），
 * 故代理场景必须自定义 provider——这正是 registerProvider 存在的理由。
 *
 * M2-6 起含 memory 官方默认层结构性自检（模型行为只报告不判定）：
 *   - boot 面：组合树首行 memory activated / 工具九件（fs 四 + memory 五）
 *   - run 后面：durable 事件里的 tool/call 名称清单（memory_write 是否被模型使用）
 *   - 重开库面：迁移链 v1→v3 就位 + memories 行数 + session_fts 行数（活体镜像）
 *
 * 用法：
 *   ANTHROPIC_BASE_URL=http://… ANTHROPIC_AUTH_TOKEN=sk-… \
 *     npx tsx tools/smoke-real.mjs "提示词" [模型id（缺省 glm-5.3）]
 *
 * 环境变量（全部可选）：
 *   SMOKE_DATA_DIR   数据目录（缺省 mktemp 临时目录——不污染 ~/.berry；
 *                    复用同目录可冒烟跨会话记忆/检索/召回链）
 *   SMOKE_WORKSPACE  工作区（缺省 mktemp 临时目录）
 *
 * 安全纪律：凭证只从环境读取、绝不回显；输出零脱敏需求。
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBerryRuntime } from '../src/app/assembly.js';
import { MEMORY_MIGRATION, SESSION_FTS_MIGRATION } from '../src/memory/index.js';
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

// M2-4 起工厂 async（⑨b 装载 awaits）——boot 即完成官方默认层 memory 首行装载
const runtime = await createBerryRuntime({
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

/* ---- memory 官方默认层结构性自检（boot 面） ---- */
// 行存在看 composition.rows；激活状态看 plugins.list()（装载回灌的有状态面）
const hasMemoryRow = runtime.composition.rows.some((row) => row.id === 'memory');
const memoryStatus = runtime.plugins.list().find((row) => row.id === 'memory')?.status;
const toolNames = runtime.tools.list().map((def) => def.name);
const memoryTools = ['memory_write', 'memory_forget', 'memory_restore', 'memory_read', 'memory_search'];
const toolsOk = memoryTools.every((name) => toolNames.includes(name));
const bootMemoryOk = hasMemoryRow && memoryStatus === 'activated' && toolsOk;
console.log(
  `[smoke] 默认层 memory 行 ${hasMemoryRow ? '✓' : '✗'}  装载状态 ${memoryStatus ?? '(无)'}  工具 ${toolNames.length} 件（memory 五件${toolsOk ? '✓' : '✗'}）`,
);
// 简报段（空库物化跳过——有记忆才进 systemPrompt；此处只报告不判定）
console.log(
  `[smoke] systemPrompt 含记忆简报段: ${runtime.systemPrompt.includes('以下来自历史记忆') ? '✓' : '（空库跳过，属预期）'}`,
);

/* ---- subagent 官方默认层次行结构性自检（boot 面，纵切四） ---- */
const hasSubagentRow = runtime.composition.rows.some((row) => row.id === 'subagent');
const subagentStatus = runtime.plugins.list().find((row) => row.id === 'subagent')?.status;
const agentToolOk = toolNames.includes('agent');
const listSectionOk = runtime.systemPrompt.includes('可用子代理类型');
const bootSubagentOk = hasSubagentRow && subagentStatus === 'activated' && agentToolOk && listSectionOk;
console.log(
  `[smoke] 默认层 subagent 行 ${hasSubagentRow ? '✓' : '✗'}  装载状态 ${subagentStatus ?? '(无)'}  agent 工具${agentToolOk ? '✓' : '✗'}  清单段${listSectionOk ? '✓' : '✗'}`,
);

/* ---- goal 官方默认层第三行结构性自检（boot 面，goal 纵切二） ---- */
const hasGoalRow = runtime.composition.rows.some((row) => row.id === 'goal');
const goalStatus = runtime.plugins.list().find((row) => row.id === 'goal')?.status;
const goalTools = ['goal_get', 'goal_set', 'goal_update'];
const goalToolsOk = goalTools.every((name) => toolNames.includes(name));
const bootGoalOk = hasGoalRow && goalStatus === 'activated' && goalToolsOk;
console.log(
  `[smoke] 默认层 goal 行 ${hasGoalRow ? '✓' : '✗'}  装载状态 ${goalStatus ?? '(无)'}  工具三件${goalToolsOk ? '✓' : '✗'}`,
);

let failBoot = !bootMemoryOk || !bootSubagentOk || !bootGoalOk || !service;

try {
  const result = await runtime.conversation.submitOnce(prompt);
  const events = runtime.session?.events ?? [];
  const types = events.map((e) => e.type);
  console.log(`[smoke] 事件序: ${types.join(' → ')}`);
  // 模型实际用了哪些工具（行为只报告不判定——冒烟不替模型背书）
  const toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => String(e.data?.name ?? '?'));
  console.log(`[smoke] 工具调用: ${toolCalls.length ? toolCalls.join(', ') : '（无）'}`);
  const last = result?.messages.at(-1);
  const text =
    last && last.role === 'assistant'
      ? (last.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('')
      : '(无 assistant 文本)';
  console.log(`[smoke] status=${result?.status}  回答: ${text.slice(0, 300)}`);

  /* ---- subagent service 级真模型委派轮（纵切四——委派面冒烟，模型行为不判定） ---- */
  // 经 ctx.subagents 服务面前台委派（与插件委派工具同 provider 同工厂——真流真工具
  // 真结算）；子任务要求真用 ls 工具（工具过子管道守门）。
  let subagentOk = false;
  let childSessionId = '';
  try {
    const subagents = runtime.ctx.get('subagents');
    const run = subagents.start({
      provider: 'in-process',
      prompt: '调用 ls 工具查看工作区目录内容，然后用一条完整的消息报告你看到了什么。',
      label: '冒烟委派',
    });
    childSessionId = run.id;
    const settled = await run.result;
    run.dispose();
    const childText = settled.output ?? '';
    console.log(
      `[smoke] 委派结算: stopReason=${settled.stopReason}  汇报 ${childText.length} 字: ${childText.slice(0, 160)}`,
    );
    subagentOk = settled.stopReason === 'completed' && childText.trim() !== '';
  } catch (error) {
    console.error(`[smoke] 委派轮异常: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`[smoke] 委派面 ${subagentOk ? '✓' : '✗'}  子会话 ${childSessionId.slice(0, 8)}…`);

  /* ---- goal 真模型续跑轮（goal 纵切二——设定→推进→终态/续跑注入） ---- */
  // 结构性判定（模型行为只报告不判定）：① goal_update 工具真被调用过 且终态
  // completed；或 ② 续跑注入至少发生一次（durable user/message source=plugin:goal）。
  // 两条任一即「机制通」——模型是否一次做完是行为，机制是否运转是结构。
  let goalRoundOk = false;
  try {
    const callTool = (name, args) => {
      const def = runtime.tools.get(name);
      if (!def) throw new Error(`工具未注册：${name}`);
      return runtime.tools.toAgentTool(def).execute('smoke-goal', args);
    };
    const goalStateText = async () => {
      const result = await callTool('goal_get', {});
      return result.content[0]?.text ?? '';
    };
    await callTool('goal_set', {
      objective: '在工作区创建 goal-smoke.txt，内容为一行「goal 冒烟完成」',
      tokenBudget: 50_000,
    });
    console.log(`[smoke] goal 已设定:\n${await goalStateText()}`);
    await runtime.conversation.submitOnce('请推进当前目标：按目标内容做完，然后调用 goal_update 申报完成并附证据。');
    // 续跑链等待：结算 → 注入 → 新轮 → …… 直到终态或 12 轮上限（真模型轮次
    // 耗时不定，800ms 间隙 + settle 逐轮探）
    let goalTerminal = '';
    for (let round = 0; round < 12; round += 1) {
      await runtime.conversation.settle();
      const text = await goalStateText();
      const statusLine = text.split('\n').find((line) => line.startsWith('状态：')) ?? '';
      if (/状态：(completed|blocked|stopped)/.test(statusLine)) {
        goalTerminal = statusLine;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const sessionEvents = runtime.session?.events ?? [];
    const injections = sessionEvents.filter(
      (e) => e.type === 'user/message' && e.data?.source === 'plugin:goal',
    ).length;
    const goalUpdateCalled = sessionEvents.some((e) => e.type === 'tool/call' && e.data?.name === 'goal_update');
    goalRoundOk = (goalTerminal.includes('completed') && goalUpdateCalled) || injections > 0;
    console.log(
      `[smoke] goal 终态: ${goalTerminal || '（12 轮内未终——续跑链或预算所致）'}  续跑注入 ${injections} 次  goal_update 调用 ${goalUpdateCalled ? '✓' : '✗'}  → ${goalRoundOk ? '✓' : '✗'}`,
    );
  } catch (error) {
    console.error(`[smoke] goal 轮异常: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[smoke] data=${smokeData}  workspace=${smokeWorkspace}`);
  // 会话驱动完成即落库（write-behind 在 shutdown flush——下方 finally 保证）
  process.exitCode = failBoot || result?.status !== 'completed' || !subagentOk || !goalRoundOk ? 1 : 0;
} catch (error) {
  console.error(`[smoke] 未预期异常: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // 优雅关停：run 结算 → flush 屏障 → 关库 → ctx 回卷（骨架篇 §1.3）
  await runtime.shutdown();
  // 落库自检：重开库（带全迁移链 v1→v5——goal 纵切二起 goals 表 v5；裸开少
  // 一段即拒开属设计）
  try {
    const { Persistence } = await import('../src/persist/index.js');
    const { GOAL_MIGRATION } = await import('../src/goal/index.js');
    const reopened = Persistence.open({
      path: join(smokeData, 'sessions.db'),
      migrations: [MEMORY_MIGRATION, SESSION_FTS_MIGRATION, GOAL_MIGRATION],
    });
    const ids = reopened.store.listSessionIds();
    const firstId = ids[0];
    const events = firstId ? (reopened.loadSession(firstId)?.events ?? []) : [];
    console.log(`[smoke] 重开库: ${ids.length} 会话 / ${events.length} 事件`);
    // subagent 面（纵切四）：委派子会话须落库且 origin='delegation'（结构性判定，
    // 不判内容——子汇报文本由上方委派轮已报告）
    const delegationIds = ids.filter((id) => reopened.loadSession(id)?.header.origin === 'delegation');
    console.log(
      `[smoke] 委派子会话落库 ${delegationIds.length ? '✓' : '✗'}（${delegationIds.length} 个 origin=delegation）`,
    );
    if (delegationIds.length === 0) process.exitCode = 1;
    // memory 结构面：memories 表行数（提取即时路+工具写路径）+ session_fts 行数（活体镜像）
    const db = reopened.store.connection;
    const count = (sql) => db.prepare(sql).get().n;
    const memoryCount = count('SELECT COUNT(*) AS n FROM memories');
    const ftsCount = count('SELECT COUNT(*) AS n FROM session_fts');
    const ftsSessions = count('SELECT COUNT(*) AS n FROM session_fts_state');
    console.log(`[smoke] memory 表 ${memoryCount} 条 / session_fts ${ftsCount} 行 / 水位 ${ftsSessions} 会话`);
    // goal 结构面（goal 纵切二）：goals 表行数 + 终态形态（结构性——主会话单行）
    const goalRows = db.prepare('SELECT session_id, status, stop_reason, tokens_used, token_budget FROM goals').all();
    console.log(
      `[smoke] goals 表 ${goalRows.length} 行: ${goalRows.map((g) => `${g.status}${g.stop_reason ? `/${g.stop_reason}` : ''} ${g.tokens_used}/${g.token_budget}t`).join('；') || '（无）'}`,
    );
    if (goalRows.length === 0) process.exitCode = 1;
    await reopened.close();
  } catch (error) {
    console.error(`[smoke] 重开库自检失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// （重开库自检即结束——文件写入断言由外部 shell 按需检查 workspace）
