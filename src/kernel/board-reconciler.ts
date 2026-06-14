/**
 * 任务板孤儿恢复（架构升级 16.0 §6.5.3）。
 *
 * 启动时扫 board_status='in_progress' 但 agent_task 已终态（崩溃/超时/取消/完成未收尾）的孤儿板，
 * 标 failed + 写系统兜底 report，保证板必达终态（对齐 15.0「失败永不丢」）。
 *
 * 与已删的旧 OrphanReconciler（R14-2）区别：旧版扫对话孤儿（user 后无 assistant），
 * 由 SessionManager.recoverSessions 在写入点兜底替代；本版扫【板孤儿】（板卡在 in_progress），
 * 是 16.0 task board 引入的新一类孤儿。
 *
 * 幂等：已 failed 的板不在 in_progress 查询范围，多次启动不重复标。
 */

import { listOrphanBoards } from './board-repo.js';
import { postSystemReportEnvelope } from './board-projection.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('board-reconciler');

/**
 * 扫描并恢复孤儿板。启动阶段调用（db 就绪后）。
 *
 * 每个孤儿板经 postSystemReportEnvelope：内部 postReportEnvelope(status:blocked) →
 * applyBoardStatus(in_progress→failed，合法流转) + 落 from:'system' report 信封（审计可见）。
 * 单调用即完成状态推进 + 兜底报告，无需额外 updateBoardMeta。
 *
 * @returns 恢复的孤儿板数（供启动日志/审计）
 */
export function reconcileOrphanBoards(): number {
  const orphans = listOrphanBoards();
  if (orphans.length === 0) return 0;
  for (const taskId of orphans) {
    // postSystemReportEnvelope 联动：status→failed（§6.5.1）+ 系统 report 信封落板（审计）
    postSystemReportEnvelope(taskId, {
      summary: '板孤儿恢复：启动时检测到 board_status=in_progress 但 agent_task 已终态（崩溃/超时/取消），标记 failed',
    });
  }
  logger.info({ count: orphans.length, taskIds: orphans }, 'board-reconciler: 恢复孤儿板（in_progress→failed）');
  return orphans.length;
}
