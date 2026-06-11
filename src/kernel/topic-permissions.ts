/**
 * 13.0 §5.3.2: Topic 订阅权限矩阵 — per-agent 精细控制。
 *
 * 设计文档定义的权限模型：
 *   - 每个 topic 有一个 { canSubscribe: string[] } 矩阵
 *   - canSubscribe 中的 '*' 表示所有 agent 都可订阅
 *   - 具体的 agent 名（如 'brain', 'kernel'）表示仅该 agent 可订阅
 *   - 不在矩阵中的 topic 默认拒绝（fail-closed）
 *   - 通配符 topic 支持：`topic:xxx.*` 匹配 `topic:xxx.yyy`
 *
 * 调用方：
 *   - KernelRouter / AgentManager 在 agent 调用 `subscribe(topic, ...)` 前调 gateTopicSubscribe
 *   - 返回 true 表示允许；false 表示拒绝
 */

// ─────────────────────────────────────────────────────────────────
// §5.3.2 Topic 权限矩阵
// ─────────────────────────────────────────────────────────────────

/**
 * Topic 权限条目。
 * canSubscribe 列表中：
 *   - '*' 表示所有 agent 可订阅
 *   - 具体名称（如 'brain'）表示仅该 agent 可订阅
 */
interface TopicPermission {
  /** 允许订阅该 topic 的 agent 列表（'*' = 全部） */
  canSubscribe: string[];
}

/**
 * §5.3.2 完整权限矩阵。
 *
 * key = topic 字符串或通配符模式（如 'topic:brain-internal.*'）
 * value = { canSubscribe: string[] } 允许订阅的 agent 列表
 *
 * 新增 topic 时必须在此矩阵中注册，否则所有 agent 都会被拒绝（fail-closed）。
 */
const TOPIC_PERMISSIONS: Record<string, TopicPermission> = {
  // ─── 公共 topic — 所有 agent 可订阅 ───
  'topic:tool-events':       { canSubscribe: ['*'] },
  'topic:agent-chats':       { canSubscribe: ['*'] },
  'topic:task-progress':     { canSubscribe: ['*'] },
  'topic:mission-events':    { canSubscribe: ['*'] },

  // ─── Brain + Kernel 独占 topic — 只有 Brain 和 Kernel 可订阅 ───
  'topic:user-interactions': { canSubscribe: ['brain', 'kernel'] },
  'topic:brain-internal':    { canSubscribe: ['brain'] },
  'topic:brain-internal.*':  { canSubscribe: ['brain'] },
  'topic:permission-flows':  { canSubscribe: ['brain', 'kernel'] },
  'topic:kernel-private':    { canSubscribe: ['kernel'] },
  'topic:kernel-private.*':  { canSubscribe: ['kernel'] },

  // ─── 安全审计 topic — 仅 Kernel 可订阅（写入审计日志） ───
  'topic:security-audit':    { canSubscribe: ['kernel'] },
};

// ─────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────

/**
 * 判断 agent 是否允许订阅给定 topic。
 *
 * 查找顺序：
 *   1. 精确匹配 topic → 检查 canSubscribe
 *   2. 通配符匹配 → 遍历所有 `xxx.*` 模式
 *   3. 不匹配任何矩阵条目 → 拒绝（fail-closed）
 *
 * @param agentName 发起订阅的 agent 名
 * @param topic topic 字符串
 * @returns true 表示允许；false 表示拒绝
 */
export function gateTopicSubscribe(agentName: string, topic: string): boolean {
  if (!topic) return false;

  // 1. 精确匹配
  const exact = TOPIC_PERMISSIONS[topic];
  if (exact) {
    return exact.canSubscribe.includes('*') || exact.canSubscribe.includes(agentName);
  }

  // 2. 通配符匹配：遍历所有模式，找到最长匹配（最具体的模式优先）
  let matched: TopicPermission | null = null;
  let matchedLength = -1;

  for (const [pattern, perm] of Object.entries(TOPIC_PERMISSIONS)) {
    if (pattern.includes('*') && matchTopicPattern(pattern, topic)) {
      // 选择最具体的（最长的前缀）模式
      const prefixLen = pattern.indexOf('*');
      if (prefixLen > matchedLength) {
        matchedLength = prefixLen;
        matched = perm;
      }
    }
  }

  if (matched) {
    return matched.canSubscribe.includes('*') || matched.canSubscribe.includes(agentName);
  }

  // 3. 不在矩阵中 → fail-closed（拒绝）
  return false;
}

/**
 * 列出当前所有权限矩阵条目（用于 UI 展示 / 测试）。
 *
 * @returns topic → 允许订阅的 agent 列表的映射
 */
export function listTopicPermissions(): Readonly<Record<string, TopicPermission>> {
  return TOPIC_PERMISSIONS;
}

/**
 * 向权限矩阵动态添加 topic 权限（用于插件注册自定义 topic）。
 *
 * @param topic topic 字符串
 * @param permission 权限条目
 */
export function registerTopicPermission(topic: string, permission: TopicPermission): void {
  TOPIC_PERMISSIONS[topic] = permission;
}

// ─────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────

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
