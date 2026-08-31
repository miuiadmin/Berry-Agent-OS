/**
 * 服务面取数腿（fetch 封装——七端点中的五消费面）。错误统一抛 ApiError，
 * 组件层 catch 收进状态条展示，不打断 UI。
 *
 * URL 恒相对路径：生产形态 SPA 由宿主 webui 件同源直发（静态分发）；开发
 * 形态经 vite dev server 的 /api 代理转发到宿主端口。
 */

import type {
  ApprovalDecision,
  PendingApproval,
  ProjectedMessage,
  SessionSummary,
  SymbolQuery,
  TodoItem,
} from './types';

/** 服务面非 2xx 应答（status 原样透出——404/503 等在 UI 有区分文案） */
export class ApiError extends Error {
  constructor(
    /** HTTP 状态码 */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET JSON 应答（非 2xx 即抛——本面全部端点应答体都是 JSON） */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, `GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** 会话清单（活条目 ∪ 近史两源合并——组合根组装） */
export function fetchSessions(): Promise<SessionSummary[]> {
  return getJson<SessionSummary[]>('/api/sessions');
}

/** 消息投影（拉投影腿——SPA 渲染唯一真相源） */
export function fetchMessages(sessionId: string): Promise<ProjectedMessage[]> {
  return getJson<{ messages: ProjectedMessage[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages`).then(
    (body) => body.messages,
  );
}

/** todo 折叠（null = 无表——面板收起；404 抛 ApiError） */
export function fetchTodo(sessionId: string): Promise<TodoItem[] | null> {
  return getJson<{ todo: TodoItem[] | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/todo`).then(
    (body) => body.todo,
  );
}

/** 提交用户消息（202 fire-and-forget——轮次活态走 SSE，应答不等轮次） */
export async function submitMessage(sessionId: string, text: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new ApiError(res.status, `submit → ${res.status}`);
}

/**
 * 开新会话（body v1 恒空 {}——默认应用解析/驻留/切前台全在服务端一条龙）。
 * 503（无持久层/默认应用兜底态）抛 ApiError 由调用方出文案。
 */
export async function openSession(): Promise<SessionSummary> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new ApiError(res.status, `open session → ${res.status}`);
  return (await res.json()) as SessionSummary;
}

/** 未决审批清单（刀三——刷新/晚连接的卡片与角标恢复面） */
export function fetchApprovals(): Promise<PendingApproval[]> {
  return getJson<{ approvals: PendingApproval[] }>('/api/approvals').then((body) => body.approvals);
}

/**
 * 一次性引导（daemon 刀一·M1 消费面，复盘 #45）：贴 token 走 Bearer 验证换
 * HttpOnly cookie（应答 Set-Cookie 由浏览器自动种上——此后同源 fetch /
 * EventSource 恒携 cookie）。401 = token 不符。
 */
export async function authBootstrap(token: string): Promise<void> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(res.status, `auth → ${res.status}`);
}

/**
 * 打断在飞 run（daemon 刀一·interrupt 端点的 SPA 消费面，复盘 #48）——与
 * TUI Ctrl+C 同源 driver.interrupt 面。404 = 目标不在册 / 已闭 / 无在飞 run。
 */
export async function interruptSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, `interrupt → ${res.status}`);
}

/**
 * 审批应答（刀三——只 resolve registry resolver，durable 写在服务端单写漏斗）。
 * @returns accepted:false = 已被 TUI 先决（superseded 幂等回执，不二次落账）
 */
export async function decideApproval(id: string, decision: ApprovalDecision): Promise<{ accepted: boolean }> {
  const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw new ApiError(res.status, `decide → ${res.status}`);
  return (await res.json()) as { accepted: boolean };
}

/** 工作区文件补全（刀三 @-mention 第一段——前缀匹配 ≤50 条，目录也可补全） */
export function fetchFiles(prefix: string): Promise<string[]> {
  return getJson<{ files: string[] }>(`/api/workspace/files?prefix=${encodeURIComponent(prefix)}`).then(
    (body) => body.files,
  );
}

/**
 * 工作区符号补全（刀三 @-mention 第二段——LSP documentSymbol 投影）。
 * @returns null = 404 降级档（无路由/根外/熔断/文件不在盘——SPA 只留文件段）
 */
export async function fetchSymbols(path: string): Promise<SymbolQuery | null> {
  try {
    return await getJson<SymbolQuery>(`/api/workspace/symbols?path=${encodeURIComponent(path)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}
