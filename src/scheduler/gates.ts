/**
 * L3 scheduler — DiscoveryGates 纯函数（内核边界篇 §4.1 席 13；第二刀④扩为
 * tick 投递统一闸门，骨架篇 §8.7 never-unbounded 律在 tick 入口的执法）。
 *
 * 判据四件（全部由调用方闭包注入数据——本函数不做任何 I/O，纯函数可单测）：
 * ① busy：turn/start·turn/end 配对深度 > 0（数据面 = events 表 SQL 投影，
 *   跨进程有效——席 13④拍板，driverRef 进程内布尔退役）；
 * ② recent_user_msg：用户 30 秒窗口内说过话（数据面进程内锚定——OS 时钟
 *   唤起的子进程读不到宿主内存态，定时路恒 null 退化，拍板已知边界）；
 * ③ canAfford：当日后台道余额（同一底账——复用 ctx.llm.canAfford 闭包，
 *   spend ledger = 日志投影不建第二套账；前台不硬断铁律不在此——闸的是
 *   tick 无人值守投递路）；
 * ④ 自激预算：同链自我唤醒连击深度（v1 数据面 = 驱动闭包注入 wakeCount；
 *   定时是外部钟非自激链，不计入——定时/手动路传 null 不判）。
 *
 * 定时/事件/手动三种触发全过本函数（openclaw 冷却门在分叉路径漏一条即
 * 烧钱的结构解）；管辖域 = scheduler 件的 tick 投递路——goal 续跑/notify
 * 类事件唤醒不归此闸，各走既有自激预算/预算刹车（席 13④管辖域收窄）。
 */

/** 「用户刚说话」窗口（毫秒）：窗口内触发让路——agent 可能即将开跑 */
export const RECENT_USER_MSG_WINDOW_MS = 30_000;

/**
 * 自激唤醒连击帽（判据④）：同一会话自上次用户消息后连续后台唤醒至此即拒
 * ——防「唤醒→结算→再唤醒」自旋烧钱（无人值守形态的 never-unbounded 软顶
 * 之一；token 硬顶随 Account 树批，骨架篇 §8.7 诚实定位）。
 */
export const WAKE_CHAIN_CAP = 5;

/** 闸门输入（五值全部注入——busy 数据面为 turn 配对深度，非布尔） */
export interface DiscoveryGatesInput {
  /** 敞开 turn 深度（> 0 = 有轮在跑；数据面 = events 表配对投影） */
  readonly turnDepth: number;
  /** 当前会话最近一条 user/message 时刻（Unix 毫秒；无会话/无消息/定时路 = null） */
  readonly lastUserMessageAt: number | null;
  /** 当日后台道预算是否尚可负担（= ctx.llm.canAfford('background') 同一闭包） */
  readonly backgroundAffordable: boolean;
  /** 同链自激唤醒连击数（定时/手动路 = null 不判；会话投递路注入实际连击数） */
  readonly wakeCount: number | null;
  /** 判定时钟（Unix 毫秒——注入式，测试可冻结） */
  readonly now: number;
}

/** 拒绝原因（ok=false 时必带——通知面的人读词汇） */
export type DiscoveryGateReason = 'agent_busy' | 'recent_user_msg' | 'over_budget' | 'wake_cap';

/** 闸门裁决 */
export interface DiscoveryGateDecision {
  readonly ok: boolean;
  readonly reason?: DiscoveryGateReason;
}

/**
 * tick 投递统一闸门：busy → recent_user_msg → canAfford → 自激预算，任一
 * 拒即拒（判据序 = 拒因可读性：先「跟用户打架」后「烧钱」）。
 */
export function discoveryGates(input: DiscoveryGatesInput): DiscoveryGateDecision {
  if (input.turnDepth > 0) {
    return { ok: false, reason: 'agent_busy' };
  }
  if (input.lastUserMessageAt !== null && input.now - input.lastUserMessageAt < RECENT_USER_MSG_WINDOW_MS) {
    return { ok: false, reason: 'recent_user_msg' };
  }
  if (!input.backgroundAffordable) {
    return { ok: false, reason: 'over_budget' };
  }
  if (input.wakeCount !== null && input.wakeCount >= WAKE_CHAIN_CAP) {
    return { ok: false, reason: 'wake_cap' };
  }
  return { ok: true };
}
