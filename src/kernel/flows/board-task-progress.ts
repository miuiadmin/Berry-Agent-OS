/**
 * 16.0 §14.5 任务进展卡投影（从 board-projection.ts 拆出——board 状态 → task_progress block）。
 *
 * 3 个函数：
 *   - deriveTaskProgressFromBoard：board 状态 → task_progress 字段（goal/status/leader/members/activitySummary）
 *   - emitTaskProgressForBoard：board 活动 → collector.onTaskProgress emit（live 投影）
 *   - enrichTimelineWithTaskProgress：timeline 刷新时为含 delegation 块的消息重建 task_progress
 *
 * 自包含（依赖 board-repo + block-collector + governance-switch，不依赖 safePost）。
 */
import type { Block, DelegationBlock } from '../../contracts/message-blocks.js';
import { getLogger } from '../../utils/logger.js';
import { getBoardContext } from '../board-repo.js';
import { peekBlockCollector } from '../block-collector.js';
import { routeGovernance } from './governance-switch.js';

const logger = getLogger('board-projection');

/** 从 board 状态派生任务进展卡的字段。无 board / 失败 → null。 */
export function deriveTaskProgressFromBoard(taskId: string): {
  goal: string; status: string; leader?: string; members: string[];
  turnCount: number; maxTurns: number; spawnDepth: number; activitySummary: string;
} | null {
  try {
    const ctx = getBoardContext(taskId, 10);
    if (!ctx) return null;
    const counts = { gate: 0, review: 0, escalate: 0, command: 0, none: 0 };
    for (const m of ctx.recentMessages) {
      const route = routeGovernance(m);
      if (route.kind === 'gate') counts.gate++;
      else if (route.kind === 'review') counts.review++;
      else if (route.kind === 'escalate' || route.kind === 'peer_help') counts.escalate++;
      else if (route.kind === 'command') counts.command++;
      else counts.none++;
    }
    return {
      goal: ctx.meta.goal ?? '(无目标)', status: ctx.meta.boardStatus,
      leader: ctx.meta.leader ?? undefined, members: ctx.members.map((mem) => mem.agentId),
      turnCount: ctx.meta.turnCount, maxTurns: ctx.meta.maxTurns, spawnDepth: ctx.meta.spawnDepth,
      activitySummary: `${counts.gate}工具闸 ${counts.review}审核 ${counts.command}纠偏 ${counts.escalate}求助 ${counts.none}发言`,
    };
  } catch { return null; }
}

/** §14.5 board 活动 → peekBlockCollector(taskId).onTaskProgress emit。live-only fire-and-forget。 */
export function emitTaskProgressForBoard(taskId: string): void {
  const collector = peekBlockCollector(taskId);
  if (!collector) return;
  const opts = deriveTaskProgressFromBoard(taskId);
  if (opts) collector.onTaskProgress(opts);
}

/** §14.5 timeline 刷新重建：对含 delegation 块的消息，从 board 状态重建 task_progress 块追加到 blocks。 */
export function enrichTimelineWithTaskProgress<T extends { id: string; blocks?: Block[] }>(messages: T[]): T[] {
  for (const msg of messages) {
    const blocks = msg.blocks;
    if (!blocks || blocks.length === 0) continue;
    if (blocks.some((b) => b.type === 'task_progress')) continue;
    const deleg = blocks.find((b): b is DelegationBlock => b.type === 'delegation');
    if (!deleg) continue;
    const opts = deriveTaskProgressFromBoard(deleg.id);
    if (!opts) continue;
    blocks.push({ type: 'task_progress', id: `${msg.id}#taskprog`, ...opts });
  }
  return messages;
}
