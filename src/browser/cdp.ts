/**
 * L3 browser — CDP 连接与会话层（契约篇 §6.10 第四十九批刀一冷读 B1 裁决）。
 *
 * 连接层三件：
 * - `fetchVersionInfo`：attach 形态端点发现——HTTP GET /json/version 取
 *   webSocketDebuggerUrl（spawn 形态不走本口，DevToolsActivePort 直读）；
 * - `CdpConnection`：原生 WebSocket（Node ≥22.19 自带——本仓首个宿主消费位）
 *   ↔ JsonRpcConnection 组装——WS 文本帧 ↔ feed/writeLine 直配（CDP 无换行
 *   分帧，每帧一对象）；CDP 按字段名解析容忍帧上陌生 jsonrpc 字段；
 * - 会话层：per-session `Target.createBrowserContext` → `Target.createTarget`
 *   → `Target.attachToTarget({flatten:true})` → sessionId——page 级命令顶层
 *   附 sessionId 路由、target 级事件按 sessionId 分流（桥核三处加法面）。
 *
 * 桥核经组合根注入（结构投影——本模块零 mcp import，lsp 先例同构）。
 */

import { AppError, BROWSER_CONNECT_FAILED } from '../contracts/errors.js';
import type { SessionBrowserState } from './types.js';

/**
 * JSON-RPC 桥核结构子集（mcp JsonRpcConnection 的结构投影——组合根注入真类，
 * 本模块零 mcp import；测试注入假桥全协议面覆盖零子进程）。opts.sessionId
 * 在场则请求帧顶层附加（第四十九批 CDP 加法面）。
 */
export interface CdpRpc {
  request(
    method: string,
    params?: object,
    opts?: { timeoutMs?: number; timeoutCode?: string; sessionId?: string },
  ): Promise<unknown>;
  close(reason: string): void;
  get isClosed(): boolean;
  /** 喂一条完整 JSON 消息文本（WS 文本帧到达时调用——帧无关桥） */
  feed(line: string): void;
}

/** 桥工厂注入面（组合根把 mcp JsonRpcConnection 类以本签名塞入——lsp 同款纪律） */
export type CdpConnectionFactory = (opts: {
  writeLine: (line: string) => void;
  onNoise?: (message: string) => void;
  onNotification?: (method: string, params: unknown, sessionId?: string) => void;
  /** 连接生命周期失败码（close 结清 pending 用——browser 恒 BROWSER_CONNECT_FAILED） */
  defaultTimeoutCode?: typeof BROWSER_CONNECT_FAILED;
}) => CdpRpc;

/** /json/version 产物（attach 形态端点发现——只要 Browser 名与 ws 端点两键） */
export interface CdpVersionInfo {
  /** 浏览器自报名（如 "Chrome/131.0.6778.0"——诊断面披露） */
  readonly browser: string;
  /** browser 级 ws 调试端点（连本端点即 browser 域单连接） */
  readonly webSocketDebuggerUrl: string;
}

/**
 * attach 形态端点解析：`host:port` → HTTP /json/version 探 webSocketDebuggerUrl；
 * `ws://`/`wss://` 全 url → 直用（不再 HTTP 探测）；`http(s)://host:port` →
 * 取其 host:port 再探。私网地址**不拦**——本地 CDP 回环不属 SSRF 面（契约篇
 * §6.10 安全卫生段裁决：回环调试端点是引擎控制面不是数据抓取面）。
 */
export async function fetchVersionInfo(endpoint: string, timeoutMs = 5_000): Promise<CdpVersionInfo> {
  let base: string;
  if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
    // ws url 直用形态：无 HTTP 探测——browser 自报名以 '(endpoint)' 字面量
    // 回填（端点即真相；遗漏大扫 20260901-b #21：原注释「0.0.0.0 形回填」为
    // 起草残留——该形态从未实现，与实现漂移）
    return { browser: '(endpoint)', webSocketDebuggerUrl: endpoint };
  }
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    const parsed = new URL(endpoint);
    base = `${parsed.protocol}//${parsed.host}`;
  } else {
    base = `http://${endpoint}`;
  }
  let response: Response;
  try {
    response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AppError(
      BROWSER_CONNECT_FAILED,
      `CDP 端点探测失败（${base}/json/version）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new AppError(BROWSER_CONNECT_FAILED, `CDP 端点应答 ${response.status}（${base}/json/version）`);
  }
  let info: { Browser?: string; webSocketDebuggerUrl?: string };
  try {
    info = (await response.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
  } catch {
    throw new AppError(BROWSER_CONNECT_FAILED, `CDP /json/version 应答非 JSON（${base}）`);
  }
  if (typeof info.webSocketDebuggerUrl !== 'string' || info.webSocketDebuggerUrl === '') {
    throw new AppError(BROWSER_CONNECT_FAILED, `CDP /json/version 无 webSocketDebuggerUrl（${base}）`);
  }
  return { browser: info.Browser ?? '(unknown)', webSocketDebuggerUrl: info.webSocketDebuggerUrl };
}

/** 物理连接死亡回调（引擎死亡感知——engine.ts 接线回收/登记簿净退） */
type DeadCallback = (reason: string) => void;

/**
 * CDP 连接封装：原生 WebSocket 载体 + 桥核 + 死亡感知。
 *
 * 帧配线：ws 'message'（文本帧）→ rpc.feed；rpc writeLine → ws.send。
 * 死亡面：ws close/error → rpc.close（结清 pending）+ dead 回调（一次性——
 * 主动 close 与异常死亡同一口，回调方自辨收场理由）。
 */
export class CdpConnection {
  private readonly ws: WebSocket;
  readonly rpc: CdpRpc;
  /** 死亡回调簿（一次性触发——重入护栏） */
  private deadCbs: readonly DeadCallback[] = [];
  private deadFired = false;

  /** 私有构造——经 `connectCdp` 建立（open 等待收敛在工厂里） */
  private constructor(ws: WebSocket, rpc: CdpRpc) {
    this.ws = ws;
    this.rpc = rpc;
    ws.addEventListener('message', (ev: MessageEvent) => {
      // CDP 只发文本帧（binary 面零消费——异常形态走杂音口不炸桥）
      if (typeof ev.data === 'string') {
        rpc.feed(ev.data);
      }
    });
    ws.addEventListener('close', () => this.fireDead('CDP 连接已关闭'));
    ws.addEventListener('error', () => this.fireDead('CDP 连接错误'));
  }

  /**
   * 建 CDP 连接（等 open 握手完成）。
   * @param wsUrl browser 级 ws 端点（fetchVersionInfo 产物或 DevToolsActivePort 拼装）
   * @param newConnection 桥工厂（组合根注入 JsonRpcConnection）
   * @param opts.onEvent target 级事件消费口（method+params+sessionId——console
   *   订阅/页面生命周期消费；缺省事件走杂音口）
   */
  static async connect(
    wsUrl: string,
    newConnection: CdpConnectionFactory,
    opts?: {
      timeoutMs?: number;
      onEvent?: (method: string, params: unknown, sessionId?: string) => void;
      onNoise?: (message: string) => void;
    },
  ): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    const conn = new CdpConnection(
      ws,
      newConnection({
        writeLine: (line) => ws.send(line), // CONNECTING 期 send 自动排队（WHATWG 语义）——open 前请求不丢
        ...(opts?.onEvent !== undefined ? { onNotification: opts.onEvent } : {}),
        ...(opts?.onNoise !== undefined ? { onNoise: opts.onNoise } : {}),
        defaultTimeoutCode: BROWSER_CONNECT_FAILED,
      }),
    );
    // open 握手等待（超时/失败 → BROWSER_CONNECT_FAILED——连接期统一码）
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AppError(BROWSER_CONNECT_FAILED, `CDP WebSocket 握手超时（>${opts?.timeoutMs ?? 10_000}ms）：${wsUrl}`),
        );
      }, opts?.timeoutMs ?? 10_000);
      timer.unref?.();
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      const failEarly = (why: string) => {
        clearTimeout(timer);
        reject(new AppError(BROWSER_CONNECT_FAILED, `CDP WebSocket 连接失败：${why}`));
      };
      ws.addEventListener('error', () => failEarly('传输错误'), { once: true });
      ws.addEventListener('close', () => failEarly('握手期即关闭'), { once: true });
    }).catch((err) => {
      // 失败收场：物理载体随手关（已关是幂等）——不留半开 ws
      try {
        ws.close();
      } catch {
        /* 忽略——close 期异常无关紧要 */
      }
      throw err;
    });
    return conn;
  }

  /** 登记死亡回调（可多登——close/error 一次性全触发；主动 close 同口） */
  onDead(cb: DeadCallback): void {
    this.deadCbs = [...this.deadCbs, cb];
  }

  /** 死亡触发（一次性护栏——close 与 error 双事件只跑一轮） */
  private fireDead(reason: string): void {
    if (this.deadFired) return;
    this.deadFired = true;
    this.rpc.close(reason); // 结清全部 pending（BROWSER_CONNECT_FAILED）
    for (const cb of this.deadCbs) {
      try {
        cb(reason);
      } catch {
        /* 回调异常不拦死亡传播 */
      }
    }
  }

  /** 主动关停（effect 回卷/闲置回收——ws 关闭 + 桥结清 + 死亡回调照发） */
  close(reason: string): void {
    this.fireDead(reason);
    try {
      this.ws.close();
    } catch {
      /* 忽略——重复关停幂等 */
    }
  }
}

/** CDP 应答窄读（畸形应答统一 BROWSER_CONNECT_FAILED——引擎死/协议漂移两因同码） */
function expectString(value: unknown, method: string, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AppError(BROWSER_CONNECT_FAILED, `CDP ${method} 应答缺 ${field} 字段（引擎异常或协议漂移）`);
  }
  return value;
}

/**
 * 建 per-session 隔离态（契约篇 §6.10 CDP 会话层段）：BrowserContext（cookies/
 * storage/缓存隔离容器）→ context 内唯一 page target → flat attach 取 sessionId。
 * 此后该会话全部 page 级命令附 sessionId 路由；target 级事件按 sessionId 分流。
 */
export async function openSessionContext(rpc: CdpRpc): Promise<SessionBrowserState> {
  const ctxResult = (await rpc.request('Target.createBrowserContext')) as { browserContextId?: string };
  const browserContextId = expectString(ctxResult?.browserContextId, 'Target.createBrowserContext', 'browserContextId');
  const targetResult = (await rpc.request('Target.createTarget', {
    url: 'about:blank',
    browserContextId, // 钉进隔离容器——与默认上下文物理分离
  })) as { targetId?: string };
  const targetId = expectString(targetResult?.targetId, 'Target.createTarget', 'targetId');
  const attachResult = (await rpc.request('Target.attachToTarget', {
    targetId,
    flatten: true, // flat 模式：sessionId 顶层路由（非 flat 的 sessionId 前缀法不用）
  })) as { sessionId?: string };
  const sessionId = expectString(attachResult?.sessionId, 'Target.attachToTarget', 'sessionId');
  return { browserContextId, targetId, sessionId };
}

/** 会话终结：dispose BrowserContext（连带关 context 内全部 target——唯一 page 同殁） */
export async function disposeSessionContext(rpc: CdpRpc, browserContextId: string): Promise<void> {
  try {
    await rpc.request('Target.disposeBrowserContext', { browserContextId });
  } catch {
    // 容错：context 已死（引擎先亡/已回收）——终结幂等语义，不再上抛
  }
}
