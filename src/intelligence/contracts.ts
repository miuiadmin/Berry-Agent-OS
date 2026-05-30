// === P7: Intelligence Layer Contracts ===

// --- Notification types ---

export type NotificationType =
  | 'task_assigned'
  | 'execution_done'
  | 'execution_failed'
  | 'review_needed'
  | 'mention'
  | 'system'
  | 'cron_exception'
  | 'delegation_completed';

export type NotificationPriority = 'urgent' | 'normal' | 'low';

export type PreferenceCategory =
  | 'assignments'
  | 'status_changes'
  | 'comments'
  | 'agent_activity'
  | 'reviews';

export type SubscriptionReason = 'creator' | 'assignee' | 'commenter' | 'mentioned' | 'manual';

export interface NotificationRow {
  id: string;
  workspace_id: string;
  target_type: 'user' | 'agent';
  target_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  priority: NotificationPriority;
  read: number;
  archived: number;
  created_at: number;
}

export interface NotificationPreferenceRow {
  id: string;
  workspace_id: string;
  user_id: string;
  preferences_json: string;
  updated_at: number;
}

export interface TaskSubscriberRow {
  id: string;
  task_id: string;
  subscriber_type: 'user' | 'agent';
  subscriber_id: string;
  reason: SubscriptionReason;
  created_at: number;
}

export interface SendNotificationInput {
  workspaceId: string;
  targetType: 'user' | 'agent';
  targetId: string;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  priority?: NotificationPriority;
}

export interface INotificationService {
  send(input: SendNotificationInput): NotificationRow;
  getForTarget(targetType: string, targetId: string, opts?: { unreadOnly?: boolean; limit?: number; workspaceId?: string }): NotificationRow[];
  getUnreadCount(targetType: string, targetId: string, workspaceId?: string): number;
  markRead(notificationId: string): void;
  markAllRead(targetType: string, targetId: string, workspaceId?: string): void;
  archive(notificationId: string): void;
  archiveStale(): number;
  subscribe(taskId: string, subscriberType: string, subscriberId: string, reason: SubscriptionReason): void;
  unsubscribe(taskId: string, subscriberId: string): void;
  getSubscribers(taskId: string): TaskSubscriberRow[];
  getPreferences(workspaceId: string, userId: string): Record<PreferenceCategory, 'enabled' | 'muted'>;
  updatePreferences(workspaceId: string, userId: string, prefs: Partial<Record<PreferenceCategory, 'enabled' | 'muted'>>): void;
  shouldDeliver(workspaceId: string, userId: string, category: PreferenceCategory): boolean;
}

// --- Memory types ---

export type MemoryType = 'knowledge' | 'preference' | 'feedback' | 'context';
export type MemoryVisibility = 'private' | 'workspace';
export type MemoryOrigin = 'evolved' | 'manual' | 'imported' | 'promoted';
export type MemoryLayer = 'agent' | 'workspace' | 'global';

export interface AgentMemoryRow {
  id: string;
  agent_id: string;
  workspace_id: string | null;
  type: MemoryType;
  content: string;
  source: string | null;
  importance: number;
  access_count: number;
  last_accessed_at: number | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceMemoryRow {
  id: string;
  workspace_id: string;
  owner_agent_id: string | null;
  type: MemoryType;
  content: string;
  origin: MemoryOrigin;
  visibility: MemoryVisibility;
  importance: number;
  tags: string | null;
  recall_count: number;
  verified_at: number | null;
  source_memory_id: string | null;
  archived: number;
  last_recalled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface GlobalMemoryRow {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  origin: 'evolved' | 'manual' | 'promoted';
  source_workspace_id: string | null;
  source_memory_id: string | null;
  importance: number;
  tags: string | null;
  recall_count: number;
  verified_at: number | null;
  archived: number;
  last_recalled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AgentMemoryBindingRow {
  id: string;
  agent_id: string;
  memory_id: string;
  memory_layer: MemoryLayer;
  source: string;
  enabled: number;
  pinned: number;
  assigned_by: string | null;
  created_at: number;
}

export interface CreateAgentMemoryInput {
  agentId: string;
  workspaceId?: string;
  type: MemoryType;
  content: string;
  source?: string;
  importance?: number;
}

export interface CreateWorkspaceMemoryInput {
  workspaceId: string;
  ownerAgentId?: string;
  type: MemoryType;
  content: string;
  origin?: MemoryOrigin;
  visibility?: MemoryVisibility;
  importance?: number;
  tags?: string[];
  sourceMemoryId?: string;
}

export interface CreateGlobalMemoryInput {
  userId: string;
  type: MemoryType;
  content: string;
  origin?: 'evolved' | 'manual' | 'promoted';
  sourceWorkspaceId?: string;
  sourceMemoryId?: string;
  importance?: number;
  tags?: string[];
}

export interface RecallContext {
  agentId?: string;
  workspaceId?: string;
  userId?: string;
  tokenBudget?: number;
  topK?: number;
}

export interface RecalledMemory {
  id: string;
  layer: MemoryLayer;
  content: string;
  type: MemoryType;
  importance: number;
  score: number;
}

export interface RecallResult {
  memories: RecalledMemory[];
  totalChars: number;
  truncated: boolean;
}

export interface IMemoryLayerService {
  createAgentMemory(input: CreateAgentMemoryInput): AgentMemoryRow;
  getAgentMemories(agentId: string, opts?: { type?: MemoryType; limit?: number }): AgentMemoryRow[];
  updateAgentMemory(id: string, updates: Partial<Pick<AgentMemoryRow, 'content' | 'importance' | 'type'>>): void;
  deleteAgentMemory(id: string): void;
  recordAccess(memoryId: string, layer: MemoryLayer): void;

  createWorkspaceMemory(input: CreateWorkspaceMemoryInput): WorkspaceMemoryRow;
  getWorkspaceMemories(workspaceId: string, opts?: { visibility?: MemoryVisibility; type?: MemoryType; limit?: number }): WorkspaceMemoryRow[];
  updateWorkspaceMemory(id: string, updates: Partial<Pick<WorkspaceMemoryRow, 'content' | 'importance' | 'visibility' | 'type'>>): void;
  deleteWorkspaceMemory(id: string): void;

  createGlobalMemory(input: CreateGlobalMemoryInput): GlobalMemoryRow;
  getGlobalMemories(userId: string, opts?: { type?: MemoryType; limit?: number }): GlobalMemoryRow[];
  updateGlobalMemory(id: string, updates: Partial<Pick<GlobalMemoryRow, 'content' | 'importance' | 'type'>>): void;
  deleteGlobalMemory(id: string): void;

  promoteAgentToWorkspace(memoryId: string): WorkspaceMemoryRow;
  promoteWorkspaceToGlobal(memoryId: string, userId: string): GlobalMemoryRow;
  evaluatePromotion(memoryId: string): boolean;

  recall(query: string, context: RecallContext): RecallResult;

  applyTimeDecay(): number;
  archiveStale(): number;

  bindToAgent(agentId: string, memoryId: string, layer: MemoryLayer, source: string): void;
  unbindFromAgent(agentId: string, memoryId: string): void;
  getAgentBindings(agentId: string): AgentMemoryBindingRow[];

  verifyMemory(memoryId: string, layer: MemoryLayer): void;
}

// --- Workspace Context ---

export interface WorkspaceContextHistoryRow {
  id: string;
  workspace_id: string;
  version: number;
  content: string;
  change_summary: string | null;
  changed_by: string;
  created_at: number;
}

export interface IWorkspaceContextService {
  getContext(workspaceId: string): string | null;
  updateContext(workspaceId: string, content: string, changedBy: string, changeSummary?: string): number;
  getVersion(workspaceId: string, version: number): WorkspaceContextHistoryRow | null;
  getHistory(workspaceId: string, limit?: number): WorkspaceContextHistoryRow[];
  getCurrentVersion(workspaceId: string): number;
  freezeSnapshot(workspaceId: string): string;
  rollbackToVersion(workspaceId: string, version: number, changedBy: string): number;
  pruneOldVersions(workspaceId: string, keep?: number): number;
}

// --- Async Delegation ---

export type AsyncDelegationStatus = 'pending' | 'accepted' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface AsyncDelegationRow {
  id: string;
  source_session_id: string;
  source_workspace_id: string | null;
  target_workspace_id: string;
  target_agent_id: string | null;
  prompt: string;
  context_snapshot: string | null;
  status: AsyncDelegationStatus;
  priority: NotificationPriority;
  timeout_ms: number;
  result: string | null;
  error: string | null;
  parent_delegation_id: string | null;
  created_at: number;
  accepted_at: number | null;
  completed_at: number | null;
}

export interface CreateAsyncDelegationInput {
  sourceSessionId: string;
  sourceWorkspaceId?: string;
  targetWorkspaceId: string;
  targetAgentId?: string;
  prompt: string;
  contextSnapshot?: string;
  priority?: NotificationPriority;
  timeoutMs?: number;
  parentDelegationId?: string;
}

export interface AggregatedResult {
  delegations: Array<{
    id: string;
    workspaceId: string;
    status: AsyncDelegationStatus;
    result: string | null;
    error: string | null;
  }>;
  allCompleted: boolean;
}

export interface IAsyncDelegationService {
  create(input: CreateAsyncDelegationInput): AsyncDelegationRow;
  accept(delegationId: string): void;
  markRunning(delegationId: string): void;
  complete(delegationId: string, result: string): void;
  fail(delegationId: string, error: string): void;
  cancel(delegationId: string): void;
  get(id: string): AsyncDelegationRow | null;
  listBySession(sessionId: string): AsyncDelegationRow[];
  listByWorkspace(workspaceId: string, status?: AsyncDelegationStatus): AsyncDelegationRow[];
  checkTimeouts(): string[];
  dispatchParallel(inputs: CreateAsyncDelegationInput[]): AsyncDelegationRow[];
  aggregateResults(delegationIds: string[]): AggregatedResult;
}

// --- Team Templates ---

export type TemplateCategory = 'content' | 'dev' | 'research' | 'support' | 'custom';

export interface TeamTemplateRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  category: TemplateCategory;
  org_structure: string;
  agent_configs: string;
  is_public: number;
  use_count: number;
  created_at: number;
  updated_at: number;
}

export interface CreateTemplateInput {
  ownerId: string;
  name: string;
  description?: string;
  category?: TemplateCategory;
  orgStructure: unknown;
  agentConfigs: unknown;
  isPublic?: boolean;
}

export interface ITemplateService {
  create(input: CreateTemplateInput): TeamTemplateRow;
  get(id: string): TeamTemplateRow | null;
  list(opts?: { category?: TemplateCategory; isPublic?: boolean; limit?: number }): TeamTemplateRow[];
  update(id: string, updates: Partial<CreateTemplateInput>): void;
  delete(id: string): void;
  saveFromWorkspace(workspaceId: string, name: string, ownerId: string, category?: TemplateCategory): TeamTemplateRow;
  applyToWorkspace(templateId: string, workspaceId: string): void;
  incrementUseCount(id: string): void;
}

// --- Plugin Scope ---

export interface PluginDiscoveryResult {
  private: PluginScopeRecord[];
  workspace: PluginScopeRecord[];
  global: PluginScopeRecord[];
}

export interface PluginScopeRecord {
  id: string;
  name: string;
  scope: 'private' | 'workspace' | 'global';
  status: string;
  has_prompt: number;
  has_tools: number;
  has_code: number;
  has_hooks: number;
  has_service: number;
  binding_status?: 'enabled' | 'disabled' | 'unbound';
}

export interface IPluginScopeService {
  promote(pluginId: string, targetScope: 'workspace' | 'global'): void;
  demote(pluginId: string, targetScope: 'private' | 'workspace'): void;
  shareWithAgent(pluginId: string, agentId: string, assignedBy: string): void;
  unshareFromAgent(pluginId: string, agentId: string): void;
  discover(agentId: string, workspaceId: string): PluginDiscoveryResult;
  getBindings(pluginId: string): Array<{ agent_id: string; enabled: number; pinned: number }>;
  toggleBinding(pluginId: string, agentId: string, enabled: boolean): void;
}

// --- Team Builder ---

export interface TeamBuildPlan {
  workspaceName: string;
  workspaceSlug: string;
  orgNodes: Array<{ name: string; description: string; parentPath?: string; nodeType?: string }>;
  agents: Array<{
    name: string;
    role: string;
    description: string;
    orgNodePath: string;
    superiorName?: string;
  }>;
  defaultProject?: { name: string; description: string };
}

export interface TeamBuildSession {
  id: string;
  userId: string;
  status: 'gathering' | 'proposing' | 'ready' | 'applied' | 'cancelled';
  requirements: string;
  currentPlan: TeamBuildPlan | null;
  createdAt: number;
}

export interface ApplyResult {
  workspaceId: string;
  agentNames: string[];
  orgNodeIds: string[];
  templateId?: string;
}

export interface ITeamBuilderService {
  startSession(userId: string, requirements: string): Promise<TeamBuildSession>;
  refineSession(sessionId: string, feedback: string): Promise<TeamBuildSession>;
  previewPlan(sessionId: string): TeamBuildPlan | null;
  approvePlan(sessionId: string): Promise<ApplyResult>;
  cancelSession(sessionId: string): void;
}
