import type { AppDb } from '../db/client.js';
import { createEventBus } from '../lib/event-bus.js';
import type { AppEvents } from '../lib/event-bus.js';
import { JobQueueService } from '../lib/queue.js';

import { AuthRepository } from './auth/auth.repository.js';
import { AuthService } from './auth/auth.service.js';
import { WorkspaceRepository } from './workspace/workspace.repository.js';
import { WorkspaceService } from './workspace/workspace.service.js';
import { OrgRepository } from './org/org.repository.js';
import { OrgService } from './org/org.service.js';
import { AgentRepository } from './agent/agent.repository.js';
import { AgentService } from './agent/agent.service.js';
import { ProjectRepository } from './project/project.repository.js';
import { ProjectService } from './project/project.service.js';
import { TaskRepository } from './task/task.repository.js';
import { TaskService } from './task/task.service.js';
import { ExecutionRepository } from './execution/execution.repository.js';
import { ExecutionService } from './execution/execution.service.js';
import { SchedulerRepository } from './scheduler/scheduler.repository.js';
import { SchedulerService } from './scheduler/scheduler.service.js';
import { ReviewService } from './review/review.service.js';
import { MemoryRepository } from './memory/memory.repository.js';
import { MemoryService } from './memory/memory.service.js';
import { PluginRepository } from './plugin/plugin.repository.js';
import { PluginService } from './plugin/plugin.service.js';
import { NotificationRepository } from './notification/notification.repository.js';
import { NotificationService } from './notification/notification.service.js';

export interface ModuleContainer {
  events: AppEvents;
  auth: AuthService;
  workspace: WorkspaceService;
  org: OrgService;
  agent: AgentService;
  project: ProjectService;
  task: TaskService;
  execution: ExecutionService;
  scheduler: SchedulerService;
  review: ReviewService;
  memory: MemoryService;
  plugin: PluginService;
  notification: NotificationService;
  shutdown: () => void;
}

export function createModuleContainer(db: AppDb): ModuleContainer {
  const events = createEventBus();
  const queue = new JobQueueService(db);

  const authRepo = new AuthRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const orgRepo = new OrgRepository(db);
  const agentRepo = new AgentRepository(db);
  const projectRepo = new ProjectRepository(db);
  const taskRepo = new TaskRepository(db);
  const executionRepo = new ExecutionRepository(db);
  const schedulerRepo = new SchedulerRepository(db);
  const memoryRepo = new MemoryRepository(db);
  const pluginRepo = new PluginRepository(db);
  const notificationRepo = new NotificationRepository(db);

  const auth = new AuthService(authRepo, events);
  const workspace = new WorkspaceService(workspaceRepo, events);
  const org = new OrgService(orgRepo, events);
  const agent = new AgentService(agentRepo, events);

  workspace.setOrgService(org);
  workspace.setAgentService(agent);
  const project = new ProjectService(projectRepo, events);
  const task = new TaskService(taskRepo, workspace, events);
  const execution = new ExecutionService(executionRepo, events);
  const scheduler = new SchedulerService(schedulerRepo, queue, events);
  const review = new ReviewService(execution, agent, events);
  const memory = new MemoryService(memoryRepo, events);
  const plugin = new PluginService(pluginRepo, events);
  const notification = new NotificationService(notificationRepo, events);

  return {
    events,
    auth,
    workspace,
    org,
    agent,
    project,
    task,
    execution,
    scheduler,
    review,
    memory,
    plugin,
    notification,
    shutdown: () => scheduler.shutdown(),
  };
}

export { AuthService } from './auth/index.js';
export { WorkspaceService } from './workspace/index.js';
export { OrgService } from './org/index.js';
export { AgentService } from './agent/index.js';
export { ProjectService } from './project/index.js';
export { TaskService } from './task/index.js';
export { ExecutionService } from './execution/index.js';
export { SchedulerService } from './scheduler/index.js';
export { ReviewService } from './review/index.js';
export { MemoryService } from './memory/index.js';
export { PluginService } from './plugin/index.js';
export { NotificationService } from './notification/index.js';
