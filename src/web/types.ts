import type { Socket } from 'node:net';
import type { TaskManager, SessionManager, AgentManager, AgentLifecycle, PermissionCoordinator } from '../contracts/kernel-services.js';
import type { EventBus } from '../contracts/infrastructure.js';
import type { AppConfig } from '../contracts/config.js';
import type { IConfigService } from '../config/contract.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { INotificationService, IMemoryLayerService, IWorkspaceContextService, IPluginScopeService, ITemplateService, IAsyncDelegationService, ITeamBuilderService } from '../intelligence/index.js';
import type { IProviderRegistry } from '../providers/contract.js';

export type MessageHandler = (request: Record<string, unknown>, socket: Socket) => void;

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
  schedulerService?: SchedulerService | null;
  notificationService?: INotificationService | null;
  memoryLayerService?: IMemoryLayerService | null;
  workspaceContextService?: IWorkspaceContextService | null;
  pluginScopeService?: IPluginScopeService | null;
  templateService?: ITemplateService | null;
  asyncDelegationService?: IAsyncDelegationService | null;
  teamBuilderService?: ITeamBuilderService | null;
  humanDelegationManager?: { resolve(id: string, response: string | null, status?: string): boolean } | null;
  getProviderRegistry?: () => IProviderRegistry;
}
