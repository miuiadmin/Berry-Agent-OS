/**
 * KernelRouter — 13.0 灵魂版 Kernel 层路由抽象。
 *
 * 设计目标：
 * - 从 DelegationOrchestrator 抽取纯路由逻辑（dialogue send/reply + 跨 Agent 消息分发）
 * - 让 Orchestrator 专注任务管理 / 委托 / 路由决策
 * - 单一职责：KernelRouter = "消息从 A 路由到 B"，Orchestrator = "业务编排"
 *
 * 13.0 §4.1/§5.2 安全门控：
 * - 禁止 to:'brain'（Brain 是观察者，不直接对话）
 * - 调用深度限制（防循环调用 A→B→A→B）
 * - 循环引用检测（防 A→B→A）
 * - Agent 对频率限制（防高频轰炸）
 *
 * Phase 5 抽取范围：
 * - dialogue.send 路由（Conversation → Target / Module Agent → Target）
 * - dialogue.reply 转发（Target → Initiator）
 * - dialogue.end 关闭
 * - 13.0 AgentPort 跨 Agent 发起对话的 dialogue.send 路由（Module Agent → Target）
 * - 权限确认期间暂停 dialogue 超时的 EventBus 监听
 *
 * 保留在 DelegationOrchestrator 的部分（不属于纯路由）：
 * - task lifecycle handlers（setupTaskResultHandlers / setupTaskProgressHandler 等）
 * - audit handlers
 * - permission flow handlers
 * - capability bus handlers
 * - model override handlers
 * - takeover routing
 *
 * 设计依据：设计文档/19-架构升级-13.0.md §20.5（Phase 5 KernelRouter 抽取）
 */

import type { IpcMessage } from './types.js';
import type { DialogueRouter } from './dialogue-router.js';
import type { AgentManager } from './agent-manager.js';
import type { SessionManager } from './session-manager.js';
import type { StateCache } from './state-cache.js';
import type { InterAgentBudget } from './state-cache.js';
import { getEventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';
import { safeSlice } from '../utils/safe-slice.js';
import { AgentTimeoutError, AgentCrashError, AgentUnavailableError } from './errors.js';

const logger = getLogger('kernel-router');

/** §4.4.2: 跨 Agent 调用最大深度（防无限递归） */
const MAX_AGENT_CALL_DEPTH = 16;

/** §5.2.3: 每 (from, to) agent 对的频率限制 */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 分钟窗口
const RATE_LIMIT_MAX_REQUESTS = 10;   // §4.4.2: 每 agent 对每分钟最多 10 次

/** §4.4.2: 单个 session 内的跨 agent request 总次数上限 */
const MAX_INTER_AGENT_REQUESTS_PER_SESSION = 30;

/**
 * §5.2.2: Agent 消息类型白名单。
 *
 * 限制每个 Agent 可以发送/接收的消息类型。
 * 不在白名单中的消息类型会被 gate 拒绝。
 * '*' 通配符表示允许所有类型（向后兼容未明确配置的 agent）。
 */
interface AgentMessagePermission {
  canSend: string[];
  canReceive: string[];
}

const AGENT_MESSAGE_WHITELIST: Record<string, AgentMessagePermission> = {
  code: {
    canSend: ['agent.question', 'agent.delegate', 'agent.notify', 'tool.*', 'turn.*', 'stream.*', 'task.handoff', 'task.reject', 'user.ask'],
    canReceive: ['turn.start', 'agent.question', 'agent.delegate', 'turn.correction', 'user.message', 'user.interrupt', 'state.query'],
  },
  learning: {
    canSend: ['agent.answer', 'agent.result', 'turn.final', 'stream.*'],
    canReceive: ['agent.question', 'agent.delegate', 'state.query'],
  },
  memory: {
    canSend: ['agent.answer', 'agent.result', 'turn.final', 'stream.*'],
    canReceive: ['agent.question', 'agent.delegate', 'state.query'],
  },
  skills: {
    canSend: ['agent.answer', 'agent.result', 'turn.final', 'stream.*', 'task.handoff'],
    canReceive: ['turn.start', 'agent.question', 'agent.delegate', 'turn.correction', 'state.query'],
  },
  conversation: {
    canSend: ['dialogue.*', 'agent.question', 'agent.delegate', 'turn.*', 'stream.*', 'draft.response', 'final.response'],
    canReceive: ['user.message', 'review.result', 'turn.correction', 'dialogue.reply'],
  },
  brain: {
    canSend: ['route.result', 'review.result', 'permission.judge.result', 'checkpoint.result', 'brain.correction'],
    canReceive: ['route.request', 'review.request', 'permission.judge', 'brain.observe', 'dialogue.observe', 'checkpoint.evaluate', 'drift.check.request'],
  },
  evolution: {
    canSend: ['agent.answer', 'agent.result', 'turn.final', 'stream.*'],
    canReceive: ['agent.question', 'agent.delegate', 'state.query'],
  },
};

/**
 * §5.2.2: 检查消息类型是否匹配白名单模式。
 *
 * 支持通配符：'tool.*' 匹配 'tool.call'、'tool.result' 等。
 * '*' 单独使用表示匹配所有类型。
 */
function isMessageTypeAllowed(messageType: string, patterns: string[]): boolean {
  if (patterns.includes('*')) return true;
  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      if (messageType.startsWith(prefix + '.')) return true;
    } else if (messageType === pattern) {
      return true;
    }
  }
  return false;
}

/** 频率限制追踪条目 */
interface RateLimitEntry {
  /** 窗口内请求计数 */
  count: number;
  /** 窗口起始时间 */
  windowStart: number;
}

/**
 * 从错误对象中提取类型化错误码，供 Agent LLM 做出合理决策。
 *
 * 错误码对照：
 * - AGENT_TIMEOUT → Agent 还活着但卡住/处理慢，可安全重试
 * - AGENT_CRASHED → Agent 进程已崩溃，不应重试
 * - AGENT_UNAVAILABLE → Agent 未注册或离线，不应重试
 * - UNKNOWN → 通用错误
 */
function errorToCode(err: unknown): { code: string; message: string } {
  if (err instanceof AgentTimeoutError) return { code: 'AGENT_TIMEOUT', message: err.message };
  if (err instanceof AgentCrashError) return { code: 'AGENT_CRASHED', message: err.message };
  if (err instanceof AgentUnavailableError) return { code: 'AGENT_UNAVAILABLE', message: err.message };
  return { code: 'UNKNOWN', message: (err as Error).message };
}

/** Agent IPC 接口的最小子集（KernelRouter 只需要 onMessage + send） */
export interface AgentIpcLike {
  onMessage: (type: string, handler: (msg: IpcMessage) => void) => void;
  send: <T = unknown>(type: string, to: string, payload: T, correlationId?: string) => boolean;
}

/** KernelRouter 依赖 */
export interface KernelRouterDeps {
  /** 对话路由器（管理 dialogue 状态、超时、预算） */
  dialogueRouter: DialogueRouter | null;
  /** Agent 管理器（ensureAgent 启动 on-demand agent） */
  agentManager: AgentManager;
  /** 会话管理器（通过 correlationId 查找 pending） */
  sessionManager: SessionManager;
  /**
   * 13.0 §4.4.2: 统一状态缓存（跨 agent 预算等）。
   * 可选——未注入时跳过预算检查（向后兼容）。
   */
  stateCache?: StateCache;
  /**
   * 13.0 §4.4.2: session 级总 token 预算上限（来自 BudgetConfigSchema.sessionLimit）。
   * 用于初始化 inter_agent_budget.totalBudget，使 30% 软上限检查真实生效。
   * 未注入时回退到默认值 500_000（与 BudgetConfigSchema.sessionLimit 默认值一致）。
   */
  sessionBudgetLimit?: number;
}

/**
 * KernelRouter — 封装跨 Agent 消息路由的纯路由层。
 *
 * 用法：
 * ```ts
 * const kernelRouter = new KernelRouter({ dialogueRouter, agentManager, sessionManager });
 * kernelRouter.setupDialogueRouting(primaryIpc, primaryName);
 * kernelRouter.setupDialogueRoutingForAgent(agentIpc, agentName);
 * ```
 */
export class KernelRouter {
  /** 已注册的 module agent IPC 集合（防重复注册） */
  private setupAgentIpcs = new WeakSet<object>();
  private deps: KernelRouterDeps;

  /** §5.2.3: per-agent-pair 频率限制追踪 (from:to → RateLimitEntry) */
  private rateLimits = new Map<string, RateLimitEntry>();

  /**
   * §5.2.3: 活跃对话方向追踪（防 A→B→A 循环引用）。
   *
   * key = `${from}→${to}`，value = 该方向的活跃对话 ID 集合。
   * 当 dialogue.send 建立对话时 add，dialogue 完成/结束时 delete。
   * gate() 检查反向 key `${to}→${from}` 是否存在 — 存在说明 B→A 已在活跃，
   * A→B 请求构成循环引用。
   */
  private activeDialogueDirections = new Map<string, Set<string>>();

  /**
   * §5.3.10: Agent 目录本地缓存。
   * Kernel 维护实时目录，agent.discover 直接从缓存读取（零 IPC）。
   * agent register/crashed 时增量推送 directory.changed 事件更新缓存。
   */
  private directoryCache: Array<{ name: string; description: string; capabilities: string[]; status: 'online' | 'offline' }> = [];
  /** 缓存是否已初始化 */
  private directoryInitialized = false;

  constructor(deps: KernelRouterDeps) {
    this.deps = deps;

    // §5.3.10: 订阅 agent 生命周期事件，维护目录缓存
    this.setupDirectoryCache();
  }

  /**
   * §5.3.10: 初始化目录缓存并订阅增量更新。
   * agent register/crashed 事件触发缓存重建 + 推送 directory.changed。
   */
  private setupDirectoryCache(): void {
    // 首次查询时懒加载（因为构造时 agentManager 可能还没有 agent）
    getEventBus().on('agent.registered', () => {
      this.refreshDirectoryCache();
    });
    // agent 崩溃也触发更新
    getEventBus().on('agent.crashed', () => {
      this.refreshDirectoryCache();
    });
  }

  /**
   * §5.3.10: 从 AgentManager 刷新目录缓存。
   * 更新内存缓存后推 directory.changed 事件让已注册的 agent 知道。
   */
  private refreshDirectoryCache(): void {
    try {
      const agents = this.deps.agentManager.listAliveAgents();
      this.directoryCache = agents
        .filter(a => a.name !== 'brain')
        .map(a => ({
          name: a.name,
          description: a.description ?? '',
          capabilities: a.capabilities ?? [],
          status: 'online' as const,
        }));
      this.directoryInitialized = true;

      // 推送 directory.changed 事件（EventBus 广播，已注册的 agent 可订阅）
      getEventBus().emit('directory.changed', {
        added: this.directoryCache,
        removed: [],
      });
    } catch (err) {
      logger.warn({ err }, 'refreshDirectoryCache failed');
    }
  }

  /**
   * 注入 dialogueRouter（延迟到 init 阶段，因为 DialogueRouter 构造需要 getDb() 等运行时依赖）。
   */
  setDialogueRouter(router: DialogueRouter): void {
    this.deps.dialogueRouter = router;
  }

  /**
   * §4.4.2: 注入 stateCache（延迟到 initMissionSystem 阶段）。
   * 注入后启用跨 agent 预算检查和记录。
   */
  setStateCache(cache: StateCache): void {
    this.deps.stateCache = cache;
  }

  // ═══════════════════════════════════════════════════════════════
  // 13.0 §4.1/§5.2: 集中式安全门控
  // ═══════════════════════════════════════════════════════════════

  /**
   * 集中式安全门控 — 所有跨 Agent 消息必须通过此检查。
   *
   * 13.0 §5.2.2-§5.2.4 规定的检查：
   * 1. 禁止 to:'brain'（Brain 是观察者，不直接对话）
   * 2. 调用深度限制（防循环调用 A→B→C→...→A）
   * 3. 循环引用检测（防 A→B→A）
   * 4. Agent 对频率限制（每分钟最多 N 次）
   * 5. 自我消息禁止（防 A→A）
   * 6. 跨 Agent 预算检查（session 级总次数上限）
   *
   * @param from - 发送方 agent 名
   * @param to - 接收方 agent 名
   * @param sessionId - 可选的 session ID，用于预算检查
   * @param messageType - 可选的消息类型，用于白名单检查
   * @param callDepth - 可选的当前调用深度，用于防无限递归
   * @returns 拒绝原因字符串（null 表示通过）
   */
  gate(from: string, to: string, sessionId?: string, messageType?: string, callDepth?: number): string | null {
    // ① §5.2.4: 禁止任何 agent 直接发消息给 Brain
    if (to === 'brain') {
      return '不允许直接向 Brain 发送消息（Brain 是观察者，不直接对话）';
    }

    // ② 自我消息禁止
    if (to === from) {
      return `不允许自己向自己发消息 (${from})`;
    }

    // ③ §5.2.3: 循环引用检测 — 检查反向方向是否有活跃对话（防 A→B→A）
    const reverseKey = `${to}→${from}`;
    const reverseDialogues = this.activeDialogueDirections.get(reverseKey);
    if (reverseDialogues && reverseDialogues.size > 0) {
      return `循环引用检测: ${to}→${from} 已有 ${reverseDialogues.size} 个活跃对话，拒绝 ${from}→${to} 防止 A→B→A 循环`;
    }

    // ④ §4.4.1: 调用深度限制（防无限递归 A→B→C→...→A）
    if (callDepth !== undefined && callDepth >= MAX_AGENT_CALL_DEPTH) {
      return `调用深度超限 (${callDepth}/${MAX_AGENT_CALL_DEPTH})，可能存在循环调用`;
    }

    // ④ §5.2.3: Agent 对频率限制
    if (!this.checkRateLimit(from, to)) {
      return `${from} → ${to} 频率超限（每分钟最多 ${RATE_LIMIT_MAX_REQUESTS} 次）`;
    }

    // ⑤ §5.2.2: 消息类型白名单
    if (messageType) {
      const fromWhitelist = AGENT_MESSAGE_WHITELIST[from];
      if (fromWhitelist && !isMessageTypeAllowed(messageType, fromWhitelist.canSend)) {
        return `${from} 不允许发送消息类型 "${messageType}"`;
      }
    }

    // ⑥ §4.4.2: 跨 Agent 预算检查（session 级总次数上限 + 30% 预算占比）
    if (sessionId && this.deps.stateCache) {
      const budget = this.deps.stateCache.get<InterAgentBudget>('inter_agent_budget', sessionId);
      if (budget) {
        // ⑥a: 硬上限 — 单 session 最多 30 次跨 agent 通信
        if (budget.requestCount >= MAX_INTER_AGENT_REQUESTS_PER_SESSION) {
          return `session ${sessionId} 跨 agent 通信次数已耗尽（${budget.requestCount}/${MAX_INTER_AGENT_REQUESTS_PER_SESSION}）`;
        }
        // ⑥b: §4.4.2 软上限 — 跨 agent 通信消耗不超过 session 总预算的 30%
        // 防止 agent 间互相问答消耗过多 token，保证至少 70% 用于主 task
        if (budget.totalBudget > 0 && budget.tokensUsed >= budget.totalBudget * 0.3) {
          return `session ${sessionId} 跨 agent 预算占比超限（${Math.round(budget.tokensUsed / budget.totalBudget * 100)}% >= 30%）`;
        }
      }
    }

    return null; // 通过所有检查
  }

  /**
   * §5.2.3: 追踪活跃对话方向（用于循环引用检测）。
   *
   * 在 dialogue 注册成功后调用。将 dialogueId 加入 `from→to` 方向的活跃集合。
   * gate() 会检查反向 `to→from` 是否存在活跃对话来判定循环引用。
   *
   * @param from 发送方 agent
   * @param to 接收方 agent
   * @param dialogueId 对话 ID
   */
  private trackDialogueDirection(from: string, to: string, dialogueId: string): void {
    const key = `${from}→${to}`;
    let set = this.activeDialogueDirections.get(key);
    if (!set) {
      set = new Set();
      this.activeDialogueDirections.set(key, set);
    }
    set.add(dialogueId);
    logger.debug({ from, to, dialogueId, activeCount: set.size }, 'KernelRouter: tracked dialogue direction');
  }

  /**
   * §5.2.3: 清除对话方向追踪。
   *
   * 在 dialogue 完成（成功或失败）后调用。从 `from→to` 方向集合中移除 dialogueId。
   * 集合为空时自动清理 Map entry，避免内存泄漏。
   *
   * @param from 发送方 agent
   * @param to 接收方 agent
   * @param dialogueId 对话 ID
   */
  private untrackDialogueDirection(from: string, to: string, dialogueId: string): void {
    const key = `${from}→${to}`;
    const set = this.activeDialogueDirections.get(key);
    if (set) {
      set.delete(dialogueId);
      if (set.size === 0) {
        this.activeDialogueDirections.delete(key);
      }
      logger.debug({ from, to, dialogueId, remainingCount: set.size }, 'KernelRouter: untracked dialogue direction');
    }
  }

  /**
   * §4.1 §3.2 OBSERVE: 异步转发观察副本给 Brain Agent。
   *
   * 设计文档要求 KernelRouter.route() 的第四步：所有跨 agent 消息经 Kernel 中转时，
   * 异步转发一份副本给 Brain 的 brain.observe handler，实现 OBSERVE 阶段的实时 IPC 推送。
   *
   * Brain 的 handler 会将观察持久化到 brain_observations 表（SQLite），
   * 并定期触发 plan 进度检查（每 PLAN_CHECK_INTERVAL 次观察后）。
   *
   * 此方法是 fire-and-forget（异步不阻塞），发送失败仅记 debug 日志不影响原消息投递。
   *
   * @param from - 发送方 agent
   * @param to - 接收方 agent
   * @param originalType - 原始消息类型（dialogue_send / dialogue_reply / tool_call / tool_result）
   * @param payload - 观察内容摘要（已截断）
   * @param sessionId - 可选 session ID
   * @param taskId - 可选真实 task ID（用于按 task 聚合观察队列；缺失时回退到 sessionId 兜底）
   */
  private observeToBrain(from: string, to: string, originalType: string, payload: Record<string, unknown>, sessionId?: string, taskId?: string): void {
    // Brain 不观察自己的消息和内核内部消息
    if (from === 'brain' || to === 'brain' || from === 'core') return;

    try {
      const brainAgent = this.deps.agentManager.getAgent('brain');
      if (!brainAgent?.ipc) return; // Brain 未启动则静默跳过

      // 13.0 §4.1 数据完整性：taskId 必须是真实 task ID，
      // 不能用 sessionId 替代——否则 Brain 的 plan 进度检查（checkPlanProgress）
      // 和观察队列按 task 聚合会拿到错误的 key。
      // 优先用真实 taskId；缺失时回退到 sessionId（保证有值，不丢观察）。
      const effectiveTaskId = taskId ?? (sessionId ?? 'unknown');

      brainAgent.ipc.send('brain.observe', 'brain', {
        sessionId: sessionId ?? 'unknown',
        taskId: effectiveTaskId,
        observationType: originalType,
        fromAgent: from,
        toAgent: to,
        content: JSON.stringify(payload),
        priority: 1, // normal 优先级
      });
    } catch (err) {
      // 观察 IPC 发送失败不应影响正常消息路由
      logger.debug({ err, from, to, originalType }, 'KernelRouter: observeToBrain send failed (non-critical)');
    }
  }

  /**
   * §4.4.2: 记录一次跨 agent 通信，更新预算计数。
   *
   * 在 dialogue 成功建立后调用（gate 通过 + sendMessage 完成）。
   *
   * @param sessionId - session ID
   * @param tokensUsed - 本次通信消耗的 token 数（估算，后续可精确化）
   */
  recordInterAgentRequest(sessionId: string, tokensUsed?: number): void {
    if (!this.deps.stateCache) return;
    const SESSION_BUDGET_DEFAULT = 500_000; // 与 BudgetConfigSchema.sessionLimit 默认值一致
    const budget = this.deps.stateCache.get<InterAgentBudget>('inter_agent_budget', sessionId) ?? {
      tokensUsed: 0,
      requestCount: 0,
      // 13.0 §4.4.2: totalBudget 从配置初始化（修复旧版恒为 0 的死代码，
      // 使 gate ⑥b 的 30% 软上限检查真实生效）
      totalBudget: this.deps.sessionBudgetLimit ?? SESSION_BUDGET_DEFAULT,
    };
    budget.requestCount++;
    if (tokensUsed) budget.tokensUsed += tokensUsed;
    this.deps.stateCache.set('inter_agent_budget', sessionId, budget);
  }

  /**
   * §5.2.3: 检查 per-agent-pair 频率限制。
   *
   * 滑动窗口算法：每 (from, to) 对在 1 分钟窗口内最多允许 RATE_LIMIT_MAX_REQUESTS 次请求。
   * 窗口过期后自动重置计数。
   *
   * @returns true 表示未超限，false 表示超限
   */
  private checkRateLimit(from: string, to: string): boolean {
    const key = `${from}:${to}`;
    const now = Date.now();
    const entry = this.rateLimits.get(key);

    if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
      // 新窗口或窗口过期 → 重置
      this.rateLimits.set(key, { count: 1, windowStart: now });
      return true;
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
      logger.warn({ from, to, count: entry.count }, 'kernel-router: agent 对频率超限');
      return false;
    }

    return true;
  }

  /**
   * 设置 Primary Agent（通常是 Conversation）的 dialogue 路由。
   * - dialogue.send: Primary → Target Agent
   * - dialogue.reply: Target → Primary
   * - dialogue.end: Primary 主动结束对话
   * - permission.user_confirm_needed: 暂停所有活跃 dialogue 的超时
   *
   * @param primaryIpc Primary Agent 的 IPC 通道
   * @param primaryName Primary Agent 名称
   */
  setupDialogueRouting(primaryIpc: AgentIpcLike, primaryName: string): void {
    const router = this.deps.dialogueRouter;
    if (!router) return;

    // Primary 发来 dialogue.send → 确保目标 agent 已启动 → 路由
    primaryIpc.onMessage('dialogue.send', async (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueMessagePayload;

      // 13.0 §5.2: 集中式安全门控（包含 to:'brain' 禁止 + 频率限制 + 自消息禁止）
      const gateResult = this.gate(payload.from, payload.to);
      if (gateResult) {
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: 'core',
          to: payload.from,
          content: `[对话错误] ${gateResult}`,
          metadata: { isFinal: true },
        };
        primaryIpc.send('dialogue.reply', primaryName, errorReply, payload.dialogueId);
        return;
      }

      // 首次对话：在 DialogueRouter 中注册对话状态
      let state = router.getDialogue(payload.dialogueId);
      if (!state) {
        const correlationId = msg.correlationId ?? msg.id;
        const pending = this.deps.sessionManager.getPending(correlationId);
        state = router.registerDialogue(payload.dialogueId, {
          sessionId: pending?.sessionId ?? 'unknown',
          correlationId,
          initiator: payload.from,
          target: payload.to,
        });

        // §5.2.3: 追踪活跃对话方向（用于循环引用检测）
        this.trackDialogueDirection(payload.from, payload.to, payload.dialogueId);
      }

      // 确保目标 agent 已启动 + 注册其 dialogue routing
      await this.deps.agentManager.ensureAgent(payload.to);
      const targetAgent = this.deps.agentManager.getAgent(payload.to);
      if (targetAgent) {
        this.setupDialogueRoutingForAgent(targetAgent.ipc as AgentIpcLike, payload.to);
      }

      // 推送前端事件
      const pending = this.deps.sessionManager.getPending(state!.correlationId);
      getEventBus().emit('dialogue.status', {
        dialogueId: payload.dialogueId,
        sessionId: pending?.sessionId ?? state!.sessionId,
        status: state!.currentRound === 0 ? 'started' : 'round_complete',
        from: payload.from,
        to: payload.to,
        round: state!.currentRound,
      });

      // §4.1 §3.2 OBSERVE: 异步转发发送方向给 Brain（setupDialogueRouting 路径）
      this.observeToBrain(payload.from, payload.to, 'dialogue_send', {
        dialogueId: payload.dialogueId,
        from: payload.from,
        to: payload.to,
        contentSummary: safeSlice(payload.content, 200),
      }, pending?.sessionId, pending?.taskId);

      try {
        const reply = await router.sendMessage(payload);
        primaryIpc.send('dialogue.reply', primaryName, reply, payload.dialogueId);

        // §4.4.2: 记录一次成功的跨 agent 通信（更新预算计数）
        if (pending?.sessionId) {
          this.recordInterAgentRequest(pending.sessionId);
        }

        // §4.1 §3.2 OBSERVE: 异步转发副本给 Brain（不阻塞原消息投递）
        // Brain 的 brain.observe handler 接收后持久化到 brain_observations 表
        // 这是 OBSERVE 阶段的实时 IPC 推送路径（补充 SQLite 间接读取）
        this.observeToBrain(payload.from, payload.to, 'dialogue_reply', {
          dialogueId: payload.dialogueId,
          from: payload.from,
          to: payload.to,
          contentSummary: safeSlice(reply.content, 200),
        }, pending?.sessionId, pending?.taskId);

        // §5.2.3: 对话完成，清除方向追踪
        this.untrackDialogueDirection(payload.from, payload.to, payload.dialogueId);
      } catch (err) {
        // 使用类型化错误码，让 Agent LLM 能区分超时/崩溃/不可用
        const { code, message } = errorToCode(err);
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: payload.to,
          to: payload.from,
          content: `[对话错误:${code}] ${message}`,
          metadata: { isFinal: true, errorCode: code },
        };
        primaryIpc.send('dialogue.reply', primaryName, errorReply, payload.dialogueId);

        getEventBus().emit('dialogue.status', {
          dialogueId: payload.dialogueId,
          sessionId: pending?.sessionId ?? state!.sessionId,
          status: 'ended',
          from: payload.from,
          to: payload.to,
          round: state!.currentRound,
        });

        // §5.2.3: 对话失败，也要清除方向追踪
        this.untrackDialogueDirection(payload.from, payload.to, payload.dialogueId);
      }
    });

    // Primary 主动结束对话
    primaryIpc.onMessage('dialogue.end', (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueEndPayload;
      router.closeDialogue(payload.dialogueId, payload.reason ?? 'completed');
    });

    // 权限确认期间暂停 dialogue 超时
    getEventBus().on('permission.user_confirm_needed', ({ sessionId }) => {
      for (const d of router.getActiveDialoguesForSession(sessionId)) {
        router.pauseTimeout(d.dialogueId);
      }
    });
  }

  /**
   * 设置 Module Agent 的 dialogue 路由。
   * - dialogue.reply: Module Agent → DialogueRouter（resolve pending）
   * - dialogue.send: Module Agent → Target（13.0 AgentPort 跨 Agent 通信）
   *
   * 防重复注册（同一 IPC 只注册一次）。
   *
   * @param agentIpc Module Agent 的 IPC 通道
   * @param agentName Module Agent 名称
   */
  setupDialogueRoutingForAgent(agentIpc: AgentIpcLike, agentName: string): void {
    const ipcObj = agentIpc as unknown as object;
    if (this.setupAgentIpcs.has(ipcObj)) return;
    this.setupAgentIpcs.add(ipcObj);

    const router = this.deps.dialogueRouter;
    if (!router) return;

    // dialogue.reply: Module Agent 回复 → DialogueRouter handleReply
    agentIpc.onMessage('dialogue.reply', (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueMessagePayload;
      router.handleReply(payload);
    });

    // L5: 注册 agent.discover handler（返回实时在线 Agent 列表）
    this.setupDiscoverHandler(agentIpc, agentName);

    // 13.0 AgentPort: Module Agent 主动发起的 dialogue.send 路由
    agentIpc.onMessage('dialogue.send', async (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueMessagePayload;

      // 13.0 §5.2: 集中式安全门控（替换原有的分散 to:'brain' + self-messaging 检查）
      const gateResult = this.gate(payload.from, payload.to);
      if (gateResult) {
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: 'core',
          to: payload.from,
          content: `[对话错误] ${gateResult}`,
          metadata: { isFinal: true },
        };
        agentIpc.send('dialogue.reply', agentName, errorReply, payload.dialogueId);
        return;
      }

      // 注册对话状态（如未注册）
      let state = router.getDialogue(payload.dialogueId);
      if (!state) {
        const correlationId = msg.correlationId ?? msg.id;
        state = router.registerDialogue(payload.dialogueId, {
          sessionId: (payload.context as Record<string, unknown>)?._sessionId as string ?? 'agent-port',
          correlationId,
          initiator: payload.from,
          target: payload.to,
        });
      }

      // 确保目标 agent 已启动
      try {
        await this.deps.agentManager.ensureAgent(payload.to);
        const targetAgent = this.deps.agentManager.getAgent(payload.to);
        if (targetAgent) {
          this.setupDialogueRoutingForAgent(targetAgent.ipc as AgentIpcLike, payload.to);
        }
      } catch (err) {
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: payload.to,
          to: payload.from,
          content: `[对话错误:AGENT_UNAVAILABLE] 目标 Agent "${payload.to}" 不可用: ${(err as Error).message}`,
          metadata: { isFinal: true, errorCode: 'AGENT_UNAVAILABLE' },
        };
        agentIpc.send('dialogue.reply', agentName, errorReply, payload.dialogueId);
        return;
      }

      // 推送前端事件
      const pending = this.deps.sessionManager.getPending(state!.correlationId);
      getEventBus().emit('dialogue.status', {
        dialogueId: payload.dialogueId,
        sessionId: pending?.sessionId ?? state!.sessionId,
        status: state!.currentRound === 0 ? 'started' : 'round_complete',
        from: payload.from,
        to: payload.to,
        round: state!.currentRound,
      });

      try {
        const reply = await router.sendMessage(payload);
        agentIpc.send('dialogue.reply', agentName, reply, payload.dialogueId);

        // §4.4.2: 记录一次成功的跨 agent 通信（更新预算计数）
        const budgetSessionId = (payload.context as Record<string, unknown>)?._sessionId as string | undefined;
        if (budgetSessionId) {
          this.recordInterAgentRequest(budgetSessionId);
        }
      } catch (err) {
        // 使用类型化错误码，让 Agent LLM 能区分超时/崩溃/不可用
        const { code, message } = errorToCode(err);
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: payload.to,
          to: payload.from,
          content: `[对话错误:${code}] ${message}`,
          metadata: { isFinal: true, errorCode: code },
        };
        agentIpc.send('dialogue.reply', agentName, errorReply, payload.dialogueId);

        getEventBus().emit('dialogue.status', {
          dialogueId: payload.dialogueId,
          sessionId: pending?.sessionId ?? state!.sessionId,
          status: 'ended',
          from: payload.from,
          to: payload.to,
          round: state!.currentRound,
        });
      }
    });

    logger.debug({ agentName }, 'kernel-router:dialogue routing registered for agent');
  }

  /**
   * 重置状态（用于测试或重连场景）
   */
  reset(): void {
    this.setupAgentIpcs = new WeakSet<object>();
    this.rateLimits.clear();
  }

  /**
   * L5: 处理 agent.discover IPC — 返回 Kernel Agent 注册表中的实时在线列表。
   *
   * Agent 调用 port.discover() 时发 IPC 到 Kernel，Kernel 从 AgentRegistry 查询
   * 当前已注册的 Agent 并附带在线状态（通过 AgentManager.isAlive 判断）。
   *
   * @param agentIpc 发起查询的 Agent IPC 通道
   * @param agentName 发起查询的 Agent 名称
   */
  setupDiscoverHandler(agentIpc: AgentIpcLike, agentName: string): void {
    agentIpc.onMessage('agent.discover', (msg: IpcMessage) => {
      try {
        // 从 AgentManager 获取当前在线的 agent 列表
        const agents = this.deps.agentManager.listAliveAgents();
        const result = agents
          .filter(a => a.name !== agentName && a.name !== 'brain') // 排除自己和 Brain
          .map(a => ({
            name: a.name,
            description: a.description ?? '',
            capabilities: a.capabilities ?? [],
            status: 'online' as const,
          }));
        agentIpc.send('agent.discover.reply', agentName, result, msg.correlationId);
      } catch (err) {
        logger.warn({ err, agentName }, 'agent.discover handler failed');
        agentIpc.send('agent.discover.reply', agentName, [], msg.correlationId);
      }
    });

    // §5.3.10: 订阅 EventBus 的 directory.changed 事件，转发给 agent 进程
    // agent 端 port.on('directory.changed', ...) 或 discover() 缓存可收到实时更新
    getEventBus().on('directory.changed', (payload: { added: Array<{ name: string; description: string; capabilities: string[]; status: 'online' | 'offline' }>; removed: string[] }) => {
      try {
        agentIpc.send('directory.changed' as import('../kernel/types.js').IpcMessageType, agentName, payload);
      } catch (err) {
        // Agent 可能已关闭，忽略发送失败
        logger.debug({ err: (err as Error).message, agentName }, 'directory.changed push to agent failed (likely closed)');
      }
    });
  }
}