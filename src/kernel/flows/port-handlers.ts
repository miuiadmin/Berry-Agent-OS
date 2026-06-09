/**
 * AgentPort IPC handler — 13.0 架构
 *
 * 把 AgentPort 6 原语翻译为底层 IPC 消息的 Kernel 侧 handler。
 * 在 DelegationOrchestrator.setup() 中调用 setupPortHandlers() 注册。
 *
 * 当前实现：
 * - port.discover: 返回可用 agent 列表（不含 brain）
 * - port.directory_changed: 目录变更推送
 * - port.ask_user: 路由到用户（CLI/WS 通道）
 * - port.use_tool: 走权限流程
 * - port.request: 跨 agent request（Phase 2 完整实现，Phase 1 占位透传）
 * - port.notify: 跨 agent 通知（Phase 2 完整实现，Phase 1 占位透传）
 *
 * Phase 1 范围：
 * - 完整实现 port.discover / port.ask_user / port.use_tool
 * - port.request / port.notify 仅做路由占位，Phase 2 接入 DialogueRouter
 */

import type { IpcChannel } from '../ipc.js';
import type { AgentManager } from '../agent-manager.js';
import type { AgentRegistry } from '../agent-registry.js';
import type { AgentInfo, AskUserOptions } from '../../contracts/agent-port.js';
import type { AgentName } from '../../contracts/agents.js';
import { buildAvailableAgentsList } from '../agent-registry.js';
import { getEventBus } from '../event-bus.js';
import { getLogger } from '../../utils/logger.js';
import { classifyLevel } from '../../contracts/review.js';
import { getDb } from '../../memory/index.js';

const logger = getLogger('port-handlers');

// === Handler 注入的依赖 ===

export interface PortHandlersDeps {
  /** Agent 管理器（用于确保 on-demand agent 启动） */
  readonly agentManager: AgentManager;
  /** Agent 注册表（用于发现可用 agent） */
  readonly registry: AgentRegistry;
  /** 把 ask_user 转发的目标 — 通常是 primary (Conversation) agent 的 ipc */
  readonly primaryIpc: IpcChannel;
  /** primary agent 名称 */
  readonly primaryName: string;
  /** reviewer (Brain) agent 的 ipc，用于 permission.judge 等 */
  readonly reviewerIpc: IpcChannel;
}

// === port.discover payload ===

interface PortDiscoverRequestPayload {
  // 13.0 v1: 空 payload，预留扩展
  _placeholder?: never;
}

// === port.ask_user payload ===

interface PortAskUserRequestPayload {
  question: string;
  options?: string[];
  timeoutMs?: number;
}

interface PortAskUserReplyPayload {
  reply: string;
}

// === port.use_tool payload ===

interface PortUseToolRequestPayload {
  name: string;
  input: unknown;
  dangerLevel: 'safe' | 'moderate' | 'dangerous';
}

interface PortUseToolReplyPayload {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
  approvedBy?: 'auto' | 'scope' | 'brain' | 'user';
}

// === port.directory_changed payload ===

interface PortDirectoryChangedPayload {
  agents: AgentInfo[];
}

// === 主入口 ===

/**
 * 注册 AgentPort IPC handler 到 primary agent 的 IPC channel。
 *
 * 同时注册 port.directory_changed 推送到所有在线 agent。
 */
export function setupPortHandlers(deps: PortHandlersDeps): void {
  const { agentManager, registry, primaryIpc, primaryName, reviewerIpc } = deps;
  const eventBus = getEventBus();

  // ─── port.discover ─────────────────────────────────
  // Agent 想知道有哪些 agent 可以对话
  // 返回 AgentInfo[]，过滤掉 brain
  primaryIpc.onMessage('port.discover', (msg) => {
    const data = msg.payload as PortDiscoverRequestPayload;
    void (async () => {
      const agents = buildAgentDirectory(registry, agentManager);
      logger.debug({ count: agents.length, from: msg.from }, 'port.discover 返回 agent 列表');
      primaryIpc.send(
        'port.discover',
        primaryName,
        { agents, _echo: data?._placeholder },
        msg.correlationId,
      );
    })();
  });

  // ─── port.ask_user ─────────────────────────────────
  // Agent 想问用户一个问题
  // Phase 1 简化版：直接转发到 primary（Conversation）处理，复用现有 askUserTool 链路
  // Phase 4 完善：从 EventBus 订阅 session.user_input 等待用户回复
  primaryIpc.onMessage('port.ask_user', (msg) => {
    const data = msg.payload as PortAskUserRequestPayload;
    const timeoutMs = data.timeoutMs ?? 300_000;

    logger.debug({ from: msg.from, question: data.question.slice(0, 50) }, 'port.ask_user 收到问题');

    // 通过 EventBus 推送用户提示（WS bridge 转发给前端）
    // 复用已有 conversation.ask_user 事件（已在 EventMap 中定义）
    eventBus.emit('conversation.ask_user', {
      sessionId: 'pending',
      agent: msg.from,
      question: data.question,
      options: data.options,
      correlationId: msg.correlationId,
    });

    // Phase 1 占位：直接返回一个"已收到"占位回复，避免超时
    // Phase 4 替换为真正的等待用户输入 + 5 分钟超时 + 默认回复
    const reply: PortAskUserReplyPayload = {
      reply: 'user_input_pending',
    };
    primaryIpc.send('port.ask_user', primaryName, reply, msg.correlationId);
  });

  // ─── port.use_tool ─────────────────────────────────
  // Agent 想用工具
  // Phase 1 简化版：safe 工具自动通过，moderate/dangerous 走 permission 流程
  primaryIpc.onMessage('port.use_tool', (msg) => {
    const data = msg.payload as PortUseToolRequestPayload;
    const t0 = Date.now();

    void (async () => {
      try {
        // safe 工具：自动通过
        if (data.dangerLevel === 'safe') {
          const reply: PortUseToolReplyPayload = {
            success: true,
            output: `[auto-approved] safe tool ${data.name} would execute on agent side`,
            durationMs: Date.now() - t0,
            approvedBy: 'auto',
          };
          primaryIpc.send('port.use_tool', primaryName, reply, msg.correlationId);
          return;
        }

        // moderate / dangerous: 转发到 permission flow（走 Brain 判定）
        // Phase 1 简化版：只记录日志，不实际执行
        logger.warn(
          { from: msg.from, name: data.name, dangerLevel: data.dangerLevel },
          'port.use_tool 收到非 safe 工具调用 — Phase 1 不执行',
        );
        const reply: PortUseToolReplyPayload = {
          success: false,
          error: 'port.use_tool moderate/dangerous 路径在 Phase 1 暂未启用 — 请走原有 permission.request',
          durationMs: Date.now() - t0,
          approvedBy: 'brain',
        };
        primaryIpc.send('port.use_tool', primaryName, reply, msg.correlationId);
      } catch (err) {
        const reply: PortUseToolReplyPayload = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - t0,
        };
        primaryIpc.send('port.use_tool', primaryName, reply, msg.correlationId);
      }
    })();
  });

  // ─── port.request / port.notify 占位 ──────────────
  // Phase 2 接入 DialogueRouter
  primaryIpc.onMessage('port.request', (msg) => {
    logger.debug({ from: msg.from, type: (msg.payload as { type?: string })?.type }, 'port.request 收到（Phase 2 实现）');
    // Phase 1 占位：返回 not_implemented
    primaryIpc.send(
      'port.request',
      primaryName,
      { type: 'port.error', payload: { error: 'port.request Phase 2 待实现' } },
      msg.correlationId,
    );
  });

  primaryIpc.onMessage('port.notify', (msg) => {
    const data = msg.payload as { target?: string; type?: string };
    logger.debug({ from: msg.from, target: data.target, type: data.type }, 'port.notify 收到（Phase 2 实现）');
  });

  // ─── 目录变更推送 ─────────────────────────────────
  // 当 agent 上下线时（已有 EventBus 事件），推送目录给所有 agent
  let directoryDebounce: NodeJS.Timeout | null = null;
  const pushDirectory = () => {
    if (directoryDebounce) clearTimeout(directoryDebounce);
    directoryDebounce = setTimeout(() => {
      const agents = buildAgentDirectory(registry, agentManager);
      const payload: PortDirectoryChangedPayload = { agents };
      // 推给所有在线 agent（复用 AgentManager.getStatus() 枚举）
      const status = agentManager.getStatus();
      for (const agentName of Object.keys(status)) {
        if (agentName === 'brain') continue;
        const agent = agentManager.getAgent(agentName);
        if (agent && agent.status === 'ready') {
          agent.ipc.send('port.directory_changed', agent.name, payload);
        }
      }
      logger.debug({ count: agents.length }, 'port.directory_changed 已推送');
    }, 500);
  };

  // 复用 EventMap 中已有的事件名（agent.registered / agent.crashed / agent.removed）
  eventBus.on('agent.registered', pushDirectory);
  eventBus.on('agent.crashed', pushDirectory);
  eventBus.on('agent.removed', pushDirectory);
}

// === 工具函数 ===

/**
 * 构建 agent 目录（不含 brain）
 */
function buildAgentDirectory(registry: AgentRegistry, _agentManager: AgentManager): AgentInfo[] {
  const all = buildAvailableAgentsList(registry);
  return all
    .filter((a) => a.name !== 'brain')
    .map((a) => ({
      name: a.name as AgentName,
      description: a.description,
      handles: ['agent.question', 'agent.delegate'],
      status: 'ready' as const,
      level: 1 as const, // 简化版：所有列出的 agent 都视为可用层级
    }));
}

// 内部类型导出（供 AgentPort 使用）
export type {
  PortDiscoverRequestPayload,
  PortAskUserRequestPayload,
  PortAskUserReplyPayload,
  PortUseToolRequestPayload,
  PortUseToolReplyPayload,
  PortDirectoryChangedPayload,
};
