import { genId } from '../../utils/id.js';
import type { AppEvents } from '../../lib/event-bus.js';
import { NotificationRepository } from './notification.repository.js';
import type { Notification } from './notification.repository.js';

export interface SendNotificationInput {
  workspaceId: string;
  targetType: 'user' | 'agent';
  targetId: string;
  type: 'task_assigned' | 'execution_done' | 'execution_failed' | 'review_needed' | 'mention' | 'system';
  title: string;
  body?: string;
  link?: string;
}

export class NotificationService {
  constructor(
    private repo: NotificationRepository,
    private events: AppEvents,
  ) {}

  send(input: SendNotificationInput): Notification {
    const id = genId();
    const now = new Date();
    const notification = {
      id,
      workspaceId: input.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      read: 0,
      createdAt: now,
    };
    this.repo.insert(notification);
    this.events.emit('notification.created', {
      notificationId: id,
      targetType: input.targetType,
      targetId: input.targetId,
    });
    return notification as Notification;
  }

  getUnread(targetType: string, targetId: string): Notification[] {
    return this.repo.findUnread(targetType, targetId);
  }

  getAll(targetType: string, targetId: string, limit?: number): Notification[] {
    return this.repo.findByTarget(targetType, targetId, limit);
  }

  markRead(notificationId: string): void {
    this.repo.markRead(notificationId);
  }

  markAllRead(targetType: string, targetId: string): void {
    this.repo.markAllRead(targetType, targetId);
  }

  updatePreferences(workspaceId: string, userId: string, preferences: unknown): void {
    this.repo.upsertPreferences(workspaceId, userId, preferences, genId());
  }
}
