/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——任务结果处理簇提取（第 5 步）。
 *
 * 从 delegation-orchestrator.ts 搬出 4 个方法 + 1 个小工具（行为保持，仅把 this.* 依赖
 * 改成显式参数）：
 *   - handleForegroundTaskResult：foreground 任务结果（成功 / 失败 / group）核心收口
 *   - resolveMultiTaskResult：multi 路由子任务全部完成后的汇总
 *   - handleTaskReject：Agent task.reject 的重路由 / 降级处理
 *   - setupDaemonTaskResultHandlers：EventBus 订阅（daemon.task.progress/completed/failed / task.timeout / task.cancelled）
 *   - formatAgentResult：outputPayload → 文本（仅本簇使用，一并搬入）
 *
 * ⚠️ AgentRequestQueue.complete 槽位释放逐字保留（§4.4.1 并发控制不变量）。
 * ⚠️ 委派终态收口 + plan 状态更新 + postReportEnvelope 落板副作用逐字保留。
 * ⚠️ V-2：超时 / cancel 必须终态化委派 + active_scope 清理（onTermination 回调）逐字保留。
 */

import type { DelegationManager } from '../delegation-manager.js';
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { TaskManager } from '../task-manager.js';
import type { StreamingFlusher } from '../streaming-flusher.js';
import type { AgentRequestQueue } from '../agent-request-queue.js';
import type { ObservationRecorder } from '../observation-recorder.js';
import type { MissionContextDeps } from './mission-context-builder.js';
import type { AgentTaskResultPayload } from '../../contracts/tasks.js';
import type { IpcMessage } from '../types.js';
import type { DelegationGroup } from '../../contracts/delegation.js';
import { getOrCreateBlockCollector } from '../block-collector.js';
import { postReportEnvelope } from '../board-projection.js';
import { applyBoardStatus } from '../board-repo.js';
import { updatePlanTaskStatus } from './mission-context-builder.js';
import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** 任务结果处理簇依赖注入 + 跨集群回调 */
export interface ForegroundResultDeps {
  readonly delegationManager: DelegationManager;
  readonly sessionManager: SessionManager;
  readonly taskManager: TaskManager;
  readonly streamingFlusher: StreamingFlusher;
  readonly missionContextDeps: MissionContextDeps;
  readonly agentRequestQueue: AgentRequestQueue | null;
  readonly observationRecorder: ObservationRecorder;
  /** 任务结果送审回调（主类 sendTaskResultForReview） */
  sendTaskResultForReview(
    fgEntry: { correlationId: string; sessionId: string },
    pending: PendingRequest,
    draftResponse: string,
  ): void;
  /**
   * 模块任务派发回调（主类 dispatchModuleTaskInternal）。
   * task.reject 重路由派发到 suggestAgent 时用。
   */
  dispatchModuleTaskInternal(input: {
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
 * outputPayload → 文本格式化（防御性兜底：response → result → summary → JSON dump）。
 *
 * 部分 agent（如 code_task）返回 summary 而非 response，故兜底链式检查多个字段。
 */
export function formatAgentResult(agentName: string, outputPayload: Record<string, unknown>): string {
  if (typeof outputPayload.response === 'string') return outputPayload.response;
  if (typeof outputPayload.result === 'string') return outputPayload.result;
  // 防御性兜底：部分 agent（如 code_task）返回 summary 而非 response
  if (typeof outputPayload.summary === 'string') return outputPayload.summary;
  return `[${agentName}] 任务完成:\n${JSON.stringify(outputPayload, null, 2)}`;
}

/**
 * 13.0 §5.3.14: 处理 Agent 的 task.reject — Agent 拒绝任务并建议其他 Agent。
 *
 * 回退策略（逐字搬运）：
 * 1. 检查 reRouteDepth（≤ 2 次重路由）
 * 2. 如果 suggestAgent 合理且有该 Agent → 重路由
 * 3. 如果超过 2 次或无合理建议 → 降级让用户决定
 *
 * @param agentName - 拒绝任务的 Agent 名
 * @param msg - task.reject IPC 消息
 * @param deps    依赖注入 + 跨集群回调
 */
export function handleTaskReject(agentName: string, msg: IpcMessage, deps: ForegroundResultDeps): void {
  const { delegationManager, sessionManager, agentRequestQueue, observationRecorder, missionContextDeps, dispatchModuleTaskInternal } = deps;
  const { taskId, reason, suggestAgent } = (msg.payload ?? {}) as {
    taskId: string;
    reason: string;
    suggestAgent?: string;
  };

  if (!taskId) {
    logger.warn({ agentName }, 'task.reject: 缺少 taskId，忽略');
    return;
  }

  // 释放 AgentRequestQueue 槽位
  if (agentRequestQueue) {
    agentRequestQueue.complete(agentName);
  }

  const entry = delegationManager.get(taskId);
  if (!entry) {
    logger.warn({ taskId, agentName }, 'task.reject: 任务不存在');
    return;
  }

  // ── 13.0 §8.7: 将 task.reject 写入 Brain 观察队列 ──
  // Brain 通过观察队列看到 agent 拒绝任务，可以审核拒绝理由和 suggestAgent 是否合理。
  // 如果 Brain 不认同 reject（比如觉得 agent 应该能做），可以发纠偏。
  // 如果 Brain 同意 reject → 接受，拒绝后由 Kernel 决定下一步（重路由或降级，见 §5.3.14）
  if (entry.sessionId && observationRecorder) {
    observationRecorder.record({
      sessionId: entry.sessionId,
      taskId,
      observationType: 'task_reject',
      fromAgent: agentName,
      content: JSON.stringify({ reason, suggestAgent }),
      priority: 0, // task.reject 是 critical 事件，永不丢弃
    });
  }

  // 检查 reRouteDepth
  const currentDepth = entry.reRouteDepth ?? 0;
  const MAX_RE_ROUTE_DEPTH = 2;

  logger.info({ taskId, agentName, reason: reason?.slice(0, 200), suggestAgent, reRouteDepth: currentDepth }, 'task.reject: Agent 拒绝任务');

  // 同步更新 plan task 状态为 failed
  updatePlanTaskStatus(missionContextDeps, taskId, 'failed', `Agent ${agentName} 拒绝: ${reason}`);

  if (currentDepth >= MAX_RE_ROUTE_DEPTH) {
    // 超过 2 次重路由 → 降级处理，通知用户
    logger.info({ taskId, reRouteDepth: currentDepth }, 'task.reject: 重路由次数耗尽，降级');

    delegationManager.fail(taskId, `任务被多个 Agent 拒绝。${agentName} 的理由: ${reason}`);

    const pending = sessionManager.getPending(entry.correlationId);
    if (pending) {
      // 让 Conversation 告诉用户情况
      sessionManager.complete(entry.correlationId,
        `抱歉，这个任务 ${agentName} 和之前的 Agent 都无法处理。\n理由: ${reason}\n请提供更多信息或尝试换个方式描述。`,
      );
    }
    return;
  }

  // 尝试重路由到 suggestAgent
  if (suggestAgent && suggestAgent !== agentName) {
    const newDepth = currentDepth + 1;
    // 标记当前任务失败
    delegationManager.fail(taskId, `Agent ${agentName} 拒绝，建议路由给 ${suggestAgent}。理由: ${reason}`);

    // 用新的 reRouteDepth 重新派发
    const pending = sessionManager.getPending(entry.correlationId);
    if (pending) {
      logger.info({ taskId, from: agentName, to: suggestAgent, newDepth }, 'task.reject: 重路由到建议 Agent');

      dispatchModuleTaskInternal({
        sessionId: entry.sessionId,
        taskType: 'chat',
        requester: agentName,
        inputPayload: {
          message: pending.userMessage ?? entry.userMessage,
          reRouteDepth: newDepth,
          _rejectReason: reason,
          _rejectedBy: agentName,
        },
        correlationId: entry.correlationId,
        foreground: true,
      }).catch(err => {
        logger.warn({ err, taskId }, 'task.reject: 重路由派发失败');
        sessionManager.fail(entry.correlationId, { kind: 'failed', agentName, error: `重路由失败: ${(err as Error).message}` });
      });
    }
  } else {
    // 无 suggestAgent → 降级为 chat
    delegationManager.fail(taskId, `Agent ${agentName} 拒绝任务且无建议: ${reason}`);
    const pending = sessionManager.getPending(entry.correlationId);
    if (pending) {
      sessionManager.complete(entry.correlationId,
        `Agent ${agentName} 表示无法处理这个任务。\n理由: ${reason}\n请尝试更具体地描述你的需求。`,
      );
    }
  }
}

/**
 * foreground 任务结果收口（逐字搬运）。
 *
 * 路径分支：
 *   1. group child → completeChild + 若全部完成 → resolveMultiTaskResult
 *   2. postReportEnvelope 统一投影
 *   3. 无 pending（后台任务）→ delegation complete/fail（必须终态化，防 heartbeat 误发）
 *   4. !result.ok → flusher.remove + delegation fail + plan failed + postReport(blocked) + sessionManager.fail
 *   5. result.ok → plan done + postReport(done) + sendTaskResultForReview
 *
 * @param result    AgentTaskResultPayload
 * @param fgEntry   { correlationId, sessionId }
 * @param agentName 完成（或声称完成）该任务的 agent 名
 * @param deps      依赖注入 + 跨集群回调
 */
export function handleForegroundTaskResult(
  result: AgentTaskResultPayload,
  fgEntry: { correlationId: string; sessionId: string },
  agentName: string,
  deps: ForegroundResultDeps,
): void {
  const { delegationManager, sessionManager, streamingFlusher, missionContextDeps, agentRequestQueue, sendTaskResultForReview } = deps;

  // ─── 13.0 §4.4.1: 释放 AgentRequestQueue 槽位 ───
  // 任务完成后释放该 agent 的并发槽位，让队列中的下一个请求开始处理
  if (agentRequestQueue) {
    agentRequestQueue.complete(agentName);
  }

  // 调试日志：定位对话中断原因
  logger.info({
    taskId: result.taskId,
    correlationId: fgEntry.correlationId,
    sessionId: fgEntry.sessionId,
    agent: agentName,
    ok: result.ok,
    error: result.error,
    hasPending: !!sessionManager.getPending(fgEntry.correlationId),
  }, 'handleForegroundTaskResult: 任务结果到达');
  const groupInfo = delegationManager.getGroupByChild(result.taskId);
  if (groupInfo) {
    const responseText = result.ok ? formatAgentResult(agentName, result.outputPayload ?? {}) : '';
    const allDone = delegationManager.completeChild(groupInfo.correlationId, result.taskId, agentName, responseText);
    if (allDone) {
      const completedGroup = delegationManager.removeGroup(groupInfo.correlationId);
      if (completedGroup) {
        resolveMultiTaskResult(completedGroup, groupInfo.correlationId, groupInfo.group.sessionId, deps);
      }
    }
    return;
  }

  const pending = sessionManager.getPending(fgEntry.correlationId);

  // 16.0 P4-C3：在所有分支之前统一投影 report 信封——不论 foreground/background/group，
  // 只要 task 结果到达就落板（§7.5 审计载体：板上可重建完整协作链）。
  // fire-and-forget，不影响现有终态收口逻辑。
  postReportEnvelope(result.taskId, {
    from: agentName,
    to: 'leader',
    status: result.ok ? 'done' : 'blocked',
    summary: result.ok ? formatAgentResult(agentName, result.outputPayload ?? {}) : (result.error ?? '任务失败'),
    sessionId: fgEntry.sessionId,
  });

  if (!pending) {
    // 无 user session pending：fire-and-forget 异步委派（evolution extract_feedback / detect_gap 等
    // 后台学习任务）或 pending 已被并发消费的 race 场景。task 既已结束，delegation entry 必须收口到
    // 终态——否则 entry.state 永驻 delegated/active/reviewing，TaskHeartbeatManager 会持续对已完成
    // task 误发 task.heartbeat（违反状态机不变量：task 完成 ⇒ delegation 收口）。
    // 同步 foreground 委派有 pending，走下方 review 流程由 delegationManager.complete 收口；
    // 本分支只补齐无 pending 的收口路径。complete/fail 对已终态 entry 幂等（return false）。
    if (result.ok) {
      delegationManager.complete(result.taskId, formatAgentResult(agentName, result.outputPayload ?? {}));
    } else {
      delegationManager.fail(result.taskId, result.error ?? '任务失败');
    }
    return;
  }

  if (!result.ok) {
    streamingFlusher.remove(result.taskId);
    delegationManager.fail(result.taskId, result.error ?? '任务失败');

    // 13.0 多智能体协作：任务失败时同步更新 plan.json 中对应任务的状态
    updatePlanTaskStatus(missionContextDeps, result.taskId, 'failed', result.error);

    // 16.0 P4-C3：失败结果投影 report(status:blocked) 落板（fire-and-forget 审计影子）
    postReportEnvelope(result.taskId, {
      from: agentName, to: 'leader', status: 'blocked', summary: result.error ?? '任务失败',
      sessionId: fgEntry.sessionId,
    });

    // R14-1：foreground 任务失败走 finalizeTask 统一入口
    sessionManager.fail(fgEntry.correlationId, { kind: 'failed', agentName, error: result.error });
    return;
  }

  // 13.0 多智能体协作：任务成功完成时同步更新 plan.json 中对应任务的状态
  const agentOutput = formatAgentResult(agentName, result.outputPayload ?? {});
  updatePlanTaskStatus(missionContextDeps, result.taskId, 'done', agentOutput);

  const draftResponse = agentOutput;
  pending.draftResponse = draftResponse;

  // 16.0 P4-C3：成功结果投影 report(status:done) 落板（fire-and-forget 审计影子，在 sendTaskResultForReview 前）
  postReportEnvelope(result.taskId, {
    from: agentName, to: 'leader', status: 'done', summary: draftResponse,
    sessionId: fgEntry.sessionId,
  });

  sendTaskResultForReview(fgEntry, pending, draftResponse);
}

/**
 * multi 路由子任务全部完成后的汇总（逐字搬运）。
 *
 * 把 completedResults 的所有 response 用 --- 分隔拼成 draftResponse，送 Brain 审核。
 */
export function resolveMultiTaskResult(
  group: DelegationGroup,
  correlationId: string,
  sessionId: string,
  deps: ForegroundResultDeps,
): void {
  const { sessionManager, sendTaskResultForReview } = deps;
  const pending = sessionManager.getPending(correlationId);
  if (!pending) return;

  const parts: string[] = [];
  for (const [, r] of group.completedResults) {
    if (r.response) parts.push(r.response);
  }
  const draftResponse = parts.join('\n\n---\n\n');
  pending.draftResponse = draftResponse;

  sendTaskResultForReview({ correlationId, sessionId }, pending, draftResponse);
}

/**
 * 注册 daemon 外部智能体 + 任务超时 / 取消的 EventBus 订阅（逐字搬运）。
 *
 * 订阅：
 *   - daemon.task.progress：text / tool_call / tool_result → BlockCollector + streamingFlusher
 *   - daemon.task.completed：从 task.output_payload 解析 → handleForegroundTaskResult(ok)
 *   - daemon.task.failed：handleForegroundTaskResult(!ok)
 *   - task.timeout：daemon 走 foreground 路径；非 daemon 终态化委派 + plan failed（V-2 + §13.21）
 *   - task.cancelled：终态化委派（释放 active_scope）+ 有 pending 则 fail pending（V-2）
 *
 * ⚠️ V-2：超时 / cancel 必须终态化委派——否则 active_scope 泄漏至 sweepStale(10min)。
 */
export function setupDaemonTaskResultHandlers(deps: ForegroundResultDeps): void {
  const { delegationManager, sessionManager, streamingFlusher, taskManager, missionContextDeps } = deps;
  const eventBus = getEventBus();
  eventBus.on('daemon.task.progress', ({ taskId, event }) => {
    // tool-trace: daemon 外部 agent 事件到达 orchestrator — 记录 kind（text / tool_call / tool_result / thinking）
    logger.debug({ taskId, eventKind: event.kind, dataKind: (event.data as { kind?: string }).kind }, 'tool-trace: daemon.task.progress 到达 orchestrator');
    const entry = delegationManager.get(taskId);
    if (!entry) return;
    const pending = sessionManager.getPending(entry.correlationId);
    if (!pending?.streaming) return;

    // 对话内联（设计文档/22 期4）：daemon 工具卡片统一走 BlockCollector（与委派 :1697 同构）。
    // collector key=taskId（== pending.delegationTaskId，daemon 派发时已赋值），turn 终态由
    // complete()→persistInlineBlocks 据此 key dispose 并落 message_blocks（刷新可恢复）。
    const collector = getOrCreateBlockCollector(taskId, pending.sessionId, entry.correlationId);

    if (event.kind === 'text' && event.data.kind === 'text') {
      // 无条件积累文本（业务与传输层解耦，daemon 后端任务独立于前端连接）
      pending.draftResponse = (pending.draftResponse ?? '') + event.data.text;
      // 定期持久化到 SQLite（断连/刷新恢复用）
      streamingFlusher.onTextAccumulated(taskId, pending.draftResponse, pending.reasoning);
      // 对话内联（doc 22 Phase C）：文本经 collector → emit stream.block text（单一事件族，前端从 TextBlock 渲染）。
      // 粒度 stream.text_delta 已删（与 task-flow/runtime 同步消灭双写）；draftResponse + flusher 仍保留（持久化事实源）。
      collector.onTextDelta(event.data.text);
    }

    // 对话内联（设计文档/22 期4）：daemon 工具调用统一走 BlockCollector（onToolStart/onToolComplete），
    // 与委派路径（:1731/:1742）同构——不再缓冲配对 + emit 旧 stream.tool_call。collector 内部按 callId
    // 配对 start/complete（result 先于 call 到达时 fail-open 降级为 unknown 工具）、算 durationMs、
    // emit stream.block（前端 block-renderers 内联渲染）。终态由 persistInlineBlocks 落 message_blocks。
    if (event.data.kind === 'tool_call') {
      const d = event.data;
      // input 直传对象（block 模型 input 为结构化对象，非旧 stream.tool_call 的 string 形）
      // ts 透传事件原始 timestamp（与委派 :1731 同构）：durationMs 才反映工具实际耗时，而非 orchestrator 收到事件的间隔
      collector.onToolStart({
        callId: d.callId,
        toolName: d.toolName,
        input: d.input,
        ts: event.timestamp,
      });
      logger.debug({ taskId, callId: d.callId, toolName: d.toolName }, 'tool-trace: daemon tool_call → onToolStart');
    } else if (event.data.kind === 'tool_result') {
      const d = event.data;
      // onToolComplete 内部按 callId 回查 onToolStart 暂存的 toolName/input（result 事件不带这些），
      // 组装终态 block；无配对 start 时 fail-open（toolName=unknown），不再需要手动兜底 emit。
      // ts 透传 event.timestamp：与 onToolStart 的 startedAt 配对算 durationMs（与委派 :1742 同构）
      collector.onToolComplete({
        callId: d.callId,
        output: d.output,
        success: d.success,
        ts: event.timestamp,
      });
      logger.debug({ taskId, callId: d.callId, success: d.success }, 'tool-trace: daemon tool_result → onToolComplete');
    }
  });

  eventBus.on('daemon.task.completed', ({ taskId }) => {
    // collector 生命周期由 handleForegroundTaskResult→complete()→persistInlineBlocks 统一 dispose（无需手动清缓冲）
    const entry = delegationManager.get(taskId);
    if (!entry) return;

    const task = taskManager.getTask(taskId);
    let outputPayload: Record<string, unknown> = {};
    if (task?.output_payload) {
      try { outputPayload = JSON.parse(task.output_payload); } catch { /* use empty */ }
    }

    const result: AgentTaskResultPayload = { taskId, ok: true, outputPayload };
    handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__', deps);
  });

  eventBus.on('daemon.task.failed', ({ taskId, error }) => {
    const entry = delegationManager.get(taskId);
    if (!entry) return;

    const result: AgentTaskResultPayload = { taskId, ok: false, error };
    handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__', deps);
  });

  eventBus.on('task.timeout', ({ taskId, targetAgent }) => {
    if (targetAgent === '__daemon__') {
      // daemon 外部智能体超时走 foreground 路径（collector 由 complete()→persistInlineBlocks 统一 dispose）
      const entry = delegationManager.get(taskId);
      if (!entry) return;
      const result: AgentTaskResultPayload = { taskId, ok: false, error: '外部智能体执行超时' };
      handleForegroundTaskResult(result, { correlationId: entry.correlationId, sessionId: entry.sessionId }, '__daemon__', deps);
      return;
    }

    // R14-1 + V-2：超时必须终态化委派 + 标记 plan failed，二者都不应被「无 pending」门挡住。
    // 原代码 `if (!pending) return` 提前 bail：① 委派留非终态 → active_scope 泄漏至 sweepStale(10min)；
    // ② 后台任务（无 pending）连 plan 状态都不更新 → mission 卡 working（§13.21）。
    // 现统一：委派 fail（幂等，触发 onTermination→cleanupTaskState 释放 active_scope）+ plan failed 始终执行；
    // pending fail + flusher 清理仅前台（有 pending）执行——后台任务无可达 pending。
    const entry = delegationManager.get(taskId);
    if (!entry) return;
    // 13.0 §13.21: 超时的 plan task 必须标记 failed，否则永留 working →
    // 级联失效依赖它的任务 → mission 永不终态（与 1804 失败路径一致）
    const timeoutError = `任务执行超时（${targetAgent}）`;
    updatePlanTaskStatus(missionContextDeps, taskId, 'failed', timeoutError);
    delegationManager.fail(taskId, timeoutError);
    const pending = sessionManager.getPending(entry.correlationId);
    if (pending) {
      streamingFlusher.remove(taskId);
      sessionManager.fail(entry.correlationId, { kind: 'timeout', agentName: targetAgent, error: timeoutError });
    }
  });

  // V-2：cancel（API tasks/:id/cancel · CLI task stop，两入口都 emit task.cancelled）终态化委派 + pending。
  // task 层只标 task cancelled + emit 事件，委派层无感知 → active_scope 泄漏；前台任务 pending 不失败则会话卡死。
  // 委派 fail（→ onTermination 释放 active_scope，幂等）；有 pending 则 fail pending（kind=terminated，同 interruptSession）。
  // 与 interruptSession 不冲突：interruptSession 用 delegationManager.interrupt 直处理、不 emit task.cancelled，两路径不相交。
  eventBus.on('task.cancelled', ({ taskId, reason }) => {
    const entry = delegationManager.get(taskId);
    if (!entry) return;
    delegationManager.fail(taskId, `任务取消: ${reason ?? '用户停止'}`);
    // 16.0 §6.5.1/D：用户取消 → 板状态机 interrupted 终态（fire-and-forget，旧库无 board 列静默降级）。
    // 与委派 fail 独立——委派层终态化释放 active_scope，板层终态化让前端任务卡显示「已中断」。
    applyBoardStatus(taskId, { kind: 'interrupt' });
    const pending = sessionManager.getPending(entry.correlationId);
    if (pending) {
      streamingFlusher.remove(pending.delegationTaskId ?? pending.taskId ?? '');
      sessionManager.fail(entry.correlationId, { kind: 'terminated' });
    }
  });
}
