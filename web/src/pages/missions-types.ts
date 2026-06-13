/**
 * Missions API 响应类型定义。
 *
 * 从 missions-components.tsx 提取，让组件文件只包含 UI 逻辑。
 */

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
