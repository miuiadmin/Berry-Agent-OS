declare global {
  interface Window {
    api?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
      send: (channel: string, ...args: unknown[]) => void;
    };
  }
}

const API_BASE = 'http://localhost:3721/api';

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET';
  const body = options?.body ? JSON.parse(options.body as string) : undefined;

  if (window.api) {
    const result = await window.api.invoke('api:request', method, `/api${path}`, body) as { status: number; data: T };
    if (result.status >= 400) {
      throw new Error((result.data as { error?: string })?.error || `HTTP ${result.status}`);
    }
    return result.data;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || res.statusText);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

