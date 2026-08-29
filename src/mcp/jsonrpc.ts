/**
 * L3 mcp — 行帧 JSON-RPC 桥（契约篇 §6.6 手写最小桥的核心件）。
 *
 * 职责收窄为纯协议层：id 关联表（request ↔ pending promise）+ 行分发。
 * 不持有子进程——流对由调用方注入（组合根 spawnServer 闭包产物），
 * 单元测试用 PassThrough 流对即可全协议面覆盖（零子进程依赖）。
 *
 * 协议行为（契约篇 §6.6 transport 条）：
 * - 服务器→客户端**请求**：ping 照答（result 空对象——服务器探活宿主）；
 *   sampling/elicitation 等其余请求一律回 -32601 MethodNotFound
 *   （第一刀 stdio-only 拒答扩展 capability）；
 * - 服务器**通知**忽略（tools/list_changed 不热刷——改配置走 /reload）；
 * - 请求超时按调用方给的码拒绝（connect 期 MCP_CONNECT_FAILED /
 *   调用期 TOOL_TIMEOUT——同桥两码，调用方定身份）。
 */

import { AppError, LSP_CONNECT_FAILED, MCP_CONNECT_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';

/** JSON-RPC 请求超时缺省拒绝码（mcp/lsp 两桥共用本类——lsp 注入 LSP_CONNECT_FAILED） */
export type JsonRpcTimeoutCode = typeof MCP_CONNECT_FAILED | typeof TOOL_TIMEOUT | typeof LSP_CONNECT_FAILED;

/** 单条 JSON-RPC 消息的宽松形态（分发按字段在场性判别，不做全量校验） */
interface JsonRpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** pending 请求簿记（id → 结算回调 + 超时计时器） */
interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 桥构造选项 */
export interface JsonRpcConnectionOptions {
  /** 写一行（调用方接子进程 stdin——行帧 = 单行一个 JSON 对象） */
  writeLine: (line: string) => void;
  /** 请求超时缺省毫秒（逐请求可覆盖） */
  defaultTimeoutMs?: number;
  /** 超时缺省错误码（connect 期与调用期分码——见上） */
  defaultTimeoutCode?: JsonRpcTimeoutCode;
  /** 协议杂音出口（服务器通知等——debug 级，诊断可见不进上下文） */
  onNoise?: (message: string) => void;
  /**
   * 通知消费钩子（LSP 复用桥时声明——2026-08-30 LSP 刀加法面）：在场则全部
   * 服务器通知改派本口（method+params 原样），消费方自过滤关心的方法名；
   * 不在场行为零变化（通知仍走 onNoise 杂音口——mcp 现状语义）
   */
  onNotification?: (method: string, params: unknown) => void;
}

/**
 * 行帧 JSON-RPC 连接（纯协议层）。
 *
 * 生命周期：构造即用；`close()` 后全部 pending 拒绝、新请求拒绝——
 * 连接的物理载体（子进程）由调用方管理，close 只结清簿记。
 */
export class JsonRpcConnection {
  /** id 关联表：请求 id → pending 结算（响应/超时/关闭三路结算） */
  private readonly pending = new Map<number, PendingEntry>();
  /** 自增请求 id（JSON-RPC 数字 id——服务器回显原值） */
  private nextId = 1;
  /** 关闭旗（close 后桥死——新请求/入线一律拒绝/忽略） */
  private closed = false;
  private readonly opts: JsonRpcConnectionOptions;

  constructor(opts: JsonRpcConnectionOptions) {
    this.opts = opts;
  }

  /** 结清全部 pending 并封桥（子进程退出/主动关停时调用——参数即拒绝理由；拒绝码随注入的 defaultTimeoutCode——lsp 桥即 LSP_CONNECT_FAILED） */
  close(reason: string): void {
    this.closed = true;
    const code = this.opts.defaultTimeoutCode ?? MCP_CONNECT_FAILED;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AppError(code, reason));
    }
    this.pending.clear();
  }

  /** 是否已关（调用方竞态护栏——close 后不再发新请求） */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 发一条请求并等响应。
   * @param method JSON-RPC 方法名（initialize / tools/list / tools/call / ping）
   * @param params 参数对象（无参传 undefined——不发 params 字段）
   * @param opts 超时毫秒与超时码覆盖（connect 期 MCP_CONNECT_FAILED、调用期 TOOL_TIMEOUT）
   */
  request(
    method: string,
    params?: object,
    opts?: { timeoutMs?: number; timeoutCode?: JsonRpcTimeoutCode },
  ): Promise<unknown> {
    if (this.closed) {
      const code = this.opts.defaultTimeoutCode ?? MCP_CONNECT_FAILED;
      return Promise.reject(new AppError(code, `连接已关闭，请求被拒：${method}`));
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000;
    const timeoutCode = opts?.timeoutCode ?? this.opts.defaultTimeoutCode ?? TOOL_TIMEOUT;
    return new Promise<unknown>((resolve, reject) => {
      /** 双结算闸：超时与响应竞速，先到先结算 */
      let settled = false;
      const entry: PendingEntry = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          resolve(value);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(err);
        },
        timer: setTimeout(() => {
          // 超时腿：pending 簿记由 reject 内清（双结算闸防响应后到误清）
          entry.reject(new AppError(timeoutCode, `JSON-RPC 请求超时（>${timeoutMs}ms）：${method}`));
        }, timeoutMs),
      };
      this.pending.set(id, entry);
      // 请求体：id 请求必有 jsonrpc 2.0 与 method；params 只在有值时发
      const frame: Record<string, unknown> = { jsonrpc: '2.0', id, method };
      if (params !== undefined) frame.params = params;
      this.opts.writeLine(JSON.stringify(frame));
    });
  }

  /** 发一条通知（无 id——不等待响应；initialized 告别用） */
  notify(method: string, params?: object): void {
    if (this.closed) return;
    const frame: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    this.opts.writeLine(JSON.stringify(frame));
  }

  /**
   * 喂一行（调用方把子进程 stdout 按行切好送进来）。
   * 分发：id+result/error = 响应（结 pending）；method+id = 服务器请求（回
   * -32601）；method 无 id = 通知（忽略 + 杂音出口）。
   */
  feed(line: string): void {
    if (this.closed || line.trim() === '') return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.opts.onNoise?.(`非 JSON 行（丢弃）：${line.slice(0, 120)}`);
      return;
    }
    // 响应腿：有 id 且带 result 或 error
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id as number);
      if (entry === undefined) {
        this.opts.onNoise?.(`未知 id 响应（丢弃）：${String(msg.id)}`);
        return;
      }
      if (msg.error !== undefined) {
        // 服务器回的 JSON-RPC error 是**数据不是宿主故障**（契约篇 §6.6）——
        // 桥以普通 Error 上抛（身份归调用方：connect 期包 MCP_CONNECT_FAILED、
        // 调用期转工具结果 error），不带 AppError 码防误升格
        entry.reject(new Error(`服务器错误 ${msg.error.code ?? '?'}：${msg.error.message ?? ''}`.trim()));
        return;
      }
      entry.resolve(msg.result);
      return;
    }
    // 服务器请求腿：ping 照答（契约篇 §6.6 ping 语义——服务器探活宿主，result 空对象）；
    // 其余（sampling/elicitation…）一律 -32601 MethodNotFound（第一刀 stdio-only
    // 拒答扩展 capability）
    if (msg.method !== undefined && msg.id !== undefined) {
      if (msg.method === 'ping') {
        this.opts.writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        return;
      }
      const frame = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
      this.opts.writeLine(JSON.stringify(frame));
      return;
    }
    // 通知腿：onNotification 在场改派消费口（LSP publishDiagnostics——本类
    // 2026-08-30 LSP 刀加法面）；不在场维持 mcp 现状（杂音口忽略）
    if (msg.method !== undefined) {
      if (this.opts.onNotification !== undefined) {
        this.opts.onNotification(msg.method, msg.params);
      } else {
        this.opts.onNoise?.(`服务器通知（忽略）：${msg.method}`);
      }
    }
  }
}
