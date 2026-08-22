/**
 * L0 contracts — 事件词汇基型（内核篇 §5 词汇表 / 会话篇 §1 事实源）。
 *
 * 两类「事件」严格区分（内核篇词汇：活体事件 vs durable 事件）：
 * - ctx.on/emit 上的**活体事件**：进程内广播，不落库，传输层订阅转发给 UI；
 * - **durable 事件**：SessionEvent 信封 append 进会话事件日志，是唯一事实源。
 */

/**
 * 活体事件名。统一小写斜线式 `'<域>/<动作>'`（如 session/start、tool/finished、
 * approval/decided）。完整清单随各模块 types 收口（35 钩子见插件契约篇 §4）；
 * M1 首发仅以字符串词汇约束，各模块落地时在此追加字面量联合。
 */
export type EventName = string;

/**
 * durable 事件信封基型（会话篇 §1：append-only 单一事实源）。
 * 载荷 schema 以 session 模块 types 为权威（骨架篇 §9 纪律），此处只钉信封形状。
 */
export interface SessionEventEnvelope<TData = unknown> {
  /** 会话内连续序号，0 起、+1 递增——断裂即护栏触发（恢复 reducer 依赖） */
  readonly seq: number;
  /** 所属会话 id */
  readonly sessionId: string;
  /** ISO 8601 时间戳 */
  readonly time: string;
  /** 事件类别（session/start、user/message、assistant/message、tool/…）；未知类别整体拒绝、不静默丢弃（dsh 同纪律） */
  readonly kind: string;
  /** 类别对应的载荷（deepFreeze 冻结后对外） */
  readonly data: TData;
}
