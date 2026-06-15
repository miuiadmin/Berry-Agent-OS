/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——路由处理器簇提取（第 6 步）。
 *
 * 从 delegation-orchestrator.ts 搬出 6 个 route handler + 3 个辅助函数（行为保持，
 * 仅把 this.* 依赖改成显式参数）：
 *   - handleChatRoute：chat 路由（派 primary agent user.message，注入 systemPrompt/memoryContext/skill/mission）
 *   - handleTaskRoute：code/skill_test/learning/plugin 路由（dispatchModuleTaskInternal）
 *   - handleExternalRoute：external 路由（runtime 优先 → daemon bridge 回退）
 *   - handleMultiRoute：multi 路由（subDispatches 并行）
 *   - handleWorkspaceRoute：workspace 路由（委托给 team lead）
 *   - handleRouteFallback：LLM 不可用降级到 FallbackRouter
 *   - executeSetupAction：setup 动作日志（create_agent/activate_skill/enable_plugin）
 *   - loadActiveSkills：加载激活的 Skills 注入 systemPrompt（注入检测）
 *
 * 互调策略：handler 簇内部相互调用（handleTaskRoute 失败 fallback 到 handleChatRoute 等）走
 * 同文件直接调用；调用主类方法（handleRouteDecision / resolveRuntimeForTarget / executeViaRuntime /
 * dispatchModuleTaskInternal / reportProgress）走 deps 回调。handleRouteDecision（switch 分发）本身
 * 留在主类，是核心编排骨架。
 */

import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { TaskManager } from '../task-manager.js';
import type { DelegationManager } from '../delegation-manager.js';
import type { FallbackRouter } from '../fallback-router.js';
import type { DialogueRouter } from '../dialogue-router.js';
import type { DaemonBridge } from '../daemon-bridge.js';
import type { WorkspaceRouter } from '../workspace-router.js';
import type { RuntimeRegistry } from '../runtime/runtime-registry.js';
import type { RuntimeExecutor } from '../runtime/runtime-executor.js';
import type { AgentRuntime } from '../../contracts/agent-runtime.js';
import type { RouteDecision } from '../../contracts/routing.js';
import type { MissionContextDeps } from './mission-context-builder.js';
import type { SocketProgressEvent } from '../../contracts/socket-protocol.js';
import { buildMissionContextPrompt } from './mission-context-builder.js';
import { postDelegateEnvelope } from '../board-projection.js';
import { resolveLeaderForDelegate } from '../board-repo.js';
import { metrics } from '../../observability/metrics.js';
import { getDb } from '../../memory/index.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** 路由处理器簇依赖注入 + 跨集群回调 */
export interface RouteHandlersDeps {
  readonly agentManager: AgentManager;
  readonly registry: AgentRegistry;
  readonly sessionManager: SessionManager;
  readonly taskManager: TaskManager;
  readonly delegationManager: DelegationManager;
  readonly fallbackRouter: FallbackRouter;
  readonly dialogueRouter: DialogueRouter | null;
  readonly daemonBridge: DaemonBridge | null;
  readonly workspaceRouter: WorkspaceRouter | null;
  readonly runtimeRegistry: RuntimeRegistry | null;
  readonly runtimeExecutor: RuntimeExecutor | null;
  readonly missionContextDeps: MissionContextDeps;
  /** ReviewOrigin 跟踪 Map（correlationId → 'conversation' | 'task' | 'superior_chain'） */
  readonly pendingReviewOrigins: Map<string, 'conversation' | 'task' | 'superior_chain'>;
  /** 路由决策分发回调（主类 handleRouteDecision，handler 簇中 fallback / external 失败回退到对话走它） */
  handleRouteDecision(decision: RouteDecision, correlationId: string): void;
  /** runtime 解析回调（主类 resolveRuntimeForTarget） */
  resolveRuntimeForTarget(targetAgent: string): AgentRuntime | null;
  /** runtime 执行回调（主类 executeViaRuntime） */
  executeViaRuntime(runtime: AgentRuntime, decision: RouteDecision, correlationId: string, pending: PendingRequest): Promise<void>;
  /** 模块任务派发回调（主类 dispatchModuleTaskInternal） */
  dispatchModuleTaskInternal(input: {
    sessionId: string;
    taskType: string;
    requester: string;
    inputPayload: Record<string, unknown>;
    foreground?: boolean;
    correlationId?: string;
    targetAgentOverride?: string;
  }): Promise<{ taskId: string; targetAgent: string }>;
  /** 进度上报回调（主类 reportProgress） */
  reportProgress(pending: PendingRequest, status: SocketProgressEvent['status'], summary: string): void;
}

/**
 * 13.0 VF-2: LLM 不可用 / Brain 路由超时降级到 FallbackRouter（规则路由）。
 *
 * 逐字搬运：记录 metrics + warn 日志，再用 fallbackRouter.route 拿规则决策，
 * 交 handleRouteDecision 分发（走回主类 switch）。
 */
export function handleRouteFallback(
  correlationId: string,
  userMessage: string | undefined,
  deps: RouteHandlersDeps,
): void {
  const { sessionManager, fallbackRouter, handleRouteDecision } = deps;
  const pending = sessionManager.getPending(correlationId);
  if (!pending) return;

  const message = userMessage ?? pending.userMessage;
  // 13.0 VF-2: 记录 LLM 全局故障的回退路径，让监控和前端能感知
  // 设计依据：设计文档 §23 漏洞 #2 — LLM global failure no fallback strategy
  // 当前策略：fail-soft（用规则 fallback）但记录指标 + 事件，便于：
  // 1. 运维发现 LLM 异常时及时干预
  // 2. 前端可显示「Brain 暂时不可用」提示
  metrics.counter('routing_llm_fallback_total').inc({ reason: 'brain_unavailable' });
  logger.warn({ correlationId, intent: 'chat', sessionId: pending.sessionId }, 'routing: Brain LLM 不可用，降级到 FallbackRouter（规则路由）');

  const decision = fallbackRouter.route(message);
  handleRouteDecision(decision, correlationId);
}

/**
 * §2.2 setup 动作执行（逐字搬运，目前仅日志，未真正执行）。
 */
export function executeSetupAction(action: { action: string; params: unknown }): void {
  switch (action.action) {
    case 'create_agent':
      logger.info({ params: action.params }, 'Setup: creating dynamic agent');
      break;
    case 'activate_skill':
      logger.info({ params: action.params }, 'Setup: activating skill');
      break;
    case 'enable_plugin':
      logger.info({ params: action.params }, 'Setup: enabling plugin');
      break;
    default:
      logger.warn({ action: action.action }, 'Unknown setup action');
  }
}

/**
 * §8.9 加载激活的 Skills 注入 systemPrompt（逐字搬运）。
 *
 * 用 SkillsRegistry 读取 skill content，scanContextFile 做注入检测（unsafe 跳过）。
 * 最多取 5 个 skill，返回拼接的 prompt 片段。
 */
export function loadActiveSkills(skillNames: string[]): string | null {
  try {
    const { SkillsRegistry } = require('../../skills/index.js');
    const { scanContextFile } = require('../../safety/context-file-scanner.js');
    const registry = new SkillsRegistry(getDb());
    const parts: string[] = [];
    for (const name of skillNames.slice(0, 5)) {
      const skill = registry.get(name);
      if (skill?.content) {
        const scan = scanContextFile(skill.content);
        if (!scan.safe) {
          logger.warn({ skill: name, threats: scan.threats }, 'Skill content blocked: injection detected');
          continue;
        }
        parts.push(`--- Skill: ${name} ---\n${skill.content}`);
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}

/**
 * chat 路由处理器（逐字搬运）。
 *
 * 流程：
 *   1. primary agent 不可用 → sessionManager.fail(unavailable)
 *   2. pendingReviewOrigins.set('conversation') + reportProgress('thinking')
 *   3. 构建 systemPrompt（buildPrompt + 崩溃恢复 + Skills + mission context）
 *   4. ipc.send('user.message') 给 primary agent
 *
 * @param decision      路由决策（intent='chat'）
 * @param correlationId pending request 的 correlation id
 * @param pending       关联的 pending request
 * @param deps          依赖注入 + 跨集群回调
 */
export function handleChatRoute(
  decision: RouteDecision,
  correlationId: string,
  pending: PendingRequest,
  deps: RouteHandlersDeps,
): void {
  const { agentManager, registry, sessionManager, dialogueRouter, missionContextDeps, pendingReviewOrigins, reportProgress } = deps;
  const primaryAgent = registry.requireRole('primary');
  const primaryName = primaryAgent.manifest.name;
  const primary = agentManager.getAgent(primaryName);
  if (!primary) {
    // R14-1：unavailable 失败源走 finalizeTask 统一入口
    sessionManager.fail(correlationId, { kind: 'unavailable' });
    return;
  }

  pendingReviewOrigins.set(correlationId, 'conversation');
  reportProgress(pending, 'thinking', '正在思考...');
  let systemPrompt = sessionManager.buildPrompt(pending.sessionId);
  const memoryContext = sessionManager.buildMemoryContext(pending.sessionId, pending.userMessage);

  // 崩溃恢复：注入未完成对话的摘要（Conversation 重启后不丢失上下文）
  if (dialogueRouter) {
    const recovery = dialogueRouter.getRecentUnfinishedSummary(pending.sessionId);
    if (recovery) {
      systemPrompt += `\n\n## 上次未完成的智能体对话\n\n${recovery}\n\n如果用户希望继续，可以通过 dialogue 工具恢复协作。`;
    }
  }

  // §8.9 Skill activation: inject active Skills into system prompt
  if (decision.activeSkills && decision.activeSkills.length > 0) {
    const skillContent = loadActiveSkills(decision.activeSkills);
    if (skillContent) {
      systemPrompt += `\n\n${skillContent}`;
    }
  }

  // 13.0 多智能体协作：注入 mission context（让 agent 知道自己的 mission 目标 + squad 角色）
  if (decision.missionId) {
    const missionContext = buildMissionContextPrompt(
      missionContextDeps,
      decision.missionId,
      decision.planTaskId,
      decision.targetAgent,
    );
    if (missionContext) {
      systemPrompt += `\n\n${missionContext}`;
    }
  }

  primary.ipc.send('user.message', primaryName, {
    sessionId: pending.sessionId,
    message: pending.userMessage,
    taskId: pending.taskId,
    systemPrompt,
    memoryContext,
    instruction: decision.instruction,
    intent: decision.intent,
    modelTierOverride: decision.modelTier,
  }, correlationId);
}

/**
 * code / skill_test / learning / plugin 路由处理器（逐字搬运）。
 *
 * intent → taskType 映射，dispatchModuleTaskInternal 派发，失败 fallback 到 handleChatRoute。
 */
export async function handleTaskRoute(
  decision: RouteDecision,
  correlationId: string,
  pending: PendingRequest,
  deps: RouteHandlersDeps,
): Promise<void> {
  const { taskManager, reportProgress, dispatchModuleTaskInternal } = deps;
  const taskTypeMap: Record<string, string> = {
    code: 'code_task',
    skill_test: 'skill_test',
    learning: 'learning_review',
    plugin: 'plugin_task',
  };
  const taskType = taskTypeMap[decision.intent] ?? 'conversation_turn';

  reportProgress(pending, 'dispatching', `正在分发给 ${decision.targetAgent}...`);

  try {
    const { getLastCwd } = await import('../../tools/shell.js');
    const { taskId } = await dispatchModuleTaskInternal({
      sessionId: pending.sessionId,
      taskType,
      requester: 'brain-route',
      inputPayload: {
        message: pending.userMessage,
        instruction: decision.instruction,
        contextHints: decision.contextHints,
        workingDir: getLastCwd(),
        // 13.0 多智能体协作：透传 missionId，让 Agent 知道自己属于哪个 mission
        ...(decision.missionId ? { missionId: decision.missionId } : {}),
      },
      foreground: true,
      correlationId,
    });
    // 关联新 taskId 到 pending（供 flusher/rebind 使用）
    pending.delegationTaskId = taskId;
    if (pending.taskId) {
      taskManager.complete(pending.taskId, { delegatedTo: taskId });
    }
  } catch (err) {
    logger.error({ err, decision }, '任务路由分发失败，fallback 到对话');
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
  }
}

/**
 * external 路由处理器（逐字搬运）：claude-code / opencode / 自定义外部 agent。
 *
 * 路径：
 *   1. runtime 优先（resolveRuntimeForTarget + executeViaRuntime）
 *   2. daemon bridge 回退（不可用 → fallback 到 chat）
 *   3. delegationManager.create + postDelegateEnvelope 落板
 *   4. daemonBridge.dispatch → 失败 fallback 到 chat
 */
export async function handleExternalRoute(
  decision: RouteDecision,
  correlationId: string,
  pending: PendingRequest,
  deps: RouteHandlersDeps,
): Promise<void> {
  const { runtimeRegistry, daemonBridge, delegationManager, taskManager, reportProgress, resolveRuntimeForTarget, executeViaRuntime } = deps;
  // New path: try RuntimeRegistry first
  if (runtimeRegistry) {
    const runtime = resolveRuntimeForTarget(decision.targetAgent);
    if (runtime) {
      return executeViaRuntime(runtime, decision, correlationId, pending);
    }
  }

  // Legacy path: direct daemon bridge dispatch
  if (!daemonBridge?.isAvailable) {
    logger.warn({ correlationId }, 'External route requested but daemon not available, fallback to chat');
    reportProgress(pending, 'routing', '外部智能体不可用，转为对话处理...');
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
    return;
  }

  reportProgress(pending, 'dispatching', `正在分发给外部智能体 ${decision.targetAgent}...`);

  const taskId = delegationManager.create({
    sessionId: pending.sessionId,
    correlationId,
    targetAgent: '__daemon__',
    targetKind: 'daemon',
    userMessage: pending.userMessage,
    taskType: 'external_code_task',
    requester: 'brain-route',
    inputPayload: {
      message: pending.userMessage,
      instruction: decision.instruction,
      contextHints: decision.contextHints,
      // 13.0：透传 missionId，让外部 agent 知道自己属于哪个 mission
      ...(decision.missionId ? { missionId: decision.missionId } : {}),
    },
    foreground: true,
  });

  // 记录委托 task ID，供 flusher 清理使用
  pending.delegationTaskId = taskId;

  // 16.0 P4-C4：daemon 派发点投影 delegate 信封（fire-and-forget 审计影子）
  postDelegateEnvelope(taskId, {
    from: resolveLeaderForDelegate(),
    to: decision.targetAgent,
    subTaskGoal: pending.userMessage,
    sessionId: pending.sessionId,
    scope: { allowTools: ['*'] },
  });

  const dispatched = await daemonBridge.dispatch(taskId, {
    prompt: pending.userMessage,
    systemPrompt: decision.instruction,
  }, decision.targetAgent);

  if (!dispatched) {
    delegationManager.fail(taskId, 'Daemon dispatch failed');
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
    return;
  }

  if (pending.taskId) {
    taskManager.complete(pending.taskId, { delegatedTo: taskId });
  }
}

/**
 * multi 路由处理器（逐字搬运）：subDispatches 并行派发。
 *
 * 无 subDispatches → fallback 到 chat。createGroup 后逐个 dispatchModuleTaskInternal，
 * 全部失败则 removeGroup + fallback 到 chat。
 */
export async function handleMultiRoute(
  decision: RouteDecision,
  correlationId: string,
  pending: PendingRequest,
  deps: RouteHandlersDeps,
): Promise<void> {
  const { delegationManager, reportProgress, dispatchModuleTaskInternal } = deps;
  if (!decision.subDispatches || decision.subDispatches.length === 0) {
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
    return;
  }

  reportProgress(pending, 'dispatching', `正在并行分发 ${decision.subDispatches.length} 个子任务...`);

  delegationManager.createGroup('multi-' + correlationId, correlationId, pending.sessionId);
  let hasAny = false;

  for (const sub of decision.subDispatches) {
    try {
      const { taskId } = await dispatchModuleTaskInternal({
        sessionId: pending.sessionId,
        taskType: sub.taskType,
        requester: 'brain-route-multi',
        inputPayload: {
          ...sub.inputPayload,
          // 13.0：透传 missionId 到子任务
          ...(decision.missionId ? { missionId: decision.missionId } : {}),
        },
        foreground: true,
        correlationId: genId('sub'),
      });
      delegationManager.addChildToGroup(correlationId, taskId);
      hasAny = true;
    } catch (err) {
      logger.warn({ err, sub }, '多意图子任务分发失败');
    }
  }

  if (!hasAny) {
    delegationManager.removeGroup(correlationId);
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
  }
}

/**
 * workspace 路由处理器（逐字搬运）：委托给工作区 team lead。
 *
 * workspaceRouter 不可用 / 无 targetWorkspaceId / 无 lead → fallback 到 chat。
 * 成功则 recordSuccess，失败则 recordFailure + fallback。
 */
export async function handleWorkspaceRoute(
  decision: RouteDecision,
  correlationId: string,
  pending: PendingRequest,
  deps: RouteHandlersDeps,
): Promise<void> {
  const { workspaceRouter, taskManager, reportProgress, dispatchModuleTaskInternal } = deps;
  if (!workspaceRouter || !decision.targetWorkspaceId) {
    logger.warn({ correlationId }, '工作区路由不可用或缺少 targetWorkspaceId，降级到对话');
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
    return;
  }

  const lead = workspaceRouter.getTeamLead(decision.targetWorkspaceId);
  if (!lead) {
    logger.warn({ correlationId, workspaceId: decision.targetWorkspaceId }, '工作区没有 lead agent，降级到对话');
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
    return;
  }

  reportProgress(pending, 'dispatching', `正在委托给工作区团队 ${lead}...`);

  try {
    const { taskId } = await dispatchModuleTaskInternal({
      sessionId: pending.sessionId,
      taskType: 'conversation_turn',
      requester: 'workspace-route',
      inputPayload: {
        message: pending.userMessage,
        instruction: decision.instruction,
        workspaceId: decision.targetWorkspaceId,
        delegationType: 'workspace',
        // 13.0：透传 missionId 到工作区路由
        ...(decision.missionId ? { missionId: decision.missionId } : {}),
      },
      foreground: true,
      correlationId,
    });

    workspaceRouter.recordSuccess(pending.userMessage, decision.targetWorkspaceId, decision.intent);

    if (pending.taskId) {
      taskManager.complete(pending.taskId, { delegatedTo: taskId });
    }
  } catch (err) {
    logger.error({ err, decision }, '工作区路由分发失败，降级到对话');
    workspaceRouter.recordFailure(pending.userMessage, decision.targetWorkspaceId, decision.intent);
    handleChatRoute({ ...decision, intent: 'chat', targetAgent: 'conversation' }, correlationId, pending, deps);
  }
}
