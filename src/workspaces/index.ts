export { WorkspaceManager } from './manager.js';
// WorkspaceWatcher 已在 16.0 §17.8 删除（零实例化）
export { OrgTreeManager } from './org-tree-manager.js';
export { AgentHierarchy } from './agent-hierarchy.js';
export { TrustManager } from './trust-manager.js';
export type { CreateWorkspaceInput, UpdateWorkspaceInput, RegisterCapabilityInput, WorkspaceOverlay } from './types.js';
// WatcherEvent 类型已随 WorkspaceWatcher 一并删除（16.0 §17.8）
