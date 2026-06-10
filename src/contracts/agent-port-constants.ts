/**
 * AgentPort 常量定义。
 *
 * 独立于接口契约，方便实现层和测试层复用。
 */

/** 禁止作为 request/send 目标的 Agent 名称列表 */
export const FORBIDDEN_TARGETS: ReadonlySet<string> = new Set([
  'brain', // Brain 不是对话伙伴，只能通过专用 handler (review/route/permission) 交互
]);

/** 默认 request 超时（毫秒），与 DIALOGUE_DEFAULTS.replyTimeoutMs 一致 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
