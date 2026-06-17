/**
 * 16.0 重构——mission handoff 交接（从 mission-manager.ts 提取）。
 *
 * 4 个函数（行为保持式提取）：
 *   - executeHandoff：执行 from→to 交接（写 squad.json + emit mission.handoff）
 *   - readLatestHandoffContext：读最近 from→to handoff 的结构化上下文
 *   - readLatestHandoffContextAny：读最近任意 handoff 的上下文
 *   - renderHandoffContext：把 HandoffContext 渲染为 system prompt 文本
 *
 * 依赖：mission-paths（文件 I/O）+ contracts（SquadFile/HandoffContext 类型）。
 */
import type { SquadFile, Handoff } from '../../contracts/mission.js';
import type { HandoffContext } from '../../contracts/delegation.js';
import { readJsonFile, writeJsonFile, getSquadPath } from './mission-paths.js';

/** executeHandoff 的 emit 回调（mission-manager.emitEvent） */
type EmitEventFn = (type: string, payload: Record<string, unknown>) => void;

/** 执行交接（from squad → to squad）。写 squad.json + emit mission.handoff。行为保持。 */
export function executeHandoff(
  missionId: string, fromSquad: string, toSquad: string, what: string,
  content: string | undefined, sourceContext: HandoffContext | undefined,
  emitEvent: EmitEventFn,
): SquadFile | null {
  const squadFile = readJsonFile<SquadFile>(getSquadPath(missionId));
  if (!squadFile) return null;

  const handoffContent = sourceContext ? JSON.stringify(sourceContext) : (content ?? what);

  let handoff = squadFile.handoffs.find(h => h.from === fromSquad && h.to === toSquad && h.status === 'pending');
  if (handoff) {
    handoff.status = 'delivered';
    handoff.content = handoffContent;
  } else {
    handoff = { from: fromSquad, to: toSquad, what, status: 'delivered', content: handoffContent };
    squadFile.handoffs.push(handoff);
  }

  writeJsonFile(getSquadPath(missionId), squadFile);
  emitEvent('mission.handoff', { missionId, from: fromSquad, to: toSquad, what });
  return squadFile;
}

/** 读最近 from→to handoff 的 HandoffContext（JSON 解析，回退字符串透传）。 */
export function readLatestHandoffContext(missionId: string, fromSquad: string, toSquad: string): HandoffContext | null {
  const squadFile = readJsonFile<SquadFile>(getSquadPath(missionId));
  if (!squadFile) return null;

  const candidates = squadFile.handoffs.filter(h => h.from === fromSquad && h.to === toSquad);
  if (candidates.length === 0) return null;

  const latest = candidates[candidates.length - 1];
  if (!latest.content) return null;

  try {
    return JSON.parse(latest.content) as HandoffContext;
  } catch {
    return {
      originalInstruction: latest.content, filesRead: [], filesModified: [],
      agentConversations: [], currentProgress: latest.what, blockers: [],
      handoffAt: new Date(latest.content ?? '').getTime?.() ?? Date.now(), fromAgent: fromSquad,
    };
  }
}

/** 读最近任意 handoff 的 HandoffContext（不限定 from/to）。 */
export function readLatestHandoffContextAny(missionId: string): HandoffContext | null {
  const squadFile = readJsonFile<SquadFile>(getSquadPath(missionId));
  if (!squadFile || squadFile.handoffs.length === 0) return null;

  const latest = squadFile.handoffs[squadFile.handoffs.length - 1];
  if (!latest.content) return null;

  try {
    return JSON.parse(latest.content) as HandoffContext;
  } catch {
    return {
      originalInstruction: latest.content, filesRead: [], filesModified: [],
      agentConversations: [], currentProgress: latest.what, blockers: [],
      handoffAt: Date.now(), fromAgent: latest.from,
    };
  }
}

/** 把 HandoffContext 渲染为 system prompt 文本。纯函数。 */
export function renderHandoffContext(ctx: HandoffContext): string {
  const lines: string[] = [];
  lines.push(`## 交接上下文（来自 ${ctx.fromAgent}）`);
  lines.push(`原始指令: ${ctx.originalInstruction}`);
  lines.push(`当前进度: ${ctx.currentProgress}`);

  if (ctx.intentAnchor) {
    lines.push(`意图锚: ${ctx.intentAnchor.goal}`);
    if (ctx.intentAnchor.successCriteria.length > 0) {
      lines.push(`成功标准: ${ctx.intentAnchor.successCriteria.join('; ')}`);
    }
  }
  if (ctx.filesRead.length > 0) {
    lines.push(`已读文件（避免重复读）:`);
    for (const f of ctx.filesRead) lines.push(`  - ${f}`);
  }
  if (ctx.filesModified.length > 0) {
    lines.push(`已改文件:`);
    for (const f of ctx.filesModified) lines.push(`  - ${f.path}${f.diffHash ? ` (${f.diffHash})` : ''}`);
  }
  if (ctx.agentConversations.length > 0) {
    lines.push(`与其他 Agent 的对话（最近 ${ctx.agentConversations.length} 条）:`);
    for (const c of ctx.agentConversations) lines.push(`  - ${c.with}: ${c.summary}`);
  }
  if (ctx.blockers.length > 0) {
    lines.push(`已知阻塞:`);
    for (const b of ctx.blockers) lines.push(`  - ${b.reason}（${b.raisedBy}）`);
  }
  if (ctx.scopeSnapshot) {
    if (ctx.scopeSnapshot.blockPaths.length > 0) lines.push(`不可访问路径: ${ctx.scopeSnapshot.blockPaths.join(', ')}`);
    if (ctx.scopeSnapshot.blockTools.length > 0) lines.push(`不可用工具: ${ctx.scopeSnapshot.blockTools.join(', ')}`);
  }
  return lines.join('\n');
}
