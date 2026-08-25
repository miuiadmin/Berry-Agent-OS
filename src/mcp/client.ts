/**
 * L3 mcp — 单服务器连接生命周期（握手 → 发现 → 调用 → 关停）。
 *
 * 物理载体（子进程）经注入的 spawnServer 闭包取得——spawn 组装上提组合根
 * （app/mcp-spawn.ts：buildChildEnv 白名单 + env set 层 + detached 建组 +
 * cwd 钉 dataDir），本模块零 exec 知识（内核篇席 14 边表 [contracts, context]）。
 *
 * 语义对应契约篇 §6.6：
 * - connect 期一切失败（相对路径/未启动/握手失败/启动超时）= MCP_CONNECT_FAILED；
 * - 调用期超时 = TOOL_TIMEOUT（子进程不杀——轮九实证后续调用健康）；
 * - 服务器 JSON-RPC error 与运行期退出 = 调用方转工具结果 error（数据不是宿主故障）；
 * - 关停序 = stdin.end() 协议化告别 → 宽限 → killTree 树杀（轮九实证优雅）。
 */

import { createInterface } from 'node:readline';
import { AppError, MCP_CONNECT_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import type { PluginLogger } from '../contracts/plugin.js';
import { JsonRpcConnection } from './jsonrpc.js';
import type { McpCallResult, McpRemoteTool, McpServerConfig } from './types.js';

/** 宿主已知的最新协议版本（宽容客户端：服务器回什么版本都接受不强校验） */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** 启动握手缺省超时（毫秒 = 10s——契约篇 §6.6） */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
/** 逐调用缺省超时（毫秒 = 60s——契约篇 §6.6） */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/** 关停宽限（毫秒）——stdin 告别后等子进程自退的耐心，到点树杀 */
export const DISPOSE_GRACE_MS = 3_000;

/**
 * 子进程最小结构面（ChildProcess 的结构子集——注入面收窄，测试可用假流对）。
 * 组合根闭包返回真 ChildProcess；本模块只见这四件。
 */
export interface SpawnedChild {
  /** 子进程 pid（登记簿/树杀用；可能 undefined——已退出的极端竞态） */
  readonly pid?: number;
  /** stdin：行帧写面（write 追加换行由桥调用方负责——本面只要求可写可关） */
  readonly stdin: { write(chunk: string): boolean; end(): void; on(ev: 'error', cb: (err: Error) => void): void };
  /** stdout：行帧读面（readline 切行——本面只要求可读流） */
  readonly stdout: NodeJS.ReadableStream;
  /** stderr：诊断读面（MCP 惯例日志走 stderr——debug 落盘不进上下文） */
  readonly stderr: { on(ev: 'data', cb: (chunk: Buffer | string) => void): void };
  /** 退出事件订阅（close = 流已 flush 的真死信号——运行期 exit 语义的锚点） */
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
}

/** 连接期依赖注入束（组合根闭包——本模块不 import exec/child_process） */
export interface McpConnectDeps {
  /** spawn 组装（app/mcp-spawn.ts：env 白名单 + detached 建组 + cwd=dataDir） */
  readonly spawnServer: (config: McpServerConfig) => Promise<SpawnedChild>;
  /** 树杀原语（exec killTree 经组合根注入） */
  readonly killTree: (pid: number, alive: () => boolean) => void;
  /** 诊断日志（stderr 行/通知杂音——debug 级） */
  readonly logger: Pick<PluginLogger, 'debug' | 'warn'>;
}

/** 连接后的稳定面（plugin 层消费：发现/调用/关停/退出订阅） */
export interface McpServerConnection {
  /** 服务器名（诊断归因） */
  readonly server: string;
  /** 子进程 pid（登记簿键；spawn 竞态下可能 undefined） */
  readonly childPid: number | undefined;
  /** 发现远端工具（initialize 握手 + tools/list 跟 nextCursor 至尽——契约篇 §6.6） */
  discover(): Promise<McpRemoteTool[]>;
  /** 调用远端工具（超时 TOOL_TIMEOUT；服务器错误/连接死 = 抛 Error 由调用方转结果 error） */
  call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError: boolean }>;
  /** 订阅运行期退出（close 事件——plugin 撤工具 + notify 的锚点）；返回退订 */
  onExit(cb: (reason: string) => void): () => void;
  /** 协议化关停（stdin 告别 → 宽限 → 树杀；幂等） */
  dispose(): Promise<void>;
}

/**
 * 建立一条服务器连接（spawn → initialize → initialized 通知——不含发现；
 * discover 独立成步，件层先并发起全部连接再统一过全局阈值决定注册形态）。
 *
 * @throws AppError(MCP_CONNECT_FAILED) connect 期一码收口（相对路径/未启动/握手失败/超时）
 */
export async function connectMcpServer(
  server: string,
  config: McpServerConfig,
  deps: McpConnectDeps,
): Promise<McpServerConnection> {
  // v1 只认绝对路径 command（相对路径在花钱 spawn 前拦下）
  if (!config.command.startsWith('/')) {
    throw new AppError(
      MCP_CONNECT_FAILED,
      `服务器 ${server} 的 command 必须是绝对路径（v1 不解析相对路径/npx）：${config.command}`,
    );
  }
  const startupTimeoutMs = (config.startup_timeout_sec ?? DEFAULT_STARTUP_TIMEOUT_MS / 1000) * 1000;
  let child: SpawnedChild;
  try {
    child = await deps.spawnServer(config);
  } catch (err) {
    // spawn 失败（ENOENT/EACCES…）：一码收口，cause 保真
    throw new AppError(MCP_CONNECT_FAILED, `服务器 ${server} 子进程未启动：${describeCause(err)}`, { cause: err });
  }

  const exitListeners = new Set<(reason: string) => void>();
  let disposed = false; // dispose 幂等闸（effect 回卷与运行期退出可能竞速）
  let closeReason: string | undefined; // 首次 close 的归因（后续重复 close 用首因）

  const conn = new JsonRpcConnection({
    // 行帧纪律：单行一个 JSON 对象——write 必须追加换行（协议物理形态）
    writeLine: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onNoise: (msg) => deps.logger.debug(`mcp[${server}] ${msg}`),
  });

  // stdout 行帧分发：readline 切行喂桥
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => conn.feed(line));

  // stderr：MCP 惯例日志走 stderr——debug 落盘不进上下文（契约篇 §6.6 transport 条）
  child.stderr.on('data', (chunk: Buffer | string) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') deps.logger.debug(`mcp[${server}] stderr: ${line.slice(0, 300)}`);
    }
  });

  /** close 单次结算：结清桥 pending、fire 退出监听（运行期 exit 语义的锚点） */
  child.on('close', (code, signal) => {
    closeReason ??= `服务器 ${server} 子进程退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}）`;
    conn.close(closeReason);
    for (const cb of [...exitListeners]) cb(closeReason);
  });
  child.stdin.on('error', () => undefined); // 告别后服务器不读 stdin 的 EPIPE 不算失败

  try {
    // initialize 握手（协议宽容：回什么 protocolVersion 都接受）+ initialized 通知
    await conn.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mcp-bridge', version: '1.0.0' },
      },
      { timeoutMs: startupTimeoutMs, timeoutCode: MCP_CONNECT_FAILED },
    );
    conn.notify('notifications/initialized');
  } catch (err) {
    // 握手失败/超时：响亮杀进程树不留挂起（契约篇 §6.6 连接语义条）；
    // alive 恒 true = 无条件树杀（killpg 打在已死组上抛 ESRCH 被内吞——安全）
    deps.killTree(child.pid ?? -1, () => true);
    if (err instanceof AppError) throw err;
    throw new AppError(MCP_CONNECT_FAILED, `服务器 ${server} 握手失败：${describeCause(err)}`, { cause: err });
  }

  const toolTimeoutMs = () => (config.tool_timeout_sec ?? DEFAULT_TOOL_TIMEOUT_MS / 1000) * 1000;

  return {
    server,
    childPid: child.pid,
    async discover(): Promise<McpRemoteTool[]> {
      // tools/list 分页：nextCursor 至尽（不跟即静默丢工具——冷读 #6）
      const tools: McpRemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = (await conn.request('tools/list', cursor === undefined ? undefined : { cursor }, {
          timeoutMs: startupTimeoutMs,
          timeoutCode: MCP_CONNECT_FAILED,
        })) as { tools?: McpRemoteTool[]; nextCursor?: string };
        tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    async call(tool, args, timeoutMs) {
      const result = (await conn.request(
        'tools/call',
        { name: tool, arguments: args },
        { timeoutMs: timeoutMs || toolTimeoutMs(), timeoutCode: TOOL_TIMEOUT },
      )) as McpCallResult;
      // 内容映射：text 直取；非文本块计数注记（v1 只过文本——图片等后续刀再议）
      const texts: string[] = [];
      let dropped = 0;
      for (const part of result.content ?? []) {
        if (part.type === 'text' && part.text !== undefined) texts.push(part.text);
        else dropped += 1;
      }
      if (dropped > 0) texts.push(`（${dropped} 个非文本内容块未透传）`);
      return { text: texts.join('\n'), isError: result.isError === true };
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // 协议化告别：stdin.end() → 宽限等自退 → 到点树杀（轮九实证优雅关停序）
      const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
      child.stdin.end();
      const timer = setTimeout(() => {
        deps.killTree(child.pid ?? -1, () => true);
      }, DISPOSE_GRACE_MS);
      await Promise.race([exited, sleep(DISPOSE_GRACE_MS + 200)]);
      clearTimeout(timer);
      deps.killTree(child.pid ?? -1, () => true); // 已退即 ESRCH 内吞（幂等收尾）
    },
  };
}

/** sleep 小工具（关停宽限竞速用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** cause 归因串（错误消息保真不吞栈） */
function describeCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
