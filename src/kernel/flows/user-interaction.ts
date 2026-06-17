/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——用户交互操作提取。
 *
 * 从 delegation-orchestrator.ts 提取 3 个用户交互方法（行为保持）：
 *   - handleSendUserReply：用户回复 agent 提问 → 板状态 user_resumed + 观察 + IPC
 *   - handleResolveUserPermissionConfirm：用户权限确认 → token 签发 + 通知 + 记录
 *   - handleInterruptSession：用户中断会话 → 委派 interrupt + pending fail + 清理投机状态
 */
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { AgentManager } from '../agent-manager.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { ObservationRecorder } from '../observation-recorder.js';
import type { PermissionCoordinator } from '../permission-coordinator.js';
import type { PermissionFlow } from './permission-flow.js';
import type { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import type { StreamingFlusher } from '../streaming-flusher.js';
import type { AgentUserReplyPayload } from '../../contracts/routing.js';
import type { RouteDecision } from '../../contracts/routing.js';
import { getEventBus } from '../event-bus.js';
import { applyBoardStatus } from '../board-repo.js';

/** handleSendUserReply 依赖 */
export interface SendUserReplyDeps {
  readonly sessionManager: SessionManager;
  readonly delegationManager: DelegationManager;
  readonly observationRecorder: ObservationRecorder | null;
  readonly agentManager: AgentManager;
}

/** 用户回复 agent 提问（行为保持式提取）。板状态 user_resumed + 观察队列 + IPC + 事件。 */
export function handleSendUserReply(payload: AgentUserReplyPayload, correlationId: string, deps: SendUserReplyDeps): void {
  const { sessionManager, delegationManager, observationRecorder, agentManager } = deps;
  const askState = sessionManager.getPendingAsk(payload.sessionId);
  if (!askState) return;

  const agent = agentManager.getAgent(askState.agentName);
  if (!agent) return;

  delegationManager.resumeFromUserReply(askState.taskId);
  sessionManager.clearPendingAsk(payload.sessionId);

  // 16.0 §6.5.1/D：用户回复 → 板状态 user_resumed（awaiting_user → in_progress）
  if (askState.taskId) applyBoardStatus(askState.taskId, { kind: 'user_resumed' });

  // 13.0 §3.2/§5.3.3: 用户回复写入 Brain 观察队列（priority=0，critical）
  if (payload.sessionId && observationRecorder) {
    observationRecorder.record({
      sessionId: payload.sessionId,
      taskId: payload.taskId ?? askState.taskId ?? '',
      observationType: 'user_interaction',
      fromAgent: askState.agentName,
      content: JSON.stringify({ direction: 'user_reply', question: askState.question, reply: payload.reply?.slice(0, 500) }),
      priority: 0,
    });
  }

  agent.ipc.send('agent.user_reply', askState.agentName, payload, correlationId);

  getEventBus().emit('user.ask_response', {
    sessionId: payload.sessionId, taskId: payload.taskId, correlationId, response: payload.reply,
  });
}

/** handleResolveUserPermissionConfirm 依赖 */
export interface ResolvePermissionDeps {
  readonly permissionCoordinator: PermissionCoordinator;
  readonly permissionFlow: PermissionFlow;
  readonly brainDecisionRecorder: BrainDecisionRecorder | null;
}

/** 用户权限确认 → token 签发 + 通知 tool-caller + 记录（行为保持式提取）。 */
export function handleResolveUserPermissionConfirm(
  requestId: string, approved: boolean, reason: string | undefined, deps: ResolvePermissionDeps,
): boolean {
  const { permissionCoordinator, permissionFlow, brainDecisionRecorder } = deps;
  // 1. 先签发 token（批准→PermissionToken，拒绝→null）。须在通知 tool-caller 前完成。
  const token = permissionCoordinator.resolve(requestId, {
    verdict: approved ? 'approved' : 'denied',
    source: 'user',
    tokenVerdict: approved ? 'allow_once' : undefined,
    reason: reason ?? (approved ? '用户确认' : '用户拒绝'),
  });

  // 2. 通知 tool-caller（带 tokenId）
  const resolved = permissionFlow.resolveUserConfirm(requestId, approved, reason, token?.id);
  if (!resolved) return false;

  if (!approved && reason) {
    brainDecisionRecorder?.record({
      sessionId: 'user_permission', decisionType: 'permission',
      inputSummary: `user denied permission`, outputJson: { denied: true, userReason: reason },
    });
    brainDecisionRecorder?.updateLesson(requestId, reason);
  }
  return true;
}

/** handleInterruptSession 依赖 */
export interface InterruptSessionDeps {
  readonly delegationManager: DelegationManager;
  readonly sessionManager: SessionManager;
  readonly streamingFlusher: StreamingFlusher;
  speculativeCorrelations: Set<string>;
  pendingHandoffs: Map<string, RouteDecision>;
}

/** 用户中断会话 → 委派 interrupt + pending fail + 清理投机状态（行为保持式提取）。 */
export function handleInterruptSession(
  sessionId: string, reason: string | undefined, deps: InterruptSessionDeps,
): { interrupted: boolean; taskId?: string; partialResponse?: string } {
  const { delegationManager, sessionManager, streamingFlusher, speculativeCorrelations, pendingHandoffs } = deps;
  const activeEntries = delegationManager.getActiveForSession(sessionId);
  if (activeEntries.length === 0) return { interrupted: false };

  for (const entry of activeEntries) {
    delegationManager.interrupt(entry.id, reason ?? 'user interrupt');
  }

  const primary = activeEntries[0];
  const pending = sessionManager.getPending(primary.correlationId);
  if (pending) {
    streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
    sessionManager.fail(primary.correlationId, { kind: 'terminated' });
  }

  speculativeCorrelations.delete(primary.correlationId);
  pendingHandoffs.delete(primary.correlationId);

  return { interrupted: true, taskId: primary.id, partialResponse: primary.finalResponse };
}
