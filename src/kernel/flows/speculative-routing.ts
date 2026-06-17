/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——sendRouteRequest 投机执行路由提取。
 *
 * 从 delegation-orchestrator.ts 的 sendRouteRequest/sendRouteRequestSync 闭包整组搬出（行为保持）。
 * 含：规则路由快路径 → 投机执行 conversation → Brain LLM 并行路由（富化 context）→ 30s 超时降级。
 */

import type { SessionManager, PendingRequest } from '../session-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { AgentManager } from '../agent-manager.js';
import type { TakeoverController } from '../../testing/model-takeover.js';
import type { FallbackRouter } from '../fallback-router.js';
import type { BrainDecisionRecorder } from '../brain-decision-recorder.js';
import type { WorldModelRuntime } from '../world-model.js';
import type { SuggestionQueue } from '../suggestion-queue.js';
import type { ICapabilityBus } from '../../bus/contract.js';
import type { RouteDecision, RouteRequestPayload } from '../../contracts/routing.js';
import { getLogger } from '../../utils/logger.js';
import { getTracer } from '../../observability/tracer.js';
import { getEventBus } from '../event-bus.js';
import { withTrace } from '../../observability/trace-context.js';
import { metrics } from '../../observability/metrics.js';

const logger = getLogger('orchestrator');

/** sendRouteRequest 依赖（orchestrator 构建，测试可注入） */
export interface SpeculativeRoutingDeps {
  readonly takeoverController: TakeoverController | null;
  readonly fallbackRouter: FallbackRouter;
  readonly sessionManager: SessionManager;
  readonly brainDecisionRecorder: BrainDecisionRecorder | null;
  readonly registry: AgentRegistry;
  readonly agentManager: AgentManager;
  readonly worldModelRef: WorldModelRuntime | null;
  readonly suggestionQueueRef: SuggestionQueue | null;
  readonly capabilityBusRef: ICapabilityBus | null;
  /** 投机执行状态（conversation 已启动、等 Brain 确认） */
  speculativeCorrelations: Set<string>;
  /** 进度上报回调（主类 reportProgress） */
  reportProgress: (pending: PendingRequest, status: 'thinking' | 'routing' | 'dispatching' | 'reviewing', summary: string) => void;
  /** 路由决策处理回调（主类 handleRouteDecision） */
  handleRouteDecision: (decision: RouteDecision, correlationId: string) => void;
  /** chat 路由回调（主类 handleChatRoute） */
  handleChatRoute: (decision: RouteDecision, correlationId: string, pending: PendingRequest) => void;
  /** 降级路由回调（主类 handleRouteFallback） */
  handleRouteFallback: (correlationId: string, userMessage?: string) => void;
}

/**
 * sendRouteRequest 投机执行路由（行为保持式提取）。
 *
 * 流程：test/takeover 模式→同步路由；规则路由命中→直接派发；未命中→投机执行 conversation + Brain LLM
 * 并行路由（富化 memory/world/suggestion/capability context）+ 30s 超时降级 FallbackRouter。
 */
export function sendRouteRequestImpl(payload: RouteRequestPayload, correlationId: string, deps: SpeculativeRoutingDeps): void {
  const { takeoverController, fallbackRouter, sessionManager, brainDecisionRecorder, registry, agentManager } = deps;
  withTrace('router.sendRouteRequest', () => {
    // test/takeover 模式→同步 Brain 路由
    if (takeoverController) {
      sendRouteRequestSyncImpl(payload, correlationId, deps);
      return;
    }

    // 规则路由快路径
    const ruleDecision = fallbackRouter.route(payload.message);
    if (ruleDecision.intent !== 'chat') {
      logger.info({ intent: ruleDecision.intent, target: ruleDecision.targetAgent }, '规则路由命中，跳过 Brain');
      const pending = sessionManager.getPending(correlationId);
      if (pending) {
        deps.reportProgress(pending, 'thinking', '正在分析意图...');
        brainDecisionRecorder?.recordRouteDecision(pending.sessionId, pending.userMessage, { ...ruleDecision, source: 'rule' } as unknown as Record<string, unknown>, pending.taskId);
        getEventBus().emit('message.routed', { sessionId: pending.sessionId, taskId: pending.taskId ?? correlationId, targetAgent: ruleDecision.targetAgent, intent: ruleDecision.intent });
      }
      deps.handleRouteDecision(ruleDecision, correlationId);
      return;
    }

    // 投机执行：conversation 先启动
    const pending = sessionManager.getPending(correlationId);
    if (pending) {
      deps.speculativeCorrelations.add(correlationId);
      const chatDecision: RouteDecision = { intent: 'chat', targetAgent: 'conversation', priority: 'normal', reason: 'speculative: conversation started while Brain routing' };
      deps.handleChatRoute(chatDecision, correlationId, pending);
    }

    // Brain LLM 并行路由（学习 + 可能 handoff）
    const orchestratorAgent = registry.requireRole('orchestrator');
    const orchestratorName = orchestratorAgent.manifest.name;
    const brain = agentManager.getAgent(orchestratorName);
    if (!brain) {
      deps.speculativeCorrelations.delete(correlationId);
      return;
    }

    // 富化 context（memory/world/suggestion/capability）
    let enrichedPayload = { ...payload };
    const memoryFrame = sessionManager.buildMemoryContext(enrichedPayload.sessionId, enrichedPayload.message);
    if (memoryFrame?.records && memoryFrame.records.length > 0) {
      const memoryHints = memoryFrame.records.slice(0, 5).map((r: any) => r.summary ?? r.content).join('; ');
      enrichedPayload = { ...enrichedPayload, sessionContext: (enrichedPayload.sessionContext ?? '') + `\n\n[用户记忆] ${memoryHints}` };
    }
    if (deps.worldModelRef) {
      const worldSummary = deps.worldModelRef.getSummary();
      if (worldSummary) {
        enrichedPayload = { ...enrichedPayload, sessionContext: enrichedPayload.sessionContext ? `${enrichedPayload.sessionContext}\n\n[世界模型] ${worldSummary}` : `[世界模型] ${worldSummary}` };
      }
    }
    if (deps.suggestionQueueRef) {
      const suggestionsBlock = deps.suggestionQueueRef.buildPromptBlock(enrichedPayload.sessionId);
      if (suggestionsBlock) {
        enrichedPayload = { ...enrichedPayload, sessionContext: (enrichedPayload.sessionContext ?? '') + suggestionsBlock };
      }
    }
    if (deps.capabilityBusRef) {
      const capabilities = deps.capabilityBusRef.discover();
      if (capabilities.length > 0) {
        const capList = capabilities.slice(0, 30).map(c => `${c.name} (${c.dangerLevel})`).join(', ');
        enrichedPayload = { ...enrichedPayload, sessionContext: (enrichedPayload.sessionContext ?? '') + `\n\n[可用能力] ${capList}` };
      }
    }
    brain.ipc.send('route.request', orchestratorName, enrichedPayload, correlationId);

    // 30s 超时降级（VF-2）
    setTimeout(() => {
      const p = sessionManager.getPending(correlationId);
      if (p && !deps.speculativeCorrelations.has(correlationId)) {
        metrics.counter('routing_llm_fallback_total').inc({ reason: 'timeout' });
        logger.warn({ correlationId, timeoutMs: 30_000, sessionId: p.sessionId }, 'routing: Brain LLM 30s 无响应，降级到 FallbackRouter');
        deps.handleRouteFallback(correlationId);
      }
    }, 30_000).unref();
  });
}

/** 同步 Brain 路由（test/takeover 模式，行为保持） */
export function sendRouteRequestSyncImpl(payload: RouteRequestPayload, correlationId: string, deps: SpeculativeRoutingDeps): void {
  const orchestratorAgent = deps.registry.requireRole('orchestrator');
  const orchestratorName = orchestratorAgent.manifest.name;
  const brain = deps.agentManager.getAgent(orchestratorName);
  if (!brain) {
    deps.handleRouteFallback(correlationId);
    return;
  }
  brain.ipc.send('route.request', orchestratorName, payload, correlationId);
}
