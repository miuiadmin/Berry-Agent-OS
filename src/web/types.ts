import type { Socket } from 'node:net';
import type { WebSocket } from 'ws';
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
  handleInterrupt: (sessionId: string, reason: string | undefined, ws: WebSocket) => void;
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
  providerRegistry?: IProviderRegistry | null;
}
