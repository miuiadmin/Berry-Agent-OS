import type { MessageBus } from './message-bus.js';
import type { EventMessageType, EventMap } from '../contracts/messages.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('event-bus');

// ── 中枢事件 trace（上帝视角）─────────────────────────────────────────────
// EventBus.emit 是所有业务事件（stream.* / task.* / delegation.* / daemon.* /
// conversation.* / mission.* …）的唯一入口。在此插桩 = 一次覆盖全系统事件流，
// 用来回答「某事件到底有没有发出 / 带没带某字段」。grep `evt>` 看全部。
// 高频 per-token 流式增量（stream.text_delta / stream.reasoning_delta）按 1/50 节流，
// 防 berry.log 被逐 token 淹爆；其余事件完整记录安全小字段指纹（绝不 dump 大 payload）。
const EVT_FP_KEYS = [
  'taskId', 'delegationId', 'sessionId', 'toolName', 'callId', 'blockId', 'blockType',
  'messageId', 'durationMs', 'kind', 'state', 'correlationId', 'agentName', 'intent',
  'targetAgent', 'from', 'to', 'ok', 'isError', 'reason', 'verdict', 'summary',
] as const;
/** per-token 流式增量节流计数器（模块级，会话内累计；不按 taskId 分桶避免 map 无限增长） */
let _textDeltaN = 0;
let _reasoningDeltaN = 0;
/**
 * 事件指纹提取：从 payload 里挑安全的小字段（taskId / toolName / durationMs …），
 * 跳过 input / result / text / output 等可能很大的载荷，保证日志可读不爆。
 */
function traceEventEmit(event: string, payload: unknown): void {
  // per-token 流式增量：每 50 条记 1 条，仅证明「流在动 + 累计条数」
  if (event === 'stream.text_delta') {
    _textDeltaN++;
    if (_textDeltaN % 50 === 1) logger.debug({ event, n: _textDeltaN }, 'evt> 流式文本增量(1/50 节流)');
    return;
  }
  if (event === 'stream.reasoning_delta') {
    _reasoningDeltaN++;
    if (_reasoningDeltaN % 50 === 1) logger.debug({ event, n: _reasoningDeltaN }, 'evt> 流式推理增量(1/50 节流)');
    return;
  }
  const fp: Record<string, unknown> = { event };
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    for (const k of EVT_FP_KEYS) if (k in p) fp[k] = p[k];
    // 工具事件专门标出 durationMs 在不在（计时链路核心诊断字段）
    if ('durationMs' in p) fp.hasDurationMs = p.durationMs != null;
  }
  logger.debug(fp, 'evt>');
}

let instance: EventBus | null = null;

export function initEventBus(): EventBus {
  instance = new EventBus();
  return instance;
}

export function getEventBus(): EventBus {
  if (!instance) throw new Error('EventBus not initialized');
  return instance;
}

export type EventName = keyof EventMap;
export type EventPayload<E extends EventName> = EventMap[E];

type Listener<E extends EventName> = (payload: EventPayload<E>) => void;

export class EventBus {
  private localListeners = new Map<string, Set<Function>>();
  private messageBus: MessageBus | null = null;

  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus;
    for (const [event, set] of this.localListeners) {
      const busType = `event:${event}` as EventMessageType;
      for (const fn of set) {
        bus.on(busType, fn as any);
      }
    }
    this.localListeners.clear();
  }

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    if (this.messageBus) {
      const busType = `event:${event}` as EventMessageType;
      this.messageBus.on(busType, listener as any);
    } else {
      if (!this.localListeners.has(event)) {
        this.localListeners.set(event, new Set());
      }
      this.localListeners.get(event)!.add(listener);
    }
    return () => this.off(event, listener);
  }

  once<E extends EventName>(event: E, listener: Listener<E>): () => void {
    const wrapper: Listener<E> = (payload) => {
      this.off(event, wrapper);
      listener(payload);
    };
    return this.on(event, wrapper);
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    if (this.messageBus) {
      const busType = `event:${event}` as EventMessageType;
      this.messageBus.off(busType, listener as any);
    } else {
      this.localListeners.get(event)?.delete(listener);
    }
  }

  emit<E extends EventName>(event: E, payload: EventPayload<E>): void {
    // 上帝视角：所有业务事件经此发出，先记 trace 再分发（见 traceEventEmit）
    traceEventEmit(event as string, payload);
    if (this.messageBus) {
      const busType = `event:${event}` as EventMessageType;
      this.messageBus.emit(busType, payload as any);
      return;
    }
    const set = this.localListeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<E>)(payload);
      } catch (err) {
        logger.error({ err, event }, 'EventBus listener error');
      }
    }
  }

  removeAll(): void {
    this.localListeners.clear();
    if (this.messageBus) {
      this.messageBus.removeAll();
    }
  }

  // R6-7: 删除 listenerCount() 探测孔（dead code — 无 caller）。
  // 取消订阅 / 添加订阅由 Set.add / Set.delete 自然处理。
}
