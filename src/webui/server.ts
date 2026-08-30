/**
 * L3 webui — HTTP 服务面（契约篇 §6.8：node:http 手写微路由 + typebox
 * schema-first 参数校验——§2.2 定稿形态的第一消费者；零新增依赖）。
 *
 * 鉴权与绑定三防线（技术栈篇 §4.4 单机闭环，全部请求先过再路由）：
 * ①绑定防线在 app.ts 装配期（非回环 host = 拒启，本文件只见合法值）；
 * ②Host 头白名单（DNS rebinding 防线——rebind 后浏览器请求的 Host 是攻击者
 *   域名，按字面拒）；③Origin 硬防线（浏览器跨源请求；无 Origin 头放行 =
 *   curl/本地 CLI 消费面兼容——防线判的是浏览器跨源不是非浏览器客户端）。
 * 白名单值域三值对称（冷读 B2 勘正：防线① 允许显式 ::1 回环绑定，Host/
 * Origin 白名单缺 [::1] 形态则该配置下同源 SPA 全死）。
 *
 * 静态分发（SPA）：路径归一 + 根包含防穿越；未知路径回落 index.html（SPA
 * 路由惯例）。dist/webui 缺席（dev 形态）= 静态路径 404 + /api 面照常——
 * 诊断态不拒启。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Type, Value } from '../contracts/typebox.js';
import type { WebuiChannel } from './channel.js';
import type { PendingApprovals } from './approvals.js';
import { listWorkspaceFiles } from './files.js';
import {
  WEBUI_BODY_LIMIT_BYTES,
  type WebuiAppDeps,
  type WebuiApprovalDecision,
  type WebuiSseEnvelope,
} from './types.js';

/** submit 请求体 schema（typebox schema-first 校验——端点面 POST 载荷两件之一） */
const SUBMIT_BODY_SCHEMA = Type.Object({
  text: Type.String({ minLength: 1, description: '用户消息文本（空串拒绝——与 TUI 输入面同语义）' }),
});

/** decide 请求体 schema（刀三：decision 闭集值域校验在路由层——400 同码同因） */
const DECIDE_BODY_SCHEMA = Type.Object({
  decision: Type.String({ minLength: 1, description: "应答闭集 'approve' | 'reject' | 'always'" }),
});

/** decide 闭集（web 应答面——TUI 四值减 cancel：cancel 无 web 产出面，spec 钉死） */
const DECIDE_CLOSED_SET: readonly WebuiApprovalDecision[] = ['approve', 'reject', 'always'];

/** 静态文件扩展名 → Content-Type 小表（SPA 资产面；未命中走八进制流兜底） */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * 绑定防线① 的值域判定（app.ts 装配期执法面——三值与 Host/Origin 白名单
 * 对称：127.0.0.1 / localhost / ::1；IPv6 方括号形态剥壳后比对）。
 * @returns true = 合法回环绑定值
 */
export function isLoopbackBindValue(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/** 服务构造参数（app.ts 装配期一次给齐；listen 由调用方驱动——本面只造不启） */
export interface WebuiServerOptions {
  /** 监听端口（已解析缺省——Host/Origin 白名单与它同源拼装） */
  readonly port: number;
  /** 监听地址（已过绑定防线①的回环值） */
  readonly host: string;
  /** 宿主面闭包（清单/投影/提交三取数腿） */
  readonly deps: WebuiAppDeps;
  /** SSE 连接扇出面（GET /api/events 升级产物归它管理） */
  readonly channel: WebuiChannel;
  /** pending 审批登记簿（刀三两端点消费面——app.ts apply 期构造传入） */
  readonly approvals: PendingApprovals;
  /** SPA 静态资产根（dist/webui 目录本体——tsc 宿主侧产物与 vite 产物同目录共存） */
  readonly staticRoot: string;
  /** /api/health 报告的宿主版本号（app/version.ts 同源） */
  readonly version: string;
}

/**
 * 造 HTTP 服务（不 listen——app.ts apply 内 await listen，EADDRINUSE 在彼处
 * 映射 WEBUI_PORT_IN_USE 拒启）。返回 server 本体 + 关停面。
 */
export function createWebuiServer(opts: WebuiServerOptions): { server: Server; close: () => Promise<void> } {
  const hostWhitelist = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  // Origin 白名单与 Host 白名单三值对称（B2：::1 绑定下同源 Origin 序列化即 http://[::1]:port）
  const originWhitelist = new Set([
    `http://127.0.0.1:${opts.port}`,
    `http://localhost:${opts.port}`,
    `http://[::1]:${opts.port}`,
  ]);

  const server = createServer((req, res) => {
    void handle(req, res, opts, hostWhitelist, originWhitelist);
  });

  return {
    server,
    /** 关停：停止收新连接，等在途请求/连接终结（SSE 连接由 channel.dispose 先毁——此处只收尾） */
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

/** 单请求处理主管线：三防线 → 微路由（异常全收口 500，不裸抛进 http 层） */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebuiServerOptions,
  hostWhitelist: ReadonlySet<string>,
  originWhitelist: ReadonlySet<string>,
): Promise<void> {
  try {
    // 防线② Host 头白名单（HTTP/1.1 必带；缺失/白名单外一律 403）
    const host = req.headers.host;
    if (typeof host !== 'string' || !hostWhitelist.has(host)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }
    // 防线③ Origin 硬防线（带 Origin 头且白名单外 = 403；无头放行——curl/CLI 面）
    const origin = req.headers.origin;
    if (origin !== undefined && !originWhitelist.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'forbidden origin' }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    await route(req, res, url, opts);
  } catch (err) {
    // 兜底收口（路由内已各自收 JSON 错——此处是未预期异常的最后一道）
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'internal' }));
    void err; // 诊断面由宿主 logger 承担（app.ts 侧 wired 日志），本面不重复
  }
}

/** 微路由（方法 + 路径分发；/api 族 JSON 应答、其余走静态分发） */
async function route(req: IncomingMessage, res: ServerResponse, url: URL, opts: WebuiServerOptions): Promise<void> {
  const { pathname } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, version: opts.version });
    return;
  }
  if (pathname === '/api/sessions' && req.method === 'GET') {
    sendJson(res, 200, opts.deps.sessionsFor());
    return;
  }
  // 开新会话（刀二 = SPA 新开按钮消费面）：body v1 恒空 `{}`——解析成功即可，
  // 内容不校验不消费（未来扩展字段时再升 schema）。openSession() 一条龙
  // （默认应用解析/驻留/切前台）全在组合根闭包内，服务面只译状态码
  if (pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readBody(req);
    if (body === undefined) {
      sendJson(res, 413, { error: 'body too large' });
      return;
    }
    try {
      JSON.parse(body === '' ? '{}' : body);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    const summary = await opts.deps.openSession();
    if (summary === undefined) {
      // 两因严合 503：无持久层 / 默认应用兜底态（开不出新会话——服务降级非 404）
      sendJson(res, 503, { error: 'session open unavailable' });
      return;
    }
    sendJson(res, 201, summary);
    return;
  }
  // todo 常驻面板数据源（刀二）：foldCurrentTodo 归一产物——null = 无表（合法
  // 档，前端收起面板）；undefined = 会话不在册（404）。已闭会话由组合根闭包
  // 走 store 装载只读派生，服务面对两腿同形
  const todo = /^\/api\/sessions\/([^/]+)\/todo$/.exec(pathname);
  if (todo !== null && req.method === 'GET') {
    const items = opts.deps.todoFor(decodeSegment(todo[1]!));
    if (items === undefined) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    sendJson(res, 200, { todo: items });
    return;
  }
  const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
  if (messages !== null && req.method === 'GET') {
    // 拉投影腿（通道契约——SPA focus 换装全量重拉同 TUI 清屏重画语义）
    const history = opts.deps.historyFor(decodeSegment(messages[1]!));
    if (history === undefined) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    sendJson(res, 200, { messages: history });
    return;
  }
  const submit = /^\/api\/sessions\/([^/]+)\/submit$/.exec(pathname);
  if (submit !== null && req.method === 'POST') {
    const body = await readBody(req);
    if (body === undefined) {
      sendJson(res, 413, { error: 'body too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body === '' ? '{}' : body);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    if (!Value.Check(SUBMIT_BODY_SCHEMA, parsed)) {
      sendJson(res, 400, { error: 'invalid body' });
      return;
    }
    // 目标不存在或已闭（retired）= 404（冷读 m3：已闭会话 v1 只读，复活面挂刀三）
    const ok = opts.deps.submitTo(decodeSegment(submit[1]!), (parsed as { text: string }).text);
    if (!ok) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    sendJson(res, 202, { ok: true });
    return;
  }
  // 未决审批清单（刀三 = GET /api/approvals）：registry 已决过滤产物——刷新/
  // 晚连接的卡片恢复面与侧栏角标面数据源
  if (pathname === '/api/approvals' && req.method === 'GET') {
    sendJson(res, 200, { approvals: opts.approvals.list() });
    return;
  }
  // 审批应答（刀三 = POST /api/approvals/:id/decide）：值域校验 400 / always
  // 无草案 400 / 已决 superseded / 槽不存在 404（已决保留使竞窗不存在——
  // 竞窗闭合论证见 approvals.ts 模块头）
  const decide = /^\/api\/approvals\/([^/]+)\/decide$/.exec(pathname);
  if (decide !== null && req.method === 'POST') {
    const body = await readBody(req);
    if (body === undefined) {
      sendJson(res, 413, { error: 'body too large' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body === '' ? '{}' : body);
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    if (!Value.Check(DECIDE_BODY_SCHEMA, parsed)) {
      sendJson(res, 400, { error: 'invalid body' });
      return;
    }
    const decision = (parsed as { decision: string }).decision;
    if (!DECIDE_CLOSED_SET.includes(decision as WebuiApprovalDecision)) {
      sendJson(res, 400, { error: 'invalid decision' }); // 闭集外（含 cancel——无 web 产出面）
      return;
    }
    const approvalId = decodeSegment(decide[1]!);
    const entry = opts.approvals.pending(approvalId);
    if (entry === undefined) {
      // 未决条目不在：槽从未存在或已决——decide 内部再判一次（TOCTOU 无害：
      // pending→decide 间条目只可能由未决转已决，decide 自回 superseded）
      const judged = opts.approvals.decide(approvalId, decision as WebuiApprovalDecision);
      if (judged === undefined) sendJson(res, 404, { error: 'approval not found' });
      else sendJson(res, 200, { accepted: false, reason: 'superseded' });
      return;
    }
    if (decision === 'always' && entry.suggestedEntry === undefined) {
      sendJson(res, 400, { error: 'always requires suggested entry' }); // 三态面只在草案在场时呈现——无草案恒 400
      return;
    }
    const judged = opts.approvals.decide(approvalId, decision as WebuiApprovalDecision);
    if (judged === undefined) {
      sendJson(res, 404, { error: 'approval not found' }); // pending→decide 竞速转已决外的不存在（防御位）
      return;
    }
    sendJson(res, 200, judged.accepted ? { accepted: true } : { accepted: false, reason: judged.reason });
    return;
  }
  // 工作区文件补全（刀三 @-mention 第一段 = GET /api/workspace/files?prefix=）：
  // 行走锚 = deps.workspaceRoot 原始 workspace（canonical 差集 v1 不入补全面）
  if (pathname === '/api/workspace/files' && req.method === 'GET') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const files = await listWorkspaceFiles(opts.deps.workspaceRoot(), prefix);
    sendJson(res, 200, { files });
    return;
  }
  // 工作区符号补全（刀三 @-mention 第二段 = GET /api/workspace/symbols?path=）：
  // 晚绑桥缺席腿（无路由/熔断/文件不在盘）= 404；warming 档如实透传（前端提示）
  if (pathname === '/api/workspace/symbols' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path') ?? '';
    const query = await opts.deps.symbolsFor(rawPath);
    if (query === undefined) {
      sendJson(res, 404, { error: 'no symbols' });
      return;
    }
    sendJson(res, 200, query);
    return;
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    upgradeSse(res, opts);
    return;
  }
  if (pathname.startsWith('/api/')) {
    // API 族未知路径（含方法不符）——JSON 面 404，不落静态回落
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(res, pathname, opts.staticRoot, req.method === 'HEAD');
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

/** SSE 升级（GET /api/events）：连接帽执法在前（超帽 503），再开帧头注册连接 */
function upgradeSse(res: ServerResponse, opts: WebuiServerOptions): void {
  const conn = opts.channel.register(res);
  if (conn === undefined) {
    sendJson(res, 503, { error: 'too many connections' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // 反代缓冲关断（本机直连无反代也无害——标准 SSE 卫生头）
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  // 初始欢迎帧（连接即当下——v1 无重放游标，历史走拉投影腿）
  const hello: WebuiSseEnvelope = { kind: 'status', payload: { status: 'connected' } };
  conn.writeFrame(hello);
}

/**
 * 读 POST 请求体（字节帽 256KiB——submit 文本远小于此，超帽 413 由调用方应答）。
 * @returns undefined = 超帽；字符串 = 全体 UTF-8 文本
 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > WEBUI_BODY_LIMIT_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON 应答（Content-Type 固定 utf-8；整体单次 stringify 同 SSE 帧纪律） */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** 路径段解码（%XX 还原；坏序列按 404 收——不抛出路由层） */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 静态分发（SPA）：路径归一（decode + null 字节/相对段拒绝）→ 根包含防穿越
 * （resolve 后必须仍在 staticRoot 内）→ 命中文件即流式回发；未命中回落
 * index.html（SPA 路由惯例）；index 缺席（dev 形态未构建）= 404 诊断态。
 */
async function serveStatic(
  res: ServerResponse,
  pathname: string,
  staticRoot: string,
  headOnly: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (decoded.includes('\0') || decoded.split('/').some((seg) => seg === '..')) {
    sendJson(res, 404, { error: 'not found' }); // 穿越载荷按不存在收（不披露判定细节）
    return;
  }
  // 根包含防穿越：resolve 归一后必须以 staticRoot 为前缀（sep 边界防 homedir 式前缀碰撞）
  const root = resolve(staticRoot);
  const target = resolve(join(root, decoded));
  if (target !== root && !target.startsWith(root + sep)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  // 命中即回发；目录或未命中回落 index.html（'/' 与 SPA 路由路径都走这条）
  const candidates =
    target.endsWith(sep) || target === root ? [join(root, 'index.html')] : [target, join(root, 'index.html')];
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      const type = CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      if (headOnly) {
        res.end();
        return;
      }
      // 流式回发（createReadStream 自动管背压——assets 大文件不整读进内存）
      createReadStream(candidate).pipe(res);
      return;
    }
  }
  sendJson(res, 404, { error: 'webui assets not built' });
}

/** 是普通文件吗（stat 单查——目录/缺失/符号链接断链都算未命中） */
async function isFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
