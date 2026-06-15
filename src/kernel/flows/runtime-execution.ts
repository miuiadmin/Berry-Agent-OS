/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——Runtime 执行流提取（第 4 步）。
 *
 * 从 delegation-orchestrator.ts 的 resolveRuntimeForTarget + executeViaRuntime
 * 整组搬出（行为保持，仅把 this.* 依赖改成显式参数）。
 *
 * external 路由的 runtime 路径（claude_code/opencode 等外部 driver）：
 *   - resolveRuntimeForTarget：provider 名映射查 RuntimeRegistry
 *   - executeViaRuntime：构造 ExecutionTask → 创建 delegation → postDelegateEnvelope 落板 →
 *     跑 runtime.execute / runtimeExecutor.executeWithCheckpoint 的异步事件源，
 *     按 AgentEvent.kind 走 BlockCollector（tool/thinking/text/delegation 内联 block 单源）+
 *     streamingFlusher 持久化 + 终态走 sendTaskResultForReview 或 fail。
 *
 * ⚠️ BlockCollector 生命周期副作用逐字保留：onDelegationStart/Complete、onReasoningDelta、
 * onToolStart/Complete、onTextDelta 调用顺序与原代码完全一致。collector 不在 runtime
 * 结束时 dispose（由 SessionManager.persistInlineBlocks 在 turn 终态 complete() 时统一 dispose 落库）。
 */

import type { RuntimeRegistry } from '../runtime/runtime-registry.js';
import type { RuntimeExecutor } from '../runtime/runtime-executor.js';
import type { AgentRuntime, ExecutionTask } from '../../contracts/agent-runtime.js';
import type { RuntimeProvider } from '../../contracts/agent-runtime.js';
import type { RouteDecision } from '../../contracts/routing.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { StreamingFlusher } from '../streaming-flusher.js';
import { getOrCreateBlockCollector } from '../block-collector.js';
import { postDelegateEnvelope } from '../board-projection.js';
import { resolveLeaderForDelegate } from '../board-repo.js';
import { getDb } from '../../memory/index.js';
import { getCurrentTrace } from '../../observability/trace-context.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** runtime 执行所需的依赖注入 + 跨集群回调 */
export interface RuntimeExecutionDeps {
  readonly delegationManager: DelegationManager;
  readonly streamingFlusher: StreamingFlusher;
  /** 进度上报回调（主类 reportProgress） */
  reportProgress(
    pending: PendingRequest,
    status: import('../../contracts/socket-protocol.js').SocketProgressEvent['status'],
    summary: string,
  ): void;
  /**
   * sessionManager.fail 回调——runtime 终态失败时走 finalizeTask 统一入口。
   * 签名与主类 sessionManager.fail(correlationId, outcome) 一致（outcome.kind 等）。
   */
  sessionManagerFail(
    correlationId: string,
    outcome: {
      kind: 'crash' | 'failed' | 'timeout' | 'cancelled' | 'terminated' | 'unavailable' | 'runtime_error';
      agentName?: string;
      error?: string;
    },
  ): void;
  /**
   * 任务结果送审回调（主类 sendTaskResultForReview）。
   * runtime 执行完成后把最终文本送 Brain 审核（或 reviewer 不可用时降级 approve）。
   */
  sendTaskResultForReview(
    fgEntry: { correlationId: string; sessionId: string },
    pending: PendingRequest,
    draftResponse: string,
  ): void;
}

/**
 * 按 targetAgent 名解析 RuntimeRegistry 中的 AgentRuntime。
 *
 * targetAgent（'claude-code' / 'opencode'）映射到 provider 名（'claude_code' / 'opencode'），
 * 再从 RuntimeRegistry.get(provider) 取出 runtime。未注册返回 null（调用方降级为对话 / daemon 路径）。
 */
export function resolveRuntimeForTarget(
  runtimeRegistry: RuntimeRegistry | null,
  targetAgent: string,
): AgentRuntime | null {
  if (!runtimeRegistry) return null;

  const providerMap: Record<string, string> = {
    'claude-code': 'claude_code',
    'opencode': 'opencode',
  };
  const provider = providerMap[targetAgent];
  if (provider) {
    return runtimeRegistry.get(provider as RuntimeProvider) ?? null;
  }
  return null;
}

/**
 * 通过 AgentRuntime 执行 external 路由任务（claude_code / opencode / 自定义 driver）。
 *
 * 行为与原 executeViaRuntime 逐字一致：
 *   1. reportProgress('dispatching')
 *   2. 解析 per-agent workspace config（workspacePath + thinkingLevel）
 *   3. 构造 ExecutionTask + delegationManager.create + postDelegateEnvelope 落板
 *   4. pending.delegationTaskId = delegationId（记录供后续清理路径）
 *   5. 创建 BlockCollector + onDelegationStart（委派表头卡）
 *   6. 跑 runtime.execute 或 runtimeExecutor.executeWithCheckpoint 的异步事件源
 *      - thinking_delta → onReasoningDelta + 累积进 pending.reasoning
 *      - tool_pending/tool_running → onToolStart
 *      - tool_completed/tool_failed → onToolComplete
 *      - text_delta → 累积 + streamingFlusher + onTextDelta
 *      - execution_completed → flusher.remove + onDelegationComplete + workspace 落库 + sendTaskResultForReview + return
 *      - execution_failed → onDelegationComplete(interrupted/failed) + delegationManager.fail + sessionManager.fail
 *      - execution_cancelled → onDelegationComplete(interrupted) + fail + fail
 *   7. generator 自然结束 → 有产出 sendTaskResultForReview，无产出 fail
 *   8. catch：runtime 异常 → fail（含 no_response 通知）
 *
 * @param runtime         AgentRuntime 实例
 * @param runtimeExecutor 可选的 RuntimeExecutor（带 checkpoint 的执行器，提供则用其 executeWithCheckpoint）
 * @param decision        路由决策（targetAgent / instruction / targetWorkspaceId 等）
 * @param correlationId   pending request 的 correlation id
 * @param pending         关联的 pending request
 * @param deps            依赖注入 + 跨集群回调
 */
export async function executeViaRuntime(
  runtime: AgentRuntime,
  runtimeExecutor: RuntimeExecutor | null,
  decision: RouteDecision,
  correlationId: string,
  pending: PendingRequest,
  deps: RuntimeExecutionDeps,
): Promise<void> {
  const { delegationManager, streamingFlusher, reportProgress, sessionManagerFail, sendTaskResultForReview } = deps;

  reportProgress(pending, 'dispatching', `正在通过 ${runtime.name} 执行...`);

  const executionId = genId('exec');

  // Resolve per-agent config (workspace reuse + thinking level)
  let workspacePath: string | undefined;
  let thinkingLevel: string | undefined;
  const workspaceId = decision.targetWorkspaceId;
  if (workspaceId) {
    const agentConfig = getDb().prepare(
      'SELECT prior_work_dir, thinking_level FROM workspace_agents WHERE workspace_id = ? AND agent_name = ? AND enabled = 1 LIMIT 1',
    ).get(workspaceId, decision.targetAgent) as { prior_work_dir: string | null; thinking_level: string } | undefined;
    if (agentConfig) {
      workspacePath = agentConfig.prior_work_dir ?? undefined;
      thinkingLevel = agentConfig.thinking_level;
    }
  }

  const task: ExecutionTask = {
    executionId,
    prompt: pending.userMessage,
    systemPrompt: decision.instruction,
    sessionId: pending.sessionId,
    traceId: getCurrentTrace()?.traceId,
    workspacePath,
    thinkingLevel,
  };

  const delegationId = delegationManager.create({
    sessionId: pending.sessionId,
    correlationId,
    targetAgent: runtime.name,
    targetKind: 'daemon',
    userMessage: pending.userMessage,
    taskType: 'runtime_execution',
    requester: 'brain-route',
    inputPayload: { message: pending.userMessage, instruction: decision.instruction },
    foreground: true,
  });

  // 记录委托 task ID 到 pending，供后续所有清理路径使用
  pending.delegationTaskId = delegationId;
  // 16.0 P4-C4：runtime 派发点投影 delegate 信封（fire-and-forget 审计影子）
  postDelegateEnvelope(delegationId, {
    from: resolveLeaderForDelegate(),
    to: runtime.name,
    subTaskGoal: pending.userMessage,
    sessionId: pending.sessionId,
    scope: { allowTools: ['*'] },
  });

  let textAccumulator = '';

  // 对话内联（设计文档/22 期4）：为本次委派创建 BlockCollector——把外部 driver 的
  // tool_running/completed/failed + thinking_delta + text_delta 归一为内联 block（前端实时渲染工具卡 / 思考 / 正文）。
  // Phase C：文本也喂 collector（下方 text_delta case 调 onTextDelta），与 task-flow 统一为 block 单源；
  // 过渡期 stream.text_delta 仍 emit（双写），待前端改读 TextBlock 后删（Commit 4）。
  // 之前这些事件落入 default:break 被丢弃——正是「外部 agent 委派时工具卡片缺失」的根因。
  const blockCollector = getOrCreateBlockCollector(delegationId, pending.sessionId, correlationId);
  // 对话内联（doc 22 期4+）：本轮即一次委派——产出 delegation block（「委派给 X agent」表头卡），
  // 实时内联 + 落库后刷新保留。终态在各 execution_* 分支用 onDelegationComplete 推进。
  blockCollector.onDelegationStart({ targetAgent: runtime.name });

  try {
    const eventSource = runtimeExecutor
      ? runtimeExecutor.executeWithCheckpoint(runtime, task)
      : runtime.execute(task);

    for await (const event of eventSource) {
      // tool-trace（保留诊断）：runtime/driver 路径（builtin / opencode / claude / 自定义 driver）的
      // tool_* / thinking_delta AgentEvent 在此被消费——期4 已接入 BlockCollector（下方 switch 新增 case），
      // 不再落入 default 丢弃。覆盖全部 4 个工具 kind（曾漏掉 builtin-driver 的 tool_pending）。
      if (
        event.kind === 'tool_pending' ||
        event.kind === 'tool_running' ||
        event.kind === 'tool_completed' ||
        event.kind === 'tool_failed' ||
        event.kind === 'thinking_delta'
      ) {
        logger.debug(
          { delegationId, eventKind: event.kind, callId: (event.data as { callId?: string }).callId, name: (event.data as { name?: string }).name, timestamp: event.timestamp },
          'tool-trace: orchestrator AgentEvent → BlockCollector',
        );
      }
      switch (event.kind) {
        // 对话内联（设计文档/22 期4）：外部 driver 的思考增量 → thinking block（前端可折叠）+ 累积进 pending.reasoning 供持久化
        case 'thinking_delta': {
          const text = event.data.text as string;
          pending.reasoning = (pending.reasoning ?? '') + text;
          blockCollector.onReasoningDelta(text);
          break;
        }
        // 工具启动（tool_pending / tool_running）：发 running 态 tool block，按 callId 暂存等 result 配对
        case 'tool_pending':
        case 'tool_running': {
          blockCollector.onToolStart({
            callId: event.data.callId as string,
            toolName: event.data.name as string,
            input: event.data.input,
            ts: event.timestamp,
          });
          break;
        }
        // 工具完成（tool_completed / tool_failed）：按 callId 回查 start，组装终态 block + 算耗时
        case 'tool_completed':
        case 'tool_failed': {
          blockCollector.onToolComplete({
            callId: event.data.callId as string,
            output: event.data.output as string | undefined,
            success: event.kind === 'tool_completed',
            ts: event.timestamp,
          });
          break;
        }
        case 'text_delta': {
          const text = event.data.text as string;
          textAccumulator += text;
          // 实时同步到 pending，重连时可从中恢复已积累的文本
          pending.draftResponse = textAccumulator;
          // 定期持久化到 SQLite，前端断连/刷新后可恢复
          streamingFlusher.onTextAccumulated(delegationId, textAccumulator, pending.reasoning);
          // 对话内联（doc 22 Phase C）：文本经 collector → emit stream.block text（单一事件族，前端气泡从 TextBlock 渲染）。
          // 粒度 stream.text_delta 已删（与 task-flow 同步消灭双写）；textAccumulator + flusher 仍保留（持久化事实源）。
          blockCollector.onTextDelta(text);
          break;
        }
        case 'execution_completed': {
          const finalText = textAccumulator || (event.data.content as string) || '';
          pending.draftResponse = finalText;
          streamingFlusher.remove(delegationId);
          // 委派终态：推进 delegation block 到 completed（产出由下方 text block 承载，summary 省略避免重复）
          blockCollector.onDelegationComplete({ state: 'completed' });
          if (workspaceId && task.workspacePath) {
            getDb().prepare(
              'UPDATE workspace_agents SET prior_work_dir = ?, prior_session_id = ? WHERE workspace_id = ? AND agent_name = ?',
            ).run(task.workspacePath, task.sessionId ?? null, workspaceId, decision.targetAgent);
          }
          sendTaskResultForReview(
            { correlationId, sessionId: pending.sessionId },
            pending,
            finalText,
          );
          return;
        }
        case 'execution_failed': {
          const error = (event.data.error as string) || '执行失败';
          const resumable = event.data.resumable as boolean | undefined;
          streamingFlusher.remove(delegationId);
          // 委派终态：可恢复→interrupted，否则 failed
          blockCollector.onDelegationComplete({ state: resumable ? 'interrupted' : 'failed' });
          delegationManager.fail(delegationId, resumable ? `[resumable] ${error}` : error);
          sessionManagerFail(correlationId, {
            kind: resumable ? 'cancelled' : 'failed',
            agentName: runtime.name,
            error: resumable ? `执行中断（可恢复）: ${error}` : error,
          });
          return;
        }
        case 'execution_cancelled': {
          streamingFlusher.remove(delegationId);
          // 委派终态：取消→interrupted
          blockCollector.onDelegationComplete({ state: 'interrupted' });
          delegationManager.fail(delegationId, 'Cancelled');
          sessionManagerFail(correlationId, { kind: 'cancelled', agentName: runtime.name });
          return;
        }
        default:
          break;
      }
    }

    // Generator completed without explicit execution_completed event
    if (textAccumulator) {
      pending.draftResponse = textAccumulator;
      // 委派终态：generator 自然结束且有产出 → completed
      blockCollector.onDelegationComplete({ state: 'completed' });
      sendTaskResultForReview(
        { correlationId, sessionId: pending.sessionId },
        pending,
        textAccumulator,
      );
    } else {
      streamingFlusher.remove(delegationId);
      // 委派终态：无产出 → failed
      blockCollector.onDelegationComplete({ state: 'failed' });
      delegationManager.fail(delegationId, 'No output produced');
      // R14-1：未产出输出 走 finalizeTask 统一入口
      sessionManagerFail(correlationId, { kind: 'failed', agentName: runtime.name, error: '未产出任何输出' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ correlationId, err }, 'Runtime execution error');
    streamingFlusher.remove(delegationId);
    // 委派终态：Runtime 异常 → failed
    blockCollector.onDelegationComplete({ state: 'failed' });
    delegationManager.fail(delegationId, message);
    // R14-1：Runtime exception 兜底走 finalizeTask 统一入口（含 no_response 通知）
    sessionManagerFail(correlationId, { kind: 'runtime_error', agentName: runtime.name, error: message });
  }
  // 对话内联（doc 22）：本委派的 BlockCollector 不再在 finally 释放——dispose + buildBlocks + persistAssistantTurn
  // 已统一下沉到 SessionManager.persistInlineBlocks()（由 fail()/final.response 路径的 complete() 调用）。
  // collector 在 runtime 结束后留 registry，直到 turn 终态 complete() 时 dispose 落库。
}
