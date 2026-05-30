type Listener<T> = (payload: T) => void;

export class ModuleEventBus<EventMap extends {}> {
  private listeners = new Map<keyof EventMap, Set<Listener<any>>>();

  on<E extends keyof EventMap>(event: E, listener: Listener<EventMap[E]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit<E extends keyof EventMap>(event: E, payload: EventMap[E]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        listener(payload);
      }
    }
  }

  removeAllListeners(event?: keyof EventMap): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

export interface AppEventMap {
  'user.created': { userId: string };
  'user.updated': { userId: string };

  'workspace.created': { workspaceId: string; ownerId: string };
  'workspace.updated': { workspaceId: string };
  'workspace.deleted': { workspaceId: string };
  'workspace.member.added': { workspaceId: string; userId: string; role: string };
  'workspace.member.removed': { workspaceId: string; userId: string };

  'org.node.created': { workspaceId: string; nodeId: string; parentId: string | null };
  'org.node.moved': { workspaceId: string; nodeId: string; oldParentId: string | null; newParentId: string | null };
  'org.node.deleted': { workspaceId: string; nodeId: string };

  'agent.created': { agentId: string; workspaceId: string | null };
  'agent.updated': { agentId: string };
  'agent.archived': { agentId: string };
  'agent.trust.changed': { agentId: string; oldLevel: string; newLevel: string };
  'agent.status.changed': { agentId: string; status: string };

  'project.created': { projectId: string; workspaceId: string };
  'project.updated': { projectId: string };
  'project.archived': { projectId: string };

  'task.created': { taskId: string; workspaceId: string; projectId: string };
  'task.updated': { taskId: string };
  'task.assigned': { taskId: string; assigneeType: string; assigneeId: string };
  'task.moved': { taskId: string; fromColumnId: string; toColumnId: string };
  'task.completed': { taskId: string; workspaceId: string };
  'task.deleted': { taskId: string };

  'execution.started': { executionId: string; agentId: string; taskId: string | null };
  'execution.completed': { executionId: string; agentId: string; status: string };
  'execution.failed': { executionId: string; agentId: string; error: string };

  'review.requested': { executionId: string; reviewerId: string };
  'review.decided': { executionId: string; action: string; reviewerId: string };

  'scheduler.job.created': { jobId: string; workspaceId: string };
  'scheduler.job.triggered': { jobId: string; executionId: string };
  'scheduler.job.failed': { jobId: string; error: string };

  'memory.created': { memoryId: string; scope: 'agent' | 'workspace' | 'global' };
  'memory.updated': { memoryId: string };

  'plugin.created': { pluginId: string };
  'plugin.enabled': { pluginId: string };
  'plugin.disabled': { pluginId: string };

  'notification.created': { notificationId: string; targetType: string; targetId: string };
}

export type AppEvents = ModuleEventBus<AppEventMap>;

export function createEventBus(): AppEvents {
  return new ModuleEventBus<AppEventMap>();
}
