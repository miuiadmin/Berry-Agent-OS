/**
 * Missions API 响应类型定义。
 *
 * 从 missions-components.tsx 提取，让组件文件只包含 UI 逻辑。
 * 页面级类型层：所有 Missions 相关的 API 形状集中在此，
 * 页面组件文件（missions-components.tsx）只应从这里 import 类型。
 *
 * 注：MissionTask 的真正定义仍在 lib/stores/mission-store.ts
 * （store 在运行时也用同一份形状），这里 re-export 让"页面用什么类型"
 * 的来源统一收口到本文件，组件文件不再直接耦合 store 模块。
 */

export type { MissionTask, MissionTaskStatus } from "@/lib/stores/mission-store";
// 内部使用：MissionTask 同时作为本文件其他 interface 的字段类型（如 PlanResponse.tasks），
// 因此除了 re-export 给消费方，还要 import 一份供本地引用。
import type { MissionTask } from "@/lib/stores/mission-store";

/** mission 列表项 */
export interface MissionListItemData {
  id: string;
  goal: string;
  status: string;
  taskCount: number;
}

/** mission 列表响应 */
export interface MissionsListResponse {
  items: MissionListItemData[];
  total: number;
}

/** mission 详情响应（plan.json 内容） */
export interface PlanResponse {
  mission: {
    id: string;
    goal: string;
    status: string;
    created_by: string;
    created_at: string;
    context?: string;
  };
  tasks: MissionTask[];
}

/** Squad 组织单元（可嵌套） */
export interface SquadNode {
  id: string;
  name: string;
  status: string;
  goal: string;
  leader: string;
  members?: SquadMember[];
  squads?: SquadNode[];
}

/** Squad 成员 */
export interface SquadMember {
  agent: string;
  role: string;
  status: string;
  on: string;
}

/** Squad 间信号 */
export interface SquadSignal {
  type: string;
  from: string;
  msg: string;
}
