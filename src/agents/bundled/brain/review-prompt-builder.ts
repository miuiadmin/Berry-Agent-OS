/**
 * 16.0 §17.4 续 + ①② 议会拆解第 1 步：review systemPrompt 构造提取为纯函数。
 *
 * 此前内联在 brain/entry.ts 的 review.request handler（含 worldModel / 观察队列 / 板上下文 /
 * insights / mission 任务 / 历史决策 6 段注入）。提取目的：
 *   - brain/entry.ts 续瘦身（§17.4 巨石拆解脉络）
 *   - review 逻辑成离散可测单元（prompt 构造可单测，不必跑整个 brain 进程）
 *   - ①② 议会拆解前置：本函数 + observation-context + review-handler 未来整体迁 kernel/，
 *     供 ②reviewer agent 复用（review 逻辑不再绑死 brain 进程闭包）。
 *
 * 两个 brain 闭包（getBasePrompt = prompts.getReviewPrompt 带 promptVersioning；
 * recallDecisionsBlock = brain-helpers 读 BrainDecisionRecorder）经 ctx 注入——
 * 使本函数本身 agent 无关（②reviewer 注入自己的实现即可复用）。
 */

import type Database from 'better-sqlite3';
import type { ObservationRecorder } from '../../../kernel/observation-recorder.js';
import type { MissionManager } from '../../../kernel/mission-manager.js';
import { C_LEVEL_OBSERVATION_TYPES, renderObservationContext } from './observation-context.js';
import { renderBoardContext } from './board-context.js';
import { getBoardContext } from '../../../kernel/board-repo.js';
import { recallInsightsForDecision, formatInsightsBlock } from '../../../kernel/insights-recall.js';
import { markInsightAdoptedByDecision } from '../../../kernel/insights-lifecycle.js';
import { getLogger } from '../../../utils/logger.js';

const logger = getLogger('brain');

/** 构造 review systemPrompt 所需的 turn 字段（review.request payload 子集） */
export interface ReviewTurnForPrompt {
  sessionId: string;
  /** 审核级别（A 摘要 / B-C 完整） */
  level: 'A' | 'B' | 'C';
  /** 16.0 P4-B1：板 id（C 级注入板上下文看板下钻） */
  boardTaskId?: string;
  /** mission 上下文（§12.6 注入分配的任务目标） */
  missionId?: string;
  planTaskId?: string;
}

/** buildReviewSystemPrompt 依赖（brain 闭包经此注入，使函数 agent 无关） */
export interface ReviewPromptContext {
  db: Database.Database;
  observationRecorder: ObservationRecorder;
  missionManager: MissionManager;
  /** 基础 review prompt（brain prompts.getReviewPrompt，带 promptVersioning 自学习） */
  getBasePrompt: (level: 'A' | 'B' | 'C') => string;
  /** 历史 review 决策回溯块（brain-helpers.recallDecisionsBlock，读 BrainDecisionRecorder） */
  recallDecisionsBlock: (decisionType: string) => string;
}

/**
 * 读取 world_model 表当前快照，渲染为审核用的世界状态摘要（活动/精力/挫败/deadline）。
 * 从 brain/entry.ts 搬出（纯 db 读，agent 无关）。
 */
function getWorldModelSummary(db: Database.Database): string {
  try {
    const row = db.prepare(`SELECT snapshot_json FROM world_model WHERE id = 'current'`).get() as { snapshot_json: string } | undefined;
    if (!row) return '';
    const snapshot = JSON.parse(row.snapshot_json);
    const parts: string[] = [];
    if (snapshot.user?.currentActivity) parts.push(`活动: ${snapshot.user.currentActivity}`);
    if (snapshot.user?.energyLevel && snapshot.user.energyLevel !== 'unknown') parts.push(`精力: ${snapshot.user.energyLevel}`);
    if (snapshot.user?.frustrationSignals > 2) parts.push(`注意: 挫败感信号(${snapshot.user.frustrationSignals})`);
    if (snapshot.temporal?.upcomingDeadlines?.length > 0) {
      const d = snapshot.temporal.upcomingDeadlines[0];
      parts.push(`deadline: ${d.description}`);
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
}

/**
 * 构造 review systemPrompt：基础 prompt + 世界状态 + C 级观察/板上下文 + insights + 历史决策 + mission 任务 + uncertain 升级指令。
 *
 * 行为与原 brain/entry.ts 内联构造逐字一致（§17.4 行为保持式提取）。
 *
 * @param turn 审核轮次字段
 * @param ctx  依赖（db / observationRecorder / missionManager + 两个 brain 闭包）
 * @returns 完整 review systemPrompt
 */
export function buildReviewSystemPrompt(turn: ReviewTurnForPrompt, ctx: ReviewPromptContext): string {
  const { db, observationRecorder, missionManager, getBasePrompt, recallDecisionsBlock } = ctx;
  let systemPrompt = getBasePrompt(turn.level);

  // Inject World Model context for review decisions
  const worldSummary = getWorldModelSummary(db);
  if (worldSummary) {
    systemPrompt += `\n\n[World State] ${worldSummary}`;
  }

  // 13.0 灵魂版：C 级审核注入观察队列上下文，提供完整 Agent 行为时间线
  // 设计依据：§20.7 后置审核增强 — C 级使用完整 observation queue
  // M1 保真度：若观察队列被截断（窗口裁剪），追加警告降低审核置信度
  if (turn.level === 'C' && turn.sessionId) {
    // 15.0 C3 闭合：C 级审核注入近期 Agent 行为观察（白名单含 agent_event——审计报告 + plan_stalled）。
    const observations = observationRecorder.queryByType(
      turn.sessionId,
      [...C_LEVEL_OBSERVATION_TYPES],
      20,
    );
    if (observations.length > 0) {
      const observationContext = renderObservationContext(observations);
      systemPrompt += `\n\n## 近期 Agent 行为观察（供 C 级审核参考）\n${observationContext}`;

      // M1 截断降级：若第一条观察记录的 taskId 存在，检查截断状态
      const sampleTaskId = observations[0]?.taskId;
      if (sampleTaskId && observationRecorder.isTruncated(turn.sessionId, sampleTaskId)) {
        systemPrompt += `\n\n⚠️ **观察队列被截断**（部分历史记录因窗口限制被裁剪）。你看到的行为记录可能不完整，审核结论请保守判定，对不确定的问题标注 "低置信度"。`;
      }
    }
    // 16.0 P4-B1：C 级审核注入板上下文（turn.boardTaskId，§5.1 task=board），看板下钻
    if (turn.boardTaskId) {
      const boardCtx = getBoardContext(turn.boardTaskId);
      if (boardCtx) {
        systemPrompt += `\n\n## 任务板上下文（你正在审核的板）\n${renderBoardContext(boardCtx)}`;
      }
    }
  }

  // Inject validated system insights for review decisions
  const reviewInsights = recallInsightsForDecision(db, 'review', 3);
  if (reviewInsights.length > 0) {
    systemPrompt += formatInsightsBlock(reviewInsights);
    markInsightAdoptedByDecision(db, 'review', reviewInsights.map(i => i.id));
  }

  // §5.2 ④: Recall historical review decisions for learning
  systemPrompt += recallDecisionsBlock('review');

  // 13.0 §12.3 + §12.6: 注入 mission 任务上下文 — Brain 审核时知道该 agent 被分配的具体任务
  if (turn.missionId && turn.planTaskId) {
    try {
      const plan = missionManager.readPlan(turn.missionId);
      const assignedTask = plan?.tasks.find(t => t.id === turn.planTaskId);
      if (assignedTask) {
        systemPrompt += `\n\n## 任务上下文（该 agent 被分配的任务）\n` +
          `- 任务 ID: ${assignedTask.id}\n` +
          `- 任务目标: ${assignedTask.what}\n` +
          `- 负责人: ${assignedTask.who}\n` +
          `- 状态: ${assignedTask.status}\n` +
          `审核时请判断回复是否真正完成了上述任务目标，而不仅是回复本身是否合理。`;
      }
    } catch (missionErr) {
      // mission 上下文注入失败非致命——保留基础 prompt 继续（行为与原 entry.ts 一致）
      logger.debug({ err: missionErr, missionId: turn.missionId }, 'brain:review mission context injection skipped');
    }
  }

  // 15.0 机制 B：审核 uncertain 升级指令（保守，不要滥用）
  systemPrompt += `\n\n## 拿不准时升级（uncertain）\n绝大多数情况你能明确 approve/modify/reject。仅当信息严重不足、` +
    `无法判断回复质量且误判代价高时，额外返回 "uncertain": true 与 "escalationQuestion"（要问用户的自然语言问题），` +
    `系统会把问题转给用户而非你强行裁决。能判断就正常给 verdict，不要滥用。`;

  return systemPrompt;
}
