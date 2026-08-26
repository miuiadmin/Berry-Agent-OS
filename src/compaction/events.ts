/**
 * L3 compaction — durable 会话事件词汇宿主面注册（会话篇 §2 增补 6 / §2.1
 * 官方件纪律，2026-08-26 纵切落码）。
 *
 * 四词出生纪律（契约篇事件词汇注册纪律：自动触发类带 reason + willRetry +
 * 失败孪生 `*_failed`）：
 * - compaction/start：归因启动（reason: threshold/overflow 封闭值 + willRetry）
 * - compaction/summary：审计快照（text/model/usage——可从日志重建迭代链）
 * - compaction/end：成功收尾（遮蔽规模观测）
 * - compaction/failed：失败孪生（冷却判定的 durable 数据源——重启不重试
 *   持续性 provider 故障，失败事实在日志里）
 *
 * 走宿主面模块级注册而非 ctx.registerSessionEventType（memory/diff 同款，
 * check-events 注释钉死的官方件纪律）：durable 词汇的可读性不随组合树行
 * 装载漂移——compaction 件可以被禁用/卸载，但曾压缩过的会话日志必须永远
 * 可读（未注册且非 ignorable 类型读侧整体拒绝 = 件卸载即旧会话变砖）。
 *
 * 本文件运行时依赖保持轻量（只 import contracts 注册面，不连锁 SQLite）——
 * check-events.mjs 族 3 直接 jiti 导入本模块取注册表运行时面。
 */

import { registerSessionEventType } from '../contracts/session-events.js';
import type { SessionEventTypeDefinition } from '../contracts/session-events.js';

/** compaction 四词定义（category 全 log-only——不进表面推导，落日志即目的） */
export const COMPACTION_EVENT_TYPES: readonly SessionEventTypeDefinition[] = [
  { type: 'compaction/start', category: 'log-only' },
  { type: 'compaction/summary', category: 'log-only' },
  { type: 'compaction/end', category: 'log-only' },
  { type: 'compaction/failed', category: 'log-only' },
];

// 模块加载即注册（官方件随包代码存在、组合无关）
for (const def of COMPACTION_EVENT_TYPES) {
  registerSessionEventType(def);
}
