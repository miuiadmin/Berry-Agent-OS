import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import type {
  INotificationService,
  NotificationRow,
  TaskSubscriberRow,
  SendNotificationInput,
  PreferenceCategory,
  SubscriptionReason,
  NotificationPriority,
} from './contracts.js';

const DEFAULT_PREFERENCES: Record<PreferenceCategory, 'enabled' | 'muted'> = {
  assignments: 'enabled',
  status_changes: 'enabled',
  comments: 'enabled',
  agent_activity: 'enabled',
  reviews: 'enabled',
};

const TYPE_TO_CATEGORY: Record<string, PreferenceCategory> = {
  task_assigned: 'assignments',
  execution_done: 'agent_activity',
  execution_failed: 'agent_activity',
  review_needed: 'reviews',
  mention: 'comments',
  system: 'assignments',
  cron_exception: 'agent_activity',
  delegation_completed: 'assignments',
};

export class NotificationService implements INotificationService {
  private stmts: ReturnType<typeof this.prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepareStatements();
  }

  private prepareStatements() {
    return {
      insert: this.db.prepare(`
        INSERT INTO notifications (id, workspace_id, target_type, target_id, type, title, body, link, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getForTarget: this.db.prepare(`
        SELECT * FROM notifications WHERE target_type = ? AND target_id = ? AND archived = 0
        ORDER BY created_at DESC LIMIT ?
      `),
      getForTargetUnread: this.db.prepare(`
        SELECT * FROM notifications WHERE target_type = ? AND target_id = ? AND read = 0 AND archived = 0
        ORDER BY created_at DESC LIMIT ?
      `),
      getForTargetInWorkspace: this.db.prepare(`
        SELECT * FROM notifications WHERE target_type = ? AND target_id = ? AND workspace_id = ? AND archived = 0
        ORDER BY created_at DESC LIMIT ?
      `),
      getForTargetUnreadInWorkspace: this.db.prepare(`
        SELECT * FROM notifications WHERE target_type = ? AND target_id = ? AND workspace_id = ? AND read = 0 AND archived = 0
        ORDER BY created_at DESC LIMIT ?
      `),
      unreadCount: this.db.prepare(`
        SELECT COUNT(*) as cnt FROM notifications WHERE target_type = ? AND target_id = ? AND read = 0 AND archived = 0
      `),
      unreadCountInWorkspace: this.db.prepare(`
        SELECT COUNT(*) as cnt FROM notifications WHERE target_type = ? AND target_id = ? AND workspace_id = ? AND read = 0 AND archived = 0
      `),
      markRead: this.db.prepare(`UPDATE notifications SET read = 1 WHERE id = ?`),
      markAllRead: this.db.prepare(`UPDATE notifications SET read = 1 WHERE target_type = ? AND target_id = ? AND read = 0`),
      markAllReadInWorkspace: this.db.prepare(`UPDATE notifications SET read = 1 WHERE target_type = ? AND target_id = ? AND workspace_id = ? AND read = 0`),
      archive: this.db.prepare(`UPDATE notifications SET archived = 1 WHERE id = ?`),
      archiveStale: this.db.prepare(`UPDATE notifications SET archived = 1 WHERE read = 0 AND archived = 0 AND created_at < ?`),
      insertSubscriber: this.db.prepare(`
        INSERT OR IGNORE INTO task_subscribers (id, task_id, subscriber_type, subscriber_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      deleteSubscriber: this.db.prepare(`
        DELETE FROM task_subscribers WHERE task_id = ? AND subscriber_id = ?
      `),
      getSubscribers: this.db.prepare(`SELECT * FROM task_subscribers WHERE task_id = ?`),
      getPreferences: this.db.prepare(`SELECT preferences_json FROM notification_preferences WHERE workspace_id = ? AND user_id = ?`),
      upsertPreferences: this.db.prepare(`
        INSERT INTO notification_preferences (id, workspace_id, user_id, preferences_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET preferences_json = excluded.preferences_json, updated_at = excluded.updated_at
      `),
    };
  }

  send(input: SendNotificationInput): NotificationRow {
    const category = TYPE_TO_CATEGORY[input.type];
    if (category && !this.shouldDeliver(input.workspaceId, input.targetId, category)) {
      const row: NotificationRow = {
        id: genId(),
        workspace_id: input.workspaceId,
        target_type: input.targetType,
        target_id: input.targetId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        priority: input.priority ?? 'normal',
        read: 1,
        archived: 1,
        created_at: Date.now(),
      };
      return row;
    }

    const id = genId();
    const now = Date.now();
    const priority: NotificationPriority = input.priority ?? 'normal';
    this.stmts.insert.run(id, input.workspaceId, input.targetType, input.targetId, input.type, input.title, input.body ?? null, input.link ?? null, priority, now);

    return {
      id,
      workspace_id: input.workspaceId,
      target_type: input.targetType,
      target_id: input.targetId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      priority,
      read: 0,
      archived: 0,
      created_at: now,
    };
  }

  getForTarget(targetType: string, targetId: string, opts?: { unreadOnly?: boolean; limit?: number; workspaceId?: string }): NotificationRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.workspaceId) {
      if (opts.unreadOnly) return this.stmts.getForTargetUnreadInWorkspace.all(targetType, targetId, opts.workspaceId, limit) as NotificationRow[];
      return this.stmts.getForTargetInWorkspace.all(targetType, targetId, opts.workspaceId, limit) as NotificationRow[];
    }
    if (opts?.unreadOnly) return this.stmts.getForTargetUnread.all(targetType, targetId, limit) as NotificationRow[];
    return this.stmts.getForTarget.all(targetType, targetId, limit) as NotificationRow[];
  }

  getUnreadCount(targetType: string, targetId: string, workspaceId?: string): number {
    if (workspaceId) {
      return (this.stmts.unreadCountInWorkspace.get(targetType, targetId, workspaceId) as { cnt: number }).cnt;
    }
    return (this.stmts.unreadCount.get(targetType, targetId) as { cnt: number }).cnt;
  }

  markRead(notificationId: string): void {
    this.stmts.markRead.run(notificationId);
  }

  markAllRead(targetType: string, targetId: string, workspaceId?: string): void {
    if (workspaceId) {
      this.stmts.markAllReadInWorkspace.run(targetType, targetId, workspaceId);
    } else {
      this.stmts.markAllRead.run(targetType, targetId);
    }
  }

  archive(notificationId: string): void {
    this.stmts.archive.run(notificationId);
  }

  archiveStale(): number {
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    const result = this.stmts.archiveStale.run(sevenDaysAgo);
    return result.changes;
  }

  subscribe(taskId: string, subscriberType: string, subscriberId: string, reason: SubscriptionReason): void {
    this.stmts.insertSubscriber.run(genId(), taskId, subscriberType, subscriberId, reason, Date.now());
  }

  unsubscribe(taskId: string, subscriberId: string): void {
    this.stmts.deleteSubscriber.run(taskId, subscriberId);
  }

  getSubscribers(taskId: string): TaskSubscriberRow[] {
    return this.stmts.getSubscribers.all(taskId) as TaskSubscriberRow[];
  }

  getPreferences(workspaceId: string, userId: string): Record<PreferenceCategory, 'enabled' | 'muted'> {
    const row = this.stmts.getPreferences.get(workspaceId, userId) as { preferences_json: string } | undefined;
    if (!row) return { ...DEFAULT_PREFERENCES };
    try {
      const parsed = JSON.parse(row.preferences_json) as Partial<Record<PreferenceCategory, 'enabled' | 'muted'>>;
      return { ...DEFAULT_PREFERENCES, ...parsed };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  updatePreferences(workspaceId: string, userId: string, prefs: Partial<Record<PreferenceCategory, 'enabled' | 'muted'>>): void {
    const current = this.getPreferences(workspaceId, userId);
    const merged = { ...current, ...prefs };
    this.stmts.upsertPreferences.run(genId(), workspaceId, userId, JSON.stringify(merged), Date.now());
  }

  shouldDeliver(workspaceId: string, userId: string, category: PreferenceCategory): boolean {
    const prefs = this.getPreferences(workspaceId, userId);
    return prefs[category] !== 'muted';
  }
}
