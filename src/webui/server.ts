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
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Type, Value } from '../contracts/typebox.js';
import type { AppLogger } from '../contracts/app.js';
import type { WebuiChannel } from './channel.js';
import type { PendingApprovals } from './approvals.js';
import { listWorkspaceFiles } from './files.js';
import {
  WEBUI_BODY_LIMIT_BYTES,
  WEBUI_REQUEST_ID_CACHE,
  WEBUI_SESSION_COOKIE,
  type WebuiAppDeps,
  type WebuiApprovalDecision,
  type WebuiSseEnvelope,
} from './types.js';

/** submit 请求体 schema（typebox schema-first 校验——端点面 POST 载荷两件之一） */
const SUBMIT_BODY_SCHEMA = Type.Object({
  text: Type.String({ minLength: 1, description: '用户消息文本（空串拒绝——与 TUI 输入面同语义）' }),
  // requestId（daemon 刀一·协议正确性层）：客户端重试幂等键——可选，携带且
  // 服务端近见即 200 去重回执不双投（客户端 onopen 恒重拉 + 网络重试窗）
  requestId: Type.Optional(Type.String({ maxLength: 64, description: '重试幂等键（同键重试不双投）' })),
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
 * token 常时比对（长度先核——timingSafeEqual 等长契约；长度差即 false 不入
 * 比对，长度本身非机密）
 */
function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * 请求鉴权（daemon 刀一·P1：Bearer ∪ cookie 两源同值）。Bearer = curl/TUI
 * attach 面；cookie = SPA 桥面（POST /api/auth 签发的 HttpOnly cookie，值 =
 * token 本身）。auth 由 app.ts 两源归一恒在场（daemon 注入 / 件自足一次性——
 * 复盘 S-1「监听 ⇒ 鉴权」）；本函数保持通用机制面（缺席不判的旧缺省已废）。
 */
function authorize(req: IncomingMessage, auth: { readonly token: string }): boolean {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ') && tokenEquals(header.slice(7), auth.token)) {
    return true;
  }
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === WEBUI_SESSION_COOKIE && tokenEquals(part.slice(eq + 1).trim(), auth.token)) {
        return true;
      }
    }
  }
  return false;
}

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
  /**
   * 鉴权物（app.ts 两源归一恒注入：daemon 形态 = 组合根持久 token；非 daemon
   * 监听形态 = 件自足进程内一次性 token——复盘 S-1「监听 ⇒ 鉴权」）。在场时
   * /api 族全量执法（豁免 /api/health 公开探活与 /api/auth 签发端点自身）
   */
  readonly auth?: { readonly token: string };
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
  /**
   * 诊断面（复盘 E-2 接线）：兜底 500 与静态回发流错误的留痕宿主——app.ts
   * 注入 ctx.logger（行作用域，随行回卷）。必填非可选：留痕是硬行为不是选配
   */
  readonly logger: AppLogger;
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

  // submit requestId 去重缓存（daemon 刀一：Map 插入序 LRU——超帽逐出最旧；
  // 服务级单份，跨会话共享〔requestId 客户端生成全局唯一约定〕）
  const requestIds = new Map<string, true>();

  const server = createServer((req, res) => {
    void handle(req, res, opts, hostWhitelist, originWhitelist, requestIds);
  });

  return {
    server,
    /**
     * 关停：停止收新连接，等在途请求/连接终结（SSE 连接由 channel.dispose 先毁——
     * 此处只收尾）。先杀空闲 keep-alive 连接（复盘 L-2 顺带）：close() 只停收
     * 新连、干等全部连接自灭——空闲 keep-alive 要拖满 keepAliveTimeout（缺省
     * 5s）才放行，关停面无谓迟滞
     */
    close: () =>
      new Promise<void>((done) => {
        server.closeIdleConnections();
        server.close(() => done());
      }),
  };
}

/** 单请求处理主管线：三防线 → 鉴权门 → 微路由（异常全收口 500，不裸抛进 http 层） */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebuiServerOptions,
  hostWhitelist: ReadonlySet<string>,
  originWhitelist: ReadonlySet<string>,
  requestIds: Map<string, true>,
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
    await route(req, res, url, opts, requestIds);
  } catch (err) {
    // 兜底收口（路由内已各自收 JSON 错——此处是未预期异常的最后一道）。
    // 留痕（复盘 E-2）：批量 500 若零痕迹 = 进程日志/durable/断言三者皆无
    // （违技术栈篇 §6 红线）——error 级落 stack
    opts.logger.error('webui 微路由兜底 500（未预期异常）', {
      method: req.method,
      url: req.url,
      error: err instanceof Error ? err.stack : String(err),
    });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'internal' }));
  }
}

/** 微路由（鉴权门 → 方法 + 路径分发；/api 族 JSON 应答、其余走静态分发） */
async function route(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: WebuiServerOptions,
  requestIds: Map<string, true>,
): Promise<void> {
  const { pathname } = url;

  // 鉴权门（daemon 刀一·P1 起为一切监听形态执法面——复盘 S-1「监听 ⇒ 鉴权」
  // 结构不变式；auth 由 app.ts 两源归一恒在场，条件式保留为机制面通用性）：
  // /api 族全量 401——前置于 SSE 升级（鉴权失败不占 channel 连接帽，防 16 帽
  // 被无 token 请求占满的 DoS 面）。豁免两端点：/api/health（公开探活——M4 两
  // 语义分立：它不构成活证）/ /api/auth（签发端点自身验 token）。静态资产不
  // 鉴权：SPA 壳先上屏、首屏引导贴 token 换 cookie（M1 ① 签发过鉴权）；GET /
  // 与静态不附 Set-Cookie（cookie 只在 /api/auth 应答头出现）
  if (
    opts.auth !== undefined &&
    pathname.startsWith('/api/') &&
    pathname !== '/api/health' &&
    pathname !== '/api/auth' &&
    !authorize(req, opts.auth)
  ) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  // cookie 签发端点（daemon 刀一·M1 ① 签发过鉴权）：Bearer（或既有合法
  // cookie）验证通过 → 签发 HttpOnly cookie。cookie 值 = token 本身（两源
  // 同值判据）；HttpOnly 断脚本读、SameSite=Strict 断跨源携带、Path=/ 全径、
  // 无 Domain（回环无域可授权）无 Secure（回环明文 http）——红线：token 不
  // 进 URL/查询参数/CLI 参数（history/Referer/ps 泄露链）
  if (pathname === '/api/auth' && req.method === 'POST') {
    if (opts.auth === undefined || !authorize(req, opts.auth)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${WEBUI_SESSION_COOKIE}=${opts.auth.token}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    // 公开探活（M4 ①：无 token 可达——「活证」须 token 端点真握手，两语义
    // 分立）；cordon 降级披露（D6：ok 仍 true〔进程活〕+ degraded 字段——
    // durable 落盘失败降级态对 operator 可见）；write-behind 运行态披露
    // （基建大扫 #27：闩态 + 积压两数——闩红积绿两独立判读，消费方 doctor
    // ⑧⑨；deps 未传 = 无持久层诊断形态，键缺席）；进程内存披露（基建大扫
    // #49：rss/heapUsed/uptimeMs 恒在场——node 进程零依赖自报，与 deps 无关
    // 故不缺席；消费方 doctor ⑩——两级拓扑 RSS > 1GB 挂账触发器的观测锚点）；
    // obs 观测健康披露（P1-11：摄取在跑与否 + lastFlushAt——消费方 doctor ②；
    // 取值 undefined = obs 行未装/重装窗，键缺席即「观测面无信息」）
    const mem = process.memoryUsage();
    sendJson(res, 200, {
      ok: true,
      version: opts.version,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        // 进程存活时长（毫秒）——常驻内存增长的时长分母
        uptimeMs: Math.round(process.uptime() * 1000),
      },
      ...(opts.deps.cordoned?.() === true ? { degraded: 'persistence' } : {}),
      ...(opts.deps.writeBehindStats ? { writeBehind: opts.deps.writeBehindStats() } : {}),
      ...(opts.deps.obsHealth ? { obs: opts.deps.obsHealth() } : {}),
    });
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
    // cordon 拒面（daemon 刀一·D6）：降级期拒新写意图——「服务看着在、账必
    // 丢」不如响亮拒。decide/interrupt/SSE/读面可达不拒（operator 收场面保全）
    if (opts.deps.cordoned?.() === true) {
      sendJson(res, 503, { error: 'cordoned' });
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
    // cordon 拒面（daemon 刀一·D6）：同开新会话端点——新写意图拒 503
    if (opts.deps.cordoned?.() === true) {
      sendJson(res, 503, { error: 'cordoned' });
      return;
    }
    // requestId 命中早退（daemon 刀一·协议正确性层）：同键重试（网络重发/
    // 断线重连窗）回 200 去重回执不双投——客户端按 accepted 语义幂等收场
    const requestId = (parsed as { requestId?: string }).requestId;
    if (requestId !== undefined && requestIds.has(requestId)) {
      sendJson(res, 200, { ok: true, deduplicated: true });
      return;
    }
    // 目标不存在或已闭（retired）= 404（冷读 m3：已闭会话 v1 只读，复活面挂刀三）
    const channel = opts.deps.submitTo(decodeSegment(submit[1]!), (parsed as { text: string }).text);
    if (channel === null) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    // requestId 记账：成功投递后才记——404 路不记账（会话晚活可重投）。超帽
    // 按 Map 插入序逐出最旧（粗粒度 LRU——重试窗短够用）
    if (requestId !== undefined) {
      requestIds.set(requestId, true);
      if (requestIds.size > WEBUI_REQUEST_ID_CACHE) {
        const oldest = requestIds.keys().next().value;
        if (oldest !== undefined) requestIds.delete(oldest);
      }
    }
    // 响应体携带投递通道（刀 1 远程腿机器面同律——steer/followUp/inject 服务端
    // 真值不丢在 HTTP 边界；attach/Web 呈现面回执行 v1 豁免挂账，客户端暂不消费）
    sendJson(res, 202, { ok: true, channel });
    return;
  }
  // 打断在飞 run（daemon 刀一·协议正确性层 = POST /api/sessions/:id/interrupt）：
  // driver.interrupt——abort 当轮 run（捎跑续批不传染，与 TUI Ctrl+C 打断同源
  // 面）；目标不在册/已闭/无在飞 run = 404
  const interrupt = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(pathname);
  if (interrupt !== null && req.method === 'POST') {
    if (opts.deps.interruptFor === undefined) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const interrupted = opts.deps.interruptFor(decodeSegment(interrupt[1]!));
    sendJson(res, interrupted ? 200 : 404, interrupted ? { interrupted: true } : { error: 'session not found' });
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
    await serveStatic(res, pathname, opts.staticRoot, req.method === 'HEAD', opts.logger);
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
 *
 * 超帽后必须丢弃式继续消费至流自然 end 再返回（遗漏大扫 20260904-b F-1）：
 * 早退会让 413 应答早于请求体收尾到达，而真实客户端（node:http 全局池
 * keep-alive / 浏览器 fetch 同族）对「应答已完而写腿未完」的收场 = 中止写腿
 * 销毁 socket（RST）——连接池里紧邻的下一请求吃 ECONNRESET 连坐，更糟变体
 * 连 413 本身都丢（1MB 体五轮三轮实测命中）。丢弃式消费保证**应答永不早于
 * 体收完**——客户端写腿恒先收场，池连接恒干净；内存仍只累积帽内字节。
 *
 * @returns undefined = 超帽；字符串 = 全体 UTF-8 文本
 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  let overLimit = false;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > WEBUI_BODY_LIMIT_BYTES) {
      // 超帽：只翻旗不早退——继续消费到自然 end（见函数头注释，早退=连接池连坐病根）
      overLimit = true;
    } else {
      chunks.push(chunk as Buffer);
    }
  }
  return overLimit ? undefined : Buffer.concat(chunks).toString('utf8');
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
  logger: AppLogger,
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
      // setHeader 而非 writeHead：首块写出时才冲隐式 200 头——源流错误发生在
      // 冲头前时仍可改道干净 JSON 应答（writeHead 会提前锁死状态行）
      res.setHeader('Content-Type', type);
      if (headOnly) {
        res.end();
        return;
      }
      // 流式回发（pipe 管背压——assets 大文件不整读进内存）。源流错误腿先挂
      // （复盘 L-2）：pipe 不消费 source 的 error——stat→open 竞窗（升级覆盖
      // dist/重装）或读中错误（EACCES/EIO/截断）无人收即 uncaughtException
      // 打死宿主（signals 兜底 exit(1)，daemon 常驻形态全体陪葬）。两腿收口：
      // 头未冲（首块未发）= 干净 JSON 应答（ENOENT 404 / 其余 500）；头已冲
      // = 截断终结（socket 已写 200 无法收回，诚实截断）——两腿都 warn 留痕
      const source = createReadStream(candidate);
      source.on('error', (err: NodeJS.ErrnoException) => {
        logger.warn(`webui 静态资产回发失败：${candidate}（${err.code ?? '?'} ${err.message}）`);
        source.destroy();
        if (!res.headersSent) {
          sendJson(res, err.code === 'ENOENT' ? 404 : 500, { error: 'static read failed' });
        } else {
          res.end();
        }
      });
      // 客户端中止腿（遗漏大扫 20260902 #6）：pipe 语义只对 dest unpipe 不销毁
      // source——大资产传输中途断开时源流停在背压暂停态，fd 与已缓冲数据无限期
      // 驻留（daemon 常驻形态反复中止可累积）。res 'close' 即刻销毁源流（正常
      // 传完时 source 已 end，destroy 幂等无害）
      res.on('close', () => source.destroy());
      source.pipe(res);
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
