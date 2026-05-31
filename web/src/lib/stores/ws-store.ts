import { create } from "zustand";

type WsStatus = "connected" | "connecting" | "disconnected";
type EventCallback = (payload: unknown) => void;

interface WsState {
  status: WsStatus;
  sessionId: string | null;
}

interface WsActions {
  connect: (sessionId?: string) => void;
  disconnect: () => void;
  send: (data: unknown) => void;
  subscribe: (event: string, cb: EventCallback) => () => void;
  onMessage: (handler: (data: Record<string, unknown>) => void) => () => void;
}

type WsStore = WsState & WsActions;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let reconnectGeneration = 0;
const MAX_RECONNECT_DELAY = 30000;
const eventListeners = new Map<string, Set<EventCallback>>();
const messageHandlers = new Set<(data: Record<string, unknown>) => void>();

function generateSessionId(): string {
  try {
    return `web-${crypto.randomUUID()}`;
  } catch {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const useWsStore = create<WsStore>((set, get) => ({
  status: "disconnected",
  sessionId: null,

  connect: (sessionId?: string) => {
    // Prevent duplicate connections
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

    // Cancel any pending reconnect
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const sid = sessionId ?? get().sessionId ?? generateSessionId();
    set({ status: "connecting", sessionId: sid });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const socket = new WebSocket(`${protocol}//${host}/ws?sessionId=${sid}`);

    socket.onopen = () => {
      set({ status: "connected" });
      reconnectDelay = 1000;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;

        if (data.type === "event") {
          const eventName = data.event as string;
          const callbacks = eventListeners.get(eventName);
          if (callbacks) {
            for (const cb of callbacks) cb(data.payload);
          }
          const wildcardCbs = eventListeners.get("*");
          if (wildcardCbs) {
            for (const cb of wildcardCbs) cb(data);
          }
        }

        for (const handler of messageHandlers) {
          handler(data);
        }
      } catch {
        // ignore non-JSON frames
      }
    };

    socket.onclose = () => {
      set({ status: "disconnected" });
      ws = null;
      scheduleReconnect(get);
    };

    socket.onerror = () => {
      socket.close();
    };

    ws = socket;
  },

  disconnect: () => {
    // Increment generation to invalidate any pending reconnect attempts
    reconnectGeneration++;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
    messageHandlers.clear();
    eventListeners.clear();
    set({ status: "disconnected" });
  },

  send: (data: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  },

  subscribe: (event: string, cb: EventCallback) => {
    if (!eventListeners.has(event)) {
      eventListeners.set(event, new Set());
    }
    eventListeners.get(event)!.add(cb);
    return () => {
      eventListeners.get(event)?.delete(cb);
    };
  },

  onMessage: (handler: (data: Record<string, unknown>) => void) => {
    messageHandlers.add(handler);
    return () => {
      messageHandlers.delete(handler);
    };
  },
}));

function scheduleReconnect(get: () => WsStore) {
  if (reconnectTimer) return;
  const gen = reconnectGeneration;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Only reconnect if generation hasn't changed (no explicit disconnect)
    if (gen === reconnectGeneration && get().status === "disconnected") {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      get().connect();
    }
  }, reconnectDelay);
}
