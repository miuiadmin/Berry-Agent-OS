import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { toast } from "sonner";
import { useChatStore } from "./chat-store";
import zh from "@/locales/zh";
import en from "@/locales/en";

/** Store 内部翻译辅助（非 hook 环境，直接查翻译表） */
function t(key: string): string {
  const locale = (typeof window !== "undefined" && localStorage.getItem("locale")) || "zh";
  const translations = locale === "en" ? en : zh;
  return translations[key] ?? key;
}

/** WebSocket 连接状态 */
type WsStatus = "connected" | "connecting" | "disconnected";

/** 事件回调函数类型 */
type EventCallback = (payload: unknown) => void;

/** Zustand store 状态：连接状态 + 稳定的客户端 ID */
interface WsState {
  status: WsStatus;
  /** 稳定的客户端标识，持久化到 localStorage，跨刷新不变。
   *  WS 连接用此 ID 标识客户端，与对话 sessionId 完全解耦。 */
  clientId: string | null;
}

/** Zustand store 操作：连接/断开/发送/订阅 */
interface WsActions {
  connect: () => void;
  disconnect: () => void;
  send: (data: unknown) => void;
  /** 显式把带 clientMsgId 的消息入 outbox（用于跨刷新恢复） */
  queueOutgoingMessage: (clientMsgId: string, payload: unknown) => void;
  /** 消息已被服务端确认后从 outbox 移除（按 clientMsgId） */
  confirmOutgoingMessage: (clientMsgId: string) => void;
  subscribe: (event: string, cb: EventCallback) => () => void;
  onMessage: (handler: (data: Record<string, unknown>) => void) => () => void;
}

type WsStore = WsState & WsActions;

// ─── 模块级状态 ───────────────────────────────────────────────

/** 当前 WebSocket 实例 */
let ws: WebSocket | null = null;

/** 重连定时器 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** 当前重连延迟（指数退避），初始 1 秒 */
let reconnectDelay = 1000;

/**
 * 重连代数（generation）。
 * 每次 disconnect() 递增，用于让旧的 scheduleReconnect 回调失效，
 * 避免 disconnect 后仍然触发重连。
 */
let reconnectGeneration = 0;

/** 重连延迟上限：30 秒 */
const MAX_RECONNECT_DELAY = 30000;

/**
 * 是否曾经成功连接过。
 * 用于区分「首次连接」和「断线重连」：
 * - 首次连接：静默，不弹 toast
 * - 断线重连：弹 "Reconnected" toast 提示用户
 * - 手动 disconnect 后重置为 false
 */
let hasConnectedBefore = false;

/**
 * 事件监听器映射表。
 * subscribe() 注册的回调，仅对 type="event" 的消息派发。
 * key = 事件名（如 "task.progress"），value = 回调集合。
 */
const eventListeners = new Map<string, Set<EventCallback>>();

/**
 * 消息处理器集合。
 * onMessage() 注册的回调，对所有消息（包括 type="event"）都派发。
 */
const messageHandlers = new Set<(data: Record<string, unknown>) => void>();

/**
 * 发送队列。
 * WebSocket 未连接时，send() 将消息暂存于此；
 * 连接成功后 onopen 里调用 flushQueue() 一次性发出。
 */
const sendQueue: unknown[] = [];

/**
 * 持久化 outgoing 队列的 localStorage key。
 * 即使浏览器刷新/标签关闭，重启后未送达的 user 消息仍能恢复并按 clientMsgId 去重发送。
 */
const OUTBOX_STORAGE_KEY = "berry:ws-outbox:v1";

/** 持久化队列条目（只存少量字段，clientMsgId 用于去重） */
interface OutboxEntry {
  clientMsgId: string;
  type: string;
  payload: unknown;
  queuedAt: number;
}

/**
 * 加载持久化 outbox。
 * 读取失败的/反序列化异常的条目一律丢弃，避免阻塞后续恢复。
 */
function loadOutbox(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((e): e is OutboxEntry =>
      !!e && typeof (e as OutboxEntry).clientMsgId === "string"
    );
  } catch {
    return [];
  }
}

/**
 * 覆盖写 outbox 到 localStorage。
 * try/catch 吞掉容量超限异常（QuotaExceededError），避免影响主流程。
 */
function saveOutbox(entries: OutboxEntry[]) {
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 容量超限或 storage 不可用：放弃持久化，内存队列仍保留
  }
}

/**
 * 从 outbox 中按 clientMsgId 去重添加。
 * 同 clientMsgId 重复添加会被静默忽略（幂等）。
 */
function enqueueOutbox(entry: OutboxEntry) {
  const cur = loadOutbox();
  if (cur.some((e) => e.clientMsgId === entry.clientMsgId)) return;
  cur.push(entry);
  saveOutbox(cur);
}

/** 从 outbox 中按 clientMsgId 移除（成功发送后调用） */
function removeFromOutbox(clientMsgId: string) {
  const cur = loadOutbox();
  const next = cur.filter((e) => e.clientMsgId !== clientMsgId);
  if (next.length !== cur.length) saveOutbox(next);
}

// ─── 辅助函数 ─────────────────────────────────────────────────

/** 将发送队列中所有消息依次发出（连接成功后调用） */
function flushQueue() {
  while (sendQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
    const msg = sendQueue.shift();
    if (msg !== undefined) {
      ws.send(JSON.stringify(msg));
    }
  }
}

/** 生成稳定的客户端 ID，格式为 "client-{uuid}"，持久化后跨刷新不变 */
function generateClientId(): string {
  try {
    return `client-${crypto.randomUUID()}`;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// ─── Zustand Store ────────────────────────────────────────────

export const useWsStore = create<WsStore>()(
  persist(
    (set, get) => ({
      status: "disconnected",
      clientId: null,

      /**
       * 建立 WebSocket 连接。
       * 使用持久化的 clientId 标识客户端，与对话无关。
       * 如果已有活跃连接或正在连接中，直接跳过。
       */
      connect: () => {
        // 防止重复连接
        if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

        // 取消可能存在的重连定时器
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        // 确保 clientId 存在（首次访问时生成并持久化）
        let cid = get().clientId;
        if (!cid) {
          cid = generateClientId();
          set({ clientId: cid });
        }

        set({ status: "connecting" });

        // 根据页面协议选择 ws/wss
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        // 开发模式（端口 3889）直连后端 3888，绕过 Vite 代理（Vite WS 代理不可靠）
        const host = window.location.port === "3889" ? window.location.hostname + ":3888" : window.location.host;
        // WS 连接用 clientId 标识客户端，与对话 sessionId 完全解耦
        const socket = new WebSocket(`${protocol}//${host}/ws?clientId=${cid}`);

        ws = socket;

        // P1-6: 心跳超时检测 — 追踪最后收到消息的时间戳
        // 静默断连场景（WiFi 切换、休眠恢复）下 readyState 仍为 OPEN，
        // 但消息实际无法送达。通过定时检查 lastActivityTs 检测此类断连
        let lastActivityTs = Date.now();

        /** P1-6: 心跳超时定时器 — 每 35s 检查一次，60s 无消息则判定连接已死 */
        const heartbeatCheck = setInterval(() => {
          if (ws !== socket) { clearInterval(heartbeatCheck); return; } // 过时实例，停止检查
          if (Date.now() - lastActivityTs > 60_000) {
            // 60 秒未收到任何消息（含 ping/pong），视为静默断连
            clearInterval(heartbeatCheck);
            socket.close(4000, "heartbeat timeout");
          }
        }, 35_000);

        /** 连接成功：更新状态、发送队列、按需弹 toast */
        socket.onopen = () => {
          if (ws !== socket) return; // 过时的 socket 实例，忽略
          set({ status: "connected" });
          reconnectDelay = 1000; // 重置退避延迟

          // 先把持久化 outbox 中跨刷新残留的 user 消息灌入内存队列（按时间顺序）
          // 然后 flushQueue 一次性发出。这样刷新页面后未送达的消息仍能恢复。
          try {
            const persisted = loadOutbox();
            for (const entry of persisted) {
              // 用 clientMsgId 去重：如果内存队列里已经有同 id 的就不重复灌
              if (!sendQueue.some((m) => {
                const mm = m as { clientMsgId?: string };
                return mm?.clientMsgId === entry.clientMsgId;
              })) {
                sendQueue.push(entry.payload);
              }
            }
          } catch {
            // outbox 恢复失败不影响主流程
          }

          flushQueue();          // 发送积压消息

          // P2-11: 连接成功后发送 subscribe 消息，声明当前关注的 sessionId
          // 服务端 WsEventBridge 按订阅过滤流式事件，减少多标签冗余传输
          // 改用静态 import：避免在 socket.onopen 同步闭包里用 await
          const chatState = useChatStore.getState();
          if (chatState.sessionId) {
            socket.send(JSON.stringify({ type: 'subscribe', sessionId: chatState.sessionId }));
          }

          // 只在断线重连时弹 toast，首次连接静默
          if (hasConnectedBefore) toast.success(t("connection.connected"));
          hasConnectedBefore = true;
        };

        /** 收到消息：派发到事件监听器和消息处理器 */
        socket.onmessage = (event) => {
          if (ws !== socket) return; // 过时的 socket 实例，忽略
          lastActivityTs = Date.now(); // P1-6: 收到消息即刷新心跳时间戳
          try {
            const data = JSON.parse(event.data) as Record<string, unknown>;

            // 对 type="event" 的消息，派发到 subscribe() 注册的监听器
            if (data.type === "event") {
              const eventName = data.event as string;
              const callbacks = eventListeners.get(eventName);
              if (callbacks) {
                for (const cb of callbacks) cb(data.payload);
              }
              // 通配符 "*" 监听器收到完整 data（含 type + event + payload）
              const wildcardCbs = eventListeners.get("*");
              if (wildcardCbs) {
                for (const cb of wildcardCbs) cb(data);
              }
            }

            // 所有消息都派发到 onMessage() 注册的处理器
            for (const handler of messageHandlers) {
              handler(data);
            }
          } catch {
            // 忽略非 JSON 帧
          }
        };

        /** 连接关闭：如果之前处于 connected 状态，提示用户并触发重连 */
        socket.onclose = () => {
          if (ws !== socket) return; // 过时的 socket 实例，忽略
          clearInterval(heartbeatCheck); // P1-6: 清理心跳检查定时器
          const prev = get().status;
          set({ status: "disconnected" });
          // 只有从 connected 状态掉线才提示（connecting 阶段关闭不提示，避免首次连接失败就弹）
          if (prev === "connected") toast.warning(t("connection.connecting"));
          ws = null;
          scheduleReconnect(get);
        };

        /** 连接错误：直接关闭，让 onclose 统一处理重连逻辑 */
        socket.onerror = () => {
          socket.close();
        };
      },

      /**
       * 主动断开连接。
       * 递增 generation 使旧的重连回调失效，清空发送队列，重置状态。
       */
      disconnect: () => {
        reconnectGeneration++;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        const prev = ws;
        ws = null;
        prev?.close();
        sendQueue.length = 0;
        hasConnectedBefore = false; // 重置，下次连接视为首次
        set({ status: "disconnected" });
      },

      /**
       * 发送数据。如果 WebSocket 未连接，暂存到发送队列。
       * @param data 要发送的数据（会被 JSON.stringify）
       */
      send: (data: unknown) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(data));
        } else {
          // 未连接 → 暂存，等 onopen 后 flushQueue() 发出
          sendQueue.push(data);
          // 如果是 user 消息且带 clientMsgId，额外持久化到 outbox 用于跨刷新恢复
          const maybe = data as { type?: string; clientMsgId?: string };
          if (maybe?.type === "message" && typeof maybe.clientMsgId === "string") {
            enqueueOutbox({
              clientMsgId: maybe.clientMsgId,
              type: maybe.type,
              payload: data,
              queuedAt: Date.now(),
            });
          }
        }
      },

      /**
       * 显式入队 outbox（带 clientMsgId 的 user 消息）。
       * 用于调用方已经知道 WS 断开、希望保证可恢复时主动调用。
       * 同 clientMsgId 重复入队会被幂等忽略。
       */
      queueOutgoingMessage: (clientMsgId: string, payload: unknown) => {
        if (!clientMsgId) return;
        const maybe = payload as { type?: string };
        enqueueOutbox({
          clientMsgId,
          type: typeof maybe?.type === "string" ? maybe.type : "message",
          payload,
          queuedAt: Date.now(),
        });
        // 同时入内存队列，等连接恢复
        sendQueue.push(payload);
      },

      /**
       * 消息成功发送后从 outbox 移除（按 clientMsgId）。
       * 避免重连后重复发送已被服务端确认的消息。
       */
      confirmOutgoingMessage: (clientMsgId: string) => {
        if (!clientMsgId) return;
        removeFromOutbox(clientMsgId);
      },

      /**
       * 订阅指定事件。仅对 type="event" 的消息生效。
       * @param event 事件名（如 "task.progress"），或 "*" 监听所有事件
       * @param cb 事件回调
       * @returns 取消订阅函数
       */
      subscribe: (event: string, cb: EventCallback) => {
        if (!eventListeners.has(event)) {
          eventListeners.set(event, new Set());
        }
        eventListeners.get(event)!.add(cb);
        return () => {
          eventListeners.get(event)?.delete(cb);
        };
      },

      /**
       * 注册消息处理器。对所有消息（包括 type="event"）都触发。
       * @param handler 消息处理函数
       * @returns 取消注册函数
       */
      onMessage: (handler: (data: Record<string, unknown>) => void) => {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    }),
    {
      name: "ws-storage",
      // 用 sessionStorage 而非 localStorage：同标签页刷新保持 clientId（rebind 正常），
      // 但不同标签页各自独立（避免多标签共享 clientId 导致 rebind 跨标签内容污染）
      storage: createJSONStorage(() => {
        try { return sessionStorage; } catch { return { getItem: () => null, setItem: () => {}, removeItem: () => {} }; }
      }),
      // 只持久化 clientId，status 等运行时状态不持久化
      partialize: (state) => ({ clientId: state.clientId }),
    },
  ),
);

/**
 * 调度重连。使用指数退避策略，延迟从 1s → 2s → 4s → ... → 最大 30s。
 * 通过 generation 机制确保 disconnect() 后不会误触发重连。
 */
function scheduleReconnect(get: () => WsStore) {
  if (reconnectTimer) return; // 已有重连在等待，不重复调度
  const gen = reconnectGeneration; // 快照当前代数
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // 只有代数未变且仍处于 disconnected 状态才重连（排除 disconnect() 后的情况）
    if (gen === reconnectGeneration && get().status === "disconnected") {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY); // 指数退避
      get().connect();
    }
  }, reconnectDelay);
}
