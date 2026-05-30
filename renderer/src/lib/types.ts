export interface Workspace {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string | null;
  issuePrefix: string | null;
  issueCounter: number;
  reviewMode: string;
  createdAt: string;
}

export interface OrgNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  type: 'root' | 'group' | 'department' | 'system' | 'center' | 'custom';
  path: string;
  depth: number;
  position: number;
  metadata: unknown;
  createdAt: string;
}

export interface Agent {
  id: string;
  workspaceId: string | null;
  orgNodeId: string | null;
  superiorId: string | null;
  userId: string;
  agentType: 'global' | 'team';
  name: string;
  avatar: string | null;
  roleDescription: string | null;
  provider: string;
  config: Record<string, unknown>;
  thinkingLevel: string | null;
  l2Capabilities: string[];
  roles: string[] | null;
  status: string;
  lastActiveAt: string | null;
  trustLevel: string;
  consecutiveApprovals: number;
  totalExecutions: number;
  successRate: number | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

export interface Session {
  id: string;
  workspaceId: string | null;
  agentId: string;
  title: string | null;
  sessionType: 'user_chat' | 'execution' | 'chain' | 'delegate';
  status: string;
  messageCount: number;
  totalTokens: number;
  compressedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  reviewStatus?: string;
  reviewNote?: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  orgNodeId: string | null;
  name: string;
  description: string | null;
  visibility: string;
  status: string;
  createdAt: string;
}

export interface TaskColumn {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  wipLimit: number | null;
  position: number;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  workspaceId: string;
  columnId: string;
  parentTaskId: string | null;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  assigneeType: string | null;
  assigneeId: string | null;
  creatorType: string;
  creatorId: string;
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  position: number;
  estimatedHours: number | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
}
