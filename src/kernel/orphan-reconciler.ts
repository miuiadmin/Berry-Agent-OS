/**
 * Orphan User-Row Reconciler - 孤儿 user 消息兜底
 *
 * 核心目标：让"对话一定要保证稳定地运行"。
 *
 * 场景：user 消息在 handleMessage 入口已落 conversations 表（R1 修复 + P0-2 修复），
 * 但 assistant 回复在以下失败场景下永远入库：
 * - agent.crashed 进程死亡
 * - Runtime exception 抛出
 * - 整个 daemon 重启（pendingRequests 内存全丢）
 * - LLM 流式 chunk 突然停推（无 final.response 到达）
 * - 任务超时（task.timeout 事件）
 *
 * 本模块在 daemon 启动后 + 定期跑，扫描 conversations 表中
 * "role='user' 且后续 60s 内无 role='assistant' 的孤儿对"，
 * 调用 saveMessage('assistant', '[系统] 上次回复因进程异常未完成，请重新提问')
 * 兜底写入。这样用户刷新后至少能看到 assistant 行的占位说明。
 *
 * 设计：内存 set 维护已处理 user_id 防止 daemon 运行期内重复兜底（每次扫描
 * 同一孤儿不重复写 system 行）。daemon 重启时 set 清空，老孤儿会再被兜底
 * 一次（再写一条 system 行，可接受，因为老孤儿用户早已知道对话没回复）。
 */
import type { EventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';
import { getDb } from '../memory/db.js';
import { saveMessage } from '../memory/conversations.js';

const logger = getLogger('orphan-reconciler');

/** 孤儿判定窗口：user 消息后 60s 内无 assistant 回复视为孤儿 */
const ORPHAN_WINDOW_MS = 60_000;
/** 扫描间隔（毫秒） */
const SCAN_INTERVAL_MS = 60_000;
/** 单次扫描最多处理的孤儿数（防爆量） */
const MAX_ORPHANS_PER_SCAN = 50;
/** 系统兜底文案 */
const SYSTEM_FALLBACK_CONTENT = '[系统] 上次回复因进程异常未完成，请重新提问。';

/** 进程内已处理过的 user_id 集合（防重复写 system 行） */
const reconciledUserIds = new Set<string>();

/**
 * 扫描 conversations 表中的孤儿 user 消息并兜底写入 assistant 提示。
 *
 * 孤儿判定：
 * 1. role='user' 行
 * 2. 该行 created_at < now - ORPHAN_WINDOW_MS（已过 60s 窗口）
 * 3. 该 session + 该 user.created_at 之后 60s 内无 assistant / tool / system 行
 * 4. 该 user.id 未被本扫描器处理过（in-memory set）
 */
export function scanOrphanUserRows(): { reconciled: number; scanned: number } {
  const db = getDb();
  const cutoff = Date.now() - ORPHAN_WINDOW_MS;

  // 找孤儿 user 行：role=user，created_at < cutoff（已过 60s 窗口），
  // 且该 user.created_at 之后 60s 内无 assistant 行
  const candidates = db.prepare(
    `SELECT u.id AS user_id, u.session_id, u.content, u.created_at
     FROM conversations u
     WHERE u.role = 'user'
       AND u.created_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM conversations a
         WHERE a.session_id = u.session_id
           AND a.role IN ('assistant', 'tool', 'system')
           AND a.created_at > u.created_at
           AND a.created_at < u.created_at + ?
       )
     ORDER BY u.created_at ASC
     LIMIT ?`,
  ).all(cutoff, ORPHAN_WINDOW_MS, MAX_ORPHANS_PER_SCAN) as Array<{
    user_id: string; session_id: string; content: string; created_at: number;
  }>;

  let reconciled = 0;
  for (const orphan of candidates) {
    if (reconciledUserIds.has(orphan.user_id)) continue;
    try {
      // 写 assistant 兜底行
      saveMessage(orphan.session_id, 'assistant', SYSTEM_FALLBACK_CONTENT);
      reconciledUserIds.add(orphan.user_id);
      reconciled += 1;
      logger.warn({
        userId: orphan.user_id, sessionId: orphan.session_id,
        userContent: orphan.content.slice(0, 80),
        createdAt: orphan.created_at,
      }, '孤儿 user 消息已兜底写入 assistant 提示');
    } catch (err) {
      logger.error({ err, userId: orphan.user_id }, '孤儿兜底写入失败');
    }
  }

  return { reconciled, scanned: candidates.length };
}

/**
 * OrphanReconciler 定期扫描器。
 * daemon 启动后启动；外部 signal（graceful shutdown）时停止。
 */
/**
 * OrphanReconciler - 孤儿 user row 兜底扫描器。
 *
 * 提供两种运行模式：
 * 1. 启动时一次性扫描（runOnce）— 覆盖上次运行遗留的孤儿
 * 2. 周期性扫描（start/stop）— 覆盖运行期间产生的短期孤儿
 *    （如进程内对话超时但未被其他兜底机制捕获的场景）
 *
 * 周期扫描间隔默认 120s，大于 ORPHAN_WINDOW_MS（60s），
 * 确保孤儿有足够时间被正常机制处理后再被兜底。
 */
export class OrphanReconciler {
  // EventBus 参数保留供未来 emit 事件用（如 'orphan.reconciled'），当前实现不需要
  constructor(_eventBus: EventBus) {}

  /** 周期扫描定时器 */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 单次扫描 + 写入兜底 */
  runOnce(): { reconciled: number; scanned: number } {
    try {
      return scanOrphanUserRows();
    } catch (err) {
      logger.error({ err }, 'orphan reconciler 扫描失败');
      return { reconciled: 0, scanned: 0 };
    }
  }

  /**
   * 启动周期性扫描（120s 间隔）。
   * 通常在 bootstrap.startupRecovery() 调用 runOnce() 后调用。
   */
  start(intervalMs = 120_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const result = this.runOnce();
      if (result.reconciled > 0) {
        logger.info(result, '周期性孤儿扫描完成');
      }
    }, intervalMs);
    this.timer.unref();
    logger.debug({ intervalMs }, 'OrphanReconciler 周期扫描已启动');
  }

  /** 停止周期性扫描 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.debug('OrphanReconciler 周期扫描已停止');
    }
  }
}
