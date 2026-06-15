/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——Mission 系统 EventBus 订阅提取（第 7 步）。
 *
 * 从 delegation-orchestrator.ts 的 initMissionSystem 搬出 EventBus 订阅簇（行为保持，
 * 仅把 this.* 依赖改成显式参数）。主类 initMissionSystem 改为：设 missionManager /
 * stateCache / agentRequestQueue + 注入 kernelRouter / permissionCoordinator + 调本函数。
 *
 * 订阅清单（逐字搬运，标 §17.4 delete-needs-board 的块——只提取不删除，P5 才删）：
 *   - mission.task_ready：依赖满足自动派发下游（§12.5 who→taskType 路由）
 *   - mission.completed：派发汇总给 Conversation（§12.8）
 *   - brain.signal_intervention：找活跃 worker → turn.correction 软纠偏（§11.7/§12.5）
 *   - mission.handoff：目标 squad leader 主动通知（§11.6，修复死事件）
 *   - brain.checker.dispatch：checker 二次审核 foreground 委派（§11.3，修复零订阅者）
 *   - delegation.completed/failed：onTermination → cleanupTaskState 释放 active_scope
 *   - TaskHeartbeatManager：长任务心跳推送（§13.16）
 *
 * ⚠️ cleanupTaskState / onTermination 的 active_scope 清理副作用逐字保留（permissionCoordinator
 *    + stateCache.delete(correction/behavior_note/active_scope) 全套调用不变）。
 * ⚠️ TaskHeartbeatManager 的 HeartbeatSource 适配器（getActiveDelegations / markHeartbeat /
 *    timeoutDelegation）逐字保留，timeoutDelegation 走 delegationManager.fail。
 */

import type { MissionManager } from '../mission-manager.js';
import type { StateCache } from '../state-cache.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { AgentManager } from '../agent-manager.js';
import type { PermissionCoordinator } from '../permission-coordinator.js';
import { getTaskHeartbeatManager, type HeartbeatEntry } from '../task-heartbeat-manager.js';
import { isDelegationTerminal } from '../../contracts/delegation.js';
import { getEventBus } from '../event-bus.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** §17.4: mission 订阅所需依赖注入 + 跨集群回调 */
export interface MissionSubscriptionsDeps {
  readonly missionManager: MissionManager | null;
  readonly delegationManager: DelegationManager;
  readonly agentManager: AgentManager;
  readonly permissionCoordinator: PermissionCoordinator | null;
  readonly stateCache: StateCache | null;
  /** 模块任务派发回调（主类 dispatchModuleTask） */
  dispatchModuleTask(input: {
    sessionId: string;
    taskType: string;
    requester: string;
    inputPayload: Record<string, unknown>;
    foreground?: boolean;
    correlationId?: string;
    targetAgentOverride?: string;
  }): Promise<{ taskId: string; targetAgent: string }>;
}

/**
 * §17.4: §12.5 plan.json 的 who 字段（agent 名）→ 该 agent 的主 taskType 映射。
 * 用于 task_ready 派发时按 who 路由到真正负责的 agent。
 * 未命中返回 null（调用方回退 chat）。
 */
const AGENT_TASK_TYPE: Record<string, string> = {
  conversation: 'conversation_turn',
  code: 'code_task',
  skills: 'skill_task',
  'plugin-builder': 'plugin_task',
  'skill-tester': 'skill_test',
  learning: 'learning_review',
  evolution: 'extract_feedback',
  memory: 'memory_judge',
};

/** §12.5: 按 agent 名查主 taskType；未知 agent 返回 null */
function taskTypeForAgent(agentName: string): string | null {
  return AGENT_TASK_TYPE[agentName] ?? null;
}

/**
 * 注册 Mission 系统 EventBus 订阅 + 启动 TaskHeartbeatManager（逐字搬运）。
 *
 * 主类 initMissionSystem 在初始化 missionManager/stateCache/agentRequestQueue 后调用本函数。
 * 订阅清单见文件头注释。返回值无（副作用型注册）。
 *
 * @param deps 依赖注入 + 跨集群回调
 */
export function setupMissionSubscriptions(deps: MissionSubscriptionsDeps): void {
  const { missionManager, delegationManager, agentManager, permissionCoordinator, stateCache, dispatchModuleTask } = deps;

  /**
   * P5: 订阅 mission.task_ready 事件 — 依赖满足时自动派发下游任务。
   *
   * 当 MissionManager 检测到某个 waiting 任务的 depends_on 全部完成时，
   * 发出 mission.task_ready 事件。此处订阅并自动派发给负责的 agent。
   */
  getEventBus().on('mission.task_ready', (payload: { missionId: string; taskId: string; who: string; what: string }) => {
    logger.info({ missionId: payload.missionId, taskId: payload.taskId, who: payload.who }, '13.0: mission.task_ready — 自动派发');

    // §12.5: 用 plan 的 who 字段路由到真正负责的 agent（而非写死 chat）。
    // who 是 agent 名，需映射到该 agent 的主 taskType 供 taskRouter 路由。
    const taskType = taskTypeForAgent(payload.who) ?? 'chat';
    dispatchModuleTask({
      sessionId: payload.missionId, // missionId 作为 session 的关联标识
      taskType,
      requester: 'brain-mission',
      inputPayload: {
        userMessage: payload.what,
        missionId: payload.missionId,
        planTaskId: payload.taskId,
      },
      foreground: true,
    }).catch(err => {
      logger.warn({ err, missionId: payload.missionId, taskId: payload.taskId, who: payload.who }, '13.0: task_ready 派发失败');
    });
  });

  // 13.0 §12.8: mission 全部完成 → 派发汇总任务给 Conversation agent。
  // 修复缺口：mission.completed 事件此前仅推送前端，后端零订阅者，Conversation 不汇总。
  getEventBus().on('mission.completed', (payload: { missionId: string; goal: string }) => {
    logger.info({ missionId: payload.missionId, goal: payload.goal }, '13.0: mission.completed — 派发汇总');
    dispatchModuleTask({
      sessionId: payload.missionId,
      taskType: 'conversation_turn', // Conversation agent 负责 mission 汇总（§12.8）
      requester: 'brain-mission',
      inputPayload: {
        userMessage: `Mission「${payload.goal}」的全部任务已完成，请汇总各任务结果给用户。`,
        missionId: payload.missionId,
        isMissionSummary: true,
      },
      foreground: true,
    }).catch(err => {
      logger.warn({ err, missionId: payload.missionId }, '13.0: mission.completed 汇总派发失败');
    });
  });

  // 13.0 §11.7/§12.5: Brain 观察 blocker/question signal → 发 brain.signal_intervention。
  // 修复缺口：此事件此前零订阅者，Brain 的干预意图无人执行。
  // 消费方式：找到 mission 中活跃的 worker delegation，发 turn.correction 注入软纠偏。
  getEventBus().on('brain.signal_intervention', (payload: {
    missionId: string; from: string; signalType: string; signalMsg: string;
    instruction: string; severity: 'low' | 'medium' | 'high'; createdAt: number;
  }) => {
    // 用 missionId 当 sessionId 查活跃 worker delegation
    const active = delegationManager.getActiveForSession(payload.missionId);
    const worker = active.find(e => e.targetAgent === payload.from) ?? active[0];
    if (!worker) {
      logger.debug({ missionId: payload.missionId, from: payload.from }, '13.0: signal_intervention 无活跃 worker，跳过');
      return;
    }
    const agent = agentManager.getAgent(worker.targetAgent);
    if (!agent) return;
    // 发 turn.correction（软纠偏：instruction 注入 worker 下一轮 system message）
    agent.ipc.send('turn.correction', worker.targetAgent, {
      delegationId: worker.id,
      action: 'adjust',
      instruction: payload.instruction,
      newConstraints: payload.severity === 'high' ? { forbiddenTools: [] } : undefined,
    } as import('../../contracts/delegation.js').TurnCorrectionPayload, genId('sigint'));
    logger.info({ missionId: payload.missionId, targetAgent: worker.targetAgent, signalType: payload.signalType }, '13.0: signal_intervention → turn.correction 已派发');
  });

  // 13.0 §11.6: handoff 完成 → 目标 squad 的 leader 收到主动通知（修复死事件）。
  // 之前 handoff 上下文只写入 squad.json，目标 agent 需轮询才能感知。
  getEventBus().on('mission.handoff', (payload: { missionId: string; from: string; to: string; what: string }) => {
    // 读 squad.json 找到目标 squad 的 leader，把 handoff 摘要推给它的活跃 delegation
    try {
      const leaderAgent = missionManager?.resolveSquadLeader?.(payload.missionId, payload.to);
      const target = leaderAgent ?? 'conversation';
      const active = delegationManager.getActiveForSession(payload.missionId);
      const worker = active.find(e => e.targetAgent === target);
      if (worker) {
        const agent = agentManager.getAgent(worker.targetAgent);
        agent?.ipc.send('task.progress', worker.targetAgent, {
          taskId: worker.id,
          summary: `[Mission handoff] ${payload.from} → ${payload.to}: ${payload.what}`,
          kind: 'mission_handoff',
          missionId: payload.missionId,
        });
      }
      logger.info({ missionId: payload.missionId, to: payload.to, target }, '13.0: mission.handoff 已通知目标 squad');
    } catch (err) {
      logger.debug({ err: (err as Error).message, missionId: payload.missionId }, 'mission.handoff 通知失败（非致命）');
    }
  });

  // 13.0 P10 §11.3: checker 派发 — Brain 派出 checker 二次审核但事件零订阅者，checker 从未真正运行。
  // 订阅 brain.checker.dispatch，把 checker 当作一个独立 review 委派给目标 agent。
  getEventBus().on('brain.checker.dispatch', (payload: {
    missionId: string; planTaskId: string; sessionId: string;
    checkerAgent: string; checkerOn: string; checkerCorrelationId: string;
    workerOutput: string; workerTask: string; brainVerdict: string; brainReason: string;
  }) => {
    // 把 checker 审核作为一次 foreground 委派发给 checker agent，输出回流供 Brain 观察
    dispatchModuleTask({
      sessionId: payload.missionId,
      taskType: taskTypeForAgent(payload.checkerAgent) ?? 'review',
      requester: 'brain-checker',
      inputPayload: {
        userMessage: `请审核以下 worker 产出（你是 checker，负责质量验证）。\n任务: ${payload.workerTask}\n审核重点: ${payload.checkerOn}\n产出: ${payload.workerOutput}\n主 Brain verdict: ${payload.brainVerdict}`,
        missionId: payload.missionId,
        planTaskId: payload.planTaskId,
        isCheckerReview: true,
        checkerCorrelationId: payload.checkerCorrelationId,
      },
      foreground: true,
      correlationId: payload.checkerCorrelationId,
    }).then(({ targetAgent }) => {
      logger.info({ missionId: payload.missionId, planTaskId: payload.planTaskId, checkerAgent: targetAgent }, '13.0: brain.checker.dispatch → checker 委派已发出');
    }).catch(err => {
      logger.warn({ err, missionId: payload.missionId, planTaskId: payload.planTaskId }, '13.0: checker 委派失败');
    });
  });
  // 避免 stale 约束/纠偏/行为笔记泄漏到下一个 task
  // （active_scope 用 delegationId，correction/behavior_note 用 sessionId:taskId 复合 key）
  const cleanupTaskState = (delegationId: string, sessionId?: string, taskId?: string) => {
    if (permissionCoordinator) {
      permissionCoordinator.clearActiveScope(delegationId);
    }
    // 清理 StateCache 中所有与该 task 相关的命名空间条目
    if (stateCache) {
      if (taskId) {
        // correction / behavior_note 等用 sessionId:taskId 复合 key
        const compositeKey = sessionId ? `${sessionId}:${taskId}` : taskId;
        stateCache.delete('correction', compositeKey);
        stateCache.delete('behavior_note', compositeKey);
        // active_scope 用 taskId 作为 key
        stateCache.delete('active_scope', taskId);
        // intent_anchor 按 sessionId 索引；task 结束不主动清（跨 task 复用）
      }
      if (sessionId) {
        // mission_context 按 sessionId 索引；task 结束不主动清（跨 task 复用）
      }
    }
  };

  // 单一入口：completed / failed / timeout / cancel 都走同一个清理函数
  const onTermination = (payload: { delegationId: string; sessionId?: string; targetAgent?: string }) => {
    // 从 delegationEntry 反查 sessionId/taskId
    const entry = delegationManager.get(payload.delegationId);
    const resolvedTaskId = (entry as unknown as { taskId?: string } | undefined)?.taskId ?? payload.delegationId;
    cleanupTaskState(
      payload.delegationId,
      payload.sessionId ?? entry?.sessionId,
      resolvedTaskId,
    );
    logger.debug({
      delegationId: payload.delegationId,
      sessionId: payload.sessionId ?? entry?.sessionId,
      targetAgent: payload.targetAgent,
    }, 'orchestrator: cleanup task state on delegation end');
  };

  getEventBus().on('delegation.completed', onTermination);
  getEventBus().on('delegation.failed', onTermination);

  // 13.0 §13.16: 启动 TaskHeartbeatManager — 长任务（>1min 无活动）自动发心跳
  // 前端通过 task.heartbeat WS 事件显示「还在工作中」提示
  // getTaskHeartbeatManager 已在文件顶部 import
  const heartbeatMgr = getTaskHeartbeatManager(getEventBus());
  // HeartbeatSource 适配器：把 DelegationManager 的 entries 映射为 HeartbeatEntry
  heartbeatMgr.setSource({
    getActiveDelegations: () => {
      const entries: Array<HeartbeatEntry> = [];
      for (const entry of delegationManager.getAll()) {
        if (isDelegationTerminal(entry.state)) continue;
        entries.push({
          delegationId: entry.id,
          taskId: entry.id,
          agentName: entry.targetAgent,
          startedAt: entry.createdAt,
          lastActivityAt: entry.lastCheckpointAt ?? entry.createdAt,
          lastActivityType: entry.lastCheckpointAt ? 'checkpoint' : 'created',
        });
      }
      return entries;
    },
    markHeartbeat: (delegationId: string) => {
      // 心跳标记写入 delegation entry（更新 lastCheckpointAt 避免重复心跳）
      const entry = delegationManager.get(delegationId);
      if (entry) {
        entry.lastCheckpointAt = Date.now();
      }
    },
    /** §13.16: 通过 DelegationManager.fail() 终止超时 delegation */
    timeoutDelegation: (delegationId: string, reason: string): boolean => {
      return delegationManager.fail(delegationId, reason);
    },
  });
  heartbeatMgr.start();
}
