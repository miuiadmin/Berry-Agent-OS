/**
 * 16.0 重构——kernel-router dialogue 辅助（从 kernel-router.ts 提取）。
 *
 * 纯函数操作 Map（对话方向追踪），不依赖 this.*。
 */
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('kernel-router');

/** §5.2.3: 追踪对话方向（from→to → dialogueId 集合） */
export function trackDialogueDirection(
  activeDialogueDirections: Map<string, Set<string>>,
  from: string, to: string, dialogueId: string,
): void {
  const key = `${from}→${to}`;
  let set = activeDialogueDirections.get(key);
  if (!set) { set = new Set(); activeDialogueDirections.set(key, set); }
  set.add(dialogueId);
  logger.debug({ from, to, dialogueId, activeCount: set.size }, 'KernelRouter: tracked dialogue direction');
}

/** §5.2.3: 清除对话方向追踪（集合空时清 Map entry 防泄漏） */
export function untrackDialogueDirection(
  activeDialogueDirections: Map<string, Set<string>>,
  from: string, to: string, dialogueId: string,
): void {
  const key = `${from}→${to}`;
  const set = activeDialogueDirections.get(key);
  if (set) {
    set.delete(dialogueId);
    if (set.size === 0) activeDialogueDirections.delete(key);
    logger.debug({ from, to, dialogueId, remainingCount: set.size }, 'KernelRouter: untracked dialogue direction');
  }
}
