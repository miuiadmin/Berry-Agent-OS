/**
 * L3 lsp — 单服务器连接生命周期（握手 → 文档同步 → 诊断/符号请求 → 关停）。
 *
 * 物理载体（子进程）经注入的 spawnServer 闭包取得（组合根 confined spawner）；
 * JSON-RPC 桥核（id 关联表 + 超时 + 分发）同样经注入工厂取得——**mcp 的
 * JsonRpcConnection 帧无关设计在此复用**：本模块自持 Content-Length 帧层
 * （framing.ts），把帧内 JSON 字符串喂给桥的 feed、把桥的 writeLine 包上帧头
 * 再写 stdin（L3 横向禁 import mcp——结构子集接口本地定义，组合根装配）。
 *
 * 语义对应契约篇 §6.7：
 * - connect 期一切失败（相对路径/未启动/握手失败/启动超时）= LSP_CONNECT_FAILED；
 * - 文档同步 = Full 全文同步**盘真相**：每次触达读盘取全文发 didOpen/didChange，
 *   进程内无第二份文档状态；per-URI 单调 version 账（waiter 按 version 对齐——
 *   批内连续两次写同文件时第二次的 waiter 不被第一次触发的过期诊断唤醒）；
 * - 诊断缓存 + waiter：publishDiagnostics 收到即存最新集并唤醒 version 已达的
 *   waiter；服务器不带 version 的诊断视为最新直接解锁（协议该字段可选）；
 * - 关停序 = shutdown 请求 → exit 通知 → 宽限 → killTree 树杀（MCP 同款优雅）。
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AppError, LSP_CONNECT_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import type { AppLogger } from '../contracts/app.js';
import { createFrameDecoder, encodeFrame } from './framing.js';
import { languageIdOf, type LspDiagnostic, type LspServerConfig } from './types.js';

/** 启动握手缺省超时（毫秒 = 30s——LSP 全量索引初始化普遍慢于 MCP 握手，契约篇 §6.7） */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/** 单请求缺省超时（毫秒 = 15s——只计单请求，与握手钟分账） */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** 诊断等待缺省（毫秒 = 8s——typescript-language-server 冷启全量诊断常超 3s，冷启窗不达为常态） */
export const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 8_000;
/** 关停宽限（毫秒）——shutdown+exit 告别后等子进程自退的耐心，到点树杀 */
export const DISPOSE_GRACE_MS = 3_000;

/**
 * 子进程最小结构面（ChildProcess 结构子集——与 mcp SpawnedChild 同形但本地
 * 定义：L3 横向禁 import mcp，注入面收窄，测试可用假流对）。
 */
export interface SpawnedProcess {
  /** 子进程 pid（登记簿/树杀用；可能 undefined——已退出的极端竞态） */
  readonly pid?: number;
  /** stdin：帧写面（写帧头由本模块负责——本面只要求可写可关） */
  readonly stdin: { write(chunk: string): boolean; end(): void; on(ev: 'error', cb: (err: Error) => void): void };
  /** stdout：帧读面（流式解码器消费——本面只要求可读流） */
  readonly stdout: NodeJS.ReadableStream;
  /** stderr：诊断读面（LSP 惯例日志走 stderr——debug 落盘不进上下文） */
  readonly stderr: { on(ev: 'data', cb: (chunk: Buffer | string) => void): void };
  /** 退出事件订阅（close = 流已 flush 的真死信号——运行期 exit 语义的锚点） */
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): void;
}

/**
 * JSON-RPC 桥核结构子集（mcp JsonRpcConnection 的结构投影——组合根注入真类，
 * 本模块零 mcp import；测试可注入假桥全协议面覆盖零子进程）。
 */
export interface JsonRpcLike {
  request(method: string, params?: object, opts?: { timeoutMs?: number; timeoutCode?: string }): Promise<unknown>;
  notify(method: string, params?: object): void;
  close(reason: string): void;
  get isClosed(): boolean;
  /** 喂一条完整 JSON 消息文本（帧解码后调用——帧无关桥） */
  feed(line: string): void;
}

/** 桥工厂注入面（组合根把 mcp JsonRpcConnection 类以本签名塞入） */
export interface JsonRpcConnectionFactory {
  (opts: {
    writeLine: (line: string) => void;
    onNoise?: (message: string) => void;
    onNotification?: (method: string, params: unknown) => void;
    /** 连接生命周期失败码（close 结清 pending 用——lsp 恒 LSP_CONNECT_FAILED） */
    defaultTimeoutCode?: typeof LSP_CONNECT_FAILED;
  }): JsonRpcLike;
}

/** 连接期依赖注入束（组合根闭包——本模块不 import exec/child_process/mcp） */
export interface LspConnectDeps {
  /** spawn 组装（组合根 confined spawner——OS 沙箱 confine 同 mcp 款） */
  readonly spawnServer: (config: LspServerConfig) => Promise<SpawnedProcess>;
  /** 树杀原语（exec killTree 经组合根注入） */
  readonly killTree: (pid: number, alive: () => boolean) => void;
  /** 诊断日志（stderr 行/通知杂音——debug 级） */
  readonly logger: Pick<AppLogger, 'debug' | 'warn'>;
  /** JSON-RPC 桥核工厂（mcp JsonRpcConnection 经组合根注入——帧无关复用） */
  readonly newConnection: JsonRpcConnectionFactory;
}

/** per-URI 文档账（version 单调递增——didOpen/didChange 必填；close 后再 open 继续递增防旧唤醒） */
interface DocEntry {
  /** 最近一次同步发出的版本号（1 起） */
  version: number;
  /** 服务器侧是否 open（didClose 后 false——再触达走 didOpen） */
  open: boolean;
}

/** 诊断缓存条目（version 缺 = 服务器不追踪版本，视为最新直接解锁） */
interface DiagCacheEntry {
  readonly version?: number;
  readonly diagnostics: readonly LspDiagnostic[];
}

/** waiter 簿记（等某 URI 的诊断达指定 version） */
interface DiagWaiter {
  /** 解锁门槛：收到的诊断 version ≥ 此值才醒 */
  readonly version: number;
  /** 结算口（超时腿结算 undefined = 降级信号） */
  resolve: (diags: readonly LspDiagnostic[] | undefined) => void;
}

/** 连接后的稳定面（件层消费：同步/诊断等待/请求/退出订阅/关停） */
export interface LspServerConnection {
  /** 服务器名（诊断归因） */
  readonly server: string;
  /** 子进程 pid（登记簿键；spawn 竞态下可能 undefined） */
  readonly childPid: number | undefined;
  /**
   * 盘真相同步：读盘取全文发 didOpen（首触）或 didChange（Full 全文增量体），
   * 返回本版 version（waiter 对齐锚）。盘上文件已不在（delete 后的竞态触达）
   * 转 didClose 告别并返回 undefined——调用方跳过诊断等待。
   */
  syncDocument(absPath: string): Promise<number | undefined>;
  /** didClose 告别（edit 的 delete 操作路径——已 open 的 URI 才发，notify 零等待） */
  closeDocument(absPath: string): void;
  /**
   * 等某 URI 的诊断达指定 version（超时结算 undefined = 降级信号不算失败——
   * 诊断异步性是 LSP 协议本质，不硬等）。
   */
  waitForDiagnostics(
    absPath: string,
    version: number,
    timeoutMs: number,
  ): Promise<readonly LspDiagnostic[] | undefined>;
  /** 发一条 LSP 请求（documentSymbol/definition/references——调用方先 ensure-open） */
  request(method: string, params: object, timeoutMs: number): Promise<unknown>;
  /** 订阅运行期退出（close 事件——件层熔断记败 + notify 的锚点）；返回退订 */
  onExit(cb: (reason: string) => void): () => void;
  /** 协议化关停（shutdown → exit → 宽限 → 树杀；幂等） */
  dispose(): Promise<void>;
}

/** 绝对路径 → file:// URI（pathToFileURL 百分号编码——空格/中文路径安全） */
export function uriOf(absPath: string): string {
  return pathToFileURL(absPath).href;
}

/**
 * 建立一条 LSP 服务器连接（spawn → initialize 握手 → initialized 通知）。
 *
 * @param rootUriRoot 工作区物理根（rootUri 由此转 file:// URI——服务器索引范围）
 * @throws AppError(LSP_CONNECT_FAILED) connect 期一码收口（相对路径/未启动/握手失败/超时）
 */
export async function connectLspServer(
  server: string,
  config: LspServerConfig,
  rootUriRoot: string,
  deps: LspConnectDeps,
): Promise<LspServerConnection> {
  // v1 只认绝对路径 command（相对路径在花钱 spawn 前拦下——MCP 同款裁决）
  if (!config.command.startsWith('/')) {
    throw new AppError(
      LSP_CONNECT_FAILED,
      `LSP 服务器 ${server} 的 command 必须是绝对路径（v1 不解析相对路径/npx）：${config.command}`,
    );
  }
  const startupTimeoutMs = (config.startup_timeout_sec ?? DEFAULT_STARTUP_TIMEOUT_MS / 1000) * 1000;
  const requestTimeoutMs = (config.request_timeout_sec ?? DEFAULT_REQUEST_TIMEOUT_MS / 1000) * 1000;
  let child: SpawnedProcess;
  try {
    child = await deps.spawnServer(config);
  } catch (err) {
    // spawn 失败（ENOENT/EACCES…/OS 沙箱层不可用）：一码收口，cause 保真
    throw new AppError(LSP_CONNECT_FAILED, `LSP 服务器 ${server} 子进程未启动：${describeCause(err)}`, {
      cause: err,
    });
  }

  const exitListeners = new Set<(reason: string) => void>();
  let disposed = false; // dispose 幂等闸（effect 回卷与运行期退出可能竞速）
  let closeReason: string | undefined; // 首次 close 的归因（后续重复 close 用首因）

  /* per-URI 文档账 + 诊断缓存 + waiter 簿（盘真相同步与 version 对齐的核心状态） */
  const docs = new Map<string, DocEntry>();
  const diagCache = new Map<string, DiagCacheEntry>();
  const waiters = new Map<string, Set<DiagWaiter>>();

  const conn = deps.newConnection({
    // 写面：桥给单 JSON 字符串，包上 Content-Length 帧头再写 stdin（帧层职责）
    writeLine: (line) => {
      child.stdin.write(encodeFrame(line));
    },
    // 通知消费口：publishDiagnostics 进缓存 + 唤醒 waiter（其余通知进杂音口）
    onNotification: (method, params) => {
      if (method === 'textDocument/publishDiagnostics') {
        handlePublish(params);
      } else {
        deps.logger.debug(`lsp[${server}] 服务器通知（忽略）：${method}`);
      }
    },
    onNoise: (msg) => deps.logger.debug(`lsp[${server}] ${msg}`),
    defaultTimeoutCode: LSP_CONNECT_FAILED,
  });

  /** publishDiagnostics 消费：存最新集 + 按 version 对齐唤醒 waiter */
  function handlePublish(params: unknown): void {
    const pub = params as { uri?: string; version?: number; diagnostics?: LspDiagnostic[] };
    if (pub.uri === undefined) return;
    const diagnostics = pub.diagnostics ?? [];
    diagCache.set(pub.uri, { version: pub.version, diagnostics });
    const set = waiters.get(pub.uri);
    if (set === undefined) return;
    for (const waiter of [...set]) {
      // 解锁判据：服务器不带 version（视为最新）或 version ≥ waiter 门槛
      if (pub.version === undefined || pub.version >= waiter.version) {
        set.delete(waiter);
        waiter.resolve(diagnostics);
      }
    }
  }

  // stdout 帧解码：流式状态机解出整帧 JSON 喂桥（帧无关桥收单 JSON 文本）
  const feedFrame = createFrameDecoder((json) => conn.feed(json));
  child.stdout.on('data', (chunk: Buffer | string) => {
    try {
      feedFrame(chunk);
    } catch (err) {
      // 坏帧（头缺 Content-Length）——连接不可信，归因连接死
      crash(`LSP 帧解码失败：${describeCause(err)}`);
    }
  });

  // stderr：LSP 惯例日志走 stderr——debug 落盘不进上下文
  child.stderr.on('data', (chunk: Buffer | string) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') deps.logger.debug(`lsp[${server}] stderr: ${line.slice(0, 300)}`);
    }
  });

  /**
   * 连接死（close 事件/坏帧）：结清桥 pending、唤醒全部 waiter（降级 undefined）、fire 退出监听。
   * 一次性闸（复盘 L-1）：一次进程事故恰计一败——坏帧 crash 与随后 close 事件不得
   * 双计双 notify（熔断「连败 = 无成功间隔」按进程事故计数）；首因保留。
   */
  let crashFired = false; // crash 一次性闸（生命周期 = 连接首死时刻到实例回收）
  let childClosed = false; // 子进程 close 事件已见（crash 时未见 = 坏帧路径，子进程可能仍活）
  function crash(reason: string): void {
    if (crashFired) return;
    crashFired = true;
    closeReason ??= reason;
    conn.close(closeReason);
    for (const [, set] of waiters) {
      for (const waiter of [...set]) waiter.resolve(undefined); // 降级：诊断不可达
    }
    waiters.clear();
    for (const cb of [...exitListeners]) cb(closeReason);
    if (!childClosed) {
      // 坏帧路径：连接已不可信而子进程可能仍活——同步树杀防永久孤儿（复盘 L-1 腿二：
      // 件层 onExit 即清实例与登记簿条目，dispose 回卷与孤儿清扫两条兜底都够不着它）。
      // 已退即 ESRCH 内吞（与 dispose 收尾同款幂等语义）。
      deps.killTree(child.pid ?? -1, () => true);
    }
  }
  child.on('close', (code, signal) => {
    childClosed = true;
    crash(`LSP 服务器 ${server} 子进程退出（code=${code ?? '?'}${signal ? ` signal=${signal}` : ''}）`);
  });
  child.stdin.on('error', () => undefined); // 告别后服务器不读 stdin 的 EPIPE 不算失败

  try {
    // initialize 握手（参数最小面：processId/rootUri/capabilities/clientInfo——
    // 契约篇 §6.7；协议宽容：服务器回什么版本都接受不强校验）
    await conn.request(
      'initialize',
      {
        protocolVersion: '3.17.0',
        processId: process.pid,
        rootUri: uriOf(rootUriRoot),
        capabilities: {
          textDocument: { synchronization: { dynamicRegistration: false } },
        },
        workspace: { workspaceFolders: false },
        clientInfo: { name: 'lsp-bridge', version: '1.0.0' },
      },
      { timeoutMs: startupTimeoutMs, timeoutCode: LSP_CONNECT_FAILED },
    );
    conn.notify('initialized', {});
  } catch (err) {
    // 握手失败/超时：响亮杀进程树不留挂起（MCP 同款连接语义）
    deps.killTree(child.pid ?? -1, () => true);
    if (err instanceof AppError) throw err;
    throw new AppError(LSP_CONNECT_FAILED, `LSP 服务器 ${server} 握手失败：${describeCause(err)}`, {
      cause: err,
    });
  }

  /**
   * didClose 告别发送（本地闭包——syncDocument 的盘缺路径与 closeDocument
   * face 两处共用；已 open 才发，未 open 过的服务器不知此文档无需告别）
   */
  function sendDidClose(uri: string): void {
    const doc = docs.get(uri);
    if (doc === undefined || !doc.open) return;
    conn.notify('textDocument/didClose', { textDocument: { uri } });
    docs.set(uri, { version: doc.version, open: false });
  }

  return {
    server,
    childPid: child.pid,
    async syncDocument(absPath) {
      const uri = uriOf(absPath);
      // 盘真相：每次触达读盘取全文（文件即事实源——进程内无影子文本）
      let text: string;
      try {
        text = await readFile(absPath, 'utf8');
      } catch {
        // 盘上已无此文件（delete 后的理论竞态触达）：didClose 告别，调用方跳过等待
        sendDidClose(uri);
        return undefined;
      }
      const doc = docs.get(uri);
      // version 账：新文档 1 起；曾 open 过（含 close 后再 open）继续递增——
      // 旧 version 的迟到诊断不会误醒新 waiter
      const version = (doc?.version ?? 0) + 1;
      if (doc === undefined || !doc.open) {
        conn.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: languageIdOf(absPath), version, text },
        });
      } else {
        // Full 全文同步（syncKind 1）：contentChanges 单元素全文替换
        conn.notify('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      }
      docs.set(uri, { version, open: true });
      return version;
    },
    closeDocument(absPath) {
      sendDidClose(uriOf(absPath));
    },
    waitForDiagnostics(absPath, version, timeoutMs) {
      const uri = uriOf(absPath);
      // 快查缓存：version 已达（或服务器不带 version = 视为最新）直接返
      const cached = diagCache.get(uri);
      if (cached !== undefined && (cached.version === undefined || cached.version >= version)) {
        return Promise.resolve(cached.diagnostics);
      }
      return new Promise((resolve) => {
        /** 结算包裹：醒与超时两腿都先清簿记再结算（双结算闸） */
        const settle = (diags: readonly LspDiagnostic[] | undefined): void => {
          clearTimeout(timer);
          set.delete(waiter);
          if (set.size === 0) waiters.delete(uri);
          resolve(diags);
        };
        const waiter: DiagWaiter = { version, resolve: settle };
        const set = waiters.get(uri) ?? new Set<DiagWaiter>();
        waiters.set(uri, set);
        set.add(waiter);
        // 超时腿：结算 undefined = 降级信号（诊断异步性是协议本质，不硬等不算失败）
        const timer = setTimeout(() => settle(undefined), timeoutMs);
      });
    },
    request(method, params, timeoutMs) {
      // 调用期超时 = TOOL_TIMEOUT（与管道 def.timeoutMs 同码——桥钟 + 缓冲让管道
      // 先执法，同码不撞车；MCP 同构）
      return conn.request(method, params, { timeoutMs, timeoutCode: TOOL_TIMEOUT });
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // 协议化告别：shutdown 请求（尽力而为——超时/失败不阻后续）→ exit 通知
      try {
        await conn.request('shutdown', undefined, { timeoutMs: DISPOSE_GRACE_MS, timeoutCode: LSP_CONNECT_FAILED });
      } catch {
        // 服务器不答 shutdown（僵死/已死）——照样走 exit + 树杀兜底
      }
      conn.notify('exit', {});
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
