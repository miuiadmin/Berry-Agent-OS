export const ORG_NODE_TYPES = ['root', 'group', 'department', 'system', 'center', 'custom'] as const;

export interface OrgNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  nodeType: string;
  path: string;
  depth: number;
  position: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AgentHierarchyInfo {
  agentId: string;
  agentName: string;
  workspaceId: string;
  orgNodeId: string | null;
  superiorId: string | null;
  role: 'lead' | 'member';
  description: string | null;
}

export interface ReviewChainEntry {
  agentId: string;
  agentName: string;
  depth: number;
}

export interface OrgNodeDefinition {
  name: string;
  description?: string;
  nodeType?: string;
  children?: OrgNodeDefinition[];
  agents?: AgentSlotDefinition[];
}

export interface AgentSlotDefinition {
  agentName: string;
  role?: 'lead' | 'member';
  description?: string;
}

export interface BuildTeamInput {
  workspaceId: string;
  tree: OrgNodeDefinition;
}

export interface BuildTeamResult {
  rootNodeId: string;
  nodesCreated: number;
  agentsCreated: number;
  leadAgent: string | null;
}
