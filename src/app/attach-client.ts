/**
 * L5 app — attach 客户端纯逻辑半边（daemon 刀二，契约篇 §6.8 attach 形态）。
 *
 * `berry attach` 是纯客户端：零 createRuntime/零本地库/零本地装载。本文件
 * 是它的可测逻辑半边（无 TUI 依赖）——HTTP/SSE 三件：
 *   ① 目标解析：daemon.json 取 port（--port 覆盖）+ token 文件只读；
 *   ② 微端点客户端：sessions/messages/submit/interrupt/approvals/decide/
 *      workspace files/symbols 八端点的薄封装（Bearer 鉴权、JSON 直解）；
 *   ③ SSE 流读：手写 node:http 流解析（EventSource 不能带 header——契约篇
 *      §6.8 P4 钉死形态）+ 指数退避重连 + 重连成功恒重拉回调。
 *
 * TUI 装配半边在 attach-main.ts（createTuiChannel 复用 + 远程 ChannelHost）。
 * 纪律：token 只读不 ensure（客户端/诊断面禁造态——doctor ③ 同款钉死）；
 * 全部请求钉回环 127.0.0.1（daemon 面三防线之一，客户端同守）。
 */

import { get as httpGet, request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { readFileSync } from 'node:fs';
import { readDaemonState, daemonTokenPath, type DaemonState } from './daemon-state.js';
import type { WebuiPendingApproval, WebuiSessionSummary, WebuiSseEnvelope, WebuiSymbolQuery } from '../webui/index.js';

/* ------------------------------------------------------------------ */
/* ① 目标解析（daemon.json + token 只读）                              */
/* ------------------------------------------------------------------ */

/** attach 目标（port 优先级：--port 覆盖 > daemon.json 记录值） */
export interface AttachTarget {
  /** daemon 监听端口（回环钉死） */
  readonly port: number;
  /** daemon.json 原文（pid/bootId/heldSessions——起屏披露面用） */
  readonly state: DaemonState;
}

/**
 * 解析 attach 目标：daemon.json 不在 = undefined（调用方走「未运行」指引）。
 * @param dataRoot 数据目录根（~/.berry 缺省）
 * @param portOverride --port 覆盖值（在场时压过 daemon.json——诊断面用法）
 */
export function resolveAttachTarget(dataRoot: string, portOverride?: number): AttachTarget | undefined {
  const state = readDaemonState(dataRoot);
  if (state === undefined) return undefined;
  return { port: portOverride ?? state.port, state };
}

/**
 * 只读 token 文件（缺失/空 = undefined）。**禁 ensure 写**：attach 是客户端
 * 面，造 token 文件 = 诊断面自造矛盾态（doctor ③ 同判——复活/换发只能由
 * daemon start/stop 编舞完成）。
 */
export function readAttachToken(dataRoot: string): string | undefined {
  try {
    const token = readFileSync(daemonTokenPath(dataRoot), 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined; // 不存在/不可读——诚实缺席
  }
}

/* ------------------------------------------------------------------ */
/* ② 微端点客户端（Bearer + JSON；回环钉死）                           */
/* ------------------------------------------------------------------ */

/** 请求结果（连接失败/超时 = undefined——与 httpProbe 同形；json = 应答体直解） */
export interface AttachHttpResponse {
  readonly status: number;
  readonly json?: unknown;
}

/**
 * 单次 attach 请求（node:http 零依赖形态）。GET/POST 同道：method + 可选
 * JSON body（Content-Type: application/json）；应答体按 JSON 直解（非 JSON
 * 应答保留原文于 json=undefined——调用方按 status 分诊）。
 */
export function attachRequest(opts: {
  readonly port: number;
  readonly token: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}): Promise<AttachHttpResponse | undefined> {
  return new Promise((resolve) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const options: RequestOptions = {
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: opts.method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(payload !== undefined
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload).toString() }
          : {}),
      },
      timeout: opts.timeoutMs ?? 10_000,
    };
    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown | undefined;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined; // 非 JSON 应答（503 纯文本等）——status 面分诊
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
    req.end(payload);
  });
}

/** GET /api/health（公开探活——无 token；degraded 在场 = cordon 横幅数据源） */
export function fetchDaemonHealth(port: number): Promise<{ degraded?: string; version?: string } | undefined> {
  return new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/api/health', timeout: 3_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { degraded?: string; version?: string });
        } catch {
          resolve(undefined);
        }
      });
      res.on('error', () => resolve(undefined));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => resolve(undefined));
  });
}

/** 会话清单（GET /api/sessions——兼作真握手：200 = token 符） */
export function listSessions(
  port: number,
  token: string,
): Promise<{ status: number; sessions?: readonly WebuiSessionSummary[] } | undefined> {
  return attachRequest({ port, token, method: 'GET', path: '/api/sessions' }).then((res) =>
    res === undefined
      ? undefined
      : {
          status: res.status,
          sessions: (res.json as { sessions?: readonly WebuiSessionSummary[] } | undefined)?.sessions,
        },
  );
}

/** 历史投影（GET /api/sessions/:id/messages——unknown[] 由消费面投影转换） */
export function fetchMessages(
  port: number,
  token: string,
  sessionId: string,
): Promise<{ status: number; messages?: readonly unknown[] } | undefined> {
  return attachRequest({
    port,
    token,
    method: 'GET',
    path: `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  }).then((res) =>
    res === undefined
      ? undefined
      : { status: res.status, messages: (res.json as { messages?: readonly unknown[] } | undefined)?.messages },
  );
}

/** 投递文本（POST /api/sessions/:id/submit——requestId 去重键由调用方生成） */
export function submitText(
  port: number,
  token: string,
  sessionId: string,
  text: string,
  requestId: string,
): Promise<{ status: number; deduplicated?: boolean } | undefined> {
  return attachRequest({
    port,
    token,
    method: 'POST',
    path: `/api/sessions/${encodeURIComponent(sessionId)}/submit`,
    body: { text, requestId },
  }).then((res) =>
    res === undefined
      ? undefined
      : {
          status: res.status,
          deduplicated: (res.json as { deduplicated?: boolean } | undefined)?.deduplicated,
        },
  );
}

/** 打断在飞 run（POST /api/sessions/:id/interrupt——404 = 无在飞 run） */
export function interruptSession(
  port: number,
  token: string,
  sessionId: string,
): Promise<{ status: number } | undefined> {
  return attachRequest({
    port,
    token,
    method: 'POST',
    path: `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
  }).then((res) => (res === undefined ? undefined : { status: res.status }));
}

/** 未决审批清单（GET /api/approvals——连接即拉/重连恒重拉三发之一） */
export function listApprovals(
  port: number,
  token: string,
): Promise<{ status: number; approvals?: readonly WebuiPendingApproval[] } | undefined> {
  return attachRequest({ port, token, method: 'GET', path: '/api/approvals' }).then((res) =>
    res === undefined
      ? undefined
      : {
          status: res.status,
          approvals: (res.json as { approvals?: readonly WebuiPendingApproval[] } | undefined)?.approvals,
        },
  );
}

/** 应答审批（POST /api/approvals/:id/decide——accepted=false = 竞速败腿） */
export function decideApproval(
  port: number,
  token: string,
  approvalId: string,
  decision: 'approve' | 'reject' | 'always',
): Promise<{ status: number; accepted?: boolean; reason?: string } | undefined> {
  return attachRequest({
    port,
    token,
    method: 'POST',
    path: `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
    body: { decision },
  }).then((res) =>
    res === undefined
      ? undefined
      : {
          status: res.status,
          accepted: (res.json as { accepted?: boolean } | undefined)?.accepted,
          reason: (res.json as { reason?: string } | undefined)?.reason,
        },
  );
}

/** @ 文件段补全数据源（GET /api/workspace/files?prefix=——404/失败 = undefined 无弹层） */
export function fetchWorkspaceFiles(
  port: number,
  token: string,
  prefix: string,
): Promise<{ readonly files: readonly string[] } | undefined> {
  return attachRequest({
    port,
    token,
    method: 'GET',
    path: `/api/workspace/files?prefix=${encodeURIComponent(prefix)}`,
    timeoutMs: 5_000,
  }).then((res) => {
    if (res === undefined || res.status !== 200) return undefined;
    const files = (res.json as { files?: readonly string[] } | undefined)?.files;
    return files === undefined ? undefined : { files };
  });
}

/** @ 符号段补全数据源（GET /api/workspace/symbols?path=——404/失败/warming = undefined） */
export function fetchWorkspaceSymbols(
  port: number,
  token: string,
  path: string,
): Promise<WebuiSymbolQuery | undefined> {
  return attachRequest({
    port,
    token,
    method: 'GET',
    path: `/api/workspace/symbols?path=${encodeURIComponent(path)}`,
    timeoutMs: 5_000,
  }).then((res) => {
    if (res === undefined || res.status !== 200) return undefined;
    return res.json as WebuiSymbolQuery | undefined;
  });
}

/* ------------------------------------------------------------------ */
/* ③ SSE 流读（手写解析 + 指数退避重连）                               */
/* ------------------------------------------------------------------ */

/** 流选项（onEnvelope = 每帧信封；onConnected = 每次成功连接〔首连+重连〕——恒重拉三发驱动） */
export interface AttachStreamOptions {
  readonly port: number;
  readonly token: string;
  readonly onEnvelope: (envelope: WebuiSseEnvelope) => void;
  readonly onConnected: () => void;
  /** 断线回调（连接指示面——重连仍在后台继续） */
  readonly onDisconnected?: () => void;
  /** 401 回调（token 不符——响亮退出，**不再重连**） */
  readonly onAuthFailure?: () => void;
  /** 首次重连延迟（毫秒；此后 ×2 指数退避至上帽） */
  readonly initialBackoffMs?: number;
  /** 退避上帽（毫秒） */
  readonly maxBackoffMs?: number;
}

/** 流句柄（close = 停重连 + 断当前连接——退出总闸） */
export interface AttachStreamHandle {
  close(): void;
}

/**
 * 开 SSE 流（GET /api/events，Bearer header——EventSource 不能带 header 故
 * 手写 node:http）。行为律：
 *   - 每次连接成功（含首连）→ onConnected（调用侧恒重拉三发：投影+清单+
 *     approvals——spec 钉死，防断线窗漏帧）；
 *   - 断线/非 200 → 指数退避重连（连接成功即复位退避）；
 *   - 401 → onAuthFailure 后自停（token 轮换竞窗——重连无意义）；
 *   - 帧 = `data: <单行 JSON>\n\n`（服务端钉死单帧单写）；`: ping` 注释行
 *     与坏 JSON 帧静默忽略（补全面不因坏帧死流）。
 */
export function startAttachStream(opts: AttachStreamOptions): AttachStreamHandle {
  const initialBackoff = opts.initialBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 15_000;
  /** 停流旗（close 置位——重连循环节律与在飞连接双双自停） */
  let closed = false;
  /** 当前退避延迟（连接成功即复位回 initial） */
  let backoffMs = initialBackoff;
  /** 在飞请求句柄（close 时销毁） */
  let current: ReturnType<typeof httpRequest> | undefined;
  /** 待触发重连定时器（close 时清） */
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  /** 调度重连（指数退避；closed 后 no-op） */
  const scheduleRetry = (): void => {
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, backoffMs);
    backoffMs = Math.min(maxBackoff, backoffMs * 2);
  };

  /** 单次连接（成功 → 流读至断；失败 → 退避重连） */
  const connect = (): void => {
    if (closed) return;
    current = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: '/api/events',
        method: 'GET',
        headers: { authorization: `Bearer ${opts.token}`, accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          // 401 = token 不符（轮换竞窗）——响亮退出不重连；其余（503 帽满等）走退避
          res.resume(); // 排干应答体（连接卫生）
          if (res.statusCode === 401) {
            closed = true;
            opts.onAuthFailure?.();
            return;
          }
          opts.onDisconnected?.();
          scheduleRetry();
          return;
        }
        backoffMs = initialBackoff; // 连接成功复位退避（瞬断不累积到上帽）
        opts.onConnected();
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          // 追加后整体归一 CRLF→LF：帧分隔符只认 \n\n，而 \r\n\r\n 无连续 \n\n
          // （整体归一而非单 chunk 归一——\r 与 \n 跨 chunk 断裂时单侧归一漏对）
          buf = (buf + chunk).replace(/\r\n/g, '\n');
          // 帧边界 = 空行（\n\n；CRLF 已上行归一——服务端钉死 \n，归一防御别家代理）
          let sep = buf.indexOf('\n\n');
          while (sep !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            handleFrame(frame);
            sep = buf.indexOf('\n\n');
          }
        });
        res.on('end', () => {
          opts.onDisconnected?.();
          scheduleRetry();
        });
        res.on('error', () => {
          opts.onDisconnected?.();
          scheduleRetry();
        });
      },
    );
    current.on('error', () => {
      opts.onDisconnected?.();
      scheduleRetry();
    });
    current.end();
  };

  /** 单帧解析：data 行（可能多行拼接）→ JSON → 信封回调；注释/事件名行/坏帧忽略 */
  const handleFrame = (frame: string): void => {
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(':')) continue; // 注释行（心跳 ping）
      if (line.startsWith('data:')) {
        // SSE 规范：剥 'data:' 后**至多一个**前导空格
        const value = line.slice(5);
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // 其余字段（event:/id:/retry:）本协议不用——忽略
    }
    if (dataLines.length === 0) return;
    try {
      opts.onEnvelope(JSON.parse(dataLines.join('\n')) as WebuiSseEnvelope);
    } catch {
      // 坏 JSON 帧：忽略（流本身仍健康——服务端单帧单写，坏帧只可能是截断竞窗）
    }
  };

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      current?.destroy();
    },
  };
}
