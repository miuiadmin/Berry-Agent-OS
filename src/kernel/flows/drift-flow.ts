/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——漂移检测流提取（第 10 步）。
 *
 * 从 delegation-orchestrator.ts 的 performDriftCheckAndApprove 整组搬出（行为保持，
 * 仅把 this.* 依赖改成显式参数）。VerifyGate 一并搬入（§17.7.3 明确 keep 的活路径，
 * 只提取不删）。
 *
 * B/C 级回复的漂移检测：通过 Brain IPC 做轻量检测，根据结果决定：
 *   - 正常对齐：auto-approve（dispatchFeedbackExtraction）
 *   - 中偏离（correct）：触发 CorrectionFlow（emit delegation.checkpoint_needed）
 *   - 高偏离（verify）：VerifyGate 独立对抗性验证 → pass=true 走完整 Brain review；
 *     pass=false 直接 reject；异常不阻断继续 review
 *
 * ⚠️ DriftDetector 是 §17.7.3 明确 keep 的活路径，只提取不删。
 * ⚠️ drift check 5s 超时不再 auto-approve（绕过审核违反硬规则），降级为同步 Brain review
 *    + 30s 审核超时保护（防止 Brain LLM 挂死）。
 */

import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { DriftDetector } from '../drift-detector.js';
import type { IpcMessage } from '../types.js';
import type { TurnRecord, ReviewResult } from '../../contracts/review.js';
import type { ToolBlock } from '../../contracts/message-blocks.js';
import type { SocketProgressEvent } from '../../contracts/socket-protocol.js';
/** 12.0/13.0 VerifyGate — 独立对抗性意图验证（高漂移时触发） */
import { VerifyGate } from '../verify-gate.js';
import { safeSlice } from '../../utils/safe-slice.js';
import { genId } from '../../utils/id.js';
import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** IPC 通道抽象（onMessage + send） */
interface AgentIpc {
  onMessage: (type: import('../types.js').IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: import('../types.js').IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

/** 漂移检测流依赖注入 + 跨集群回调 */
export interface DriftFlowDeps {
  readonly agentManager: AgentManager;
  readonly registry: AgentRegistry;
  readonly delegationManager: DelegationManager;
  readonly sessionManager: SessionManager;
  readonly driftDetector: DriftDetector | null;
  /** ReviewOrigin 跟踪 Map（correlationId → origin） */
  readonly pendingReviewOrigins: Map<string, 'conversation' | 'task' | 'superior_chain'>;
  /** 审核降级回调（主类 approveReviewDegraded，走 review-flow.ts） */
  approveReviewDegraded(
    correlationId: string,
    draft: string,
    reason: string,
    sessionId: string,
  ): void;
  /** feedback extraction 派发回调（主类 dispatchFeedbackExtraction） */
  dispatchFeedbackExtraction(
    sessionId: string,
    userMessage: string,
    assistantResponse: string,
    requester: 'brain_learning' | 'post_review',
  ): void;
  /** 进度上报回调（主类 reportProgress） */
  reportProgress(pending: PendingRequest, status: SocketProgressEvent['status'], summary: string): void;
}

/**
 * B/C 级回复的漂移检测（逐字搬运）。
 *
 * 流程：
 *   1. Brain 不可用 / 无 intentAnchor → 直接 approve（降级）
 *   2. 发 drift.check.request 给 Brain，5s 超时
 *   3. 超时 → 降级为同步 Brain review（不 auto-approve，+ 30s 审核超时保护）
 *   4. drift.check.result handler：
 *      - verify（高偏离）→ VerifyGate 独立验证 → pass=false 直接 reject；pass=true 走完整 review
 *      - correct（中偏离）→ emit delegation.checkpoint_needed 触发 CorrectionFlow；无 entry 降级 approve
 *      - 正常对齐 → approve + dispatchFeedbackExtraction
 *
 * @param pending       关联的 pending request
 * @param primaryIpc    primary(Conversation) IPC 通道
 * @param primaryName   primary agent 名
 * @param reviewerIpc   reviewer(Brain) IPC 通道
 * @param reviewerName  reviewer agent 名
 * @param correlationId pending request 的 correlation id
 * @param sessionId     对话 sessionId
 * @param draft         草稿回复
 * @param turn          审核轮次记录
 * @param deps          依赖注入 + 跨集群回调
 */
export function performDriftCheckAndApprove(
  pending: PendingRequest,
  primaryIpc: AgentIpc,
  primaryName: string,
  reviewerIpc: AgentIpc,
  reviewerName: string,
  correlationId: string,
  sessionId: string,
  draft: string,
  turn: TurnRecord,
  deps: DriftFlowDeps,
): void {
  const {
    agentManager, registry, delegationManager, sessionManager, driftDetector,
    pendingReviewOrigins, approveReviewDegraded, dispatchFeedbackExtraction, reportProgress,
  } = deps;

  /** 12.0/13.0 VerifyGate — 高漂移时的独立对抗性意图验证 */
  const verifyGate = new VerifyGate();

  const brainAgent = agentManager.getAgent(registry.requireRole('reviewer').manifest.name);
  if (!brainAgent || !pending.intentAnchor) {
    // Brain 不可用或无 anchor → 降级为直接 approve
    primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
    return;
  }

  // 发 drift.check.request 给 Brain
  const driftCorrelationId = genId('drift');
  brainAgent.ipc.send('drift.check.request', 'brain', {
    anchor: pending.intentAnchor,
    content: safeSlice(draft, 3000),
    checkpointType: 'final_response',
  }, driftCorrelationId);

  // 超时设置：drift check 涉及 IPC + fast tier LLM，2s 过短易误判。
  // 超时不再 auto-approve（绕过审核违反硬规则），而是降级为同步 Brain review 深度审核。
  let settled = false;  // drift check 是否已出结果（正常返回或超时），保证二者只有一个生效
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    logger.warn({ correlationId }, 'drift check timeout, falling back to sync Brain review (not auto-approve)');
    pendingReviewOrigins.set(correlationId, 'conversation');
    reportProgress(pending, 'reviewing', '漂移检测超时，降级为完整审核...');
    // 补齐 sent 检查 + 30s 审核超时保护，与正常审核路径（2030-2037 行）保持一致。
    // 防止 drift 降级发 review.request 后 Brain LLM 挂死导致审核永久挂起——
    // 否则只能靠 240s pending 超时兜底，用户等待过久。
    const sent = reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
    if (!sent) {
      logger.warn({ correlationId }, 'drift 降级 review.request IPC 发送失败，自动 approve');
      pendingReviewOrigins.delete(correlationId);
      approveReviewDegraded(correlationId, draft, 'review_ipc_send_failed', pending.sessionId);
      return;
    }
    setTimeout(() => {
      const stillPending = sessionManager.getPending(correlationId);
      if (!stillPending) return;
      logger.warn({ correlationId }, 'drift 降级审核超时，自动 approve');
      pendingReviewOrigins.delete(correlationId);
      approveReviewDegraded(correlationId, draft, 'review_timeout', pending.sessionId);
    }, 30_000);
  }, 5000);

  const cleanup = () => {
    clearTimeout(timeoutId);
  };

  const handler = async (msg: IpcMessage) => {
    if (msg.correlationId !== driftCorrelationId) return;
    if (settled) return;  // 已超时降级，忽略迟到的 drift 结果（避免重复处理）
    settled = true;
    cleanup();

    const { signal } = msg.payload as { signal: import('../../contracts/intent.js').DriftSignal };
    const evaluated = driftDetector?.evaluate(signal) ?? signal;

    // 记录漂移信号
    driftDetector?.recordSignal(evaluated, sessionId, correlationId);

    if (evaluated.suggestedAction === 'verify') {
      // 高偏离 → 先运行 VerifyGate 独立对抗性验证
      // VerifyGate 用 Brain 的 default tier 模型以对抗性视角快速判断回复是否有根本性错误
      // 如果 VerifyGate 确认失败（pass=false）→ 直接 reject，无需完整 review
      // 如果 VerifyGate 无法确认（pass=true）→ 走同步 Brain review 深度审核
      logger.info({ correlationId, score: evaluated.alignmentScore }, 'drift:high → verify gate + sync review');
      if (pending.intentAnchor) {
        try {
          const verdict = await verifyGate.verify(
            brainAgent.ipc as any,
            pending.intentAnchor,
            draft,
          );
          if (!verdict.pass) {
            // VerifyGate 确认回复有根本性错误 → 直接 reject（节省一次完整 review LLM 调用）
            logger.info({ correlationId, reason: verdict.reason?.slice(0, 200) }, 'verify:gate REJECT');
            primaryIpc.send('review.result', primaryName, {
              verdict: 'reject',
              reason: `独立验证未通过: ${verdict.reason ?? '回复与用户意图不匹配'}`,
            } as ReviewResult, correlationId);
            dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
            return;
          }
          // VerifyGate 通过但仍高漂移 → 走完整 Brain review
          logger.debug({ correlationId }, 'verify:gate pass, proceeding to full review');
        } catch (err) {
          // VerifyGate 异常 → 不阻断，继续走完整 review
          logger.warn({ err, correlationId }, 'verify:gate error, falling back to full review');
        }
      }
      pendingReviewOrigins.set(correlationId, 'conversation');
      reportProgress(pending, 'reviewing', '检测到可能偏离，正在深度审核...');
      // 补齐 sent 检查 + 30s 审核超时保护，与正常审核路径保持一致（同 drift 超时降级路径）。
      // verify 通过后走完整 review，同样需要超时保护防止 Brain LLM 挂死。
      const sent = reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
      if (!sent) {
        logger.warn({ correlationId }, 'drift verify 降级 review.request IPC 发送失败，自动 approve');
        pendingReviewOrigins.delete(correlationId);
        approveReviewDegraded(correlationId, draft, 'review_ipc_send_failed', pending.sessionId);
        return;
      }
      setTimeout(() => {
        const stillPending = sessionManager.getPending(correlationId);
        if (!stillPending) return;
        logger.warn({ correlationId }, 'drift verify 审核超时，自动 approve');
        pendingReviewOrigins.delete(correlationId);
        approveReviewDegraded(correlationId, draft, 'review_timeout', pending.sessionId);
      }, 30_000);
      return;
    }

    if (evaluated.suggestedAction === 'correct') {
      // 中偏离 → 触发 CorrectionFlow
      logger.info({ correlationId, score: evaluated.alignmentScore }, 'drift:medium → correction');
      const entry = delegationManager.getByCorrelation(correlationId);
      if (entry) {
        getEventBus().emit('delegation.checkpoint_needed', {
          delegationId: entry.id,
          trigger: 'semantic_drift' as import('../../contracts/delegation.js').CheckpointTrigger,
        });
      } else {
        // 无 delegation entry → 降级 approve
        primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
      }
      return;
    }

    // 正常对齐 → approve
    primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
    dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
  };

  brainAgent.ipc.onMessage('drift.check.result', handler);
}
