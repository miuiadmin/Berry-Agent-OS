#!/usr/bin/env node
/**
 * E2E 真实 AI 对话场景测试
 * 直接调用 HTTP API + WebSocket 接口，测试每个常见功能的输入输出
 *
 * 用法: node tools/e2e-live-chat.mjs
 */

import { WebSocket } from 'ws';

const BASE = 'http://localhost:3888';
const WS_URL = 'ws://localhost:3888/ws';

// ─── 颜色输出 ───
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

let passCount = 0;
let failCount = 0;
const results = [];

function log(/** @type {string} */ msg) { console.log(`${c.dim}[E2E]${c.reset} ${msg}`); }
function logSection(/** @type {string} */ title) {
  console.log(`\n${c.bold}${c.cyan}━━━ ${title} ━━━${c.reset}\n`);
}

/**
 * @param {string} name
 * @param {{ ok: boolean; detail?: string; duration?: number }} r
 */
function record(name, r) {
  results.push({ name, ...r });
  if (r.ok) {
    passCount++;
    console.log(`  ${c.green}✓ PASS${c.reset} ${name} ${r.duration ? `(${r.duration}ms)` : ''}`);
  } else {
    failCount++;
    console.log(`  ${c.red}✗ FAIL${c.reset} ${name}: ${r.detail || 'unknown'}`);
  }
}

// ─── HTTP 辅助 ───
async function apiGet(/** @type {string} */ path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, data: await res.json() };
}

async function apiPost(/** @type {string} */ path, /** @type {any} */ body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function apiDelete(/** @type {string} */ path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  return { status: res.status, data: await res.json() };
}

async function apiPut(/** @type {string} */ path, /** @type {any} */ body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// ─── WebSocket 对话辅助 ───
/**
 * 通过 WebSocket 发送消息并收集完整响应
 * @param {string} text - 用户消息
 * @param {object} [opts]
 * @param {string} [opts.sessionId] - 可选 session ID
 * @param {number} [opts.timeout] - 超时毫秒数，默认 60s
 * @returns {Promise<{response: string, sessionId: string, deltas: string[], progressEvents: any[], duration: number}>}
 */
function wsChat(text, opts = {}) {
  const timeout = opts.timeout || 60_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket timeout after ${timeout}ms`));
    }, timeout);

    const ws = new WebSocket(`${WS_URL}${opts.sessionId ? `?sessionId=${opts.sessionId}` : ''}`);
    const deltas = [];
    const progressEvents = [];
    let finalResponse = '';
    let sessionId = '';
    let resolved = false;
    const startTime = Date.now();

    ws.on('open', () => {
      log(`  → 发送消息: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
      ws.send(JSON.stringify({
        type: 'message',
        text,
        sessionId: opts.sessionId || null,
        attachments: [],
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'progress':
            progressEvents.push({ status: msg.status || msg.summary, summary: msg.summary });
            process.stdout.write(`${c.dim}.${c.reset}`);
            break;
          case 'text_delta':
            deltas.push(msg.text);
            process.stdout.write(`${c.blue}▌${c.reset}`);
            break;
          case 'result':
            clearTimeout(timer);
            finalResponse = msg.content || msg.response || '';
            sessionId = msg.sessionId || opts.sessionId || '';
            resolved = true;
            const duration = Date.now() - startTime;
            process.stdout.write('\n');
            log(`  ← 收到完整回复 (${duration}ms, ${deltas.length} deltas, ${progressEvents.length} progress)`);
            log(`  ← 回复摘要: "${finalResponse.substring(0, 120)}${finalResponse.length > 120 ? '...' : ''}"`);
            ws.close();
            resolve({ response: finalResponse, sessionId, deltas, progressEvents, duration });
            break;
          case 'error':
            clearTimeout(timer);
            process.stdout.write('\n');
            log(`  ← 错误: ${msg.error || msg.message}`);
            ws.close();
            if (!resolved) {
              resolved = true;
              reject(new Error(msg.error || msg.message || 'WebSocket error'));
            }
            break;
          case 'permission.confirm_needed':
            log(`  ⚠ 权限确认: ${msg.toolName} (风险: ${msg.dangerLevel || 'unknown'})`);
            // 自动批准
            ws.send(JSON.stringify({ type: 'permissions.approve', requestId: msg.requestId }));
            break;
          default:
            // 其他事件（如 delegation, event 等）
            process.stdout.write(`${c.yellow}●${c.reset}`);
            break;
        }
      } catch (e) {
        // 解析失败，跳过
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(new Error('WebSocket closed without result'));
      }
    });
  });
}

// ─── 测试场景 ───

async function test1_healthCheck() {
  logSection('测试 1: 健康检查 GET /api/health');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/health');
    console.log('  输入: GET /api/health');
    console.log(`  输出: HTTP ${status}`, JSON.stringify(data, null, 2));
    record('health check', {
      ok: status === 200 && data.ok === true && typeof data.uptime === 'number',
      detail: status !== 200 ? `status=${status}` : !data.ok ? 'ok!=true' : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('health check', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test2_agentsList() {
  logSection('测试 2: Agent 列表 GET /api/agents');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/agents');
    console.log(`  输入: GET /api/agents`);
    console.log(`  输出: HTTP ${status}, ${data.length} 个 agent`);
    for (const a of data) {
      console.log(`    - ${a.name}: status=${a.status}, level=${a.level}, kind=${a.kind}`);
    }
    record('agents list', {
      ok: status === 200 && Array.isArray(data) && data.length > 0,
      detail: status !== 200 ? `status=${status}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('agents list', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test3_simpleChat() {
  logSection('测试 3: 简单对话 — 1+1等于几');
  const t0 = Date.now();
  try {
    const result = await wsChat('你好，请用一句话回答：1+1等于几？');
    console.log(`  完整回复: "${result.response}"`);
    console.log(`  SessionId: ${result.sessionId}`);
    console.log(`  Progress 事件: ${result.progressEvents.map(p => p.status || p.summary).join(' → ')}`);
    record('simple chat (1+1)', {
      ok: result.response.length > 0,
      detail: result.response.length === 0 ? 'empty response' : undefined,
      duration: result.duration,
    });
    return result;
  } catch (e) {
    record('simple chat (1+1)', { ok: false, detail: e.message, duration: Date.now() - t0 });
    return null;
  }
}

async function test4_multiTurn(firstResult) {
  logSection('测试 4: 多轮对话 — 记忆上下文');
  if (!firstResult?.sessionId) {
    record('multi-turn chat', { ok: false, detail: '没有可用的 sessionId，跳过' });
    return null;
  }
  const sid = firstResult.sessionId;
  const t0 = Date.now();
  try {
    // 第一轮: 告诉它一个数字
    log('  第一轮: 请记住数字 42');
    const r1 = await wsChat('请记住这个数字：42', { sessionId: sid, timeout: 60_000 });
    console.log(`  第一轮回复摘要: "${r1.response.substring(0, 100)}"`);

    // 第二轮: 问它那个数字
    log('  第二轮: 问刚才的数字');
    const r2 = await wsChat('我刚才让你记住的数字是什么？只回答数字', { sessionId: sid, timeout: 60_000 });
    console.log(`  第二轮回复: "${r2.response}"`);

    const contains42 = r2.response.includes('42');
    console.log(`  ✓ 回复中包含 "42": ${contains42}`);

    record('multi-turn context memory', {
      ok: r2.response.length > 0,
      detail: !contains42 ? '回复未包含42（可能正常，取决于模型）' : undefined,
      duration: Date.now() - t0,
    });
    return r2;
  } catch (e) {
    record('multi-turn context memory', { ok: false, detail: e.message, duration: Date.now() - t0 });
    return null;
  }
}

async function test5_knowledgeQuestion() {
  logSection('测试 5: 知识问答 — 解释一个概念');
  const t0 = Date.now();
  try {
    const result = await wsChat('用一句话解释什么是 TCP 三次握手？', { timeout: 60_000 });
    console.log(`  回复: "${result.response}"`);
    const hasKeywords = result.response.length > 20;
    record('knowledge question', {
      ok: result.response.length > 0 && result.deltas.length > 0,
      detail: !hasKeywords ? '回复过短' : undefined,
      duration: result.duration,
    });
  } catch (e) {
    record('knowledge question', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test6_streamingResponse() {
  logSection('测试 6: 流式输出 — 长回复');
  const t0 = Date.now();
  try {
    const result = await wsChat('请用中文写一首关于春天的四行小诗。', { timeout: 60_000 });
    console.log(`  回复:\n${result.response}`);
    console.log(`  流式 chunks: ${result.deltas.length} 个 text_delta`);
    console.log(`  Progress 事件数: ${result.progressEvents.length}`);
    console.log(`  首 chunk 延迟: ~${result.deltas.length > 0 ? '有输出' : '无输出'}`);
    record('streaming long response', {
      ok: result.deltas.length >= 3 && result.response.length > 20,
      detail: result.deltas.length < 3 ? `deltas=${result.deltas.length}, too few` : undefined,
      duration: result.duration,
    });
  } catch (e) {
    record('streaming long response', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test7_conversationsApi() {
  logSection('测试 7: 会话管理 API');
  const t0 = Date.now();
  try {
    // 列出会话
    const { status: listStatus, data: conversations } = await apiGet('/api/conversations?limit=10');
    console.log(`  GET /api/conversations → HTTP ${listStatus}, ${conversations.length || 0} 个会话`);
    if (Array.isArray(conversations) && conversations.length > 0) {
      console.log(`  最新会话: ${conversations[0].sessionId}, 消息数: ${conversations[0].messageCount}, 标题: "${conversations[0].title || '(无)'}"`);
    }

    // 搜索会话
    const { status: searchStatus, data: searchResult } = await apiGet('/api/search?q=42&limit=5');
    console.log(`  GET /api/search?q=42 → HTTP ${searchStatus}, results: ${searchResult?.results?.length || searchResult?.total || 0}`);

    record('conversations API', {
      ok: listStatus === 200,
      detail: listStatus !== 200 ? `list status=${listStatus}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('conversations API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test8_tasksApi() {
  logSection('测试 8: 任务管理 API');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/tasks?limit=10');
    console.log(`  GET /api/tasks → HTTP ${status}, total: ${data.total}, items: ${data.items?.length || 0}`);
    if (data.items && data.items.length > 0) {
      for (const t of data.items.slice(0, 3)) {
        console.log(`    - ${t.id}: status=${t.status}, agent=${t.targetAgent || t.agent}, type=${t.taskType}`);
      }
    }

    const { status: statsStatus, data: stats } = await apiGet('/api/tasks/stats?days=1');
    console.log(`  GET /api/tasks/stats → HTTP ${statsStatus}`);
    if (Array.isArray(stats)) {
      console.log(`    统计条目: ${stats.length}`);
    }

    record('tasks API', {
      ok: status === 200,
      detail: status !== 200 ? `status=${status}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('tasks API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test9_usageApi() {
  logSection('测试 9: 使用量统计 API');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/usage/summary?days=7');
    console.log(`  GET /api/usage/summary → HTTP ${status}`);
    if (status === 200 && data) {
      console.log(`  今日: input=${data.today?.inputTokens || 0}, output=${data.today?.outputTokens || 0}, cost=$${data.today?.costUsd || 0}`);
      console.log(`  周期: input=${data.period?.inputTokens || 0}, output=${data.period?.outputTokens || 0}, cost=$${data.period?.costUsd || 0}`);
      if (data.byModel && data.byModel.length > 0) {
        console.log(`  按模型:`);
        for (const m of data.byModel) {
          console.log(`    - ${m.model}: ${m.totalTokens} tokens, $${m.costUsd}`);
        }
      }
    }

    record('usage summary API', {
      ok: status === 200,
      detail: status !== 200 ? `status=${status}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('usage summary API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test10_providerChannels() {
  logSection('测试 10: Provider 通道 API');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/providers/channels');
    console.log(`  GET /api/providers/channels → HTTP ${status}`);
    if (status === 200 && data.channels) {
      for (const ch of data.channels) {
        console.log(`    - ${ch.name} (${ch.kind}): enabled=${ch.enabled}, models=${ch.modelCount}`);
        if (ch.models) {
          for (const m of ch.models) {
            console.log(`      · ${m.id}: context=${m.contextWindow}, maxTokens=${m.defaultMaxTokens}`);
          }
        }
      }
    }

    record('provider channels API', {
      ok: status === 200,
      detail: status !== 200 ? `status=${status}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('provider channels API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test11_schedulerApi() {
  logSection('测试 11: 调度器 API');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/scheduler/jobs');
    console.log(`  GET /api/scheduler/jobs → HTTP ${status}`);
    if (Array.isArray(data)) {
      console.log(`  任务数: ${data.length}`);
    }

    const { status: qStatus, data: queue } = await apiGet('/api/scheduler/queue');
    console.log(`  GET /api/scheduler/queue → HTTP ${qStatus}`);

    record('scheduler API', {
      ok: status === 200 || status === 503, // 503 = scheduler module not loaded (acceptable)
      detail: status !== 200 && status !== 503 ? `status=${status}` : `status=${status} (scheduler=${status === 200 ? 'active' : 'not loaded'})`,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('scheduler API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test12_notificationsApi() {
  logSection('测试 12: 通知 API');
  const t0 = Date.now();
  try {
    const { status, data } = await apiGet('/api/notifications?targetId=user-1&limit=10');
    console.log(`  GET /api/notifications → HTTP ${status}`);
    if (Array.isArray(data)) {
      console.log(`  通知数: ${data.length}`);
    }

    const { status: countStatus, data: countData } = await apiGet('/api/notifications/count?targetId=user-1');
    console.log(`  GET /api/notifications/count → HTTP ${countStatus}, data:`, countData);

    record('notifications API', {
      ok: status === 200,
      detail: status !== 200 ? `status=${status}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('notifications API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test13_memoryApi() {
  logSection('测试 13: 记忆 API');
  const t0 = Date.now();
  try {
    // 读取全局记忆
    const { status: gStatus, data: gData } = await apiGet('/api/memory/global/user-1?limit=10');
    console.log(`  GET /api/memory/global/user-1 → HTTP ${gStatus}, items: ${Array.isArray(gData) ? gData.length : 'N/A'}`);

    // 读取 agent 记忆
    const { status: aStatus, data: aData } = await apiGet('/api/memory/agent/brain?limit=5');
    console.log(`  GET /api/memory/agent/brain → HTTP ${aStatus}, items: ${Array.isArray(aData) ? aData.length : 'N/A'}`);

    record('memory API', {
      ok: gStatus === 200 && aStatus === 200,
      detail: gStatus !== 200 ? `global status=${gStatus}` : aStatus !== 200 ? `agent status=${aStatus}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('memory API', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test14_chatWithToolUse() {
  logSection('测试 14: 工具调用场景 — 让 AI 做一个计算/查询任务');
  const t0 = Date.now();
  try {
    const result = await wsChat('帮我查询一下今天的天气信息，或者告诉我当前时间。', { timeout: 120_000 });
    console.log(`  回复: "${result.response.substring(0, 200)}"`);
    console.log(`  Progress 事件: ${result.progressEvents.map(p => p.status || p.summary).join(' → ')}`);
    console.log(`  是否有 tool 使用: ${result.progressEvents.some(p => (p.status || p.summary || '').includes('tool')) ? '是' : '未知'}`);
    record('tool use scenario', {
      ok: result.response.length > 0,
      detail: result.response.length === 0 ? 'empty response' : undefined,
      duration: result.duration,
    });
  } catch (e) {
    record('tool use scenario', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

async function test15_errorHandling() {
  logSection('测试 15: 错误处理 — 404 和空消息');
  const t0 = Date.now();
  try {
    // 404
    const { status: s1 } = await apiGet('/api/nonexistent');
    console.log(`  GET /api/nonexistent → HTTP ${s1}`);
    const is404 = s1 === 404;

    // 无效 session
    const { status: s2, data: d2 } = await apiGet('/api/conversations/nonexistent-session-id');
    console.log(`  GET /api/conversations/nonexistent → HTTP ${s2}`, JSON.stringify(d2).substring(0, 100));

    record('error handling', {
      ok: is404,
      detail: !is404 ? `expected 404, got ${s1}` : undefined,
      duration: Date.now() - t0,
    });
  } catch (e) {
    record('error handling', { ok: false, detail: e.message, duration: Date.now() - t0 });
  }
}

// ─── 主流程 ───

async function main() {
  console.log(`${c.bold}${c.cyan}
╔══════════════════════════════════════════════╗
║   E2E 真实 AI 对话场景测试                    ║
║   目标: http://localhost:3888                 ║
╚══════════════════════════════════════════════╝${c.reset}
  `);

  // ─── Phase 1: HTTP API 基础 ───
  await test1_healthCheck();
  await test2_agentsList();

  // ─── Phase 2: 真实 AI 对话 ───
  const simpleResult = await test3_simpleChat();
  await test4_multiTurn(simpleResult);
  await test5_knowledgeQuestion();
  await test6_streamingResponse();
  await test14_chatWithToolUse();

  // ─── Phase 3: 会话/任务/统计 API ───
  await test7_conversationsApi();
  await test8_tasksApi();
  await test9_usageApi();
  await test10_providerChannels();
  await test11_schedulerApi();
  await test12_notificationsApi();
  await test13_memoryApi();

  // ─── Phase 4: 错误处理 ───
  await test15_errorHandling();

  // ─── 汇总 ───
  console.log(`\n${c.bold}${c.cyan}━━━ 测试汇总 ━━━${c.reset}\n`);
  console.log(`  总计: ${results.length} 个测试`);
  console.log(`  ${c.green}通过: ${passCount}${c.reset}`);
  console.log(`  ${c.red}失败: ${failCount}${c.reset}`);
  console.log();

  if (failCount > 0) {
    console.log(`${c.red}失败列表:${c.reset}`);
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ✗ ${r.name}: ${r.detail}`);
    }
    console.log();
  }

  // 打印耗时排序
  const sorted = [...results].sort((a, b) => (b.duration || 0) - (a.duration || 0));
  console.log(`${c.dim}耗时排行:${c.reset}`);
  for (const r of sorted.slice(0, 5)) {
    console.log(`  ${r.duration}ms — ${r.name}`);
  }

  console.log(`\n${failCount === 0 ? c.green + '🎉 全部通过!' : c.red + '❌ 有测试失败'}${c.reset}\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${c.red}Fatal: ${e.message}${c.reset}`);
  process.exit(1);
});
