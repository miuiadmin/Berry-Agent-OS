/**
 * Agent 通信端口契约 — 13.0 架构的核心抽象
 *
 * 设计目的：把 Agent 看到的通信面从 40+ 种 IPC 消息类型收束为 6 个原语。
 * Agent 开发者只需要理解这一层，不需要关心底层 IPC/Dialogue/Task 三套协议。
 *
 * 6 个原语：
 * - 核心通信（3 个）：request / send / on
 * - 便捷封装（3 个）：discover / askUser / useTool
 *
 * 注意：Agent 不能直接发消息给 Brain。
 * Brain 是监督者，不参与对话。Agent 间互相提问。
 */

import type { AgentName } from './agents.js';

// === 消息结构 ===

/**
 * Agent 间消息 — 系统中唯一的跨 agent 通信单元
 *
 * 字段说明：
 * - id: 消息唯一标识（自动生成）
 * - type: 点分路径消息类型，如 'agent.question' / 'tool.completed'
 * - from: 发送方 agent 名（自动填充）
 * - to: 接收方：agent 名 / "kernel"
 * - sessionId: 所属会话 id
 * - correlationId: 串联 request ↔ response
 * - traceId: 链路追踪 id
 * - timestamp: 消息创建时间戳
 * - payload: 消息内容（类型由 type 决定）
 */
export interface PortMessage {
  id: string;
  type: string;
  from: string;
  to: string;
  sessionId?: string;
  correlationId?: string;
  traceId?: string;
  timestamp: number;
  payload: unknown;
}

// === Agent 目录 ===

/**
 * Agent 目录条目 — 描述一个可对话的 agent
 */
export interface AgentInfo {
  /** Agent 名（唯一标识） */
  name: AgentName;
  /** Agent 能力描述（注入到 system prompt） */
  description: string;
  /** 支持的消息类型列表（如 ['agent.question', 'agent.delegate']） */
  handles: string[];
  /** 当前状态 */
  status: 'ready' | 'busy' | 'offline';
  /** Agent 层级（1=常驻, 2=按需, 3=动态） */
  level: 1 | 2 | 3;
}

// === 工具调用结果 ===

/**
 * 工具调用结果
 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容（成功时为 string，失败时可能为 undefined） */
  output?: unknown;
  /** 错误信息（失败时） */
  error?: string;
  /** 工具执行耗时（毫秒） */
  durationMs?: number;
  /** 审批来源（auto=自动通过, scope=scope 预授权, brain=Brain 判定, user=用户确认） */
  approvedBy?: 'auto' | 'scope' | 'brain' | 'user';
}

// === 问用户选项 ===

/**
 * askUser 选项
 */
export interface AskUserOptions {
  /** 给用户的多选项 */
  options?: string[];
  /** 超时时间（毫秒，默认 5 分钟，用户可能想很久） */
  timeoutMs?: number;
}

// === 消息处理器 ===

/**
 * 消息处理器签名
 */
export type PortHandler = (msg: PortMessage) => Promise<void> | void;

// === AgentPort 接口 ===

/**
 * Agent 通信端口 — 每个 agent 启动时获得一个
 */
export interface AgentPort {
  // ─── 核心通信（3 个） ───

  /**
   * 提问：发消息给另一个 agent，等回复
   *
   * @param msg 消息内容（to, type, payload 必填）
   * @param timeoutMs 超时时间（毫秒，默认 30s）
   * @returns 目标 agent 的回复消息
   */
  request(msg: Omit<PortMessage, 'id' | 'from' | 'timestamp'>, timeoutMs?: number): Promise<PortMessage>;

  /**
   * 通知：发消息，不等回复
   *
   * @param msg 消息内容
   */
  send(msg: Omit<PortMessage, 'id' | 'from' | 'timestamp'>): void;

  /**
   * 接收：注册消息处理器
   *
   * 支持通配符 'tool.*'：注册 tool.started, tool.completed, tool.failed 等所有 tool.* 消息
   *
   * @param type 消息类型或通配符模式
   * @param handler 处理器
   * @returns 取消注册的函数
   */
  on(type: string, handler: PortHandler): () => void;

  // ─── 便捷封装（基于前 3 个） ───

  /**
   * 目录：查看有哪些 agent 可以对话
   *
   * 注意：目录中不包含 Brain。Brain 不是对话目标。
   *
   * @returns 可用 agent 列表
   */
  discover(): Promise<AgentInfo[]>;

  /**
   * 问用户：经 kernel → WS/CLI 路由到真实用户
   *
   * @param question 问题内容
   * @param options 选项（可选）
   * @returns 用户回复
   */
  askUser(question: string, options?: AskUserOptions): Promise<string>;

  /**
   * 用工具：本地执行 + 自动走权限流程
   *
   * 内部流程：
   * 1. 检查本地 scope 缓存
   * 2. safe 工具自动通过，dangerous 工具走 permission.request
   * 3. Kernel → Brain 判定（高风险再加 user.confirm）
   * 4. 批准后执行工具
   *
   * @param name 工具名
   * @param input 工具输入
   * @returns 工具执行结果
   */
  useTool(name: string, input: unknown): Promise<ToolResult>;
}
