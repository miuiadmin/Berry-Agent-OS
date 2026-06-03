const BASE_URL = "";

/** API 层翻译辅助（非 hook 环境） */
import zh from "@/locales/zh";
import en from "@/locales/en";
function t(key: string, params?: Record<string, string | number>): string {
  const locale = (typeof window !== "undefined" && localStorage.getItem("locale")) || "zh";
  const translations = locale === "en" ? en : zh;
  let value = translations[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json", ...options?.headers },
      ...options,
    });
  } catch {
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

export function apiGet<T>(path: string) {
  return fetchApi<T>(path);
}

export function apiPut<T>(path: string, body: unknown) {
  return fetchApi<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export function apiPost<T>(path: string, body?: unknown) {
  return fetchApi<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

export function apiDelete(path: string) {
  return fetchApi<void>(path, { method: "DELETE" });
}

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

export interface TaskStatsDay {
  date: string;
  completed: number;
  failed: number;
}

export interface SearchResult {
  sessionId: string;
  content: string;
  role: string;
  createdAt: number;
  highlight: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export interface UsageDaySummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageDailyPoint extends UsageDaySummary {
  date: string;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface UsageSummary {
  today: UsageDaySummary;
  period: UsageDaySummary;
  daily: UsageDailyPoint[];
  byAgent: { agentName: string; totalTokens: number; costUsd: number }[];
  byModel: { model: string; totalTokens: number; costUsd: number }[];
}

export interface UploadResponse {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
}

export const queries = {
  health: () => ({ queryKey: ["health"], queryFn: () => apiGet<HealthResponse>("/api/health") }),
  config: () => ({ queryKey: ["config"], queryFn: () => apiGet<Record<string, unknown>>("/api/config") }),
  agents: () => ({ queryKey: ["agents"], queryFn: () => apiGet<AgentInfo[]>("/api/agents") }),
  agent: (name: string) => ({ queryKey: ["agents", name], queryFn: () => apiGet<AgentInfo>(`/api/agents/${name}`) }),
  taskStats: (days = 7) => ({
    queryKey: ["taskStats", days],
    queryFn: async (): Promise<TaskStatsDay[]> => {
      try {
        return await apiGet<TaskStatsDay[]>(`/api/tasks/stats?days=${days}`);
      } catch {
        return [];
      }
    },
  }),
  tasks: (params?: { status?: string; agent?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.agent) searchParams.set("agent", params.agent);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return {
      queryKey: ["tasks", params],
      queryFn: () => apiGet<PaginatedResponse<TaskInfo>>(`/api/tasks${qs ? `?${qs}` : ""}`),
    };
  },
  conversations: (params?: { search?: string; sort?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set("search", params.search);
    if (params?.sort) searchParams.set("sort", params.sort);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return {
      queryKey: ["conversations", params],
      queryFn: () => apiGet<ConversationInfo[]>(`/api/conversations${qs ? `?${qs}` : ""}`),
    };
  },
  conversation: (sid: string) => ({ queryKey: ["conversations", sid], queryFn: () => apiGet<unknown[]>(`/api/conversations/${sid}`) }),
  search: (q: string, limit = 20) => ({
    queryKey: ["search", q, limit],
    queryFn: async (): Promise<SearchResponse> => {
      if (!q.trim()) return { results: [], total: 0 };
      return apiGet<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    },
    enabled: q.trim().length > 0,
  }),
  usage: (days = 7) => ({
    queryKey: ["usage", days],
    queryFn: async (): Promise<UsageSummary> => {
      try {
        return await apiGet<UsageSummary>(`/api/usage/summary?days=${days}`);
      } catch {
        return { today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }, period: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }, daily: [], byAgent: [], byModel: [] };
      }
    },
  }),
};

export async function uploadFile(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${BASE_URL}/api/upload`, { method: "POST", body: formData });
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

// --- Debug Capture ---

export interface CaptureStartResponse {
  captureId: string;
  path: string;
}

export interface CaptureResult {
  captureId: string;
  path: string;
  durationMs: number;
  eventCount: number;
  size: number;
}

export interface CaptureStatus {
  active: boolean;
  captureId?: string;
  startedAt?: number;
}

// ─── Memory ────────────────────────────────────────────────────────────────

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

export interface MemoryRecallResult {
  results: MemoryEntry[];
  total: number;
}

export interface MemoryBinding {
  agentId: string;
  memoryId: string;
  createdAt: number;
}

export const memoryApi = {
  listAgent: (agentId: string) =>
    apiGet<MemoryEntry[]>(`/api/memory/agent/${encodeURIComponent(agentId)}`),
  createAgent: (data: { agentId: string; key: string; value: string; source?: string }) =>
    apiPost<MemoryEntry>("/api/memory/agent", data),
  listWorkspace: (wsId: string) =>
    apiGet<MemoryEntry[]>(`/api/memory/workspace/${encodeURIComponent(wsId)}`),
  createWorkspace: (data: { workspaceId: string; key: string; value: string }) =>
    apiPost<MemoryEntry>("/api/memory/workspace", data),
  listGlobal: (userId: string) =>
    apiGet<MemoryEntry[]>(`/api/memory/global/${encodeURIComponent(userId)}`),
  createGlobal: (data: { userId: string; key: string; value: string }) =>
    apiPost<MemoryEntry>("/api/memory/global", data),
  recall: (query: string, opts?: { agentId?: string; workspaceId?: string; limit?: number }) =>
    apiPost<MemoryRecallResult>("/api/memory/recall", { query, ...opts }),
  promote: (id: string, targetLayer: string) =>
    apiPost<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}/promote`, { targetLayer }),
  update: (layer: string, id: string, data: { key?: string; value?: string }) =>
    apiPut<MemoryEntry>(`/api/memory/${layer}/${encodeURIComponent(id)}`, data),
  delete: (layer: string, id: string) =>
    apiDelete(`/api/memory/${layer}/${encodeURIComponent(id)}`),
  verify: (id: string) =>
    apiPost<MemoryEntry>(`/api/memory/${encodeURIComponent(id)}/verify`, {}),
  listBindings: (agentId: string) =>
    apiGet<MemoryBinding[]>(`/api/memory/agent/${encodeURIComponent(agentId)}/bindings`),
  bind: (data: { agentId: string; memoryId: string }) =>
    apiPost<MemoryBinding>("/api/memory/bind", data),
  unbind: (agentId: string, memoryId: string) =>
    apiDelete(`/api/memory/bind/${encodeURIComponent(agentId)}/${encodeURIComponent(memoryId)}`),
};

// ─── Notifications ─────────────────────────────────────────────────────────

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

export interface NotificationPreferences {
  workspaceId: string;
  muted: boolean;
  channels: string[];
}

export const notificationsApi = {
  list: (params?: { targetId?: string; targetType?: string; archived?: boolean; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.targetId) sp.set("targetId", params.targetId);
    if (params?.targetType) sp.set("targetType", params.targetType);
    if (params?.archived !== undefined) sp.set("archived", String(params.archived));
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.offset) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return apiGet<NotificationItem[]>(`/api/notifications${qs ? `?${qs}` : ""}`);
  },
  count: () =>
    apiGet<{ unread: number; total: number }>("/api/notifications/count"),
  markRead: (id: string) =>
    apiPost<void>(`/api/notifications/${encodeURIComponent(id)}/read`),
  markAllRead: () =>
    apiPost<void>("/api/notifications/read-all"),
  archive: (id: string) =>
    apiPost<void>(`/api/notifications/${encodeURIComponent(id)}/archive`),
  getPreferences: (workspaceId: string) =>
    apiGet<NotificationPreferences>(`/api/notifications/preferences/${encodeURIComponent(workspaceId)}`),
  updatePreferences: (workspaceId: string, data: Partial<NotificationPreferences>) =>
    apiPut<NotificationPreferences>(`/api/notifications/preferences/${encodeURIComponent(workspaceId)}`, data),
};

// ─── Scheduler ─────────────────────────────────────────────────────────────

export interface SchedulerJob {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  status: "idle" | "running" | "paused";
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
}

export interface SchedulerExecution {
  id: string;
  jobId: string;
  status: "completed" | "failed" | "running";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface SchedulerQueue {
  pending: number;
  running: number;
  maxConcurrency: number;
}

export interface WebhookAuditEntry {
  id: string;
  token: string;
  payload: unknown;
  result: string;
  createdAt: number;
}

export interface Reminder {
  id: string;
  prompt: string;
  triggerAt: number;
  status: "pending" | "fired" | "cancelled";
  createdAt: number;
}

export const schedulerApi = {
  listJobs: () =>
    apiGet<SchedulerJob[]>("/api/scheduler/jobs"),
  getJob: (id: string) =>
    apiGet<SchedulerJob>(`/api/scheduler/jobs/${encodeURIComponent(id)}`),
  createJob: (data: { name: string; cron: string; prompt: string; enabled?: boolean }) =>
    apiPost<SchedulerJob>("/api/scheduler/jobs", data),
  updateJob: (id: string, data: Partial<Pick<SchedulerJob, "name" | "cron" | "prompt" | "enabled">>) =>
    apiPut<SchedulerJob>(`/api/scheduler/jobs/${encodeURIComponent(id)}`, data),
  deleteJob: (id: string) =>
    apiDelete(`/api/scheduler/jobs/${encodeURIComponent(id)}`),
  pauseJob: (id: string) =>
    apiPost<SchedulerJob>(`/api/scheduler/jobs/${encodeURIComponent(id)}/pause`),
  resumeJob: (id: string) =>
    apiPost<SchedulerJob>(`/api/scheduler/jobs/${encodeURIComponent(id)}/resume`),
  triggerJob: (id: string) =>
    apiPost<SchedulerExecution>(`/api/scheduler/jobs/${encodeURIComponent(id)}/trigger`),
  executions: (id: string, params?: { limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.offset) sp.set("offset", String(params.offset));
    const qs = sp.toString();
    return apiGet<SchedulerExecution[]>(`/api/scheduler/jobs/${encodeURIComponent(id)}/executions${qs ? `?${qs}` : ""}`);
  },
  queue: () =>
    apiGet<SchedulerQueue>("/api/scheduler/queue"),
  approveChain: (roundId: string, stepId: string) =>
    apiPost<void>(`/api/scheduler/chain/${encodeURIComponent(roundId)}/approve/${encodeURIComponent(stepId)}`),
  rejectChain: (roundId: string, stepId: string) =>
    apiPost<void>(`/api/scheduler/chain/${encodeURIComponent(roundId)}/reject/${encodeURIComponent(stepId)}`),
  webhookAudit: (params?: { limit?: number }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set("limit", String(params.limit));
    const qs = sp.toString();
    return apiGet<WebhookAuditEntry[]>(`/api/scheduler/webhooks/audit${qs ? `?${qs}` : ""}`);
  },
  createReminder: (data: { prompt: string; triggerAt: number }) =>
    apiPost<Reminder>("/api/scheduler/reminders", data),
  deleteReminder: (id: string) =>
    apiDelete(`/api/scheduler/reminders/${encodeURIComponent(id)}`),
};

// ─── Plugins ───────────────────────────────────────────────────────────────

export interface PluginInfo {
  id: string;
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "agent" | "workspace" | "global";
}

export interface PluginBinding {
  agentId: string;
  pluginId: string;
  enabled: boolean;
}

export const pluginsApi = {
  discover: (params?: { scope?: string; agentId?: string }) => {
    const sp = new URLSearchParams();
    if (params?.scope) sp.set("scope", params.scope);
    if (params?.agentId) sp.set("agentId", params.agentId);
    const qs = sp.toString();
    return apiGet<PluginInfo[]>(`/api/plugins/discover${qs ? `?${qs}` : ""}`);
  },
  bindings: (pluginId: string) =>
    apiGet<PluginBinding[]>(`/api/plugins/${encodeURIComponent(pluginId)}/bindings`),
  promote: (pluginId: string, data: { targetScope: string; targetId?: string }) =>
    apiPost<PluginInfo>(`/api/plugins/${encodeURIComponent(pluginId)}/promote`, data),
  demote: (pluginId: string) =>
    apiPost<PluginInfo>(`/api/plugins/${encodeURIComponent(pluginId)}/demote`),
  share: (pluginId: string, data: { agentId: string }) =>
    apiPost<PluginBinding>(`/api/plugins/${encodeURIComponent(pluginId)}/share`, data),
  unshare: (pluginId: string, agentId: string) =>
    apiDelete(`/api/plugins/${encodeURIComponent(pluginId)}/share/${encodeURIComponent(agentId)}`),
  toggle: (pluginId: string, data: { enabled: boolean; agentId?: string }) =>
    apiPost<PluginBinding>(`/api/plugins/${encodeURIComponent(pluginId)}/toggle`, data),
};

export function startDebugCapture() {
  return apiPost<CaptureStartResponse>("/api/debug/capture/start");
}

export function stopDebugCapture() {
  return apiPost<CaptureResult>("/api/debug/capture/stop");
}

export function getDebugCaptureStatus() {
  return apiGet<CaptureStatus>("/api/debug/capture/status");
}
