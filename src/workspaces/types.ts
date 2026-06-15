import type { WorkspaceCapabilityType, WorkspaceStatus, WorkspaceCapability } from '../contracts/workspaces.js';

export interface CreateWorkspaceInput {
  slug: string;
  name: string;
  workspaceDir: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  status?: WorkspaceStatus;
}

export interface RegisterCapabilityInput {
  workspaceId: string;
  capabilityType: WorkspaceCapabilityType;
  capabilityId: string;
  configPath?: string;
}

export interface WorkspaceOverlay {
  skills: WorkspaceCapability[];
  plugins: WorkspaceCapability[];
  mcps: WorkspaceCapability[];
}

// WatcherEvent 已在 16.0 §17.8 随 WorkspaceWatcher 一并删除
