/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——agent.ask_user 流提取（第 8 步）。
 *
 * 从 delegation-orchestrator.ts 的 setupAgentAskUserFlow 闭包整组搬出（行为保持，
 * 仅把 this.* 依赖改成显式参数）。该 handler 注册在 reviewer(Brain) IPC 上，
 * 处理 Brain 审核过的 agent 提问（payload._brainReview 已含 Brain 决策）：
 *   - Brain 否决且提供 autoAnswer → 直接替用户回复（不暂停问用户）
 *   - Brain 通过 / 重写问题 → setPendingAsk 暂停 + 写观察队列 + markAskingUser + emit ask_user
 *
 * ⚠️ observationRecorder 写入（§3.2/§5.3.3 priority=0 critical）逐字保留。
 * ⚠️ delegationManager.markAskingUser + emit conversation.ask_user 逐字保留。
 */

import type { AgentManager } from '../agent-manager.js';
import type { SessionManager } from '../session-manager.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { ObservationRecorder } from '../observation-recorder.js';
import type { IpcMessage, IpcMessageType } from '../types.js';
import type { AgentAskUserPayload, AgentUserReplyPayload } from '../../contracts/routing.js';
import { getEventBus } from '../event-bus.js';
import { applyBoardStatus } from '../board-repo.js';

/** agent.ask_user 流依赖注入 */
export interface AskUserFlowDeps {
  readonly agentManager: AgentManager;
  readonly sessionManager: SessionManager;
  readonly delegationManager: DelegationManager;
  readonly observationRecorder: ObservationRecorder;
}

/**
 * 注册 agent.ask_user IPC handler（Brain 审核过的 agent 提问处理）。
 *
 * 行为与原 setupAgentAskUserFlow 逐字一致：
 * 1. _brainReview 否决且 autoAnswer → 替用户回复（不暂停）
 * 2. question = rewrittenQuestion ?? payload.question
 * 3. setPendingAsk（暂停等待 sendUserReply）
 * 4. observationRecorder.record（priority=0 critical，§5.3.3）
 * 5. delegationManager.markAskingUser + emit conversation.ask_user（仅 entry 存在时）
 *
 * @param reviewerIpc Brain(reviewer) IPC 通道（Brain 审核后的 ask_user 从这里来）
 * @param deps        依赖注入
 */
export function setupAgentAskUserFlow(
  reviewerIpc: { onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void },
  deps: AskUserFlowDeps,
): void {
  const { agentManager, sessionManager, delegationManager, observationRecorder } = deps;

  reviewerIpc.onMessage('agent.ask_user', (msg: IpcMessage) => {
    const payload = msg.payload as AgentAskUserPayload & { _brainReview?: { approved: boolean; rewrittenQuestion?: string; autoAnswer?: string } };
    const correlationId = msg.correlationId!;

    const brainReview = payload._brainReview;
    if (brainReview && !brainReview.approved && brainReview.autoAnswer) {
      const agent = agentManager.getAgent(msg.from);
      if (agent) {
        agent.ipc.send('agent.user_reply', msg.from, {
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          reply: brainReview.autoAnswer,
        } satisfies AgentUserReplyPayload, correlationId);
      }
      return;
    }

    const question = brainReview?.rewrittenQuestion ?? payload.question;

    sessionManager.setPendingAsk(payload.sessionId, {
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      agentName: msg.from,
      question,
      correlationId,
    });

    // 16.0 §6.5.1/D：agent 问用户 → 板状态 awaiting_user（让前端任务卡显示「等用户输入」，
    // 板状态机单一事实源；无 board 的 chat 路径 applyBoardStatus 静默 no-op）。
    if (payload.taskId) applyBoardStatus(payload.taskId, { kind: 'await_user' });

    // 13.0 §3.2/§5.3.3: 将 agent 提问写入 Brain 观察队列（priority=0，critical，永不丢弃）
    // Brain 审核时需要知道 agent 主动问了用户什么，以判断：
    // 1. 提问是否合理（该问用户还是自己做决策？）
    // 2. 提问措辞是否安全（有没有泄露敏感信息？）
    // 3. 提问频率是否过高（§3.6 场景 H：意图模糊时应先问用户）
    if (payload.sessionId && observationRecorder) {
      observationRecorder.record({
        sessionId: payload.sessionId,
        taskId: payload.taskId ?? '',
        observationType: 'user_interaction',
        fromAgent: msg.from,
        content: JSON.stringify({
          direction: 'agent_ask',
          question,
          options: payload.options,
        }),
        priority: 0, // §5.3.3: user_interaction = priority 0（critical，永不丢弃）
      });
    }

    const entry = delegationManager.get(payload.taskId);
    if (entry) {
      delegationManager.markAskingUser(payload.taskId, question);
      // P0-B 修复：业务路径不再直写 socket，改为 emit
      getEventBus().emit('conversation.ask_user', {
        sessionId: payload.sessionId,
        taskId: payload.taskId,
        agent: msg.from,
        question,
        options: payload.options,
        correlationId,
      });
    }
  });
}
