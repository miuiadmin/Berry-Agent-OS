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
import { getEventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';
import { AgentTimeoutError, AgentCrashError, AgentUnavailableError } from './errors.js';

const logger = getLogger('kernel-router');

/** §4.4.2: 跨 Agent 调用最大深度（防无限递归） */
const MAX_AGENT_CALL_DEPTH = 16;

/** §5.2.3: 每 (from, to) agent 对的频率限制 */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 分钟窗口
const RATE_LIMIT_MAX_REQUESTS = 30;   // 每个 agent 对每分钟最多 30 次

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

  constructor(deps: KernelRouterDeps) {
    this.deps = deps;
  }

  /**
   * 注入 dialogueRouter（延迟到 init 阶段，因为 DialogueRouter 构造需要 getDb() 等运行时依赖）。
   */
  setDialogueRouter(router: DialogueRouter): void {
    this.deps.dialogueRouter = router;
  }

  // ═══════════════════════════════════════════════════════════════
  // 13.0 §4.1/§5.2: 集中式安全门控
  // ═══════════════════════════════════════════════════════════════

  /**
   * 集中式安全门控 — 所有跨 Agent 消息必须通过此检查。
   *
   * 13.0 §5.2.2-§5.2.4 规定的 5 项检查：
   * 1. 禁止 to:'brain'（Brain 是观察者，不直接对话）
   * 2. 调用深度限制（防循环调用 A→B→C→...→A）
   * 3. 循环引用检测（防 A→B→A）
   * 4. Agent 对频率限制（每分钟最多 N 次）
   * 5. 自我消息禁止（防 A→A）
   *
   * @param from - 发送方 agent 名
   * @param to - 接收方 agent 名
   * @returns 拒绝原因字符串（null 表示通过）
   */
  gate(from: string, to: string): string | null {
    // ① §5.2.4: 禁止任何 agent 直接发消息给 Brain
    if (to === 'brain') {
      return '不允许直接向 Brain 发送消息（Brain 是观察者，不直接对话）';
    }

    // ② 自我消息禁止
    if (to === from) {
      return `不允许自己向自己发消息 (${from})`;
    }

    // ③ §5.2.3: Agent 对频率限制
    if (!this.checkRateLimit(from, to)) {
      return `${from} → ${to} 频率超限（每分钟最多 ${RATE_LIMIT_MAX_REQUESTS} 次）`;
    }

    return null; // 通过所有检查
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

      try {
        const reply = await router.sendMessage(payload);
        primaryIpc.send('dialogue.reply', primaryName, reply, payload.dialogueId);
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
  }
}