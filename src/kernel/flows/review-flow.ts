/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——审核流簇提取（第 9 步，最大单块）。
 *
 * 从 delegation-orchestrator.ts 搬出审核流簇 6 方法（行为保持，仅把 this.* 依赖改成显式参数）：
 *   - setupReviewFlow：注册 draft.response / review.result / final.response 3 个 IPC handler
 *   - handleTaskReviewResult：task-origin 审核结果收口（委派 complete + plan update + onConversationCompleted）
 *   - onSuperiorChainCompleted：上级审核通过后转 Brain 审核
 *   - approveReviewDegraded：审核降级统一收尾（emit no_response → delegation complete → session complete）
 *   - onSuperiorChainRejected：上级审核退回（委派 fail + session fail）
 *   - sendTaskResultForReview：foreground 任务结果送 Brain 审核（reviewer 不可用降级）
 *
 * 互调策略：6 方法在同文件内直接调用（handleTaskReviewResult / approveReviewDegraded /
 * sendTaskResultForReview 互调）；调用主类方法（handleRouteDecision / performDriftCheckAndApprove /
 * dispatchFeedbackExtraction / onConversationCompleted）走 deps 回调。
 *
 * ⚠️ draft.response: auto-approve / drift / sync review 三路分流逐字保留（硬规则：所有回复必须经 Brain 审核）。
 * ⚠️ final.response: handoff 投机合并 + persistInlineBlocks + ReviewBlock 落徽章 + speculativeCorrelations 清理逐字保留。
 * ⚠️ review.result: 机制 B 升级问用户（fail reviewing 委派释放 active_scope）逐字保留。
 */

import { join } from 'node:path';
import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { AuditRecorder } from '../audit-recorder.js';
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { StreamingFlusher } from '../streaming-flusher.js';
import type { TaskManager } from '../task-manager.js';
import type { DialogueRouter } from '../dialogue-router.js';
import type { ObservationRecorder } from '../observation-recorder.js';
import type { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import type { TakeoverController } from '../../testing/model-takeover.js';
import type { SuperiorReviewFlow } from './superior-review-flow.js';
import type { MissionManager } from '../mission-manager.js';
import type { IpcMessage } from '../types.js';
import type { RouteDecision } from '../../contracts/routing.js';
import type { DraftResponsePayload, FinalResponsePayload } from '../../contracts/messaging.js';
import type { ReviewResult, TurnRecord } from '../../contracts/review.js';
import type { ToolBlock } from '../../contracts/message-blocks.js';
import type { SocketProgressEvent } from '../../contracts/socket-protocol.js';
import { classifyLevel } from '../../contracts/review.js';
import { peekBlockCollector } from '../block-collector.js';
import { postAskEnvelope, postReportEnvelope } from '../board-projection.js';
import { closeTaskWorkspace } from '../task-workspace.js';
import { getAgentHomePath } from '../agent-home.js';
import { safeSlice } from '../../utils/safe-slice.js';
import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

type ReviewOrigin = 'conversation' | 'task' | 'superior_chain';

/** IPC 通道抽象（onMessage + send） */
interface AgentIpc {
  onMessage: (type: import('../types.js').IpcMessageType, handler: (msg: IpcMessage) => void) => void;
  send: (type: import('../types.js').IpcMessageType, to: string, payload: unknown, correlationId?: string) => boolean;
}

/** 审核流簇依赖注入 + 跨集群回调 */
export interface ReviewFlowDeps {
  readonly agentManager: AgentManager;
  readonly registry: AgentRegistry;
  readonly sessionManager: SessionManager;
  readonly taskManager: TaskManager;
  readonly delegationManager: DelegationManager;
  readonly streamingFlusher: StreamingFlusher;
  readonly auditRecorder: AuditRecorder;
  readonly brainDecisionRecorder: BrainDecisionRecorder | null;
  readonly dialogueRouter: DialogueRouter | null;
  readonly observationRecorder: ObservationRecorder;
  readonly takeoverController: TakeoverController | null;
  readonly superiorReviewFlow: SuperiorReviewFlow | null;
  readonly missionManager: MissionManager | null;
  /** ReviewOrigin 跟踪 Map（correlationId → origin） */
  readonly pendingReviewOrigins: Map<string, ReviewOrigin>;
  /** 投机执行待 handoff 队列（correlationId → Brain 路由决策） */
  readonly pendingHandoffs: Map<string, RouteDecision>;
  /** 投机执行标记集合 */
  readonly speculativeCorrelations: Set<string>;
  /** 路由决策分发回调（主类 handleRouteDecision） */
  handleRouteDecision(decision: RouteDecision, correlationId: string): void;
  /** 漂移检测回调（主类 performDriftCheckAndApprove，B/C 级回复异步漂移检测后再决定） */
  performDriftCheckAndApprove(
    pending: PendingRequest,
    primaryIpc: AgentIpc,
    primaryName: string,
    reviewerIpc: AgentIpc,
    reviewerName: string,
    correlationId: string,
    sessionId: string,
    draft: string,
    turn: TurnRecord,
  ): void;
  /** 对话完成回调（主类 onConversationCompleted，post-complete 学习序列） */
  onConversationCompleted(sessionId: string, userMessage: string, assistantResponse: string, toolCalls?: ToolBlock[]): void;
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
 * 审核降级统一收尾（逐字搬运）。
 *
 * 当 reviewer 不可用 / IPC 发送失败 / 审核超时时，草稿回复仍有效（不是错误），
 * 直接 approve 落库。封装 emit no_response → delegationManager.complete → sessionManager.complete
 * 三步序列，消除 5 处手写重复。
 *
 * @param correlationId pending request 的 ID
 * @param draft 有效的草稿回复（直接 approve）
 * @param reason 降级原因（用于前端通知和日志）
 * @param sessionId 对话 sessionId
 * @param deps    依赖注入
 */
export function approveReviewDegraded(
  correlationId: string,
  draft: string,
  reason: string,
  sessionId: string,
  deps: ReviewFlowDeps,
): void {
  const { sessionManager, delegationManager } = deps;
  const pending = sessionManager.getPending(correlationId);
  getEventBus().emit('conversation.no_response', {
    sessionId,
    reason,
    taskId: pending?.taskId,
    correlationId,
  });
  const entry = delegationManager.getByCorrelation(correlationId);
  if (entry) {
    delegationManager.complete(entry.id, draft);
    // 16.0 §6.5.1+(B)：降级 approve（reviewer 不可用/IPC 失败/超时）→ 板状态 completed。
    // complete() 不投板，显式 postReport 终态化，防 board 卡 awaiting_review（task-origin 路径）。
    // conversation-origin 无 board（chat 不投 delegate），entry 多为空 → if 守卫跳过，零副作用。
    postReportEnvelope(entry.id, {
      from: entry.targetAgent, to: 'leader', status: 'done', summary: draft, sessionId,
    });
  }
  sessionManager.complete(correlationId, draft);
}

/**
 * 上级审核通过后转 Brain 审核（逐字搬运）。
 *
 * superior chain completed 回调：把 modifiedResponse 写入 pending.draftResponse，
 * 从 collector 取 toolBlocks，回填 origin（superior_chain → task/conversation），
 * reportProgress + 构造 turn + send review.request 给 Brain。
 */
export function onSuperiorChainCompleted(
  correlationId: string,
  modifiedResponse: string | undefined,
  reviewerIpc: AgentIpc,
  reviewerName: string,
  deps: ReviewFlowDeps,
): void {
  const { sessionManager, dialogueRouter, pendingReviewOrigins, reportProgress } = deps;
  const pending = sessionManager.getPending(correlationId);
  if (!pending) return;

  if (modifiedResponse) {
    pending.draftResponse = modifiedResponse;
  }

  // 对话内联：工具真相单一源 collector（superior 链审核期间 collector 仍存活，未到 turn-terminal complete）。
  const toolBlocks = peekBlockCollector(pending.delegationTaskId ?? pending.taskId ?? '')?.getToolBlocks() ?? [];

  const origin = pendingReviewOrigins.get(correlationId);
  pendingReviewOrigins.set(correlationId, origin === 'superior_chain' ? (pending.taskId ? 'task' : 'conversation') : origin ?? 'conversation');
  reportProgress(pending, 'reviewing', '上级审核通过，正在 Brain 审核...');

  const turn: TurnRecord = {
    sessionId: pending.sessionId,
    userMessage: pending.userMessage,
    draftResponse: pending.draftResponse ?? '',
    toolCalls: toolBlocks,
    level: pending.level as 'A' | 'B' | 'C' ?? 'A',
    missionId: pending.missionId,
    planTaskId: pending.planTaskId,
    taskDescription: pending.taskDescription,
    agentDialogCount: dialogueRouter?.getDialogueCountByCorrelation(correlationId),
  };

  reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
}

/**
 * 上级审核退回（逐字搬运）。
 *
 * superior chain rejected 回调：flusher 清理 + 删 origin + 委派 fail + session fail。
 */
export function onSuperiorChainRejected(correlationId: string, reason: string, deps: ReviewFlowDeps): void {
  const { sessionManager, streamingFlusher, pendingReviewOrigins, delegationManager } = deps;
  const pending = sessionManager.getPending(correlationId);
  if (!pending) return;

  if (pending.taskId) streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId);
  pendingReviewOrigins.delete(correlationId);
  const entry = delegationManager.getByCorrelation(correlationId);
  if (entry) delegationManager.fail(entry.id, `Superior rejected: ${reason}`);
  sessionManager.fail(correlationId, { kind: 'failed', error: `上级审核退回: ${reason}` });
}

/**
 * task-origin 审核结果收口（逐字搬运）。
 *
 * approve/modify → delegation complete + plan done；reject → plan failed。
 * 从 collector 取 toolBlocks → onConversationCompleted → finalized.resolve。
 */
export function handleTaskReviewResult(review: ReviewResult, correlationId: string, deps: ReviewFlowDeps): void {
  const { sessionManager, streamingFlusher, delegationManager, missionManager, onConversationCompleted } = deps;
  const pending = sessionManager.getPending(correlationId);
  if (!pending) return;

  if (pending.taskId) streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId);

  const response = review.verdict === 'modify' && review.finalResponse
    ? review.finalResponse
    : pending.draftResponse ?? '';

  const entry = delegationManager.getByCorrelation(correlationId);
  if (entry) {
    delegationManager.complete(entry.id, response);
    // 16.0 §6.5.1+(B)：review 裁决 → 板状态机 terminal（awaiting_review → completed[approve/modify]/failed[reject]）。
    // complete() 不投板（只 fail/interrupt 投），显式 postReport 终态化，防 board 卡 awaiting_review。
    const isReject = review.verdict === 'reject';
    postReportEnvelope(entry.id, {
      from: entry.targetAgent, to: 'leader',
      status: isReject ? 'blocked' : 'done',
      summary: isReject ? (review.reason ?? '审核拒绝') : (response ?? ''),
      sessionId: pending.sessionId,
    });
  }

  // 13.0 §12.6: Brain 审核完成后同步更新 plan.json 中对应任务的状态
  // approve → 任务完成（结果用 Brain 审核后的最终回复）
  // modify → 任务完成（结果用 Brain 修改后的回复）
  // reject → 任务失败（结果用 Brain 的拒绝原因）
  if (missionManager && entry) {
    try {
      const raw = (entry as any).inputPayload ?? (entry as any).input_payload;
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const missionId = payload?.missionId as string | undefined;
      const planTaskId = payload?.planTaskId as string | undefined;
      if (missionId && planTaskId) {
        const planStatus = review.verdict === 'reject' ? 'failed' as const : 'done' as const;
        const planResult = review.verdict === 'reject'
          ? `Brain 审核拒绝: ${review.reason ?? '未通过审核'}`
          : (response ?? '').slice(0, 500);
        missionManager.updatePlan(missionId, {
          task_id: planTaskId,
          status: planStatus,
          result: planResult,
        });
        logger.info({ missionId, planTaskId, verdict: review.verdict }, '13.0: plan task updated after Brain review');
      }
    } catch (err) {
      logger.warn({ err, correlationId }, '13.0: plan update after Brain review failed (non-critical)');
    }
  }

  // 对话内联：complete() 内 persistInlineBlocks 会 dispose collector——须在 complete 之前捕获本轮 toolBlocks
  // 供下方 onConversationCompleted（post-complete 消费者，collector 已 dispose 不能再 peek）。
  const toolBlocks = peekBlockCollector(pending.delegationTaskId ?? pending.taskId ?? '')?.getToolBlocks() ?? [];
  // 半收尾：保存对话轮次 + 删除 pending（不 resolve），留后续操作用 pending 数据
  const finalized = sessionManager.complete(correlationId, response, { skipResolve: true });
  if (!finalized || finalized === true) return;

  onConversationCompleted(pending.sessionId, pending.userMessage, response, toolBlocks);
  // 所有后续操作完成后再 resolve
  finalized.resolve(response);
}

/**
 * foreground 任务结果送 Brain 审核（逐字搬运）。
 *
 * 流程：flusher 清理 → submitForReview → reviewer 不可用降级 approve → 构造 turn
 * （含 mission 上下文 + collector toolBlocks）→ superior chain 拦截 / send review.request
 * （失败降级）+ 30s 超时降级 approve。
 */
export function sendTaskResultForReview(
  fgEntry: { correlationId: string; sessionId: string },
  pending: PendingRequest,
  draftResponse: string,
  deps: ReviewFlowDeps,
): void {
  const { streamingFlusher, delegationManager, registry, agentManager, dialogueRouter, superiorReviewFlow, pendingReviewOrigins, reportProgress } = deps;
  // 流式阶段结束，清理 flusher（complete() 会写最终 output_payload）
  streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
  const entry = delegationManager.getByCorrelation(fgEntry.correlationId);
  if (entry) {
    delegationManager.submitForReview(entry.id, { delegationId: entry.id, response: draftResponse });
  }

  const reviewerAgent = registry.requireRole('reviewer');
  const reviewerName = reviewerAgent.manifest.name;
  const reviewer = agentManager.getAgent(reviewerName);

  // reviewer 不可用（进程崩溃/未启动）→ 直接 approve，不挂死
  if (!reviewer || !reviewer.child.connected) {
    logger.warn({ correlationId: fgEntry.correlationId }, 'Reviewer 不可用，自动 approve');
    approveReviewDegraded(fgEntry.correlationId, draftResponse, 'reviewer_unavailable', fgEntry.sessionId, deps);
    return;
  }

  // 13.0 §12.6: 构造审核记录，包含 mission 上下文
  // 从 delegation entry 的 inputPayload 中提取 missionId 和 planTaskId
  let missionId: string | undefined;
  let planTaskId: string | undefined;
  let taskDescription: string | undefined;
  if (entry) {
    try {
      const raw = (entry as any).inputPayload ?? (entry as any).input_payload;
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      missionId = payload?.missionId;
      planTaskId = payload?.planTaskId;
      taskDescription = payload?.message ?? payload?.userMessage;
    } catch { /* 非关键 */ }
  }

  // 对话内联：工具真相单一源 collector（审核入口，collector 仍存活——dispose 在 turn-terminal complete）。
  // daemon/foreground 路径原读 pending.toolCalls（无生产者恒为 []）→ 现从 collector 取真实工具，
  // 修复「Brain 审核看不到 daemon/外部 agent 任务工具」的隐性 bug。key 与 persistInlineBlocks 一致。
  // TurnRecord.toolCalls 已是 ToolBlock[]（契约统一），直接用 collector 取的完整块。
  const toolBlocks = peekBlockCollector(pending.delegationTaskId ?? pending.taskId ?? '')?.getToolBlocks() ?? [];

  const turn: TurnRecord = {
    sessionId: fgEntry.sessionId,
    userMessage: pending.userMessage,
    draftResponse,
    toolCalls: toolBlocks,
    level: classifyLevel({
      sessionId: fgEntry.sessionId,
      userMessage: pending.userMessage,
      draftResponse,
      toolCalls: toolBlocks,
      level: 'A',
      missionId,
      agentDialogCount: dialogueRouter?.getDialogueCountByCorrelation(fgEntry.correlationId),
    }),
    // 13.0 §12.6: 注入 mission 上下文，让 Brain 审核时知道"分配的任务是什么"
    missionId,
    planTaskId,
    taskDescription,
  };

  const wsId = entry?.workspaceId;
  if (superiorReviewFlow?.interceptForSuperiorReview(fgEntry.correlationId, entry?.targetAgent ?? '', wsId, turn, entry?.id)) {
    pendingReviewOrigins.set(fgEntry.correlationId, 'superior_chain');
    reportProgress(pending, 'reviewing', '正在上级审核任务结果...');
    return;
  }

  pendingReviewOrigins.set(fgEntry.correlationId, 'task');
  reportProgress(pending, 'reviewing', '正在审核...');

  // 发送审核请求，检查返回值
  const sent = reviewer.ipc.send('review.request', reviewerName, { turn }, fgEntry.correlationId);
  if (!sent) {
    // IPC 发送失败（进程已断连）→ 自动 approve
    logger.warn({ correlationId: fgEntry.correlationId }, 'review.request IPC 发送失败，自动 approve');
    pendingReviewOrigins.delete(fgEntry.correlationId);
    approveReviewDegraded(fgEntry.correlationId, draftResponse, 'review_ipc_send_failed', fgEntry.sessionId, deps);
    return;
  }

  // 审核阶段超时保护：30 秒无响应则自动 approve（防止 Brain LLM 调用挂死）
  const reviewTimeoutMs = 30_000;
  setTimeout(() => {
    // 如果 pending 仍存在（说明 review.result 没有回来），自动放行
    const stillPending = deps.sessionManager.getPending(fgEntry.correlationId);
    if (!stillPending) return;
    logger.warn({ correlationId: fgEntry.correlationId, timeoutMs: reviewTimeoutMs }, '审核超时，自动 approve');
    pendingReviewOrigins.delete(fgEntry.correlationId);
    approveReviewDegraded(fgEntry.correlationId, draftResponse, 'review_timeout', fgEntry.sessionId, deps);
  }, reviewTimeoutMs);
}

/**
 * 注册审核流 3 个 IPC handler（draft.response / review.result / final.response，逐字搬运）。
 *
 * draft.response（Conversation 草稿到达）：
 *   - A 级 / 无 intentAnchor → auto-approve（recordReview + dispatchFeedbackExtraction）
 *   - B/C 级 + intentAnchor → performDriftCheckAndApprove 异步漂移检测
 *   - takeover 模式 → superior chain 拦截 / sync review.request（+ 30s 超时降级）
 *
 * review.result（Brain 审核决策回流）：
 *   - escalation → 机制 B 问用户（fail reviewing 委派 + complete）
 *   - reject + reRoute → handleRouteDecision 重路由
 *   - origin=task → handleTaskReviewResult；否则 forward 给 primary agent
 *
 * final.response（Conversation 最终回复）：
 *   - handoff 合并（投机执行完成后流式追加委派）
 *   - ReviewBlock 落徽章（modify/reject）
 *   - persistInlineBlocks + closeTaskWorkspace + audit + onConversationCompleted + emit message.responded
 *   - 观察队列 markDraining + speculativeCorrelations 清理
 *
 * @param primaryIpc   primary(Conversation) IPC 通道
 * @param reviewerIpc  reviewer(Brain) IPC 通道
 * @param primaryName  primary agent 名
 * @param reviewerName reviewer agent 名
 * @param deps         依赖注入 + 跨集群回调
 */
export function setupReviewFlow(
  primaryIpc: AgentIpc,
  reviewerIpc: AgentIpc,
  primaryName: string,
  reviewerName: string,
  deps: ReviewFlowDeps,
): void {
  const {
    sessionManager, taskManager, delegationManager, streamingFlusher, auditRecorder,
    brainDecisionRecorder, dialogueRouter, observationRecorder, takeoverController,
    superiorReviewFlow, pendingReviewOrigins, pendingHandoffs, speculativeCorrelations,
    handleRouteDecision, performDriftCheckAndApprove, onConversationCompleted, dispatchFeedbackExtraction,
    reportProgress,
  } = deps;

  primaryIpc.onMessage('draft.response', (msg: IpcMessage) => {
    const { sessionId, draft, reasoning } = msg.payload as DraftResponsePayload;
    const correlationId = msg.correlationId!;
    const pending = sessionManager.getPending(correlationId);
    if (!pending) return;

    // 对话内联：工具真相单一源 = BlockCollector（消灭 pending.toolCalls 双源）。
    // 审核入口（draft.response）时 collector 仍存活（dispose 发生在 turn-terminal complete 之后）；
    // key 与 persistInlineBlocks 一致（pending.delegationTaskId ?? pending.taskId）。
    // TurnRecord.toolCalls 已是 ToolBlock[]（契约统一），直接用 collector 取的完整块（含 state/output/durationMs）。
    const toolBlocks = peekBlockCollector(pending.delegationTaskId ?? pending.taskId ?? '')?.getToolBlocks() ?? [];

    logger.debug({ correlationId, draftLen: draft.length, toolCalls: toolBlocks.length, sessionId }, 'orchestrator:draft');

    const turn: TurnRecord = {
      sessionId,
      userMessage: pending.userMessage,
      draftResponse: draft,
      toolCalls: toolBlocks,
      level: classifyLevel({
        sessionId,
        userMessage: pending.userMessage,
        draftResponse: draft,
        toolCalls: toolBlocks,
        level: 'A',
        agentDialogCount: dialogueRouter?.getDialogueCountByCorrelation(correlationId),
      }),
      // 13.0 §12.6: 透传 mission 上下文（审核后 Brain 会自动 mark plan done）
      missionId: pending.missionId,
      planTaskId: pending.planTaskId,
      taskDescription: pending.taskDescription,
      // 16.0 P4-B1：透传板 id（= delegationTaskId，Brain 审核 C 级注入板上下文看板下钻）
      boardTaskId: pending.delegationTaskId ?? pending.taskId,
    };

    pending.level = turn.level;
    pending.draftResponse = draft;
    pending.reasoning = reasoning;

    // §9.0 M15.3 + §12.0: 生产模式分级审核
    if (!takeoverController) {
      // A 级简短回复 / 无 intent_anchor：直接 auto-approve（不做漂移检测）
      // 12.0 审计修复：auto-approve 也必须显式落库，避免 review_requests 表 99% 缺失。
      // audit-before-approve 顺序：先写审计行，再发 verdict，确保审计行先于 verdict 落库。
      // 失败处理：audit 失败不阻塞 verdict（fail-open）— recordAutoApprove 内部 try/catch
      // 只 log.error 不会抛，所以这里不需要 try/catch 包裹。
      if (turn.level === 'A' || !pending.intentAnchor) {
        // R14-4：auto-approve 走 recordReview 通用路径，不再有 recordAutoApprove 独立方法。
        // 区分依据：verdict='approve' + level='A' + reason 标注 'auto_approve'，
        // 真实 Brain 审核的 verdict='approve' 不会带 reason='auto_approve'。
        auditRecorder.recordReview({
          sessionId,
          level: 'A',
          draft,
          userMessage: pending.userMessage,
          toolCalls: toolBlocks,
          verdict: 'approve',
          finalResponse: draft,
          reason: !pending.intentAnchor ? 'auto_approve: no_intent_anchor' : 'auto_approve: level_A',
        });
        primaryIpc.send('review.result', primaryName, { verdict: 'approve' } as ReviewResult, correlationId);
        dispatchFeedbackExtraction(sessionId, pending.userMessage, draft, 'post_review');
        return;
      }

      // B/C 级回复 + 有 intentAnchor：异步漂移检测后再决定
      performDriftCheckAndApprove(
        pending, primaryIpc, primaryName, reviewerIpc, reviewerName,
        correlationId, sessionId, draft, turn,
      );
      return;
    }

    // Test/takeover mode: preserve sync Brain review
    const entry = delegationManager.getByCorrelation(correlationId);
    const wsId = entry?.workspaceId;
    if (superiorReviewFlow?.interceptForSuperiorReview(correlationId, entry?.targetAgent ?? '', wsId, turn, entry?.id)) {
      pendingReviewOrigins.set(correlationId, 'superior_chain');
      reportProgress(pending, 'reviewing', '正在上级审核...');
      return;
    }

    pendingReviewOrigins.set(correlationId, 'conversation');
    reportProgress(pending, 'reviewing', '正在审核...');

    const sent = reviewerIpc.send('review.request', reviewerName, { turn }, correlationId);
    if (!sent) {
      // IPC 发送失败 → 自动 approve
      logger.warn({ correlationId }, 'review.request (conversation) IPC 发送失败，自动 approve');
      pendingReviewOrigins.delete(correlationId);
      approveReviewDegraded(correlationId, draft, 'review_ipc_send_failed', pending.sessionId, deps);
      return;
    }

    // 审核超时保护（防止 Brain LLM 挂死）
    setTimeout(() => {
      const stillPending = sessionManager.getPending(correlationId);
      if (!stillPending) return;
      logger.warn({ correlationId }, '对话审核超时，自动 approve');
      pendingReviewOrigins.delete(correlationId);
      approveReviewDegraded(correlationId, draft, 'review_timeout', pending.sessionId, deps);
    }, 30_000);
  });

  reviewerIpc.onMessage('review.result', (msg: IpcMessage) => {
    const review = msg.payload as ReviewResult;
    const correlationId = msg.correlationId!;
    logger.info({ correlationId, verdict: review.verdict }, '大脑审核完成');

    const pending = sessionManager.getPending(correlationId);
    if (pending) {
      brainDecisionRecorder?.recordReviewDecision(
        pending.sessionId,
        safeSlice(pending.draftResponse ?? pending.userMessage, 200),
        review as unknown as Record<string, unknown>,
        pending.taskId,
      );
    }

    const origin = pendingReviewOrigins.get(correlationId);
    pendingReviewOrigins.delete(correlationId);

    // 15.0 机制 B：Brain 审核拿不准质量 → 澄清问题作为本轮回复结束（Design A，同 route 升级理由）。
    // task-origin 审核背后有在审委派（state=reviewing），complete 后该委派需 fail 释放其 active_scope
    // （与 V-2 同源的泄漏路径），否则卡在 reviewing 直到 sweepStale(10min)。fail 幂等（终态守卫），对
    // 无委派的 conversation-origin 审核 no-op。review 30s 超时 approveReviewDegraded 有 getPending 守卫，
    // pending 已被 complete 删除 → 自动 no-op，无竞态。
    if (review.escalation && pending) {
      logger.info({ correlationId, question: safeSlice(review.escalation.questionToUser, 100) }, 'review 升级问用户（机制 B）');
      // 16.0 P3-C1：review 升级投影 ask(@brain)（fire-and-forget）
      postAskEnvelope(pending.delegationTaskId ?? pending.taskId ?? correlationId, {
        from: 'reviewer', question: review.escalation.questionToUser, sessionId: pending.sessionId,
      });
      const reviewDelegation = delegationManager.getByCorrelation(correlationId);
      if (reviewDelegation) {
        delegationManager.fail(reviewDelegation.id, 'Brain review 升级问用户');
      }
      sessionManager.complete(correlationId, review.escalation.questionToUser);
      return;
    }

    if (review.verdict === 'reject' && review.reRoute) {
      handleRouteDecision(review.reRoute, correlationId);
      return;
    }

    if (origin === 'task') {
      handleTaskReviewResult(review, correlationId, deps);
    } else {
      primaryIpc.send('review.result', primaryName, review, correlationId);
    }
  });

  primaryIpc.onMessage('final.response', (msg: IpcMessage) => {
    const { sessionId, response, reviewVerdict, reviewReason, originalDraft } = msg.payload as FinalResponsePayload;
    const correlationId = msg.correlationId!;
    logger.debug({ correlationId, responseLen: response.length, verdict: reviewVerdict, sessionId }, 'orchestrator:final');
    const pending = sessionManager.getPending(correlationId);
    if (!pending) return;

    // §10.0 Stream Merge: 检查是否有待执行的 handoff（Brain 判定需要另一个 agent）
    const handoff = pendingHandoffs.get(correlationId);
    if (handoff) {
      pendingHandoffs.delete(correlationId);

      // 11.0: 如果 Conversation 在本回合已通过 dialogue 与目标 agent 交互过，
      // 跳过 handoff（dialogue 已完成协作，handoff 是冗余的）
      const hadDialogue = dialogueRouter
        ? dialogueRouter.hasDialogueForTarget(correlationId, handoff.targetAgent)
        : false;
      if (hadDialogue) {
        logger.info({ correlationId, handoffTo: handoff.targetAgent }, 'handoff 跳过：dialogue 已覆盖目标 agent');
        // 不执行 handoff，直接走正常关闭路径
      } else {
        logger.info({ correlationId, handoffTo: handoff.targetAgent, intent: handoff.intent }, '投机执行完成，流式追加委派');

        // 结束 conversation 的 flusher，但保持 pending 存活
        streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');

        // 完成 conversation 任务（它的部分已做完）
        if (pending.taskId) {
          taskManager.complete(pending.taskId, { response, reviewVerdict, handoffTo: handoff.targetAgent });
        }

        // 保存 conversation 阶段的回复到对话历史（doc 22：messages+message_blocks 唯一存储）
        // handoff 投机路径不走 complete()，手动落本轮 conversation 阶段的内联 blocks
        // （collector key=pending.taskId，此刻还未在下方 :2239 清空）。conversations 不再双写。
        sessionManager.persistInlineBlocks(pending, response);

        // 向前端发送 handoff 分隔事件（同一个气泡内）
        // P0-B 修复：业务路径不再直写 socket，改为 emit
        getEventBus().emit('conversation.handoff', {
          sessionId: pending.sessionId,
          from: 'conversation',
          to: handoff.targetAgent,
          intent: handoff.intent,
          correlationId,
        });

        // 清除旧 taskId，handoff agent 会分配新的
        pending.taskId = undefined;
        pending.delegationTaskId = undefined;
        pending.draftResponse = '';
        pending.reasoning = undefined;

        // 直接用现有 pending 分发 handoff（不重建 pending）
        handleRouteDecision(handoff, correlationId);
        return;
      }
    }

    // 无 handoff — 正常关闭路径
    streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
    // 对话内联（doc 22）：Brain 审核 modify/reject → 落 ReviewBlock，刷新后徽章保留。
    // complete() 内 persistInlineBlocks 会 dispose collector 并 buildBlocks 含此 review block。
    // 仅 modify/reject（approve 不显示徽章，且自动批准居多）。collector 此刻仍存活（complete 才 dispose），
    // 故用 peek（不销毁）。无 collector（纯文本无 telemetry 的极端情况）则 optional chaining 跳过。
    if (reviewVerdict === 'modify' || reviewVerdict === 'reject') {
      peekBlockCollector(pending.delegationTaskId ?? pending.taskId ?? '')?.onReview({
        verdict: reviewVerdict,
        reason: reviewReason,
        originalDraft,
      });
    }
    // 对话内联：complete() 内 persistInlineBlocks 会 dispose collector——须在 complete 之前捕获本轮 toolBlocks，
    // 供下方 audit + onConversationCompleted（post-complete 消费者，collector 已 dispose 不能再 peek）。
    const toolBlocks = peekBlockCollector(pending.delegationTaskId ?? pending.taskId ?? '')?.getToolBlocks() ?? [];
    // 半收尾：保存对话轮次 + 删除 pending（不 resolve），留后续操作用 pending 数据
    const finalized = sessionManager.complete(correlationId, response, { skipResolve: true });
    if (!finalized || finalized === true) return;

    if (pending.taskId) {
      taskManager.complete(pending.taskId, { response, reviewVerdict });
      const agentHome = getAgentHomePath(primaryName);
      closeTaskWorkspace(
        join(agentHome, 'tasks', pending.taskId),
        { response, reviewVerdict, completedAt: Date.now() },
      );
    }

    auditRecorder.recordReview({
      sessionId,
      level: pending.level ?? 'A',
      draft: pending.draftResponse ?? response,
      userMessage: pending.userMessage,
      toolCalls: toolBlocks,
      verdict: reviewVerdict,
      finalResponse: response,
    });

    onConversationCompleted(sessionId, pending.userMessage, response, toolBlocks);

    getEventBus().emit('message.responded', {
      sessionId,
      taskId: pending.taskId ?? '',
      response,
      verdict: reviewVerdict,
      // 13.0 灵魂版：将 Brain 审核详情传递到前端（通过 WS bridge）
      reviewReason,
      originalDraft,
    });

    // 13.0 灵魂版：将 Brain 审核信息透传给 CompletionStrategy，
    // 最终由 EventBusStrategy emit 到 conversation.result，前端可消费
    finalized.resolve(response, {
      verdict: reviewVerdict,
      reason: reviewReason,
      originalDraft,
    });

    // 13.0 灵魂版 M5：review 完成后排空观察队列（5s 延迟清除，允许迟到 INTERVENE 仍能读取）
    if (pending.taskId) {
      observationRecorder.markDraining(sessionId, pending.taskId);
    }

    // §9.0 Cleanup speculative state for this correlation
    speculativeCorrelations.delete(correlationId);
  });
}
