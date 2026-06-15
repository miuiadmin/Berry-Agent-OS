/**
 * 16.0 §17.4 巨石拆解：mission 上下文构建 helper-module
 *
 * 从 delegation-orchestrator.ts 提取的 3 个纯计算函数：
 * - buildMissionContextPrompt: 渲染 mission 上下文（squad 角色 / handoff / 纠偏指令 / 行为笔记）
 * - autoGenerateSquad: 基于 plan 的 agent 分组自动生成 squad 结构（零 LLM）
 * - updatePlanTaskStatus: agent 任务终态时同步更新 plan.json 中对应任务状态
 *
 * 这三个函数只依赖 {missionManager, stateCache, taskManager}，零 this 状态、零回调，
 * 是 delegation-orchestrator 中耦合面最小的一簇 mission helpers。
 */

import type { MissionManager } from '../mission-manager.js';
import type { StateCache, CorrectionEntry, BehaviorNote } from '../state-cache.js';
import type { TaskManager, TaskRow } from '../task-manager.js';
import type { Plan, MissionTask } from '../../contracts/mission.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

/** 显式依赖注入：调用方（DelegationOrchestrator）传入这三个实例 */
export interface MissionContextDeps {
  /** MissionManager 可能为 null（未初始化 mission 系统时） */
  missionManager: MissionManager | null;
  /** StateCache 可能为 null */
  stateCache: StateCache | null;
  /** TaskManager 可能为 undefined */
  taskManager?: TaskManager | null;
}

/**
 * 构建 mission 上下文提示词：让 agent 知道自己的 mission 目标 + squad 角色。
 *
 * 组装顺序：
 * 1. 优先用 MissionManager.renderContext 输出 squad 队友/角色/信号（需 planTaskId + targetAgent）
 * 2. 回退：仅 missionId 时输出 readSummary
 * 3. 注入 StateCache 中的纠偏指令（correction）和行为笔记（behavior_note）
 * 4. P10: 若 squad 含 checker 角色，追加 checker 角色指引
 * 5. §5.3.11: 注入 HandoffContext（接收方 agent 看到前任工作进展）
 *
 * @returns 上下文提示词字符串；mission 不存在或读取失败时返回 null
 */
export function buildMissionContextPrompt(
  deps: MissionContextDeps,
  missionId: string,
  planTaskId?: string,
  targetAgent?: string,
): string | null {
  const { missionManager, stateCache } = deps;
  if (!missionManager) return null;
  try {
    // ① 优先：使用 renderContext 输出 squad 队友/角色/信号
    let contextBlock = '';
    if (planTaskId && targetAgent) {
      const richContext = missionManager.renderContext(missionId, planTaskId, targetAgent);
      if (richContext) {
        contextBlock = `## Mission Context\n\n${richContext}`;
      }
    }

    // ② 回退：仅 missionId 时输出 readSummary
    if (!contextBlock) {
      const summary = missionManager.readSummary(missionId);
      if (!summary) return null;
      contextBlock = `## Mission Context\n\n${summary}`;
    }

    /** §3.8/§5.3.1: 注入 StateCache 中的纠偏指令和行为笔记 */
    const stateInjections: string[] = [];

    if (stateCache) {
      // 注入纠偏指令（correction namespace，key={sessionId}:{taskId}）
      // 当前上下文没有明确的 taskId，所以遍历所有 correction keys
      const correctionKeys = stateCache.keys('correction');
      for (const key of correctionKeys) {
        const correction = stateCache.get<CorrectionEntry>('correction', key);
        if (correction) {
          const severityIcon = correction.severity === 'high' ? '🔴' : correction.severity === 'medium' ? '🟡' : '🟢';
          stateInjections.push(`${severityIcon} 纠偏指令: ${correction.instruction}`);
        }
      }

      // 注入行为笔记（behavior_note namespace）
      const behaviorKeys = stateCache.keys('behavior_note');
      for (const key of behaviorKeys) {
        const note = stateCache.get<BehaviorNote>('behavior_note', key);
        if (note) {
          stateInjections.push(`📌 行为提醒: ${note.instruction}`);
        }
      }
    }

    let stateContext = '';
    if (stateInjections.length > 0) {
      stateContext = '\n\n## Brain 指令（来自监督系统）\n\n' + stateInjections.join('\n');
    }

    /** P10: squad checker 角色提示（仅在 squad 中有 checker 角色时追加） */
    let checkerHint = '';
    const squad = missionManager.readSquad(missionId);
    if (squad && squad.org.squads.some(s => s.members.some(m => m.role === 'check'))) {
      checkerHint = '\n\n### Checker 角色指引\n如果你是 Squad 中的 Checker（验证者）：独立审查 worker 的产出，关注正确性/完整性/安全性/一致性。发现问题通过 squad tool signal(blocker/question) 报告，不直接修改。验证通过用 signal(done)。';
    }

    /**
     * §5.3.11: 注入 HandoffContext（如果存在最近一次交接上下文）。
     * 接收方 agent 需要看到前任 agent 的工作进展、已读文件、阻塞等信息，
     * 才能无缝接手任务，而不是从零开始。
     */
    let handoffContext = '';
    if (planTaskId) {
      const handoffCtx = missionManager.readLatestHandoffContextAny(missionId);
      if (handoffCtx) {
        const renderedHandoff = missionManager.renderHandoffContext(handoffCtx);
        handoffContext = '\n\n## 任务交接上下文\n\n你是从另一个 Agent 接手的任务。以下是前任的工作状态：\n\n' + renderedHandoff;
      }
    }

    return `${contextBlock}\n\n使用 plan 工具（read）查看完整计划，update 更新自己的任务进度。使用 squad 工具管理团队（read/handoff/signal/update_member）。${checkerHint}${handoffContext}${stateContext}`;
  } catch (err) {
    logger.warn({ err, missionId }, 'buildMissionContextPrompt 失败');
    return null;
  }
}

/**
 * P7: 自动生成 squad 结构 — 基于 plan 中 agent 分配的分组。
 *
 * 规则化方法（零 LLM）：提取 plan 中所有 task 的 who 字段去重，
 * 每个 unique agent 创建一个 squad，agent 既是 leader 也是执行者。
 * 适用于 P1 阶段单实例模型。
 *
 * 只有 ≥2 个 agent 时才创建 squad（无需组织）。
 * P10: 为每个 squad 分配一个 checker（从其他 agent 中轮询选择）。
 *
 * @param missionId Mission ID
 * @param plan 已创建的 plan 对象
 */
export function autoGenerateSquad(deps: MissionContextDeps, missionId: string, plan: Plan): void {
  const { missionManager } = deps;
  if (!missionManager) return;

  /** 提取去重的 agent 列表 */
  const agentGroups = new Map<string, MissionTask[]>();
  for (const task of plan.tasks) {
    if (!agentGroups.has(task.who)) {
      agentGroups.set(task.who, []);
    }
    agentGroups.get(task.who)!.push(task);
  }

  /** 只有 1 个 agent 时不创建 squad（无需组织） */
  if (agentGroups.size < 2) return;

  /** 收集可用的 agent 名列表（用于 P10 checker 分配） */
  const agentNames = [...agentGroups.keys()];

  try {
    missionManager.initSquad(missionId, []);

    for (let i = 0; i < agentNames.length; i++) {
      const agent = agentNames[i];
      const tasks = agentGroups.get(agent)!;
      const goal = tasks.map(t => t.what).join(', ');

      /** P10: 为每个 squad 分配一个 checker（从其他 agent 中轮询选择） */
      const checkerIdx = (i + 1) % agentNames.length;
      const checkerAgent = agentNames[checkerIdx];

      missionManager.createSquad(missionId, {
        name: `${agent} 组`,
        goal,
        leader: agent,
        members: [{
          agent: checkerAgent,
          role: 'check',
          on: `验证 ${agent} 的产出质量`,
        }],
      });
    }

    logger.info({ missionId, squadCount: agentNames.length }, 'P7+P10: auto-generated squad with checkers');
  } catch (err) {
    logger.warn({ err, missionId }, 'P7: auto-generate squad failed (non-critical)');
  }
}

/**
 * 13.0 多智能体协作：任务完成/失败时同步更新 plan.json 中对应任务的状态。
 *
 * §12.6 审核集成 — agent 完成任务后，plan 中对应任务的状态应该自动更新。
 * 这样 Brain 和其他 agent 通过 plan tool 读取时能看到最新进度。
 *
 * 通过 agent_task 的 input_payload 中提取 missionId 和 planTaskId（派发时透传），
 * 然后调用 missionManager.updatePlan 同步状态。plan 更新失败不影响主流程。
 *
 * @param taskId - agent task ID
 * @param status - 目标状态 ('done' | 'failed')
 * @param result - 任务结果文本（可选，成功时填输出摘要，失败时填错误信息）
 */
export function updatePlanTaskStatus(
  deps: MissionContextDeps,
  taskId: string,
  status: 'done' | 'failed',
  result?: string,
): void {
  const { missionManager, taskManager } = deps;
  if (!missionManager) return;
  try {
    const task: TaskRow | undefined = taskManager?.getTask(taskId);
    if (!task) return;

    /** 从 agent_task 的 input_payload 中提取 missionId 和 planTaskId */
    let inputPayload: Record<string, unknown> = {};
    try {
      const raw = (task as unknown as { inputPayload?: unknown; input_payload?: unknown }).inputPayload
        ?? (task as unknown as { input_payload?: unknown }).input_payload;
      inputPayload = typeof raw === 'string'
        ? JSON.parse(raw)
        : (raw as Record<string, unknown>) ?? {};
    } catch { return; }

    const missionId = inputPayload.missionId as string | undefined;
    const planTaskId = inputPayload.planTaskId as string | undefined;
    if (!missionId || !planTaskId) return;

    /** 截断结果文本，避免 plan.json 膨胀 */
    const truncatedResult = result ? result.slice(0, 500) : undefined;

    missionManager.updatePlan(missionId, {
      task_id: planTaskId,
      status,
      result: truncatedResult,
    });

    logger.info({ missionId, planTaskId, status }, '13.0: plan task status synced on agent completion');
  } catch (err) {
    /** plan 更新失败不应影响主流程 — 非关键操作 */
    logger.warn({ err, taskId, status }, '13.0: plan task status sync failed (non-critical)');
  }
}
