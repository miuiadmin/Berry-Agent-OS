/**
 * AgentPort 薄封装 — 13.0 架构
 *
 * 设计目的：把 6 个原语翻译为底层 IPC 调用。Agent 开发者不需要理解 40+ 种 IPC 消息。
 *
 * 翻译表：
 * - request     → ipc.request('port.request', 'core', { target, type, payload, ... })
 * - send        → ipc.send('port.notify', 'core', { target, type, payload, ... })
 * - on          → ipc.onMessage(type, handler) — 直接映射
 * - discover    → ipc.request('port.discover', 'core', {})
 * - askUser     → ipc.request('port.ask_user', 'core', { question, options, timeoutMs })
 * - useTool     → 本地查 tool 注册表，safe 自动通过，dangerous 走 permission.request
 *
 * 关键设计：
 * - Agent 间 request 不直连目标 agent 的 IPC，仍然走 Kernel 中转
 * - Kernel 内部使用 DialogueRouter 实现多轮对话
 * - useTool 利用进程内工具注册表，避免跨进程调用开销
 */

import type { IpcChildChannel } from './ipc.js';
import { IpcMessage, IpcMessageType } from './types.js';
import type {
  AgentPort,
  PortMessage,
  PortHandler,
  AgentInfo,
  AskUserOptions,
  ToolResult,
} from '../contracts/agent-port.js';
import type { AgentName } from '../contracts/agents.js';
import { getToolByName } from '../tools/index.js';
import type { ToolDefinition } from '../tools/types.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('agent-port');

// === 危险工具分类（与 13.0 文档 11.6 一致） ===

/**
 * dangerous 工具列表：即使 scope 允许，也必须 user.confirm
 * 13.0 v1 简化为 hard-coded 列表，后续可移到 manifest 配置
 */
const DANGEROUS_TOOLS = new Set([
  'run_command',
  'http_request',
  'send_email',
  'send_message',
  'db_migrate',
  'db_write',
  'delete_file',
]);

// === 内部 payload 类型（与 Kernel 侧 handler 约定） ===

interface PortRequestPayload {
  target: string;
  type: string;
  payload: unknown;
  sessionId?: string;
  correlationId?: string;
  callDepth?: number;
}

interface PortNotifyPayload extends PortRequestPayload {}

interface PortRequestReplyPayload {
  type: string;
  payload: unknown;
  correlationId?: string;
}

interface PortAskUserPayload {
  question: string;
  options?: string[];
  timeoutMs?: number;
}

interface PortAskUserReplyPayload {
  reply: string;
}

interface PortDiscoverReplyPayload {
  agents: AgentInfo[];
}

interface PortDirectoryChangedPayload {
  agents: AgentInfo[];
}

interface PortUseToolResultPayload {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
  approvedBy?: 'auto' | 'scope' | 'brain' | 'user';
}

interface PortUseToolRequestPayload {
  name: string;
  input: unknown;
  dangerLevel: 'safe' | 'moderate' | 'dangerous';
}

/**
 * AgentPort 薄封装实现
 */
export class AgentPortImpl implements AgentPort {
  /** Agent 名（用于 from 字段自动填充） */
  private readonly agentName: string;

  /** Agent 目录缓存（Phase 3 完善） */
  private directoryCache: AgentInfo[] = [];

  /** 本地工具调用函数（可选注入 — 默认从全局注册表取） */
  private readonly toolLookup: (name: string) => ToolDefinition | undefined;

  constructor(
    /** 底层 IPC channel（agent 侧） */
    private readonly ipc: IpcChildChannel,
    options?: {
      agentName?: string;
      toolLookup?: (name: string) => ToolDefinition | undefined;
    },
  ) {
    this.agentName = options?.agentName ?? 'unknown';
    this.toolLookup = options?.toolLookup ?? getToolByName;

    // 监听目录推送（Phase 3 — Kernel 推送目录更新）
    this.ipc.onMessage('port.directory_changed', (msg: IpcMessage) => {
      const data = msg.payload as PortDirectoryChangedPayload;
      this.directoryCache = data.agents;
      logger.debug({ count: data.agents.length }, 'AgentPort 收到目录更新');
    });
  }

  // ─── 核心通信（3 个） ───

  /**
   * request — 发消息给另一个 agent，等回复
   * 内部走 Kernel 中转，Kernel 通过 DialogueRouter 路由到目标 agent
   */
  async request(
    msg: Omit<PortMessage, 'id' | 'from' | 'timestamp'>,
    timeoutMs = 30_000,
  ): Promise<PortMessage> {
    const payload: PortRequestPayload = {
      target: msg.to,
      type: msg.type,
      payload: msg.payload,
      sessionId: msg.sessionId,
      correlationId: msg.correlationId,
    };

    const result = await this.ipc.request<PortRequestReplyPayload>(
      'port.request',
      'core',
      payload,
      timeoutMs,
    );

    const reply = result.payload as PortRequestReplyPayload;
    return {
      id: result.id,
      type: reply.type,
      from: msg.to,
      to: this.agentName,
      sessionId: msg.sessionId,
      correlationId: result.correlationId,
      timestamp: typeof result.timestamp === 'number' ? result.timestamp : Date.now(),
      payload: reply.payload,
    };
  }

  /**
   * send — 发消息，不等回复
   */
  send(msg: Omit<PortMessage, 'id' | 'from' | 'timestamp'>): void {
    const payload: PortNotifyPayload = {
      target: msg.to,
      type: msg.type,
      payload: msg.payload,
      sessionId: msg.sessionId,
      correlationId: msg.correlationId,
    };
    this.ipc.send('port.notify', 'core', payload, msg.correlationId);
  }

  /**
   * on — 注册消息处理器
   *
   * 注意：当前实现不做通配符展开，直接映射到 ipc.onMessage。
   * 13.0 v1 简化：handler 写 'agent.question' 就只收 agent.question。
   * 通配符 'tool.*' 留待后续版本实现。
   */
  on(type: string, handler: PortHandler): () => void {
    this.ipc.onMessage(type as IpcMessageType, (raw: IpcMessage) => {
      const portMsg: PortMessage = {
        id: raw.id,
        type: raw.type,
        from: typeof raw.from === 'string' ? raw.from : 'unknown',
        to: typeof raw.to === 'string' ? raw.to : 'unknown',
        sessionId: undefined,
        correlationId: raw.correlationId,
        timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
        payload: raw.payload,
      };
      void Promise.resolve(handler(portMsg)).catch((err) => {
        logger.error({ err, type }, 'AgentPort handler 抛错');
      });
    });

    // 返回取消注册函数（简化版 — 当前 IpcChildChannel 不支持 unregister，
    // 所以只返回 noop；Phase 2 时补 unregister 能力）
    return () => {
      logger.debug({ type }, 'AgentPort handler 取消注册（no-op 简化版）');
    };
  }

  // ─── 便捷封装（基于前 3 个） ───

  /**
   * discover — 查询可用 agent 列表
   * 优先返回缓存，缓存为空时发 IPC 请求
   */
  async discover(): Promise<AgentInfo[]> {
    if (this.directoryCache.length > 0) {
      return this.directoryCache;
    }

    // request payload 为空（discover 不需要入参），response payload 是 PortDiscoverReplyPayload
    const result = await this.ipc.request<Record<string, never>>(
      'port.discover',
      'core',
      {},
      10_000,
    );
    const data = result.payload as PortDiscoverReplyPayload;
    this.directoryCache = data.agents;
    return data.agents;
  }

  /**
   * askUser — 经 Kernel → WS/CLI 路由到真实用户
   * 默认 5 分钟超时（用户可能想很久）
   */
  async askUser(question: string, options?: AskUserOptions): Promise<string> {
    const payload: PortAskUserPayload = {
      question,
      options: options?.options,
      timeoutMs: options?.timeoutMs ?? 300_000,
    };

    const result = await this.ipc.request<PortAskUserPayload>(
      'port.ask_user',
      'core',
      payload,
      payload.timeoutMs!,
    );
    const data = result.payload as PortAskUserReplyPayload;
    return data.reply;
  }

  /**
   * useTool — 本地执行 + 自动走权限流程
   *
   * 流程：
   * 1. 从本地 tool registry 找工具
   * 2. 检查 dangerLevel：
   *    - safe → 直接执行
   *    - moderate → 通过 ipc.request('permission.request') 走 Kernel 权限
   *    - dangerous → 必 user.confirm（即使 scope 允许）
   * 3. 返回工具执行结果
   */
  async useTool(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.toolLookup(name);
    if (!tool) {
      return {
        success: false,
        error: `工具未注册: ${name}`,
      };
    }

    // safe 工具：自动通过
    if (tool.dangerLevel === 'safe') {
      return await this.executeToolLocally(tool, input);
    }

    // moderate / dangerous：走 Kernel 权限
    try {
      // request payload 是 PortUseToolRequestPayload（含 name/input/dangerLevel）
      const result = await this.ipc.request<PortUseToolRequestPayload>(
        'port.use_tool',
        'core',
        { name, input, dangerLevel: tool.dangerLevel },
        60_000,
      );
      const data = result.payload as PortUseToolResultPayload;
      return {
        success: data.success,
        output: data.output,
        error: data.error,
        durationMs: data.durationMs,
        approvedBy: data.approvedBy,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 本地执行 safe 工具
   */
  private async executeToolLocally(
    tool: ToolDefinition,
    input: unknown,
  ): Promise<ToolResult> {
    const t0 = Date.now();
    try {
      const result = await tool.execute(input);
      return {
        success: !result.isError,
        output: result.content,
        durationMs: Date.now() - t0,
        approvedBy: 'auto',
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      };
    }
  }
}

/**
 * AgentPort 工厂函数 — 包装现有 IpcChildChannel
 *
 * @param ipc 底层 IPC channel
 * @param options 可选配置
 * @returns AgentPort 实例
 */
export function createAgentPort(
  ipc: IpcChildChannel,
  options?: {
    agentName?: string;
    toolLookup?: (name: string) => ToolDefinition | undefined;
  },
): AgentPort {
  return new AgentPortImpl(ipc, options);
}

// 内部类型导出（Kernel 侧 handler 需要）
export type {
  PortRequestPayload,
  PortNotifyPayload,
  PortRequestReplyPayload,
  PortAskUserPayload,
  PortAskUserReplyPayload,
  PortDiscoverReplyPayload,
  PortDirectoryChangedPayload,
  PortUseToolResultPayload,
};
