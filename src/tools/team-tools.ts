import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './types.js';
import type { OrgTreeManager, AgentHierarchy, WorkspaceManager } from '../workspaces/index.js';
import type { WorkspaceRouter } from '../kernel/workspace-router.js';
import type { OrgNodeDefinition } from '../contracts/org-tree.js';

interface TeamToolsDeps {
  db: Database.Database;
  orgTreeManager: OrgTreeManager;
  agentHierarchy: AgentHierarchy;
  workspaceRouter: WorkspaceRouter;
  workspaceManager: WorkspaceManager;
}

export function createTeamTools(deps: TeamToolsDeps): ToolDefinition[] {
  return [
    createBuildTeamTool(deps),
    createGetOrgTreeTool(deps),
    createGetReviewChainTool(deps),
  ];
}

const agentSlotSchema: z.ZodType<{ agentName: string; role?: 'lead' | 'member'; description?: string }> = z.object({
  agentName: z.string().describe('Agent 名称'),
  role: z.enum(['lead', 'member']).optional().describe('角色，默认 member'),
  description: z.string().optional().describe('Agent 职责描述'),
});

const orgNodeDefSchema: z.ZodType<OrgNodeDefinition> = z.lazy(() =>
  z.object({
    name: z.string().describe('节点名称'),
    description: z.string().optional().describe('节点描述'),
    nodeType: z.string().optional().describe('节点类型（group/department/system/center/custom）'),
    children: z.array(orgNodeDefSchema).optional().describe('子节点'),
    agents: z.array(agentSlotSchema).optional().describe('分配到此节点的 Agent'),
  }),
);

function createBuildTeamTool(deps: TeamToolsDeps): ToolDefinition {
  const inputSchema = z.object({
    workspaceId: z.string().describe('工作区 ID'),
    tree: orgNodeDefSchema.describe('组织树定义'),
  });

  return {
    name: 'build_team',
    description: '为工作区创建组织树并批量绑定 Agent，支持多层级嵌套结构',
    inputSchema,
    dangerLevel: 'moderate',
    execute: async (input: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.parse(input);

      const workspace = deps.workspaceManager.get(parsed.workspaceId);
      if (!workspace) {
        return { content: `工作区不存在: ${parsed.workspaceId}`, isError: true };
      }

      try {
        const result = deps.orgTreeManager.buildTree({
          workspaceId: parsed.workspaceId,
          tree: parsed.tree,
        });

        return {
          content: JSON.stringify({
            success: true,
            rootNodeId: result.rootNodeId,
            nodesCreated: result.nodesCreated,
            agentsCreated: result.agentsCreated,
            leadAgent: result.leadAgent,
            workspace: workspace.name,
          }, null, 2),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `构建团队失败: ${msg}`, isError: true };
      }
    },
  };
}

function createGetOrgTreeTool(deps: TeamToolsDeps): ToolDefinition {
  const inputSchema = z.object({
    workspaceId: z.string().describe('工作区 ID'),
  });

  return {
    name: 'get_org_tree',
    description: '获取工作区的完整组织树结构',
    inputSchema,
    dangerLevel: 'safe',
    execute: async (input: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.parse(input);

      const workspace = deps.workspaceManager.get(parsed.workspaceId);
      if (!workspace) {
        return { content: `工作区不存在: ${parsed.workspaceId}`, isError: true };
      }

      const nodes = deps.orgTreeManager.getFullTree(parsed.workspaceId);

      const nodesWithAgents = nodes.map(node => ({
        ...node,
        agents: deps.agentHierarchy.getAgentsByNode(node.id),
      }));

      return {
        content: JSON.stringify({
          workspace: workspace.name,
          nodeCount: nodes.length,
          tree: nodesWithAgents,
        }, null, 2),
      };
    },
  };
}

function createGetReviewChainTool(deps: TeamToolsDeps): ToolDefinition {
  const inputSchema = z.object({
    workspaceId: z.string().describe('工作区 ID'),
    agentName: z.string().describe('Agent 名称'),
  });

  return {
    name: 'get_review_chain',
    description: '获取指定 Agent 的上级审核链',
    inputSchema,
    dangerLevel: 'safe',
    execute: async (input: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.parse(input);

      const workspace = deps.workspaceManager.get(parsed.workspaceId);
      if (!workspace) {
        return { content: `工作区不存在: ${parsed.workspaceId}`, isError: true };
      }

      const binding = deps.db.prepare(`
        SELECT id FROM workspace_agents
        WHERE workspace_id = ? AND agent_name = ? AND enabled = 1
        LIMIT 1
      `).get(parsed.workspaceId, parsed.agentName) as { id: string } | undefined;

      if (!binding) {
        return { content: `Agent "${parsed.agentName}" 未绑定到工作区 ${workspace.name}`, isError: true };
      }

      const chain = deps.agentHierarchy.getReviewChain(binding.id);
      const isTop = deps.agentHierarchy.isTopLevel(binding.id);

      return {
        content: JSON.stringify({
          agent: parsed.agentName,
          workspace: workspace.name,
          isTopLevel: isTop,
          chainLength: chain.length,
          reviewChain: chain,
        }, null, 2),
      };
    },
  };
}
