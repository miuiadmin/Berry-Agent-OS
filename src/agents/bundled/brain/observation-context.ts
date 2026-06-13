/**
 * C 级审核观察上下文渲染（纯逻辑，从 brain/entry.ts 抽出以便单测）。
 *
 * 15.0 C3 闭合：C 级审核把近期 Agent 行为观察注入 systemPrompt，供 Brain 后置审核参考。
 * 本模块钉死两个不变量（此前 entry.ts 内联实现，无单测，曾发生白名单遗漏 bug）：
 *
 *   1. {@link C_LEVEL_OBSERVATION_TYPES} 必须含 `'agent_event'`——周期审计报告（runAudit condensed，
 *      core-service auditTimer）与 plan_stalled 信号（checkPlanProgress）都以该类型记录。此前白名单
 *      遗漏导致这两类观察「只写不读」：落了 brain_observations 表，但 queryByType 查不到，Brain C 级
 *      审核永远看不到——与 entry.ts 注释承诺的「C 级 LLM 可见」自相矛盾，机制 C §4.6「Brain 据报告
 *      行动」闭环在此断裂。
 *
 *   2. agent_event 由发送方已预浓缩（含 riskScore + recommendations + topRisks），给更大内容预算
 *      （600）避免可行动信息被 200 字符预算截成残片；其余行为观察保持紧凑预算防噪声。
 *
 * 抽出为独立模块而非留在 entry.ts：entry.ts 是子进程 agent 入口（重初始化、无法直接 import 单测），
 * 纯渲染逻辑独立后可零依赖单测，钉死上述两个不变量防回归。
 */

import type { ObservationRow, ObservationType } from '../../../kernel/observation-recorder.js';
import { safeSlice } from '../../../utils/safe-slice.js';

/**
 * C 级审核注入的观察类型白名单。
 *
 * **不要从中移除 `'agent_event'`**——它是审计闭环（机制 C）与 plan_stalled 信号的消费入口；
 * 移除等于让这两类观察退回只写不读（见文件头注释）。单测 {@link C_LEVEL_OBSERVATION_TYPES} 钉死。
 */
export const C_LEVEL_OBSERVATION_TYPES: readonly ObservationType[] = [
  'dialogue_send',
  'dialogue_reply',
  'tool_call',
  'tool_result',
  'drift_signal',
  'agent_event', // 15.0 C3：审计报告 + plan_stalled——此前遗漏导致 §4.6 闭环断裂
];

/** agent_event 由发送方预浓缩，给更大预算保留完整可行动信息 */
const AGENT_EVENT_CONTENT_BUDGET = 600;
/** 其余行为观察保持紧凑预算，避免单条噪声占满 C 级上下文 */
const DEFAULT_CONTENT_BUDGET = 200;

/**
 * 把观察列表渲染为 C 级审核 systemPrompt 的「近期 Agent 行为观察」片段（纯函数）。
 *
 * 每行格式：`[类型] fromAgent→toAgent: 内容`。agent_event 类型用 600 字符预算，
 * 其余用 200。调用方负责把返回值拼到 systemPrompt 并加章节标题。
 *
 * @param observations queryByType 返回的观察行（已按类型过滤、按时间倒序）
 * @returns 多行文本，每行一条观察；空列表返回空串
 */
export function renderObservationContext(observations: ObservationRow[]): string {
  return observations
    .map((o) => {
      const budget = o.observationType === 'agent_event' ? AGENT_EVENT_CONTENT_BUDGET : DEFAULT_CONTENT_BUDGET;
      const arrow = o.toAgent ? `→${o.toAgent}` : '';
      return `[${o.observationType}] ${o.fromAgent}${arrow}: ${safeSlice(o.content, budget)}`;
    })
    .join('\n');
}
