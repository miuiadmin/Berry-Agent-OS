import { eq, and } from 'drizzle-orm';
import type { AppDb } from '../../db/client.js';
import { notifications, notificationPreferences, webhookDeliveries } from '../../db/schema/notifications.js';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type Notification = InferSelectModel<typeof notifications>;
export type NewNotification = InferInsertModel<typeof notifications>;
export type NotificationPreference = InferSelectModel<typeof notificationPreferences>;

export class NotificationRepository {
  constructor(private db: AppDb) {}

  findByTarget(targetType: string, targetId: string, limit = 50): Notification[] {
    return this.db.select().from(notifications)
      .where(and(eq(notifications.targetType, targetType), eq(notifications.targetId, targetId)))
      .limit(limit)
      .all();
  }

  findUnread(targetType: string, targetId: string): Notification[] {
    return this.db.select().from(notifications)
      .where(and(
        eq(notifications.targetType, targetType),
        eq(notifications.targetId, targetId),
        eq(notifications.read, 0),
      ))
      .all();
  }

  insert(notification: NewNotification): void {
    this.db.insert(notifications).values(notification).run();
  }

  markRead(id: string): void {
    this.db.update(notifications).set({ read: 1 }).where(eq(notifications.id, id)).run();
  }

  markAllRead(targetType: string, targetId: string): void {
    this.db.update(notifications)
      .set({ read: 1 })
      .where(and(
        eq(notifications.targetType, targetType),
        eq(notifications.targetId, targetId),
        eq(notifications.read, 0),
      ))
      .run();
  }

  getPreferences(workspaceId: string, userId: string): NotificationPreference | undefined {
    return this.db.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.workspaceId, workspaceId), eq(notificationPreferences.userId, userId)))
      .get();
  }

  upsertPreferences(workspaceId: string, userId: string, preferences: unknown, newId: string): void {
    const existing = this.getPreferences(workspaceId, userId);
    if (existing) {
      this.db.update(notificationPreferences)
        .set({ preferences: preferences as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(notificationPreferences.id, existing.id))
        .run();
    } else {
      this.db.insert(notificationPreferences).values({
        id: newId,
        workspaceId,
        userId,
        preferences: preferences as Record<string, unknown>,
        updatedAt: new Date(),
      }).run();
    }
  }
}
