/**
 * L3 scheduler — DiscoveryGates 纯函数（内核边界篇 §4.1 席 13）。
 *
 * 手动触发前的「别跟用户打架」闸门：两判据均由组合根闭包注入数据
 *（busy = 驱动运行态；recent_user_msg = events 表 SQL 投影），件零表
 * 知识、纯函数可单测——判据语义集中在这一处。
 */

/** 「用户刚说话」窗口（毫秒）：窗口内手动触发让路——agent 可能即将开跑 */
export const RECENT_USER_MSG_WINDOW_MS = 30_000;

/** 闸门输入（三值全部注入——本函数不做任何 I/O） */
export interface DiscoveryGatesInput {
  /** 对话驱动是否正在跑（agent 忙 = 跑任务必抢上下文，让路） */
  readonly agentBusy: boolean;
  /** 当前会话最近一条 user/message 时刻（Unix 毫秒；无会话/无消息 = null） */
  readonly lastUserMessageAt: number | null;
  /** 判定时钟（Unix 毫秒——注入式，测试可冻结） */
  readonly now: number;
}

/** 拒绝原因（ok=false 时必带——通知面的人读词汇） */
export type DiscoveryGateReason = 'agent_busy' | 'recent_user_msg';

/** 闸门裁决 */
export interface DiscoveryGateDecision {
  readonly ok: boolean;
  readonly reason?: DiscoveryGateReason;
}

/**
 * 手动触发闸门：agent 空闲 且 用户最近未说话才放行。
 * 判据序：busy 优先（正跑必拒）→ recent_user_msg（空闲但用户刚落消息，
 * 对话可能即将启动——30 秒窗口内让路）。
 */
export function discoveryGates(input: DiscoveryGatesInput): DiscoveryGateDecision {
  if (input.agentBusy) {
    return { ok: false, reason: 'agent_busy' };
  }
  if (input.lastUserMessageAt !== null && input.now - input.lastUserMessageAt < RECENT_USER_MSG_WINDOW_MS) {
    return { ok: false, reason: 'recent_user_msg' };
  }
  return { ok: true };
}
