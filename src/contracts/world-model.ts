export interface WorldModelSnapshot {
  user: UserState;
  projects: ProjectState[];
  environment: EnvironmentState;
  temporal: TemporalState;
  updatedAt: number;
}

export interface UserState {
  currentActivity: string | null;
  energyLevel: 'high' | 'medium' | 'low' | 'unknown';
  recentTopics: string[];
  activeGoals: string[];
  frustrationSignals: number;
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
  sessionDurationMs: number;
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
