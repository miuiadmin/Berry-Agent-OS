/**
 * 16.0 重构——mission context 渲染（从 mission-manager.ts 提取）。
 *
 * 纯函数（squad 查找）+ readPlan/readSquad 回调注入的 readContext/renderContext。
 * 行为保持式提取。findSquad + findSquadAndMember 被 mission-manager 复用（getCheckerForPlanTask/resolveSquadLeader）。
 */
import type { Plan, Squad, SquadMember, MissionContext } from '../../contracts/mission.js';
import type { SquadFile } from '../../contracts/mission.js';
import { renderMissionContext } from '../../contracts/mission.js';

/** 递归查找 squad by id（纯函数） */
export function findSquad(squads: Squad[], squadId: string): Squad | null {
  for (const squad of squads) {
    if (squad.id === squadId) return squad;
    if (squad.squads) {
      const found = findSquad(squad.squads, squadId);
      if (found) return found;
    }
  }
  return null;
}

/** 递归查找 agent 所在的 squad + member（纯函数） */
export function findSquadAndMember(squads: Squad[], agentName: string): { squad: Squad; member: SquadMember } | null {
  for (const squad of squads) {
    if (squad.leader === agentName) {
      return { squad, member: { agent: agentName, role: 'lead', on: squad.goal, status: squad.status === 'working' ? 'working' : 'idle' } };
    }
    const member = squad.members.find(m => m.agent === agentName);
    if (member) return { squad, member };
    if (squad.squads) {
      const nested = findSquadAndMember(squad.squads, agentName);
      if (nested) return nested;
    }
  }
  return null;
}

/** readContext 依赖（回调注入 readPlan + readSquad） */
export interface MissionContextDeps {
  readPlan: (missionId: string) => Plan | null;
  readSquad: (missionId: string) => SquadFile | null;
}

/** 为 (mission, task, agent) 组装 MissionContext（行为保持式提取）。 */
export function readMissionContext(missionId: string, planTaskId: string, agentName: string, deps: MissionContextDeps): MissionContext | null {
  const plan = deps.readPlan(missionId);
  if (!plan) return null;
  const task = plan.tasks.find(t => t.id === planTaskId);
  if (!task) return null;

  const squadFile = deps.readSquad(missionId);
  let member: SquadMember | null = null;
  let parentSquad: Squad | null = null;
  if (squadFile) {
    const found = findSquadAndMember(squadFile.org.squads, agentName);
    if (found) { member = found.member; parentSquad = found.squad; }
  }

  const role: 'lead' | 'work' | 'check' = member?.role ?? 'work';
  const on = member?.on ?? task.what;
  const squadGoal = parentSquad?.goal ?? plan.mission.goal;

  const squadTeammates: MissionContext['squadTeammates'] = [];
  if (parentSquad) {
    for (const m of parentSquad.members) {
      if (m.agent === agentName) continue;
      squadTeammates.push({ agent: m.agent, role: m.role, on: m.on, status: m.status });
    }
    if (parentSquad.leader !== agentName && !parentSquad.members.some(m => m.agent === parentSquad.leader)) {
      squadTeammates.push({ agent: parentSquad.leader, role: 'lead', on: parentSquad.goal, status: parentSquad.status === 'working' ? 'working' : 'idle' });
    }
  }

  const completedTasks = plan.tasks.filter(t => t.status === 'done' && t.id !== planTaskId).map(t => ({ id: t.id, what: t.what, result: t.result }));
  const inProgressTasks = plan.tasks.filter(t => t.status === 'working' && t.id !== planTaskId).map(t => ({ id: t.id, what: t.what, who: t.who, progress: t.progress }));
  const unresolvedSignals: MissionContext['unresolvedSignals'] = [];
  if (squadFile) {
    for (const sig of squadFile.signals) {
      if (sig.resolved) continue;
      if (sig.type === 'blocker' || sig.type === 'question') unresolvedSignals.push({ from: sig.from, type: sig.type, msg: sig.msg, at: sig.at });
    }
  }

  return { missionId, goal: plan.mission.goal, currentTaskId: task.id, currentTaskWhat: task.what, squadRole: role, squadOn: on, squadGoal, squadTeammates, completedTasks, inProgressTasks, unresolvedSignals };
}

/** 渲染 MissionContext 为 system prompt 文本（行为保持）。 */
export function renderMissionContextFor(missionId: string, planTaskId: string, agentName: string, deps: MissionContextDeps): string | null {
  const ctx = readMissionContext(missionId, planTaskId, agentName, deps);
  if (!ctx) return null;
  return renderMissionContext(ctx);
}
