/**
 * @deprecated This module is a transitional facade. Its services will be
 * migrated to Capability Bus providers (src/bus/) in a future iteration.
 * New features should register as Bus capabilities, not intelligence services.
 */
export type {
  // Notification
  NotificationType,
  NotificationPriority,
  PreferenceCategory,
  SubscriptionReason,
  NotificationRow,
  NotificationPreferenceRow,
  TaskSubscriberRow,
  SendNotificationInput,
  INotificationService,

  // Memory
  MemoryType,
  MemoryVisibility,
  MemoryOrigin,
  MemoryLayer,
  AgentMemoryRow,
  WorkspaceMemoryRow,
  GlobalMemoryRow,
  AgentMemoryBindingRow,
  CreateAgentMemoryInput,
  CreateWorkspaceMemoryInput,
  CreateGlobalMemoryInput,
  RecallContext,
  RecalledMemory,
  RecallResult,
  IMemoryLayerService,

  // Workspace Context
  WorkspaceContextHistoryRow,
  IWorkspaceContextService,

  // Async Delegation
  AsyncDelegationStatus,
  AsyncDelegationRow,
  CreateAsyncDelegationInput,
  AggregatedResult,
  IAsyncDelegationService,

  // Team Templates
  TemplateCategory,
  TeamTemplateRow,
  CreateTemplateInput,
  ITemplateService,

  // Plugin Scope
  PluginDiscoveryResult,
  PluginScopeRecord,
  IPluginScopeService,

  // Team Builder
  TeamBuildPlan,
  TeamBuildSession,
  ApplyResult,
  ITeamBuilderService,
} from './contracts.js';
