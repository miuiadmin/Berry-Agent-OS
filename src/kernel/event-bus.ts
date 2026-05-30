import type { MessageBus } from './message-bus.js';
import type { EventMessageType, EventMap } from '../contracts/messages.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('event-bus');

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

  listenerCount(event: EventName): number {
    if (this.messageBus) {
      const busType = `event:${event}` as EventMessageType;
      return this.messageBus.listenerCount(busType);
    }
    return this.localListeners.get(event)?.size ?? 0;
  }
}
