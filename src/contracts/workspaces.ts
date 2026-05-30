import { z } from 'zod';

export const WORKSPACE_STATUSES = ['active', 'archived', 'disabled'] as const;
export const WORKSPACE_CAPABILITY_TYPES = ['skill', 'plugin', 'mcp', 'file'] as const;

export type WorkspaceStatus = typeof WORKSPACE_STATUSES[number];
export type WorkspaceCapabilityType = typeof WORKSPACE_CAPABILITY_TYPES[number];

export const WorkspaceStatusSchema = z.enum(WORKSPACE_STATUSES);
export const WorkspaceCapabilityTypeSchema = z.enum(WORKSPACE_CAPABILITY_TYPES);

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  workspaceDir: string;
  status: WorkspaceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceCapability {
  id: string;
  workspaceId: string;
  capabilityType: WorkspaceCapabilityType;
  capabilityId: string;
  enabled: boolean;
  configPath: string | null;
  configHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export const WorkspaceSchema = z.object({
  id: z.string(),
  slug: z.string().min(1),
  name: z.string().min(1),
  workspaceDir: z.string().min(1),
  status: WorkspaceStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const WorkspaceCapabilitySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  capabilityType: WorkspaceCapabilityTypeSchema,
  capabilityId: z.string(),
  enabled: z.boolean(),
  configPath: z.string().nullable(),
  configHash: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
