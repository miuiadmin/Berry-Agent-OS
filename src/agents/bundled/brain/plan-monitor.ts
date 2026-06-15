/**
 * Plan 进度监控 + Signal 干预（§17.4 巨石拆解——从 brain/entry.ts 整组提取）。
 *
 * checkPlanProgress：扫描 in_progress mission 的 plan，检测 working 任务是否卡住
 *   （updated_at 超过 TASK_STALLED_MS）+ 检查 squad blocker/question 信号。
 * triggerSignalIntervention：根据 blocker/question signal 通过 IPC 发 brain.signal_intervention。
 *
 * 两者 + signalInterventionCooldown Map + 常量整组提取，deps 注入。
 */

import { getLogger } from '../../../utils/logger.js';

/** 任务卡住阈值（5 分钟无更新 = stalled） */
const TASK_STALLED_MS = 5 * 60 * 1000;
/** Signal 干预冷却（5 分钟内同 (missionId, from, msg) 只触发一次） */
const SIGNAL_INTERVENTION_COOLDOWN_MS = 5 * 60_000;

/** deps 注入 */
export interface PlanMonitorDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  missionManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  observationRecorder: any;
  // eslint-disable-next-line @typescript-eslint-eslint/no-explicit-any
  decisionRecorder: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc: any;
}

/**
 * 创建 plan 监控器（checkPlanProgress + triggerSignalIntervention 的工厂函数）。
 * entry.ts 调 createPlanMonitor({ missionManager, observationRecorder, decisionRecorder, ipc })，
 * 得到 { checkPlanProgress } 供 brain.observe handler 调用。
 */
export function createPlanMonitor(deps: PlanMonitorDeps): { checkPlanProgress: (sessionId: string, taskId: string) => void } {
  const { missionManager, observationRecorder, decisionRecorder, ipc } = deps;
  const logger = getLogger('brain-plan-monitor');
  const signalInterventionCooldown = new Map<string, number>();

  function checkPlanProgress(sessionId: string, taskId: string): void {
    const missions = missionManager.listMissions();
    if (missions.length === 0) return;

    const now = Date.now();
    for (const m of missions) {
      if (m.status !== 'in_progress') continue;
      const plan = missionManager.readPlan(m.id);
      if (!plan) continue;

      for (const task of plan.tasks) {
        if (task.status !== 'working') continue;
        if (!task.updated_at) continue;
        const elapsed = now - new Date(task.updated_at).getTime();
        if (elapsed < TASK_STALLED_MS) continue;

        const signal = `plan_stalled: task ${task.id} (${task.what}) working for ${Math.round(elapsed / 1000)}s`;
        observationRecorder.record({
          sessionId, taskId, observationType: 'agent_event',
          fromAgent: 'brain', toAgent: task.who, content: signal, priority: 0,
        });
        logger.info({ sessionId, missionId: m.id, taskId: task.id, elapsedMs: elapsed }, 'brain:plan_stalled');
      }

      // P9: 检查 squad 信号 — blocker / question 触发干预
      const squad = missionManager.readSquad(m.id);
      if (squad) {
        const unresolvedSignals = squad.signals.filter((s: { type: string; resolved: boolean }) =>
          (s.type === 'blocker' || s.type === 'question') && !s.resolved);
        for (const sig of unresolvedSignals.slice(0, 3)) {
          const content = `squad_signal: [${sig.type}] ${sig.from}: ${sig.msg}`;
          observationRecorder.record({
            sessionId, taskId, observationType: 'agent_event',
            fromAgent: 'brain', toAgent: sig.from, content, priority: 0,
          });
          logger.info({ sessionId, missionId: m.id, signalType: sig.type, from: sig.from }, 'brain:squad_signal_observed');
          triggerSignalIntervention(m.id, sig, sessionId);
        }
      }
    }
  }

  function triggerSignalIntervention(
    missionId: string,
    signal: { from: string; type: string; msg: string; at: string },
    sessionIdRef: string,
  ): void {
    const cooldownKey = `${missionId}:${signal.from}:${signal.msg}`;
    const now = Date.now();
    if (now - (signalInterventionCooldown.get(cooldownKey) ?? 0) < SIGNAL_INTERVENTION_COOLDOWN_MS) return;
    signalInterventionCooldown.set(cooldownKey, now);

    const instruction = signal.type === 'blocker'
      ? `检测到 blocker 信号（来自 ${signal.from}）：${signal.msg.slice(0, 300)}。请评估是否需要调整方案、回报用户，或请 leader 协助。`
      : `检测到 question 信号（来自 ${signal.from}）：${signal.msg.slice(0, 300)}。请尽快回应，避免阻塞下游 squad。`;

    try {
      decisionRecorder.record({
        sessionId: sessionIdRef, decisionType: 'correction',
        inputSummary: `squad_signal:[${signal.type}] ${signal.from} in ${missionId}`,
        outputJson: { action: 'adjust', reason: `p9_signal_intervention:${signal.type}`, instruction: instruction.slice(0, 500), target: signal.from, missionId },
      });
    } catch (err) {
      logger.warn({ err, missionId, signalType: signal.type }, 'brain: signal intervention decision record failed');
    }

    ipc.send('brain.signal_intervention', 'core', {
      missionId, from: signal.from, signalType: signal.type, signalMsg: signal.msg,
      instruction, severity: signal.type === 'blocker' ? 'high' : 'medium', createdAt: now,
    });
    logger.info({ missionId, from: signal.from, signalType: signal.type }, 'brain:signal_intervention triggered');
  }

  return { checkPlanProgress };
}
