// Kernel module — public API barrel export
export { IpcChannel, IpcChildChannel } from './ipc.js';
export { EventBus, initEventBus, getEventBus } from './event-bus.js';
export type { EventName, EventPayload } from './event-bus.js';
export { TaskManager } from './task-manager.js';
export type { CreateTaskInput, TaskRow, TaskManagerConfig } from './task-manager.js';
export { ErrorClassifier } from './error-classifier.js';
export { WorkspaceRouter } from './workspace-router.js';
export type { WorkspaceAgentRole, WorkspaceAgentBinding } from './workspace-router.js';
