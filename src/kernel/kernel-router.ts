/**
 * KernelRouter — 13.0 灵魂版 Kernel 层路由抽象。
 *
 * 设计目标：
 * - 从 DelegationOrchestrator 抽取纯路由逻辑（dialogue send/reply + 跨 Agent 消息分发）
 * - 让 Orchestrator 专注任务管理 / 委托 / 路由决策
 * - 单一职责：KernelRouter = "消息从 A 路由到 B"，Orchestrator = "业务编排"
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

const logger = getLogger('kernel-router');

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

  constructor(deps: KernelRouterDeps) {
    this.deps = deps;
  }

  /**
   * 注入 dialogueRouter（延迟到 init 阶段，因为 DialogueRouter 构造需要 getDb() 等运行时依赖）。
   * 设计：避免 KernelRouter 与 DialogueRouter 的循环依赖，让 Orchestrator 在创建 DialogueRouter 后注入。
   */
  setDialogueRouter(router: DialogueRouter): void {
    this.deps.dialogueRouter = router;
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
        // 超时或错误 → 构造错误 reply
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: payload.to,
          to: payload.from,
          content: `[对话错误] ${(err as Error).message}`,
          metadata: { isFinal: true },
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

    // 13.0 AgentPort: Module Agent 主动发起的 dialogue.send 路由
    agentIpc.onMessage('dialogue.send', async (msg: IpcMessage) => {
      const payload = msg.payload as import('../contracts/dialogue.js').DialogueMessagePayload;

      // 安全门禁：拒绝 to='brain'
      if (payload.to === 'brain') {
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: 'core',
          to: payload.from,
          content: '[对话错误] 不允许直接向 Brain 发送消息',
          metadata: { isFinal: true },
        };
        agentIpc.send('dialogue.reply', agentName, errorReply, payload.dialogueId);
        return;
      }

      // 防递归：self-messaging
      if (payload.to === agentName) {
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: 'core',
          to: payload.from,
          content: `[对话错误] 不允许自己向自己发消息 (${agentName})`,
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
          content: `[对话错误] 目标 Agent "${payload.to}" 不可用: ${(err as Error).message}`,
          metadata: { isFinal: true },
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
        const errorReply: import('../contracts/dialogue.js').DialogueMessagePayload = {
          dialogueId: payload.dialogueId,
          sequenceNumber: payload.sequenceNumber + 1,
          from: payload.to,
          to: payload.from,
          content: `[对话错误] ${(err as Error).message}`,
          metadata: { isFinal: true },
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
  }
}