const BASE_URL = typeof window !== "undefined" ? "" : "http://127.0.0.1:7860";

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json", ...options?.headers },
      ...options,
    });
  } catch (err) {
    throw new Error("Network error — check your connection");
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
  completedAt?: string;
  sessionId?: string;
  inputPayload?: string;
  outputPayload?: string;
  errorMessage?: string;
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
    throw new Error((body as Record<string, string>).error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

export async function renameConversation(sessionId: string, title: string): Promise<void> {
  await apiPut(`/api/conversations/${sessionId}`, { title });
}

export async function exportConversation(sessionId: string): Promise<{ role: string; content: string; createdAt: string }[]> {
  return apiGet<{ role: string; content: string; createdAt: string }[]>(`/api/conversations/${sessionId}?limit=9999`);
}
