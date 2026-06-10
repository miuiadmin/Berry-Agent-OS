/**
 * 13.0 §5.3.7 + §8.8: user_preferences 管理器 — 跨 session 持久化的用户偏好。
 *
 * 数据源：
 * - Evolution Engine 从 user.feedback / restore-original / brain_modify_wrong 中推导
 * - BrainDecisionRecorder 把 severity=high 的 behavior_note 升级永久化
 * - 用户手动编辑（未来 UI）
 *
 * 清理策略：
 * - expires_at 设了值的行：定时清理（默认 90 天）
 * - expires_at NULL：常驻偏好（如「语言=中文」「风格=简洁」）
 */

import { getDb } from '../memory/index.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('user-preferences');

export type PreferenceSource =
  | 'evolution_engine'
  | 'brain_decision'
  | 'user_explicit'
  | 'restore_original';

export interface UserPreference {
  id: string;
  userId: string;
  prefKey: string;
  prefValue: string;
  source: PreferenceSource;
  confidence: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SetPreferenceInput {
  userId?: string;
  prefKey: string;
  prefValue: string;
  source?: PreferenceSource;
  confidence?: number;
  /** 过期时间戳（毫秒）；不传或 null 表示常驻 */
  expiresAt?: number | null;
}

const DEFAULT_USER_ID = 'default';
const DEFAULT_EXPIRES_MS = 90 * 24 * 60 * 60 * 1000; // 90 天

export class UserPreferencesManager {
  /** 写入或更新偏好（upsert） */
  set(input: SetPreferenceInput): UserPreference | null {
    const userId = input.userId ?? DEFAULT_USER_ID;
    const source: PreferenceSource = input.source ?? 'brain_decision';
    const confidence = input.confidence ?? 1.0;
    const now = Date.now();
    const expiresAt = input.expiresAt ?? (source === 'evolution_engine' ? now + DEFAULT_EXPIRES_MS : null);

    try {
      const db = getDb();
      // SQLite UPSERT：INSERT ... ON CONFLICT(user_id, pref_key) DO UPDATE
      // confidence 取新值（防止 evolution 反复降低 confidence）
      db.prepare(`
        INSERT INTO user_preferences
          (id, user_id, pref_key, pref_value, source, confidence, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, pref_key) DO UPDATE SET
          pref_value = excluded.pref_value,
          source = excluded.source,
          confidence = excluded.confidence,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run(
        genId('pref'),
        userId,
        input.prefKey,
        input.prefValue,
        source,
        confidence,
        expiresAt,
        now,
        now,
      );
      return this.get(userId, input.prefKey);
    } catch (err) {
      logger.warn({ err, input }, 'user-preferences: set failed');
      return null;
    }
  }

  /** 读取单个偏好 */
  get(userId: string, prefKey: string): UserPreference | null {
    try {
      const db = getDb();
      const row = db.prepare(`
        SELECT id, user_id, pref_key, pref_value, source, confidence, expires_at, created_at, updated_at
        FROM user_preferences
        WHERE user_id = ? AND pref_key = ?
      `).get(userId, prefKey) as Record<string, unknown> | undefined;
      if (!row) return null;
      return this.mapRow(row);
    } catch (err) {
      logger.warn({ err, userId, prefKey }, 'user-preferences: get failed');
      return null;
    }
  }

  /** 列出 user 的所有偏好（按 prefKey 前缀过滤） */
  list(userId: string, keyPrefix?: string): UserPreference[] {
    try {
      const db = getDb();
      const rows = keyPrefix
        ? db.prepare(`
            SELECT id, user_id, pref_key, pref_value, source, confidence, expires_at, created_at, updated_at
            FROM user_preferences
            WHERE user_id = ? AND pref_key LIKE ?
            ORDER BY pref_key ASC
          `).all(userId, `${keyPrefix}%`) as Array<Record<string, unknown>>
        : db.prepare(`
            SELECT id, user_id, pref_key, pref_value, source, confidence, expires_at, created_at, updated_at
            FROM user_preferences
            WHERE user_id = ?
            ORDER BY pref_key ASC
          `).all(userId) as Array<Record<string, unknown>>;
      return rows.map(r => this.mapRow(r));
    } catch (err) {
      logger.warn({ err, userId, keyPrefix }, 'user-preferences: list failed');
      return [];
    }
  }

  /** 删除单个偏好 */
  delete(userId: string, prefKey: string): boolean {
    try {
      const db = getDb();
      const r = db.prepare(`DELETE FROM user_preferences WHERE user_id = ? AND pref_key = ?`).run(userId, prefKey);
      return r.changes > 0;
    } catch (err) {
      logger.warn({ err, userId, prefKey }, 'user-preferences: delete failed');
      return false;
    }
  }

  /** 清理过期偏好（>90 天） */
  cleanupExpired(now: number = Date.now()): number {
    try {
      const db = getDb();
      const r = db.prepare(`DELETE FROM user_preferences WHERE expires_at IS NOT NULL AND expires_at < ?`).run(now);
      if (r.changes > 0) {
        logger.info({ deleted: r.changes }, 'user-preferences: cleanupExpired');
      }
      return r.changes;
    } catch (err) {
      logger.warn({ err }, 'user-preferences: cleanupExpired failed');
      return 0;
    }
  }

  /** 渲染偏好为 system prompt 注入文本 */
  renderForPrompt(userId: string): string {
    const prefs = this.list(userId);
    if (prefs.length === 0) return '';
    const lines: string[] = ['## 用户偏好（跨 session 持久化）'];
    for (const p of prefs) {
      const conf = p.confidence < 1 ? ` (confidence=${p.confidence.toFixed(2)})` : '';
      lines.push(`- ${p.prefKey} = ${p.prefValue}${conf}`);
    }
    return lines.join('\n');
  }

  private mapRow(row: Record<string, unknown>): UserPreference {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      prefKey: row.pref_key as string,
      prefValue: row.pref_value as string,
      source: row.source as PreferenceSource,
      confidence: row.confidence as number,
      expiresAt: row.expires_at as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}

/** 全局单例 */
let globalManager: UserPreferencesManager | null = null;

export function getUserPreferences(): UserPreferencesManager {
  if (!globalManager) {
    globalManager = new UserPreferencesManager();
  }
  return globalManager;
}

export function resetUserPreferences(): void {
  globalManager = null;
}