/**
 * L1 persist — llm/usage 计量聚合查询（canAfford 的读侧，会话篇 §1.1 / §3.3 读方清单）。
 *
 * 2026-08-24 第十一批拍板 #1（loopx 读码启发 #1）：预算底账 durable 化——花销是
 * 会话日志 llm/usage log-only 事件（写侧 = 组合根把 ctx.llm.complete 的 onUsage
 * 接线进 session.append），余额是本文件的聚合查询、不存储——重启不清零、双开各记
 * 半边（WAL 单库跨进程可见）、用户可审计，三题一次解。
 *
 * 归属说明：json_extract 的载荷路径（$.usage.*）是 llm/usage 事件信封知识，本文件
 * 与 session/event-types.ts 的 LlmUsageData 同源维护；物理编码与连接治理在 persist
 * （经 Store.connection 公共连接面——memory 表族同款先例），llm 模块不 import 本文件
 * （查询经组合根闭包注入，拓扑边不增）。
 */

import type { Store } from './store.js';

/** 聚合语句（调用频次 = canAfford 检查频次，prepare 开销可忽略——不走缓存面） */
const SUM_BACKGROUND_SQL = `
  SELECT COALESCE(SUM(json_extract(data, '$.usage.input') + json_extract(data, '$.usage.output')), 0) AS spent
  FROM events
  WHERE type = 'llm/usage'
    AND json_extract(data, '$.priority') = 'background'
    AND time >= ?
`;

/** 应用域聚合语句（canAfford 第三维 app——会话域投影归集：JOIN sessions 按 app 列过滤） */
const SUM_BACKGROUND_APP_SQL = `
  SELECT COALESCE(SUM(json_extract(e.data, '$.usage.input') + json_extract(e.data, '$.usage.output')), 0) AS spent
  FROM events e
  JOIN sessions s ON e.session_id = s.id
  WHERE e.type = 'llm/usage'
    AND json_extract(e.data, '$.priority') = 'background'
    AND e.time >= ?
    AND s.app = ?
`;

/**
 * 当日（自 sinceMs 起）后台补全累计 tokens（in+out 合计——与闸门限额同口径）。
 *
 * - 全表扫描无 (type, time) 索引：个人助手量级（日千级事件）毫秒级返回，真实量级
 *   出现再加索引（克制——不为未到的规模预付）；
 * - write-behind 批落窗口内的最近一两笔可能未及落盘（闸门偏松一笔）——与
 *   「最后一发可略超限额」同语义，预算是软闸门不是安全边界；
 * - 跨会话天然成立：events 表单库带 session_id，聚合按 type+time 全局过滤
 *   （双开另一进程的花销经 WAL 落盘后同样可见）。
 *
 * @param app 应用域（可选项——给出即按会话域投影归集：花销按 sessions.app 归集
 *   到当日各会话所属应用名下。底账 log-only 事件载荷不加 appId——域归属是
 *   会话行的属性，不是每笔花销的属性）
 */
export function spentBackgroundTokensSince(store: Store, sinceMs: number, app?: string): number {
  if (app === undefined) {
    const row = store.connection.prepare(SUM_BACKGROUND_SQL).get(sinceMs) as { spent: number } | undefined;
    return row?.spent ?? 0;
  }
  const row = store.connection.prepare(SUM_BACKGROUND_APP_SQL).get(sinceMs, app) as { spent: number } | undefined;
  return row?.spent ?? 0;
}

/** 本地时区今日零点（毫秒）——装配层聚合闭包的日界参数（与「本地日历日」语义一致） */
export function localDayStartMs(now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime();
}
