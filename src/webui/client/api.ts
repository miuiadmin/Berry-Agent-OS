/**
 * 服务面取数腿（fetch 封装——七端点中的五消费面）。错误统一抛 ApiError，
 * 组件层 catch 收进状态条展示，不打断 UI。
 *
 * URL 恒相对路径：生产形态 SPA 由宿主 webui 件同源直发（静态分发）；开发
 * 形态经 vite dev server 的 /api 代理转发到宿主端口。
 */

import type { ProjectedMessage, SessionSummary, TodoItem } from './types';

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
