/**
 * L3 web — 抓取本体（契约篇 §1.5.2：fetch 工具与 ctx.fetch **同一 execute
 * 同一卫生件**——不造两份）。
 *
 * 两层结构：
 * - `performFetch`：真值层——卫生件全流程 + WebFetchResult 九字段产出
 *   （两消费面的共同实现，规范「同一 execute」的落码形态）；
 * - `runWebFetch`：工具面文本组装层（元数据头 + 正文）——只服务模型面 def。
 *
 * 卫生件顺序钉死（规范 ③）：协议与 URL 校验 → 私网校验 → 限流 →
 * 抓取（字节预算）→ 重定向循环内重复前四。
 *
 * 错误面纪律（码族四码封顶）：字节超顶 = truncated 标注、HTTP 非 2xx =
 * isError 结果面——两者永不立码；URL/私网/超跳/网络层失败才 throw AppError。
 */

import { AppError, WEB_FETCH_FAILED, WEB_REDIRECT_LIMIT, WEB_URL_INVALID } from '../contracts/errors.js';
import type { AgentToolResult } from '../contracts/tools.js';
import { htmlToText } from './html.js';
import { assertPublicHost, InflightGates, type HostLookup } from './hygiene.js';
import { WEB_MAX_REDIRECTS, WEB_NETWORK_BUDGET_BYTES, WEB_TEXT_BUDGET_BYTES, type WebFetchResult } from './types.js';

/** 底层 fetch 注入缝（缺省全局 fetch；组合根测试注入假实现——mock 停在外部边界） */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** 抓取依赖束（件级构造一次，两消费面共享——限流/测试缝同源） */
export interface WebFetchDeps {
  /** 在飞限流信号量（件级单例——服务与工具并发共享同一计数） */
  readonly gates: InflightGates;
  /** DNS 解析注入缝（缺省 node:dns 全地址族） */
  readonly lookup?: HostLookup;
  /** 底层 fetch 注入缝（缺省 Node 原生全局 fetch） */
  readonly fetchImpl?: FetchImpl;
}

/** 出网请求头（自报身份 + 引导文本响应——无 UA 的裸请求被部分站点直接拒答） */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': 'berry/1.0',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/*;q=0.8',
};

/**
 * URL 校验：畸形或非 http/https 协议 → WEB_URL_INVALID（file/ftp/ws 一律拒）。
 * 2026-08-31 第四十九批升导出（原私有函数）——browser 件导航入口同一份协议白名单
 * （契约篇 §6.10「同一份卫生代码」裁决；经 web/index.ts 再导出单源）。
 */
export function requireHttpUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(WEB_URL_INVALID, `URL 畸形：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(WEB_URL_INVALID, `协议不在白名单（http/https）：${parsed.protocol}`);
  }
  return parsed;
}

/**
 * 流式读响应体（卫生件③——网络读 2 MiB 硬顶）：
 * 累计超预算即 cancel reader 断流，返回已读前缀 + truncated 标注。
 * 非 chunked 小响应照走（统一路径——上限执法不因响应大小而分叉）。
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  budgetBytes: number,
): Promise<{ chunks: Buffer[]; bytes: number; truncated: boolean }> {
  if (body === null) return { chunks: [], bytes: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    bytes += value.byteLength;
    if (bytes >= budgetBytes) {
      truncated = true; // 超硬顶：断流保序（已读前缀即产出——保头语义在网络读侧成立）
      await reader.cancel().catch(() => {}); // cancel 失败无关紧要（连接随响应关闭）
      break;
    }
  }
  return { chunks, bytes, truncated };
}

/** 保头截断（字节预算——Buffer 边界截断，UTF-8 坏尾由 toString 容错替换） */
function truncateHead(text: string, budgetBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= budgetBytes) return { text, truncated: false };
  return {
    text: Buffer.from(text, 'utf8').subarray(0, budgetBytes).toString('utf8'),
    truncated: true,
  };
}

/** content-type 判定桶（text/html 剥标签；text/* 与 json 原文；其余非文本面） */
function classifyContentType(contentType: string): 'html' | 'text' | 'binary' {
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  if (base === 'text/html' || base === 'application/xhtml+xml') return 'html';
  if (base.startsWith('text/')) return 'text';
  if (base === 'application/json' || base.endsWith('+json')) return 'text';
  return 'binary';
}

/** 真值层产物：结果九字段 + 非文本标注（工具面组 isError 结构说明用） */
export interface FetchOutcome {
  readonly result: WebFetchResult;
  /** 非文本响应（text 为空串——fetch 面不引二进制消费面） */
  readonly binary: boolean;
}

/**
 * 抓取真值层（两消费面共同实现——契约篇 §1.5.2「同一 execute 同一卫生件」）。
 *
 * 输入 {url, caller?}（caller 仅入 details 归因，不改变抓取行为）。
 * throw 面：WEB_URL_INVALID / WEB_PRIVATE_TARGET / WEB_REDIRECT_LIMIT /
 * WEB_FETCH_FAILED + 调用方取消（AbortError 原样传播——主动取消不是失败）。
 */
export async function performFetch(
  args: { url: string; caller?: string },
  signal: AbortSignal | undefined,
  deps: WebFetchDeps,
): Promise<FetchOutcome> {
  const startedAt = Date.now();

  /* ---- 卫生件①：URL 校验（协议白名单） ---- */
  const initialUrl = requireHttpUrl(args.url);

  /* ---- 卫生件②：私网校验（DNS 全地址过清单） ---- */
  await assertPublicHost(initialUrl.hostname, deps.lookup);

  /* ---- 卫生件④：限流（排队不拒绝；排队中 abort 立即出队） ---- */
  const gates = deps.gates;
  const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));
  let host = initialUrl.host; // 当前跳主机（重定向循环换轨游标）
  let heldHost: string | null = host; // 实际持槽主机（换轨窗口置空——finally 只还实持槽，m-1）
  await gates.acquire(host, signal);

  let finalUrl = initialUrl;
  let redirects = 0;
  let response: Response;
  try {
    /* ---- 卫生件②'：重定向循环（manual 自跟——每跳重复①②④，上限 5 跳） ---- */
    for (;;) {
      let current: Response;
      try {
        current = await fetchImpl(finalUrl.href, {
          redirect: 'manual', // 自跟：fetch 内建自动跟随跳过逐跳校验面，不用
          signal,
          headers: REQUEST_HEADERS,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err; // 调用方取消原样传播
        throw new AppError(
          WEB_FETCH_FAILED,
          `抓取 ${finalUrl.href} 网络层失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // 3xx 且带 Location = 跳转步（无 Location 的 3xx 当终点响应处理——落结果面）
      const location = current.headers.get('location');
      if (current.status >= 300 && current.status < 400 && location !== null) {
        redirects += 1;
        if (redirects > WEB_MAX_REDIRECTS) {
          throw new AppError(WEB_REDIRECT_LIMIT, `重定向超 ${WEB_MAX_REDIRECTS} 跳上限（终点未达）`);
        }
        let next: URL;
        try {
          next = new URL(location, finalUrl.href); // 相对 Location 基准解析
        } catch {
          throw new AppError(WEB_URL_INVALID, `重定向 Location 不可解析：${location}`);
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new AppError(WEB_URL_INVALID, `重定向协议不在白名单：${next.protocol}`);
        }
        // 每跳私网校验（重定向是 SSRF 向量——公网页 302 到内网地址的经典绕行）
        await assertPublicHost(next.hostname, deps.lookup);
        // 换主机 = 先还旧槽、置空持槽位、再取新槽（上限兜底跨主机链锁死）；
        // 同主机续持。槽序（m-1，20260901-c）：取槽抛出（排队中被取消）时
        // 持槽位保持 null——finally 不还从未取到的槽（旧行为 host 先行重赋值，
        // release 未 acquire 的新主机 → 限流账负漂）；刻意不「先取后放」——
        // 短暂双持两槽在全局帽下可死锁并发换轨者（与 download.ts 同形同修）。
        if (next.host !== host) {
          gates.release(host);
          heldHost = null;
          await gates.acquire(next.host, signal);
          heldHost = next.host;
          host = next.host;
        }
        finalUrl = next;
        continue;
      }
      response = current;
      break;
    }

    /* ---- 卫生件③：字节预算抓取（网络读 2 MiB 硬顶） ---- */
    const raw = await readBodyCapped(response.body, WEB_NETWORK_BUDGET_BYTES);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    // 形态转换（content-type 判定桶）：html 剥标签 / text 原文 / binary 空文本
    let truncated = raw.truncated;
    let text = '';
    let binary = false;
    const bucket = classifyContentType(contentType);
    if (bucket === 'binary') {
      binary = true; // 非文本不引二进制消费面——结构说明走结果面
    } else {
      const decoded = Buffer.concat(raw.chunks).toString('utf8');
      text = bucket === 'html' ? htmlToText(decoded) : decoded;
    }

    // 产出文本 60 KiB 保头截断（模型所见与落库同一文本——durable 预算同值对齐）
    if (!binary) {
      const head = truncateHead(text, WEB_TEXT_BUDGET_BYTES);
      text = head.text;
      truncated = truncated || head.truncated;
    }

    return {
      binary,
      result: {
        url: args.url,
        finalUrl: finalUrl.href,
        status: response.status,
        contentType,
        text,
        bytes: raw.bytes,
        truncated,
        redirects,
        durationMs: Date.now() - startedAt,
      },
    };
  } finally {
    if (heldHost !== null) gates.release(heldHost); // 只还实持槽（换轨中断时 null——账不漂移）
  }
}

/**
 * 工具面文本组装层（模型面 def 的 execute——服务面不走本层，直取 performFetch）。
 * 元数据头 + 正文；非 2xx / 非文本 = isError 结果面（模型可判断，不 throw）。
 */
export async function runWebFetch(
  args: { url: string; caller?: string },
  signal: AbortSignal | undefined,
  deps: WebFetchDeps,
): Promise<AgentToolResult> {
  const { result, binary } = await performFetch(args, signal, deps);
  const header =
    `[fetch ${result.status}] ${result.url} → ${result.finalUrl}` +
    `（${result.contentType || '未知类型'}，网络 ${result.bytes} 字节${result.truncated ? '，已截断' : ''}，` +
    `重定向 ${result.redirects} 跳，${result.durationMs}ms${args.caller ? `，调用方 ${args.caller}` : ''}）`;
  const details = { ...result, ...(args.caller ? { caller: args.caller } : {}) };
  if (binary) {
    return {
      content: [
        {
          type: 'text',
          text: `${header}\n非文本响应（${result.contentType}）——fetch 工具只消费文本面，二进制内容不引入`,
        },
      ],
      isError: true, // 结构化说明（非故障——模型改判资源形态用）
      details,
    };
  }
  const note = result.truncated ? '\n\n[产出超 60KiB 已保头截断]' : '';
  const isError = !(result.status >= 200 && result.status < 300);
  return {
    content: [{ type: 'text', text: `${header}${note}\n${'-'.repeat(16)}\n${result.text}` }],
    ...(isError ? { isError: true } : {}),
    details,
  };
}
