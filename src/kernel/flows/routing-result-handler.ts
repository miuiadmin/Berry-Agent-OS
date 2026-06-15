/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——route.result handler 提取（第 3 步）。
 *
 * 从 delegation-orchestrator.ts 的 setupRoutingFlow 闭包整组搬出（行为保持，
 * 仅把 this.* 依赖改成显式参数）。该 handler 注册在 reviewer(Brain) IPC 上，
 * 处理 Brain 的路由决策回流：
 *   - 机制 B 升级问用户（complete 结束本轮）
 *   - 记录 Brain 决策（FallbackRouter 学习 + BrainDecisionRecorder + IntentAnchor/mission 上下文回填）
 *   - 投机执行握手（speculativeCorrelations 标记 + pendingHandoffs 排队）
 *   - 非投机场景交 handleRouteDecision 分发
 *
 * 副作用逐字保留：pendingReviewOrigins 不在此处写；机制 B 的 postAskEnvelope 落板 +
 * sessionManager.complete（用户下轮重新发起）原样。
 */

import type { SessionManager } from '../session-manager.js';
import type { FallbackRouter } from '../fallback-router.js';
import type { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import type { DriftDetector } from '../drift-detector.js';
import type { IpcMessage, IpcMessageType } from '../types.js';
import type { RouteDecision, RouteResultPayload } from '../../contracts/routing.js';
import { postAskEnvelope } from '../board-projection.js';
import { getEventBus } from '../event-bus.js';
import { safeSlice } from '../../utils/safe-slice.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** handler 内部回调的回调（与主类方法解耦） */
export interface RoutingResultHandlerDeps {
  readonly sessionManager: SessionManager;
  readonly fallbackRouter: FallbackRouter;
  readonly brainDecisionRecorder: BrainDecisionRecorder | null;
  readonly driftDetector: DriftDetector | null;
  /** 投机执行标记集合（correlationId 是否已投机启动 conversation） */
  readonly speculativeCorrelations: Set<string>;
  /** 投机执行的待 handoff 队列（correlationId → Brain 的路由决策） */
  readonly pendingHandoffs: Map<string, RouteDecision>;
  /** 进度上报回调（主类 reportProgress，逐字搬运原行为） */
  reportProgress(
    pending: import('../session-manager.js').PendingRequest,
    status: import('../../contracts/socket-protocol.js').SocketProgressEvent['status'],
    summary: string,
  ): void;
  /** 路由决策分发回调（主类 handleRouteDecision，非投机场景的入口） */
  handleRouteDecision(decision: RouteDecision, correlationId: string): void;
}

/**
 * 注册 route.result IPC handler（Brain 路由决策回流处理）。
 *
 * 行为与原 setupRoutingFlow 逐字一致：
 * 1. escalation 问用户 → postAskEnvelope + complete 结束本轮
 * 2. pending 存在 → 记录 Brain 决策 + 回填 IntentAnchor/mission 上下文 + reportProgress + emit message.routed
 * 3. 投机执行标记存在 → 删除标记，chat 确认或排队 handoff
 * 4. 否则交 handleRouteDecision 分发
 *
 * @param reviewerIpc Brain(reviewer) IPC 通道
 * @param deps        依赖（注入对象 + 跨集群回调）
 */
export function setupRoutingResultHandler(
  reviewerIpc: { onMessage: (type: IpcMessageType, handler: (msg: IpcMessage) => void) => void },
  deps: RoutingResultHandlerDeps,
): void {
  const {
    sessionManager,
    fallbackRouter,
    brainDecisionRecorder,
    driftDetector,
    speculativeCorrelations,
    pendingHandoffs,
    reportProgress,
    handleRouteDecision,
  } = deps;

  reviewerIpc.onMessage('route.result', (msg: IpcMessage) => {
    const { decision, escalation } = msg.payload as RouteResultPayload;
    const correlationId = msg.correlationId!;
    logger.info({ correlationId, intent: decision.intent, target: decision.targetAgent, hasEscalation: !!escalation }, '路由决策到达');

    const pending = sessionManager.getPending(correlationId);

    // 15.0 机制 B：Brain 路由拿不准意图 → 把澄清问题作为本轮 assistant 回复结束，用户下一轮补充后 Brain 重新路由。
    // 不走 conversation.ask_user 交互暂停通道（AskUserDialog→sendUserReply）：那条通道要求事前 setPendingAsk 注册
    // 一个可恢复 agent 任务，但路由阶段尚未派发任何 agent，sendUserReply 的 getPendingAsk 空查会丢弃回复（死通道）。
    // Brain 是反应式决策者——以「问题结束本轮 + 用户下轮重新发起」承载，complete 删 pending 后
    // hasActivePendingForSession=false，用户下条消息自然进入新轮。这与 applyRestart 降级路径（correction-flow）
    // 的问用户方式一致，消除两套不一致的「问用户」实现。投机执行的 conversation 末态有 getPending 守卫
    // （final.response:2124），pending 已删 → late 投机输出 no-op，无竞态。
    if (escalation && pending) {
      logger.info({ correlationId, question: safeSlice(escalation.questionToUser, 100) }, 'route 升级问用户（机制 B）');
      // 16.0 P3-C1：route 升级投影 ask(@brain)（fire-and-forget）
      postAskEnvelope(pending.delegationTaskId ?? pending.taskId ?? correlationId, {
        from: 'brain', question: escalation.questionToUser, sessionId: pending.sessionId,
      });
      sessionManager.complete(correlationId, escalation.questionToUser);
      return;
    }

    if (pending) {
      fallbackRouter.recordBrainDecision(pending.userMessage, decision);
      brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, decision as unknown as Record<string, unknown>, pending.taskId);
      // 12.0: 填充意图锚点到 pending（漂移检测基准）并持久化
      if (decision.intentAnchor) {
        pending.intentAnchor = decision.intentAnchor;
        driftDetector?.recordAnchor(
          decision.intentAnchor, pending.userMessage,
          pending.sessionId, correlationId, decision.reason,
        );
      }
      // 13.0 §12.6: 填充 missionId / planTaskId / taskDescription 到 pending（审核时传给 Brain）
      if (decision.missionId) pending.missionId = decision.missionId;
      if (decision.planTaskId) pending.planTaskId = decision.planTaskId;
      if (decision.missionSpec?.tasks?.length && decision.planTaskId) {
        // missionSpec.tasks 没有 id 字段，按 planTaskId 解析（如 t-1 → index 0）
        const m = /^t-(\d+)$/.exec(decision.planTaskId);
        if (m) {
          const idx = parseInt(m[1], 10) - 1;
          const taskSpec = decision.missionSpec.tasks[idx];
          if (taskSpec) pending.taskDescription = taskSpec.what;
        }
      }
      if (decision.reason) {
        reportProgress(pending, 'routing', `brain → ${decision.targetAgent}: ${decision.reason}`);
      }
      getEventBus().emit('message.routed', {
        sessionId: pending.sessionId,
        taskId: pending.taskId ?? correlationId,
        targetAgent: decision.targetAgent,
        intent: decision.intent,
      });
    }

    // §9.0 Speculative execution: conversation already started
    if (speculativeCorrelations.has(correlationId)) {
      speculativeCorrelations.delete(correlationId);
      if (decision.intent === 'chat' || decision.targetAgent === 'conversation') {
        logger.debug({ correlationId }, 'speculative execution confirmed: conversation');
        return;
      }
      // Brain says different agent → store handoff for when conversation finishes
      pendingHandoffs.set(correlationId, decision);
      logger.info({ correlationId, handoffTo: decision.targetAgent }, 'speculative handoff queued');
      return;
    }

    // If pending is gone and no speculative marker, the conversation already finished
    // (late Brain response) — ignore to avoid stale routing
    if (!pending) {
      logger.debug({ correlationId, intent: decision.intent }, 'late route.result after conversation finished, ignored');
      return;
    }

    handleRouteDecision(decision, correlationId);
  });
}
