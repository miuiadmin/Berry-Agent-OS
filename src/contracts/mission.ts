/**
 * 13.0 多智能体协作 — 共享计划（plan.json）与组织语言（squad.json）的契约定义。
 *
 * 三大支柱：
 *   §10 共享计划语言 — plan.json：给 AI 团队一张共享的工作台
 *   §11 Squad 组织语言 — squad.json：团队、角色、裂变、交接、信号
 *   §12 编排语言集成 — plan/squad 如何嵌入现有架构
 *
 * 设计原则：
 *   - JSON 文件是 AI 的自然语言，LLM 天生理解 JSON
 *   - 没有中央调度器，LLM 自己读白板、自己协调
 *   - Brain 是中枢（创建 mission、监控进度、干预决策）
 *   - 单实例模型：同类型 agent 共享一个实例，通过 plan tool 串行处理各自的任务
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────
// Plan.json — 共享计划语言（§10.2.3）
// ─────────────────────────────────────────────────────────────────

/** 任务状态 */
export const TaskStatus = z.enum(['waiting', 'working', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** 单个任务的 schema */
export const MissionTaskSchema = z.object({
  /** 任务 ID（t-1, t-2, ...） */
  id: z.string(),
  /** 要做什么（自然语言描述） */
  what: z.string(),
  /** 谁来做（agent 类型名，如 'code', 'learning', 'skills'） */
  who: z.string(),
  /** 当前状态 */
  status: TaskStatus,
  /** 进度描述（执行中更新） */
  progress: z.string().optional(),
  /** 任务产出的摘要（完成时填写） */
  result: z.string().optional(),
  /** 依赖哪些任务先完成（任务 ID 列表） */
  depends_on: z.array(z.string()).default([]),
  /** 最后更新时间（ISO 8601） */
  updated_at: z.string().optional(),
});
export type MissionTask = z.infer<typeof MissionTaskSchema>;

/** Mission 元信息 */
export const MissionMetaSchema = z.object({
  /** Mission ID（m-20240610-001 格式） */
  id: z.string(),
  /** 总体目标 */
  goal: z.string(),
  /** 创建者（通常是 'brain'） */
  created_by: z.string(),
  /** 创建时间（ISO 8601） */
  created_at: z.string(),
  /** Mission 整体状态 */
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']),
  /** 上下文描述（为什么创建这个 mission） */
  context: z.string().optional(),
});
export type MissionMeta = z.infer<typeof MissionMetaSchema>;

/** 决策记录 */
export const DecisionSchema = z.object({
  /** 决策者（agent 名） */
  by: z.string(),
  /** 决策时间 */
  at: z.string(),
  /** 决策内容（自然语言） */
  thought: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** plan.json 的完整 schema */
export const PlanSchema = z.object({
  /** Mission 元信息 */
  mission: MissionMetaSchema,
  /** 任务列表 */
  tasks: z.array(MissionTaskSchema),
  /** 决策记录（为什么这样安排任务） */
  decisions: z.array(DecisionSchema).default([]),
  /** 备注和提示（任何 Agent 都可添加） */
  notes: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

/** plan tool 的 update 操作 payload */
export const PlanUpdateSchema = z.object({
  /** 目标 task ID（更新现有任务时必填） */
  task_id: z.string().optional(),
  /** 更新任务状态 */
  status: TaskStatus.optional(),
  /** 更新进度描述 */
  progress: z.string().optional(),
  /** 更新任务结果 */
  result: z.string().optional(),
  /** 新增一个任务（Brain 或任意 Agent 动态添加） */
  new_task: z.object({
    what: z.string(),
    who: z.string(),
    depends_on: z.array(z.string()).default([]),
  }).optional(),
  /** 记录一个决策 */
  decision: z.object({
    thought: z.string(),
  }).optional(),
  /** 添加一条备注 */
  note: z.string().optional(),
  /** 更新 mission 整体状态 */
  mission_status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional(),
});
export type PlanUpdate = z.infer<typeof PlanUpdateSchema>;

// ─────────────────────────────────────────────────────────────────
// Squad.json — 组织语言（§11.5）
// ─────────────────────────────────────────────────────────────────

/** Squad 成员角色 */
export const SquadRole = z.enum(['lead', 'work', 'check']);
export type SquadRole = z.infer<typeof SquadRole>;

/** Squad 成员 */
export const SquadMemberSchema = z.object({
  /** Agent 类型名 */
  agent: z.string(),
  /** 角色：lead（思考协调）/ work（执行）/ check（验证） */
  role: SquadRole,
  /** 负责的工作描述 */
  on: z.string(),
  /** 成员状态 */
  status: z.enum(['idle', 'working', 'done', 'failed']).default('idle'),
  /** 产出结果 */
  result: z.string().optional(),
});
export type SquadMember = z.infer<typeof SquadMemberSchema>;

/** 信号类型 */
export const SignalType = z.enum(['progress', 'blocker', 'done', 'question']);
export type SignalType = z.infer<typeof SignalType>;

/** 信号 */
export const SignalSchema = z.object({
  /** 发出信号的 squad 或 agent */
  from: z.string(),
  /** 信号时间 */
  at: z.string(),
  /** 信号类型 */
  type: SignalType,
  /** 信号消息 */
  msg: z.string(),
});
export type Signal = z.infer<typeof SignalSchema>;

/** Squad（团队）— 支持递归嵌套 */
export const SquadSchema: z.ZodType<Squad> = z.lazy(() =>
  z.object({
    /** Squad ID（s-1, s-2, s-2a, ...） */
    id: z.string(),
    /** Squad 名称 */
    name: z.string(),
    /** 嵌套深度（0=mission, 1=squad, 2=sub-squad, 3=最底层） */
    depth: z.number().int().min(1).max(3),
    /** Squad 目标 */
    goal: z.string(),
    /** Leader agent */
    leader: z.string(),
    /** 成员列表（不含 leader） */
    members: z.array(SquadMemberSchema).default([]),
    /** 子 squad（裂变） */
    squads: z.array(SquadSchema).optional(),
    /** Squad 状态 */
    status: z.enum(['waiting', 'working', 'done', 'failed']).default('waiting'),
    /** Squad 内部信号 */
    signals: z.array(SignalSchema).default([]),
  }),
);
export interface Squad {
  id: string;
  name: string;
  depth: number;
  goal: string;
  leader: string;
  members: SquadMember[];
  squads?: Squad[];
  status: 'waiting' | 'working' | 'done' | 'failed';
  signals: Signal[];
}

/** 交接契约 */
export const HandoffSchema = z.object({
  /** 来源 squad ID */
  from: z.string(),
  /** 目标 squad ID */
  to: z.string(),
  /** 交接什么内容 */
  what: z.string(),
  /** 交接状态 */
  status: z.enum(['pending', 'delivered', 'accepted']).default('pending'),
  /** 交接的实际内容（delivered 后填充） */
  content: z.string().optional(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

/** squad.json 的完整 schema */
export const SquadFileSchema = z.object({
  /** 关联的 Mission 元信息（与 plan.json 共享） */
  mission: MissionMetaSchema,
  /** 组织结构：squad 树 */
  org: z.object({
    squads: z.array(SquadSchema),
  }),
  /** 跨 squad 交接契约 */
  handoffs: z.array(HandoffSchema).default([]),
  /** 全局信号（各 squad 信号的聚合视图） */
  signals: z.array(SignalSchema).default([]),
});
export type SquadFile = z.infer<typeof SquadFileSchema>;

// ─────────────────────────────────────────────────────────────────
// Plan/Squad tool 输入 schema
// ─────────────────────────────────────────────────────────────────

/** plan tool 的输入 schema */
export const PlanToolInputSchema = z.object({
  /** 操作类型 */
  action: z.enum(['read', 'update']),
  /** Mission ID */
  mission_id: z.string(),
  /** 更新内容（action='update' 时使用） */
  updates: PlanUpdateSchema.optional(),
});

/** squad tool 的输入 schema */
export const SquadToolInputSchema = z.object({
  /** 操作类型 */
  action: z.enum(['read', 'create_squad', 'update_member', 'handoff', 'signal']),
  /** Mission ID */
  mission_id: z.string(),
  /** 创建新 squad 的参数（action='create_squad'） */
  squad: z.object({
    name: z.string(),
    goal: z.string(),
    /** 父 squad ID（裂变时指定） */
    parent_squad_id: z.string().optional(),
    leader: z.string(),
    members: z.array(z.object({
      agent: z.string(),
      role: z.enum(['work', 'check']),
      on: z.string(),
    })).optional(),
  }).optional(),
  /** 更新成员状态（action='update_member'） */
  member_update: z.object({
    squad_id: z.string(),
    agent: z.string(),
    status: z.enum(['idle', 'working', 'done', 'failed']),
    result: z.string().optional(),
  }).optional(),
  /** 发送信号（action='signal'） */
  signal: z.object({
    squad_id: z.string(),
    type: SignalType,
    msg: z.string(),
  }).optional(),
  /** 交接（action='handoff'） */
  handoff_data: z.object({
    from_squad: z.string(),
    to_squad: z.string(),
    what: z.string(),
    content: z.string().optional(),
  }).optional(),
});

// ─────────────────────────────────────────────────────────────────
// 深度限制常量
// ─────────────────────────────────────────────────────────────────

/** squad 最大嵌套深度（mission=0, squad=1, sub-squad=2, sub-sub-squad=3） */
export const MAX_SQUAD_DEPTH = 3;

/** 单个 task 的观察队列最大记录数（滚动窗口） */
export const MAX_OBSERVATIONS_PER_TASK = 500;

// ─────────────────────────────────────────────────────────────────
// Mission 事件类型（用于 EventBus 广播）
// ─────────────────────────────────────────────────────────────────

/** Mission 生命周期事件 */
export interface MissionEvents {
  /** Mission 被创建 */
  'mission.created': { missionId: string; goal: string; taskCount: number };
  /** Mission 状态变更 */
  'mission.status_changed': { missionId: string; oldStatus: string; newStatus: string };
  /** 任务状态变更 */
  'mission.task_updated': { missionId: string; taskId: string; status: TaskStatus; who: string };
  /** 任务依赖满足，可以开始执行 */
  'mission.task_ready': { missionId: string; taskId: string; who: string; what: string };
  /** Mission 完成（所有 tasks done） */
  'mission.completed': { missionId: string; goal: string };
  /** squad 被创建（裂变） */
  'mission.squad_created': { missionId: string; squadId: string; parentSquadId?: string };
  /** 信号发出 */
  'mission.signal': { missionId: string; squadId: string; type: SignalType; msg: string };
  /** 交接完成 */
  'mission.handoff': { missionId: string; from: string; to: string; what: string };
}
