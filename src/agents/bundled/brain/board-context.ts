/**
 * 板上下文渲染（架构升级 16.0 P4-B1）—— 供 brain 看板注入 prompt 的纯渲染。
 *
 * 镜像 observation-context.ts 的范式：纯函数（数据作参）+ 字符预算 + 单测友好。
 * brain/entry.ts 在 checkpoint/review handler 里用 getBoardContext(taskId) 取板上下文，
 * 传给本函数渲染成多行文本，拼到 systemPrompt（§4.2 brain 看板 + §10.1 分级看板 LLM 下钻）。
 *
 * 渲染三段（§10.5 brain 看板上下文 = 活跃窗口 + 元数据 + 花名册）：
 *   1. 板元数据：goal / status / leader / 深度 / 发言预算
 *   2. 花名册：成员（leader 标记）
 *   3. 近期发言窗口：每条 BoardMessage 一行（按 type 取摘要 + 字符预算防噪声）
 *
 * 冻结快照模式（15.0 设计原则 2）：本函数纯渲染，调用方一次取 ctx 后多次渲染同结果，
 * 保护 prompt cache（板内容在增长，但同一轮 brain 调用内 ctx 不变）。
 */

import type { BoardContext } from '../../../kernel/board-repo.js';
import type { BoardMessage } from '../../../contracts/board-message.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { routeGovernance } from '../../../kernel/flows/governance-switch.js';

/** 每条发言的字符预算（防单条长输出占满 brain 上下文） */
const MESSAGE_BUDGET = 200;
/** goal / 摘要的字符预算 */
const SUMMARY_BUDGET = 200;

/**
 * 从一条 BoardMessage 提取一行摘要（按 type 取最相关的字段）。
 * 纯函数，供 {@link renderBoardContext} 渲染近期发言窗口。
 */
function summarizeMessage(msg: BoardMessage): string {
  switch (msg.type) {
    case 'delegate':
      return `@指派 ${msg.to}：${msg.subTaskGoal}`;
    case 'report':
      return `@成果(${msg.status}) ${msg.to}：${msg.summary}`;
    case 'tell':
      return `@发言 ${msg.to}：${msg.text}`;
    case 'ask':
      return `@求助(${msg.to})：${msg.question}`;
    case 'tool_request':
      return `@工具 ${msg.toolName}`;
    case 'tool_result':
      return `@工具结果 ok=${msg.ok}`;
    case 'command':
      return `@指令(${msg.intent}) ${msg.to}：${msg.instruction}`;
  }
}

/**
 * 把板上下文渲染为 brain 看板 prompt 片段（纯函数）。
 *
 * @param ctx getBoardContext 返回的板上下文（meta + members + recentMessages）
 * @returns 多行文本（元数据 + 花名册 + 近期发言）；调用方负责拼到 systemPrompt 加章节标题
 */
export function renderBoardContext(ctx: BoardContext): string {
  const m = ctx.meta;
  const lines: string[] = [];
  // 1. 板元数据
  lines.push(`目标: ${safeSlice(m.goal ?? '(无目标)', SUMMARY_BUDGET)}`);
  lines.push(
    `状态: ${m.boardStatus} | leader: ${m.leader ?? '?'} | 深度: ${m.spawnDepth}/${m.maxSpawnDepth} | 发言: ${m.turnCount}/${m.maxTurns} (共 ${ctx.totalMessages})`,
  );
  // 2. 花名册（leader 标记，§6）
  if (ctx.members.length > 0) {
    const roster = ctx.members
      .map((mem) => (mem.role === 'leader' ? `${mem.agentId}(leader)` : mem.agentId))
      .join(', ');
    lines.push(`成员: ${roster}`);
  }
  // 3. 近期发言窗口（每条一行摘要 + 字符预算）
  if (ctx.recentMessages.length > 0) {
    lines.push('近期发言:');
    for (const msg of ctx.recentMessages) {
      lines.push(`  [${msg.type}] ${msg.from}→${msg.to}: ${safeSlice(summarizeMessage(msg), MESSAGE_BUDGET)}`);
    }
    // 4. 治理分类摘要（用 governance-switch.routeGovernance 分类近期消息，让 brain 看到治理视图：
    //    这个板有多少工具闸/审核/纠偏/求助——而非裸消息类型，辅助 brain 决定治理动作）
    const govCounts = { gate: 0, review: 0, escalate: 0, command: 0, none: 0 };
    for (const msg of ctx.recentMessages) {
      const route = routeGovernance(msg);
      if (route.kind === 'gate') govCounts.gate++;
      else if (route.kind === 'review') govCounts.review++;
      else if (route.kind === 'escalate' || route.kind === 'peer_help') govCounts.escalate++;
      else if (route.kind === 'command') govCounts.command++;
      else govCounts.none++;
    }
    lines.push(`治理: ${govCounts.gate}工具闸 ${govCounts.review}审核 ${govCounts.command}纠偏 ${govCounts.escalate}求助 ${govCounts.none}发言`);
  }
  return lines.join('\n');
}
