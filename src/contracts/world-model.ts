export interface WorldModelSnapshot {
  user: UserState;
  projects: ProjectState[];
  environment: EnvironmentState;
  temporal: TemporalState;
  updatedAt: number;
}

export interface UserState {
  currentActivity: string | null;
  /** 用户精力状态 — 基于挫败信号和交互密度推断 */
  energyLevel: 'high' | 'medium' | 'low' | 'frustrated' | 'focused' | 'unknown';
  /** 最近讨论的话题（去重，最多 10 条） */
  recentTopics: string[];
  /** 从工具调用推断的活跃目标（最多 5 条） */
  activeGoals: string[];
  /** 累积挫败信号计数（每 session 重置） */
  frustrationSignals: number;
  /** 最近一次交互时间戳（毫秒） */
  lastInteractionAt: number | null;
}

export interface ProjectState {
  id: string;
  name: string;
  path?: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  lastActivityAt: number;
  pendingTasks: number;
  urgency: 'high' | 'medium' | 'low';
  context?: string;
}

export interface EnvironmentState {
  platform: string;
  activeChannels: string[];
  externalEvents: ExternalEvent[];
  systemHealth: 'healthy' | 'degraded' | 'critical';
}

export interface ExternalEvent {
  type: string;
  source: string;
  summary: string;
  severity: 'info' | 'warning' | 'critical';
  receivedAt: number;
  handled: boolean;
}

export interface TemporalState {
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  dayOfWeek: number;
  /** 当前会话持续时间（毫秒）— 基于 sessionStartedAt 计算 */
  sessionDurationMs: number;
  /** 会话开始时间戳（毫秒）— 首轮交互时锚定，用于正确计算 sessionDurationMs */
  sessionStartedAt: number | null;
  /** 当前会话内的交互轮数 */
  turnsInSession: number;
  lastBreakAt: number | null;
  upcomingDeadlines: Array<{ description: string; dueAt: number }>;
}

export interface WorldModelUpdate {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: 'conversation' | 'event' | 'scheduled' | 'inference';
  timestamp: number;
}
