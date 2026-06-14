/**
 * API 客户端层。
 *
 * 提供 GET/POST/PUT/DELETE 封装 + React Query query 工厂 + 各领域 API 集合。
 * 统一错误处理、AbortSignal 透传、降级兜底。
 */

const BASE_URL = "";

import { tOutside as t } from "@/lib/i18n";
import type { QueryFunctionContext } from "@tanstack/react-query";

// ─── 通用 fetch 封装 ──────────────────────────────────────────────

/** 判断是否为 AbortError（请求被取消） */
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * 通用 fetch 封装。
 * 统一处理：网络错误、HTTP 错误码、AbortError 透传。
 */
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json", ...options?.headers },
      ...options,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(t("api.networkError"));
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
      else if (body.message) message = body.message;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = text;
    }
    throw new Error(message);
  }
  return res.json();
}

// ─── HTTP 方法封装 ────────────────────────────────────────────────

/** GET 请求，支持 AbortSignal */
export function apiGet<T>(path: string, signal?: AbortSignal) {
  return fetchApi<T>(path, signal ? { signal } : undefined);
}

/** PUT 请求 */
export function apiPut<T>(path: string, body: unknown, signal?: AbortSignal) {
  return fetchApi<T>(path, { method: "PUT", body: JSON.stringify(body), signal });
}

/** POST 请求（body 可选） */
export function apiPost<T>(path: string, body?: unknown, signal?: AbortSignal) {
  return fetchApi<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, signal });
}

/** DELETE 请求 */
export function apiDelete(path: string, signal?: AbortSignal) {
  return fetchApi<void>(path, { method: "DELETE", signal });
}

// ─── Query 工厂辅助 ──────────────────────────────────────────────

/** 构建 URL 查询参数（从键值对对象） */
function buildSearchParams(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * 带降级兜底的 queryFn 包装器。
 * 捕获非 AbortError 异常并返回 fallback 值，避免查询失败阻塞页面。
 */
function withFallback<T>(fetcher: (signal: AbortSignal) => Promise<T>, fallback: T) {
  return async (ctx: QueryFunctionContext): Promise<T> => {
    try {
      return await fetcher(ctx.signal);
    } catch (e) {
      if (isAbortError(e)) throw e;
      return fallback;
    }
  };
}

// ─── 类型定义 ──────────────────────────────────────────────────────

export interface HealthResponse {
  ok: boolean;
  uptime: number;
  agents: number;
  logLevel: string;
  debugMode: boolean;
}

export interface AgentInfo {
  name: string;
  status: string;
  description?: string;
  kind?: string;
  version?: string;
}

export interface TaskInfo {
  id: string;
  taskType: string;
  /** 任务状态：与后端 TaskStatus 枚举对齐（见 TASK_STATUS_VALUES）。
   *  类型保留为 string 以兼容后端未来新增状态，不强制收敛为联合类型。 */
  status: string;
  targetAgent: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  inputPayload?: string;
  outputPayload?: string;
  error?: string;
}

/**
 * 已知的 Task 状态枚举（与后端 TaskStatus 常量对齐）。
 * 集中定义避免各页面（如 TasksPage 的筛选下拉）各自硬编码一份字符串数组，
 *  防止后端新增状态（如 'paused'）时前端漏更新选项。
 *  TaskInfo.status 仍保留 string 类型——后端未来新增值不会破坏编译，
 *  此处只是"已知值清单"用于驱动 UI 选项。
 */
export const TASK_STATUS_VALUES = [
  "created",
  "dispatched",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "resumable",
] as const;
/** 已知任务状态联合类型（用于精确标注，但 TaskInfo.status 仍为 string 兼容新值） */
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export interface ConversationInfo {
  sessionId: string;
  messageCount: number;
  lastActive: string;
  firstMessage?: string;
  title?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

export interface TaskStatsDay { date: string; completed: number; failed: number; }

export interface SearchResult { sessionId: string; content: string; role: string; createdAt: number; highlight: string; }
export interface SearchResponse { results: SearchResult[]; total: number; }

export interface UsageDaySummary { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; }
export interface UsageDailyPoint extends UsageDaySummary { date: string; cacheReadTokens: number; cacheCreationTokens: number; }
export interface UsageSummary {
  today: UsageDaySummary;
  period: UsageDaySummary;
  daily: UsageDailyPoint[];
  byAgent: { agentName: string; totalTokens: number; costUsd: number }[];
  byModel: { model: string; totalTokens: number; costUsd: number }[];
}

export interface UploadResponse { fileId: string; filename: string; mimeType: string; size: number; url: string; }

export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  layer: "agent" | "workspace" | "global";
  source?: string;
  agentId?: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt?: number;
  verified?: boolean;
}

export interface MemoryRecallResult { results: MemoryEntry[]; total: number; }
export interface MemoryBinding { agentId: string; memoryId: string; createdAt: number; }

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body?: string;
  targetId?: string;
  targetType?: string;
  read: boolean;
  archived: boolean;
  createdAt: number;
}

export interface NotificationPreferences { workspaceId: string; muted: boolean; channels: string[]; }

export interface PluginInfo { id: string; name: string; description?: string; version?: string; enabled: boolean; scope: "agent" | "workspace" | "global"; }
export interface PluginBinding { agentId: string; pluginId: string; enabled: boolean; }

export interface CaptureStartResponse { captureId: string; path: string; }
export interface CaptureResult { captureId: string; path: string; durationMs: number; eventCount: number; size: number; }
export interface CaptureStatus { active: boolean; captureId?: string; startedAt?: number; }

// ─── 降级兜底常量 ──────────────────────────────────────────────────

const EMPTY_USAGE: UsageSummary = {
  today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  period: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  daily: [], byAgent: [], byModel: [],
};

const EMPTY_DRIFT = { avgAlignmentScore: 1, interventionRate: 0, recoveryRate: 0, finalResponseAlignment: 1, totalSignals: 0, hotspotPairs: [] };

// ─── React Query queries 工厂 ─────────────────────────────────────

export const queries = {
  health: () => ({
    queryKey: ["health"],
    queryFn: (ctx: QueryFunctionContext) => apiGet<HealthResponse>("/api/health", ctx.signal),
  }),
  config: () => ({
    queryKey: ["config"],
    queryFn: (ctx: QueryFunctionContext) => apiGet<Record<string, unknown>>("/api/config", ctx.signal),
  }),
  agents: () => ({
    queryKey: ["agents"],
    queryFn: (ctx: QueryFunctionContext) => apiGet<AgentInfo[]>("/api/agents", ctx.signal),
  }),
  agent: (name: string) => ({
    queryKey: ["agents", name],
    queryFn: (ctx: QueryFunctionContext) => apiGet<AgentInfo>(`/api/agents/${name}`, ctx.signal),
  }),
  taskStats: (days = 7) => ({
    queryKey: ["taskStats", days],
    queryFn: withFallback(
      (signal) => apiGet<TaskStatsDay[]>(`/api/tasks/stats?days=${days}`, signal),
      [] as TaskStatsDay[],
    ),
  }),
  tasks: (params?: { status?: string; agent?: string; limit?: number; offset?: number }) => ({
    queryKey: ["tasks", params],
    queryFn: (ctx: QueryFunctionContext) =>
      apiGet<PaginatedResponse<TaskInfo>>(`/api/tasks${buildSearchParams(params as Record<string, string | number | undefined>)}`, ctx.signal),
  }),
  conversations: (params?: { search?: string; sort?: string; limit?: number; offset?: number }) => ({
    queryKey: ["conversations", params],
    queryFn: (ctx: QueryFunctionContext) =>
      apiGet<ConversationInfo[]>(`/api/conversations${buildSearchParams(params as Record<string, string | number | undefined>)}`, ctx.signal),
  }),
  conversation: (sid: string) => ({
    queryKey: ["conversations", sid],
    queryFn: (ctx: QueryFunctionContext) => apiGet<unknown[]>(`/api/conversations/${sid}`, ctx.signal),
  }),
  search: (q: string, limit = 20) => ({
    queryKey: ["search", q, limit],
    queryFn: async (ctx: QueryFunctionContext): Promise<SearchResponse> => {
      if (!q.trim()) return { results: [], total: 0 };
      return apiGet<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, ctx.signal);
    },
    enabled: q.trim().length > 0,
  }),
  usage: (days = 7) => ({
    queryKey: ["usage", days],
    queryFn: withFallback(
      (signal) => apiGet<UsageSummary>(`/api/usage/summary?days=${days}`, signal),
      EMPTY_USAGE,
    ),
  }),
  drift: (days = 7) => ({
    queryKey: ["drift", days],
    queryFn: withFallback(
      (signal) => apiGet<{
        avgAlignmentScore: number; interventionRate: number; recoveryRate: number;
        finalResponseAlignment: number; totalSignals: number;
        hotspotPairs: Array<{ from: string; to: string; avgScore: number }>;
      }>(`/api/drift/metrics?days=${days}`, signal),
      EMPTY_DRIFT,
    ),
  }),
  driftSignals: (sessionId?: string) => ({
    queryKey: ["driftSignals", sessionId],
    queryFn: withFallback(
      (signal) => apiGet<{
        signals: Array<{
          id: string; checkpointType: string; alignmentScore: number;
          needsIntervention: boolean; driftDescription: string | null;
          suggestedAction: string | null; createdAt: number;
        }>;
        total: number;
      }>(`/api/drift/signals${sessionId ? `?sessionId=${sessionId}&limit=50` : "?limit=50"}`, signal),
      { signals: [], total: 0 },
    ),
  }),
};

// ─── 文件上传 ──────────────────────────────────────────────────────

/** 上传文件，支持 AbortSignal 取消 */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: formData, signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error || t("api.uploadFailed", { status: String(res.status) }));
  }
  return res.json();
}

export async function renameConversation(sessionId: string, title: string): Promise<void> {
  await apiPut(`/api/conversations/${sessionId}`, { title });
}

export async function exportConversation(sessionId: string): Promise<{ role: string; content: string; createdAt: string }[]> {
  return apiGet<{ role: string; content: string; createdAt: string }[]>(`/api/conversations/${sessionId}?limit=9999`);
}

// ─── Memory API ────────────────────────────────────────────────────

export const memoryApi = {
  listAgent: (agentId: string) => apiGet<MemoryEntry[]>(`/api/memory/agent/${encodeURIComponent(agentId)}`),
  createAgent: (data: { agentId: string; key: string; value: string; source?: string }) =>
    apiPost<MemoryEntry>("/api/memory/agent", data),
  listWorkspace: (wsId: string) => apiGet<MemoryEntry[]>(`/api/memory/workspace/${encodeURIComponent(wsId)}`),
  createWorkspace: (data: { workspaceId: string; key: string; value: string }) =>
    apiPost<MemoryEntry>("/api/memory/workspace", data),
  listGlobal: (userId: string) => apiGet<MemoryEntry[]>(`/api/memory/global/${encodeURIComponent(userId)}`),
  createGlobal: (data: { userId: string; key: string; value: string }) =>
    apiPost<MemoryEntry>("/api/memory/global", data),
  recall: (query: string, opts?: { agentId?: string; workspaceId?: string; limit?: number }, signal?: AbortSignal) =>
    apiPost<MemoryRecallResult>("/api/memory/recall", { query, ...opts }, signal),
  promote: (id: string, targetLayer: string) =>
    apiPost<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}/promote`, { targetLayer }),
  update: (layer: string, id: string, data: { key?: string; value?: string }) =>
    apiPut<MemoryEntry>(`/api/memory/${layer}/${encodeURIComponent(id)}`, data),
  delete: (layer: string, id: string) => apiDelete(`/api/memory/${layer}/${encodeURIComponent(id)}`),
  verify: (id: string) => apiPost<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}/verify`, {}),
  listBindings: (agentId: string) => apiGet<MemoryBinding[]>(`/api/memory/agent/${encodeURIComponent(agentId)}/bindings`),
  bind: (data: { agentId: string; memoryId: string }) => apiPost<MemoryBinding>("/api/memory/bind", data),
  unbind: (agentId: string, memoryId: string) => apiDelete(`/api/memory/bind/${encodeURIComponent(agentId)}/${encodeURIComponent(memoryId)}`),
};

// ─── Notifications API ─────────────────────────────────────────────

export const notificationsApi = {
  list: (params?: { targetId?: string; targetType?: string; archived?: boolean; limit?: number; offset?: number }) =>
    apiGet<NotificationItem[]>(`/api/notifications${buildSearchParams(params as Record<string, string | number | boolean | undefined>)}`),
  count: () => apiGet<{ unread: number; total: number }>("/api/notifications/count"),
  markRead: (id: string) => apiPost<void>(`/api/notifications/${encodeURIComponent(id)}/read`),
  markAllRead: () => apiPost<void>("/api/notifications/read-all"),
  archive: (id: string) => apiPost<void>(`/api/notifications/${encodeURIComponent(id)}/archive`),
  getPreferences: (workspaceId: string) => apiGet<NotificationPreferences>(`/api/notifications/preferences/${encodeURIComponent(workspaceId)}`),
  updatePreferences: (workspaceId: string, data: Partial<NotificationPreferences>) =>
    apiPut<NotificationPreferences>(`/api/notifications/preferences/${encodeURIComponent(workspaceId)}`, data),
};

// ─── Plugins API ──────────────────────────────────────────────────

export const pluginsApi = {
  discover: (params?: { scope?: string; agentId?: string }) =>
    apiGet<PluginInfo[]>(`/api/plugins/discover${buildSearchParams(params as Record<string, string | undefined>)}`),
  bindings: (pluginId: string) => apiGet<PluginBinding[]>(`/api/plugins/${encodeURIComponent(pluginId)}/bindings`),
  promote: (pluginId: string, data: { targetScope: string; targetId?: string }) =>
    apiPost<PluginInfo>(`/api/plugins/${encodeURIComponent(pluginId)}/promote`, data),
  demote: (pluginId: string) => apiPost<PluginInfo>(`/api/plugins/${encodeURIComponent(pluginId)}/demote`),
  share: (pluginId: string, data: { agentId: string }) =>
    apiPost<PluginBinding>(`/api/plugins/${encodeURIComponent(pluginId)}/share`, data),
  unshare: (pluginId: string, agentId: string) =>
    apiDelete(`/api/plugins/${encodeURIComponent(pluginId)}/share/${encodeURIComponent(agentId)}`),
  toggle: (pluginId: string, data: { enabled: boolean; agentId?: string }) =>
    apiPost<PluginBinding>(`/api/plugins/${encodeURIComponent(pluginId)}/toggle`, data),
};

// ─── Debug Capture API ────────────────────────────────────────────

export function startDebugCapture() { return apiPost<CaptureStartResponse>("/api/debug/capture/start"); }
export function stopDebugCapture() { return apiPost<CaptureResult>("/api/debug/capture/stop"); }
export function getDebugCaptureStatus() { return apiGet<CaptureStatus>("/api/debug/capture/status"); }

// ─── Task Board API（16.0 §14 全板视图）────────────────────────────

/** 板元数据（镜像后端 board-repo BoardMetaRow） */
export interface BoardMetaRow {
  taskId: string;
  goal: string | null;
  boardStatus: string;
  leader: string | null;
  parentTaskId: string | null;
  spawnDepth: number;
  turnCount: number;
  maxTurns: number;
  maxSpawnDepth: number;
}

/** GET /tasks/:tid/board 响应。thread 为 BoardMessage[]，前端按 loose 渲染（不镜像完整 7-type 判别联合） */
export interface BoardData {
  taskId: string;
  thread: unknown[];
  meta: BoardMetaRow;
  members: Array<{ agentId: string; role: string }>;
}

/** 取任务板完整协作记录（thread + 元数据 + 花名册），供 §14 全板视图渲染 */
export function getTaskBoard(taskId: string) {
  return apiGet<BoardData>(`/api/tasks/${encodeURIComponent(taskId)}/board`);
}
