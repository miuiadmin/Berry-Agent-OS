/**
 * 13.0 多智能体协作 — Mission 状态管理。
 *
 * 管理 mission 列表和当前活跃 mission 的状态。
 * 通过 API 获取 mission 数据，通过 WS 实时更新。
 */

import { create } from "zustand";

// ─── 类型定义 ───

/** 任务状态 */
export type MissionTaskStatus = "waiting" | "working" | "done" | "failed";

/** Mission 任务 */
export interface MissionTask {
  id: string;
  what: string;
  who: string;
  status: MissionTaskStatus;
  progress?: string;
  result?: string;
  depends_on: string[];
  updated_at?: string;
}

/** Mission 元信息 */
export interface Mission {
  id: string;
  goal: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  created_by: string;
  created_at: string;
  context?: string;
  tasks: MissionTask[];
  /** 任务完成百分比（前端计算） */
  progressPercent: number;
}

// ─── Store 接口 ───

interface MissionState {
  /** Mission 列表 */
  missions: Mission[];
  /** 当前选中的 mission ID */
  selectedMissionId: string | null;
  /** 加载状态 */
  isLoading: boolean;

  // ─── Actions ───
  setMissions: (missions: Mission[]) => void;
  addMission: (mission: Mission) => void;
  updateMission: (missionId: string, updates: Partial<Mission>) => void;
  updateTask: (missionId: string, taskId: string, updates: Partial<MissionTask>) => void;
  selectMission: (missionId: string | null) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

// ─── 辅助函数 ───

/** 计算任务完成百分比 */
function calcProgress(tasks: MissionTask[]): number {
  if (tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === "done").length;
  return Math.round((done / tasks.length) * 100);
}

/** 从 plan.json 的原始数据构建 Mission 对象 */
export function buildMissionFromPlan(raw: {
  mission: { id: string; goal: string; status: string; created_by: string; created_at: string; context?: string };
  tasks: MissionTask[];
}): Mission {
  return {
    id: raw.mission.id,
    goal: raw.mission.goal,
    status: raw.mission.status as Mission["status"],
    created_by: raw.mission.created_by,
    created_at: raw.mission.created_at,
    context: raw.mission.context,
    tasks: raw.tasks,
    progressPercent: calcProgress(raw.tasks),
  };
}

// ─── Store 实现 ───

export const useMissionStore = create<MissionState>()((set, get) => ({
  missions: [],
  selectedMissionId: null,
  isLoading: false,

  setMissions: (missions) => set({ missions }),

  addMission: (mission) =>
    set((s) => ({ missions: [mission, ...s.missions] })),

  updateMission: (missionId, updates) =>
    set((s) => ({
      missions: s.missions.map((m) =>
        m.id === missionId ? { ...m, ...updates } : m,
      ),
    })),

  updateTask: (missionId, taskId, updates) =>
    set((s) => ({
      missions: s.missions.map((m) => {
        if (m.id !== missionId) return m;
        const tasks = m.tasks.map((t) =>
          t.id === taskId ? { ...t, ...updates } : t,
        );
        return { ...m, tasks, progressPercent: calcProgress(tasks) };
      }),
    })),

  selectMission: (missionId) => set({ selectedMissionId: missionId }),

  setLoading: (isLoading) => set({ isLoading }),

  clear: () => set({ missions: [], selectedMissionId: null, isLoading: false }),
}));
