import { getLogger } from '../utils/logger.js';

const logger = getLogger('bus:lifecycle');

export type LifecycleEventType =
  | 'context.compressing'
  | 'session.ending'
  | 'agent.task_completed'
  | 'agent.idle'
  | 'permission.denied'
  | 'capability.registered'
  | 'capability.unregistered';

export class LifecycleEventManager {
  private listeners = new Map<LifecycleEventType, Set<(data: unknown) => void>>();

  on(event: LifecycleEventType, handler: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  emit(event: LifecycleEventType, data: unknown): void {
    const handlers = this.listeners.get(event);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        logger.debug({ err, event }, 'Lifecycle event handler error');
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
