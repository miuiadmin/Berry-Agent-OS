/**
 * L0 contracts — 事件词汇基型（内核篇 §5 词汇表 / 会话篇 §1.1 唯一权威信封）。
 *
 * 两类「事件」严格区分（内核篇词汇：活体事件 vs durable 事件）：
 * - ctx.on/emit 上的**活体事件**：进程内广播，不落库，传输层订阅转发给 UI；
 * - **durable 事件**：SessionEvent 信封 append 进会话事件日志，是唯一事实源。
 */

/**
 * 活体事件名。统一小写斜线式 `'<域>/<动作>'`（如 session/event、tool/finished、
 * approval/decided）。完整清单随各模块 types 收口（35 钩子见插件契约篇 §2.2）；
 * M1 首发仅以字符串词汇约束，各模块落地时在此追加字面量联合。
 */
export type EventName = string;

/** 遮蔽指令：改历史的唯一合法形态（会话篇 §2）——新事件携带，在派生表面遮蔽 [start, end] 区间旧节点 */
export interface SurfaceOp {
  op: 'replace';
  start: number;
  end: number;
}

/**
 * durable 事件信封（会话篇 §1.1 唯一权威）：会话事件日志的唯一条目形态。
 * 写入时经单遍 JSON 校验 + deepFreeze，任何持有者改不动。
 */
export interface SessionEvent<T = unknown> {
  /** 事件类型词汇（核心清单 + 插件显式注册扩展；未知且非 ignorable 读侧整体拒绝） */
  readonly type: string;
  /** 会话内连续序号，0 起、+1 递增（= 写入时 log.length，强制连续） */
  readonly seq: number;
  /** 毫秒时间戳；合成事件复用最后真实事件的 time（恢复确定性） */
  readonly time: number;
  /** 已冻结的 JSON 快照（载荷 schema 随事件类型定义方收口） */
  readonly data: T;
  /** true = 读侧可以不认识此类型（向前兼容）；缺省 = 必须认识 */
  readonly ignorable?: boolean;
  /** 遮蔽指令，仅改历史事件携带 */
  readonly surfaceOp?: SurfaceOp;
  /** 遮蔽溯源：被遮蔽节点 + 依据事件的完整 seq 列表（只能引用更早的 seq） */
  readonly sourceEventSeqs?: number[];
}
