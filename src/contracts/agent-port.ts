/**
 * AgentPort — 13.0 灵魂版统一 Agent 间通信契约。
 *
 * 设计目标：
 * - 6 个原语覆盖 Agent 间所有通信模式
 * - 实现 100% 封装现有 dialogue.send/reply IPC，零新协议
 * - 安全门禁：禁止直接发消息给 Brain（to: 'brain' 在实现层拒绝）
 *
 * 参见：设计文档/19-架构升级-13.0.md §19.2 / §19.6
 */

import type { ToolResult } from '../tools/types.js';
import { FORBIDDEN_TARGETS, DEFAULT_REQUEST_TIMEOUT_MS } from './agent-port-constants.js';

// ─────────────────────────────────────────────────────────────────
// 消息类型
// ─────────────────────────────────────────────────────────────────

/** Agent 间通信的消息载荷 */
export interface PortMessage {
  /** 目标 Agent 名称（禁止 'brain'，见 FORBIDDEN_TARGETS） */
  to: string;
  /** 消息内容（纯文本或结构化 JSON） */
  content: string;
  /** 附加上下文（文件路径、查询参数等） */
  context?: Record<string, unknown>;
}

/** PortMessage 顶层元数据 */
export interface PortMessageMetadata {
  /** 自定义超时（ms），覆盖 request() 第二个参数 */
  timeoutMs?: number;
  /** 期望的最低置信度（0-1），低于此值的回复会被标记 needsClarification */
  confidenceFloor?: number;
}

/** request() 返回的回复 */
export interface PortReply {
  /** 回复方 Agent 名称 */
  from: string;
  /** 回复内容 */
  content: string;
  /** 回复方附加的元数据（对应 dialogue.reply 的 DialogueMetadata） */
  metadata?: PortReplyMetadata;
}

/** 回复方附加的元数据 */
export interface PortReplyMetadata {
  /** 是否最终结果 */
  isFinal?: boolean;
  /** 是否需要澄清 */
  needsClarification?: boolean;
  /** 置信度 0-1 */
  confidence?: number;
}

// ─────────────────────────────────────────────────────────────────
// Agent 发现
// ─────────────────────────────────────────────────────────────────

/** 可用 Agent 的描述信息（discover() 返回值） */
export interface AgentInfo {
  /** Agent 名称（如 'memory', 'code', 'conversation'） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 该 Agent 支持的能力标签 */
  capabilities: string[];
  /**
   * L5: Agent 运行时状态。
   * - 'online': 进程已注册到 AgentManager 且 ready
   * - 'offline': 已安装但未启动 / 启动失败
   *
   * 不传时默认为 'online'（向后兼容）。
   */
  status?: 'online' | 'offline';
}

// ─────────────────────────────────────────────────────────────────
// askUser 选项
// ─────────────────────────────────────────────────────────────────

/** 向用户提问时的选项 */
export interface PortAskUserOptions {
  /** 选项列表（如 ['yes', 'no']），Agent 可以从中选择 */
  options?: string[];
  /** 附加上下文（帮助用户理解为什么被问） */
  context?: string;
  /** 超时时间（毫秒），默认 120000 */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────
// AgentPort 接口（6 原语）
// ─────────────────────────────────────────────────────────────────

/**
 * Agent 间统一通信端口。
 *
 * 核心通信（3 个）：
 * - request: 请求-响应，等待回复（封装 dialogue.send → dialogue.reply）
 * - send: 即发即弃通知
 * - discover: 发现可用 Agent（不暴露 brain）
 *
 * 便捷封装（3 个）：
 * - askUser: 向用户提问（委托 ModuleAgentContext.askUser）
 * - useTool: 使用已注册工具（走 ToolRegistry）
 */
export interface AgentPort {
  /**
   * 请求-响应：发送消息并等待目标 Agent 回复。
   * 内部封装 dialogue.send → dialogue.reply IPC。
   *
   * @param msg 消息载荷（to 禁止为 'brain'）
   * @param timeoutMs 超时毫秒，默认 60000（与 DIALOGUE_DEFAULTS.replyTimeoutMs 一致）
   * @throws Error 当 to='brain'、目标不可用、超时、对话被中断时
   */
  request(msg: PortMessage, timeoutMs?: number): Promise<PortReply>;

  /**
   * 即发即弃通知。不等待回复，不抛超时错误。
   * 适用于日志、状态推送等场景。
   *
   * @param msg 消息载荷（to 禁止为 'brain'）
   */
  send(msg: PortMessage): void;

  /**
   * 发现可用 Agent 列表。
   * 自动过滤掉 brain（Agent 不应知道 Brain 的存在）。
   */
  discover(): Promise<AgentInfo[]>;

  /**
   * 向用户提问，等待回复。
   * 委托给 ModuleAgentContext.askUser（已有的 agent.ask_user / agent.user_reply 协议）。
   *
   * @param question 问题文本
   * @param opts 选项（选项列表、超时等）
   */
  askUser(question: string, opts?: PortAskUserOptions): Promise<string>;

  /**
   * 使用当前进程已注册的工具。
   * 直接调用 ToolRegistry.execute，不走 IPC。
   *
   * @param name 工具名称
   * @param input 工具输入
   * @returns 工具执行结果
   */
  useTool(name: string, input: unknown): Promise<ToolResult>;
}

// ─────────────────────────────────────────────────────────────────
// Re-exports（实现层需要的常量在 agent-port-constants.ts）
// ─────────────────────────────────────────────────────────────────

export { FORBIDDEN_TARGETS, DEFAULT_REQUEST_TIMEOUT_MS };
