/**
 * L3 goal — durable 会话事件词汇宿主面注册（第三十九批 T4-A 轮结算账本 + 刀四沉淀）。
 *
 * 三词：
 * - goal/evidence（轮结算账本正文）：每轮 run 结束时 goal_update 轮结算分支落一条，
 *   载荷 { goalId, wakeId?, outcome, evidence? }——四值 outcome 词汇见 machine.ts
 *   DeliveryOutcome；另有四停因形（reason+willRetry：budget/capped/stalls——自动
 *   触发类事件出生纪律，各执法点随停随落）。
 * - goal/summary（刀四沉淀④步产物）：轮间沉淀每次成功落一条，载荷
 *   { goalId, text, summarySeq }——**沉淀事实源**（goals 表 summary/summary_seq
 *   两列只是缓存，丢列可从事件链回填——单事实源判据）。
 * - goal/summary-failed（第九轮 #20 修死）：轮间沉淀失败（attemptSummary catch）
 *   落一条，载荷 { goalId, error }（error = describeError 摘要过 2KiB 小帽）——
 *   compaction/failed 先例：失败不再 debug-only 无痕，水位不进 = 下次结算重试。
 *
 * 走宿主面模块级注册而非 ctx.registerSessionEventType（compaction/memory
 * 同款官方件纪律）：durable 词汇的可读性不随组合树行装载漂移——goal 件可以
 * 被禁用/卸载，但已记账的会话日志必须永远可读（未注册且非 ignorable 类型
 * 读侧整体拒绝 = 件卸载即旧会话变砖）。log-only = 只进 durable 日志、不进
 * 运行时总线——账本读者（goal_get 摘录 / 沉淀压缩）经 sessions 事件面回读。
 *
 * 本文件运行时依赖保持轻量（只 import contracts 注册面，不连锁 SQLite）——
 * check-events.mjs 族 3 直接 jiti 导入本模块取注册表运行时面。
 */

import { registerSessionEventType } from '../contracts/session-events.js';
import type { SessionEventTypeDefinition } from '../contracts/session-events.js';

/** goal 件 durable 事件类型定义（category log-only——落日志即目的，不进表面推导） */
export const GOAL_EVENT_TYPES: readonly SessionEventTypeDefinition[] = [
  { type: 'goal/evidence', category: 'log-only', tier: 'stable' },
  { type: 'goal/summary', category: 'log-only', tier: 'stable' },
  { type: 'goal/summary-failed', category: 'log-only', tier: 'stable' },
];

// 模块加载即注册（官方件随包代码存在、组合无关）
for (const def of GOAL_EVENT_TYPES) {
  registerSessionEventType(def);
}
