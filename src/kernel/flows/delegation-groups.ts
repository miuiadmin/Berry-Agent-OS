/**
 * 16.0 重构——delegation group 管理（从 delegation-manager.ts 提取）。
 *
 * 6 个纯函数（操作 groups + childToGroupIndex 两个 Map，行为保持）：
 *   - createGroup：创建 multi-route 子任务组
 *   - addChildToGroup：子任务加入组
 *   - completeChild：子任务完成（返回是否全部完成）
 *   - getGroupByChild：按子任务查组
 *   - removeGroup：删除组（清子索引）
 */
import type { DelegationGroup } from '../../contracts/delegation.js';

/** 创建 multi-route 子任务组 */
export function createGroup(
  groups: Map<string, DelegationGroup>,
  parentId: string, correlationId: string, sessionId: string,
): DelegationGroup {
  const group: DelegationGroup = {
    parentId, childIds: new Set(), completedResults: new Map(),
    correlationId, sessionId, createdAt: Date.now(),
  };
  groups.set(correlationId, group);
  return group;
}

/** 子任务加入组 + 更新子索引 */
export function addChildToGroup(
  groups: Map<string, DelegationGroup>,
  childToGroupIndex: Map<string, string>,
  correlationId: string, childId: string,
): void {
  const group = groups.get(correlationId);
  if (group) {
    group.childIds.add(childId);
    childToGroupIndex.set(childId, correlationId);
  }
}

/** 子任务完成 → 清子索引，返回是否全部完成 */
export function completeChild(
  groups: Map<string, DelegationGroup>,
  childToGroupIndex: Map<string, string>,
  correlationId: string, childId: string, agentName: string, response: string,
): boolean {
  const group = groups.get(correlationId);
  if (!group) return false;
  group.childIds.delete(childId);
  group.completedResults.set(childId, { agentName, response });
  childToGroupIndex.delete(childId);
  return group.childIds.size === 0;
}

/** 按子任务查组 */
export function getGroupByChild(
  groups: Map<string, DelegationGroup>,
  childToGroupIndex: Map<string, string>,
  childId: string,
): { group: DelegationGroup; correlationId: string } | undefined {
  const correlationId = childToGroupIndex.get(childId);
  if (!correlationId) return undefined;
  const group = groups.get(correlationId);
  if (!group) return undefined;
  return { group, correlationId };
}

/** 删除组（清所有子索引） */
export function removeGroup(
  groups: Map<string, DelegationGroup>,
  childToGroupIndex: Map<string, string>,
  correlationId: string,
): DelegationGroup | undefined {
  const group = groups.get(correlationId);
  if (group) {
    for (const childId of group.childIds) childToGroupIndex.delete(childId);
    groups.delete(correlationId);
  }
  return group;
}
