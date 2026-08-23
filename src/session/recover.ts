/**
 * L1 session — 崩溃恢复纯函数（会话篇 §4：interruptedTurnClosers）。
 *
 * 恢复 = 不改写历史、不截断完整事件，只做「补闭合」：为未配对的 tool/call
 * 合成错误终态 tool/result，为敞开的 turn 补 turn/end{reason:'interrupted'}。
 * 纯函数产出待追加事件，由调用方（恢复协调器）走 append 提交——合成事件与
 * 普通事件在日志里无形态差异，只是 data.error 写码、time 复用最后真实事件。
 */

import type { SessionEvent } from '../contracts/events.js';
import type { GateDecisionData, ToolCallData, ToolResultData, TurnEndReason } from './event-types.js';

/** 待追加的合成事件（不含 seq——由 append 时分配） */
export interface SyntheticCloser {
  readonly type: string;
  readonly data: unknown;
  /** 复用最后真实事件的毫秒时间戳（恢复确定性：重放不产生新时间） */
  readonly time: number;
}

/**
 * 计算中断闭合事件列表。
 * 判据（物理日志扫描，不应用遮蔽——崩溃尾部的 tool/call 不可能已被后写的 replace 遮蔽）：
 * - 未配对 tool/call 且其 toolCallId 无 gate/decision(allow) 前序 → 工具进程未启动
 *   → TOOL_NOT_STARTED（可安全重试）
 * - 有 gate/decision 前序（守门已放行）→ 已启动未结算 → TOOL_OUTCOME_UNKNOWN（须核验外部状态）
 * - 敞开 turn（最后一个 turn/start 后无 turn/end）→ 补 turn/end{reason:'interrupted'}
 *
 * 两条防御纪律（独立重读轮 #9 修复 c，2026-08-23）：
 * - turn 深度计数而非布尔——病态日志（重复 turn/start 无 end）也只多记敞开、
 *   不误判闭合；
 * - 孤儿 tool/call 不因后续 turn/end 清算——「turn 正常闭合即内部自洽」在
 *   app 层回调违约时会失守（tool/call 落账后 run 异常、无 turn_end、后续新
 *   turn 正常闭合），孤儿只能由配对的 tool/result 消费，兜底合成终态而非静默吞没。
 * @param events 物理事件日志（loadStored 读出的原始顺序）
 * @returns 待追加 closers（先 tool/result 后 turn/end）；日志本就闭合时为空数组
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SyntheticCloser[] {
  const closers: SyntheticCloser[] = [];
  // 复用最后真实事件的 time（空日志不会走到恢复——空日志即无闭合需求，返回空）
  const time = events.length > 0 ? events[events.length - 1]!.time : 0;

  /** turn 嵌套深度（turn/start +1 / turn/end -1 到 0 为止——负数属病态日志钳回 0） */
  let turnDepth = 0;
  /** 未结算的 tool/call（toolCallId → 调用信息）；只被配对 tool/result 消费，不跨 turn 清算 */
  const pending = new Map<string, ToolCallData>();
  /** 已见 gate/decision 的 toolCallId 集合（allow/mutate 均视为已放行启动） */
  const gated = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turnDepth += 1;
        break;
      case 'turn/end':
        turnDepth = Math.max(0, turnDepth - 1);
        break;
      case 'tool/call': {
        const data = event.data as ToolCallData;
        pending.set(data.toolCallId, data);
        break;
      }
      case 'tool/result': {
        const data = event.data as ToolResultData;
        pending.delete(data.toolCallId);
        break;
      }
      case 'gate/decision': {
        const data = event.data as GateDecisionData;
        if (data.decision !== 'block') {
          gated.add(data.toolCallId);
        }
        break;
      }
      default:
        break;
    }
  }

  // 未配对 tool/call → 合成错误终态（错误码即终态语义，读侧按码分派）
  for (const call of pending.values()) {
    const code = gated.has(call.toolCallId) ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED';
    const data: ToolResultData = {
      toolCallId: call.toolCallId,
      content: null,
      error: { code },
    };
    closers.push({ type: 'tool/result', data, time });
  }

  // 敞开 turn（深度 >0 = 每个 turn/start 欠一个 turn/end）→ 按深度逐个补闭合终态。
  // 补 N 个而非 1 个：恢复须一遍收敛——只补 1 个时深度仍 >0，第二遍恢复会再补，
  // 违反 recoverFromInterruption 的幂等承诺；投影不消费 turn 边界（derive 忽略），
  // 补足的闭合事件无语义副作用
  for (let i = 0; i < turnDepth; i += 1) {
    const data: { reason: TurnEndReason } = { reason: 'interrupted' };
    closers.push({ type: 'turn/end', data, time });
  }
  return closers;
}
