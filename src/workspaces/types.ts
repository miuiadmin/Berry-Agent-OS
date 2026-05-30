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

export interface WatcherEvent {
  type: 'file_changed' | 'file_created' | 'file_deleted';
  path: string;
  workspaceId: string;
}
