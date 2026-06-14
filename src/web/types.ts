import type { TaskManager, SessionManager, AgentManager, AgentLifecycle, PermissionCoordinator } from '../contracts/kernel-services.js';
import type { EventBus } from '../contracts/infrastructure.js';
import type { AppConfig } from '../contracts/config.js';
import type { IConfigService } from '../config/contract.js';
import type { INotificationService, IMemoryLayerService, IWorkspaceContextService, IPluginScopeService, ITemplateService, IAsyncDelegationService, ITeamBuilderService } from '../intelligence/index.js';
import type { IProviderRegistry } from '../providers/contract.js';
import type { WritableChannel } from '../contracts/transport.js';
import type { DelegationOrchestrator } from '../kernel/delegation-orchestrator.js';

/** P1-4 修复：MessageHandler 接受 WritableChannel 而非 Socket，消除 unsafe cast */
export type MessageHandler = (request: Record<string, unknown>, channel: WritableChannel) => void;

export interface WebServerDependencies {
  taskManager: TaskManager;
  sessionManager: SessionManager;
  agentManager: AgentManager;
  agentLifecycle: AgentLifecycle;
  eventBus: EventBus;
  config: AppConfig;
  configService: IConfigService;
  permissionCoordinator: PermissionCoordinator;
  handleMessage: MessageHandler;
  /** P0-3 修复：移除 ws 参数，中断通知通过 EventBus → WsEventBridge 投递 */
  handleInterrupt: (sessionId: string, reason: string | undefined) => void;
  resolvePermissionConfirm?: (requestId: string, approved: boolean, reason?: string) => boolean;
  startTimeMs: number;
  secret: string;
  notificationService?: INotificationService | null;
  memoryLayerService?: IMemoryLayerService | null;
  workspaceContextService?: IWorkspaceContextService | null;
  pluginScopeService?: IPluginScopeService | null;
  templateService?: ITemplateService | null;
  asyncDelegationService?: IAsyncDelegationService | null;
  teamBuilderService?: ITeamBuilderService | null;
  /** P2-10: 拓宽类型，增加 getPending() 用于 WS 重连时重放未决委托 */
  humanDelegationManager?: {
    resolve(id: string, response: string | null, status?: string): boolean;
    getPending(sessionId?: string): Array<{ id: string; sessionId: string; requestedBy: string; title: string; description: string; urgency: string; options: string[]; status: string; timeoutMs: number; createdAt: number }>;
  } | null;
  getProviderRegistry?: () => IProviderRegistry;
  /** W7 修复：Drift metrics 工厂（替代 inline require） */
  getDriftMetrics?: () => { aggregate(days: number): unknown; listSignals(opts: { sessionId?: string; limit: number; offset: number }): unknown[] };
  /** 13.0 多智能体协作：Orchestrator 引用（用于 MissionManager 访问） */
  orchestrator?: { mission: import('../kernel/mission-manager.js').MissionManager | null } | null;
}
