/**
 * 13.0 §5.3.2: Topic 订阅权限矩阵 — 防止 agent 订阅 Kernel 内部 / Brain 私有 topic。
 *
 * 规则：
 *   - 硬编码禁止所有 agent 订阅 `topic:brain-internal/*` 和 `topic:kernel-private/*`
 *   - 其他 topic 默认允许（白名单机制 — 新增 topic 无需改本文件）
 *   - 通配符支持：`topic:brain-internal.*` 命中 `topic:brain-internal.checkpoint`
 *   - 后续如需 per-agent 黑名单，可以扩展为 Map<agentName, Set<topic>>
 *
 * 调用方：
 *   - KernelRouter / AgentManager 在 agent 调用 `subscribe(topic, ...)` 前调 gateTopicSubscribe
 *   - 返回 true 表示允许；false 表示拒绝
 */

const FORBIDDEN_TOPIC_PATTERNS: readonly string[] = [
  'topic:brain-internal',
  'topic:brain-internal.*',
  'topic:kernel-private',
  'topic:kernel-private.*',
];

/**
 * 判断 agent 是否允许订阅给定 topic。
 *
 * @param agentName 发起订阅的 agent 名（保留参数 — 未来 per-agent 黑名单）
 * @param topic topic 字符串
 * @returns true 表示允许；false 表示拒绝
 */
export function gateTopicSubscribe(agentName: string, topic: string): boolean {
  if (!topic) return false;

  for (const pattern of FORBIDDEN_TOPIC_PATTERNS) {
    if (matchTopicPattern(pattern, topic)) {
      return false;
    }
  }
  return true;
}

/**
 * 列出当前所有被禁的 topic 模式（用于 UI 展示 / 测试）。
 */
export function listForbiddenTopics(): readonly string[] {
  return FORBIDDEN_TOPIC_PATTERNS;
}

/**
 * 通配符 topic 匹配：`*` 匹配除 `:` 外的一个或多个字符。
 * 例：
 *   matchTopicPattern('topic:brain-internal', 'topic:brain-internal') → true
 *   matchTopicPattern('topic:brain-internal.*', 'topic:brain-internal.checkpoint') → true
 *   matchTopicPattern('topic:brain-internal', 'topic:user-events') → false
 */
function matchTopicPattern(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;

  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return false;

  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);

  if (!topic.startsWith(prefix)) return false;
  if (suffix && !topic.endsWith(suffix)) return false;

  // * 至少匹配 1 个字符（防 topic:brain-internal* 匹配空 topic:brain-internal）
  const middle = topic.slice(prefix.length, topic.length - (suffix?.length ?? 0));
  return middle.length >= 1;
}