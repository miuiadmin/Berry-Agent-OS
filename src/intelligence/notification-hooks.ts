import type { EventBus } from '../contracts/infrastructure.js';
import type { INotificationService } from './contracts.js';

export function registerNotificationHooks(
  eventBus: EventBus,
  getService: () => INotificationService | null,
): () => void {
  const cleanups: Array<() => void> = [];

  cleanups.push(eventBus.on('task.created', (payload) => {
    const svc = getService();
    if (!svc) return;
    const { taskId, targetAgent } = payload;
    if (targetAgent) svc.subscribe(taskId, 'agent', targetAgent, 'assignee');
  }));

  cleanups.push(eventBus.on('task.dispatched', (payload) => {
    const svc = getService();
    if (!svc) return;
    const { taskId, targetAgent } = payload;
    if (targetAgent) svc.subscribe(taskId, 'agent', targetAgent, 'assignee');
  }));

  cleanups.push(eventBus.on('task.completed', (payload) => {
    const svc = getService();
    if (!svc) return;
    const { taskId } = payload;
    const subscribers = svc.getSubscribers(taskId);
    for (const sub of subscribers) {
      svc.send({
        workspaceId: '',
        targetType: sub.subscriber_type as 'user' | 'agent',
        targetId: sub.subscriber_id,
        type: 'execution_done',
        title: `Task ${taskId} completed`,
      });
    }
  }));

  cleanups.push(eventBus.on('task.failed', (payload) => {
    const svc = getService();
    if (!svc) return;
    const { taskId, error } = payload;
    const subscribers = svc.getSubscribers(taskId);
    for (const sub of subscribers) {
      svc.send({
        workspaceId: '',
        targetType: sub.subscriber_type as 'user' | 'agent',
        targetId: sub.subscriber_id,
        type: 'execution_failed',
        title: `Task ${taskId} failed`,
        body: error,
        priority: 'urgent',
      });
    }
  }));

  cleanups.push(eventBus.on('delegation.async.timeout', (payload) => {
    const svc = getService();
    if (!svc) return;
    const { delegationId } = payload;
    svc.send({
      workspaceId: '',
      targetType: 'user',
      targetId: 'owner',
      type: 'system',
      title: `Delegation ${delegationId} timed out`,
      priority: 'urgent',
    });
  }));

  return () => { for (const c of cleanups) c(); };
}
