/**
 * 13.0 多智能体协作 — 共享计划工具（plan tool）。
 *
 * §10.3 / §12.4 — plan tool 的核心能力：
 *   - read：读取整个 plan.json，了解团队目标和自己的任务
 *   - update：更新任务状态/进度/结果、添加新任务、记录决策或备注
 *
 * 设计要点：
 *   - dangerLevel: 'safe'（只读写 JSON 文件，不涉及系统操作）
 *   - 任何 Agent 都能读写，不限于 Brain
 *   - 没有并发锁——依赖 LLM 的自然串行性（同类型 Agent 单实例）
 *   - 文件路径固定：~/.berry/missions/<mission_id>/plan.json
 *
 * 协作流程（§10.4）：
 *   1. Brain 创建 mission → 写入 plan.json
 *   2. Agent 收到任务 → 调 plan tool read → 看到自己的任务
 *   3. Agent 开始执行 → 调 plan tool update → 更新 progress
 *   4. Agent 完成 → 调 plan tool update → status=done, result=...
 *   5. Brain 定期读 plan.json → 监控进度、必要时干预
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { PlanToolInputSchema } from '../contracts/mission.js';
import { MissionManager } from '../kernel/mission-manager.js';

/** MissionManager 单例（由 initMissionTools 初始化） */
let managerRef: MissionManager | null = null;

/**
 * 初始化 plan/squad 工具所需的 MissionManager 引用。
 * 在系统启动时调用一次。
 */
export function initMissionTools(manager: MissionManager): void {
  managerRef = manager;
}

/** 获取 MissionManager 实例（squad-tools 也通过此函数获取） */
export function getManager(): MissionManager {
  if (!managerRef) throw new Error('Mission tools not initialized — call initMissionTools first');
  return managerRef;
}

/**
 * plan tool — 读取或更新共享计划文档。
 *
 * Agent 通过 useTool('plan', ...) 调用，与调用 readFile、shell 完全一致。
 * 不需要新的 IPC 消息类型，是 LLM 的自然交互方式。
 */
export const planTool: ToolDefinition = {
  name: 'plan',
  description: `读取或更新当前任务的共享计划文档（plan.json）。

用途：
  - read：查看团队目标、你的任务、其他任务的状态和依赖关系
  - update：更新你的任务进度、标记完成、添加新任务、记录决策

协作流程：
  1. 先 read 了解整体计划和你的任务
  2. 开始工作后用 update 更新 progress
  3. 完成后用 update 标记 status='done' 并填写 result
  4. 如果需要帮助，添加 new_task 分配给其他 agent`,

  inputSchema: PlanToolInputSchema,
  dangerLevel: 'safe',

  async execute(input: unknown): Promise<ToolResult> {
    const parsed = PlanToolInputSchema.parse(input);
    const manager = getManager();

    try {
      if (parsed.action === 'read') {
        return handleRead(manager, parsed.mission_id);
      }

      if (parsed.action === 'update') {
        return handleUpdate(manager, parsed.mission_id, parsed.updates);
      }

      return { content: `未知操作: ${parsed.action}`, isError: true };
    } catch (err) {
      return { content: `plan tool 错误: ${(err as Error).message}`, isError: true };
    }
  },
};

/**
 * 处理 read 操作 — 返回 plan.json 的格式化内容。
 */
function handleRead(manager: MissionManager, missionId: string): ToolResult {
  const summary = manager.readSummary(missionId);
  if (!summary) {
    return { content: `Mission ${missionId} 不存在`, isError: true };
  }
  return { content: summary };
}

/**
 * 处理 update 操作 — 更新 plan.json。
 */
function handleUpdate(
  manager: MissionManager,
  missionId: string,
  updates?: z.infer<typeof PlanToolInputSchema>['updates'],
): ToolResult {
  if (!updates) {
    return { content: 'update 操作需要提供 updates 参数', isError: true };
  }

  const plan = manager.updatePlan(missionId, updates);
  if (!plan) {
    return { content: `Mission ${missionId} 不存在`, isError: true };
  }

  // 构建反馈信息
  const parts: string[] = [];

  if (updates.task_id && updates.status) {
    parts.push(`任务 ${updates.task_id} 状态更新为 ${updates.status}`);
  }
  if (updates.progress) {
    parts.push(`进度: ${updates.progress}`);
  }
  if (updates.result) {
    parts.push(`结果: ${updates.result}`);
  }
  if (updates.new_task) {
    // 找到新添加的任务
    const newTask = plan.tasks[plan.tasks.length - 1];
    parts.push(`新增任务 ${newTask.id}: ${updates.new_task.what} → @${updates.new_task.who}`);
  }
  if (updates.decision) {
    parts.push(`记录决策: ${updates.decision.thought}`);
  }
  if (updates.note) {
    parts.push(`添加备注: ${updates.note}`);
  }
  if (updates.mission_status) {
    parts.push(`Mission 状态更新为 ${updates.mission_status}`);
  }

  const message = parts.length > 0
    ? parts.join('\n')
    : '无有效更新';

  return { content: `✅ ${message}` };
}
