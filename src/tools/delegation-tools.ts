import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ToolDefinition, ToolResult } from './types.js';
import type { WorkspaceRouter } from '../kernel/workspace-router.js';
import type { WorkspaceManager } from '../workspaces/index.js';
import type { DelegationOrchestrator } from '../kernel/delegation-orchestrator.js';

interface DelegationToolsDeps {
  db: Database.Database;
  workspaceRouter: WorkspaceRouter;
  workspaceManager: WorkspaceManager;
  orchestrator: DelegationOrchestrator;
}

export function createDelegationTools(deps: DelegationToolsDeps): ToolDefinition[] {
  return [
    createDelegateToTeamTool(deps),
    createCrossTeamSummaryTool(deps),
    createListTeamsTool(deps),
  ];
}

function createDelegateToTeamTool(deps: DelegationToolsDeps): ToolDefinition {
  const inputSchema = z.object({
    workspaceId: z.string().describe('目标工作区 ID'),
    prompt: z.string().describe('委托给团队的任务描述'),
    urgent: z.boolean().optional().describe('是否紧急'),
  });

  return {
    name: 'delegate_to_team',
    description: '将任务委托给指定工作区的团队负责人处理',
    inputSchema,
    dangerLevel: 'safe',
    execute: async (input: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.parse(input);
      const { workspaceId, prompt } = parsed;

      const workspace = deps.workspaceManager.get(workspaceId);
      if (!workspace) {
        return { content: `工作区不存在: ${workspaceId}`, isError: true };
      }

      const lead = deps.workspaceRouter.getTeamLead(workspaceId);
      if (!lead) {
        return { content: `工作区 ${workspace.name} 没有指定团队负责人`, isError: true };
      }

      try {
        const result = await deps.orchestrator.dispatchModuleTask({
          sessionId: workspaceId,
          taskType: 'chat',
          requester: 'global-assistant',
          inputPayload: {
            userMessage: prompt,
            workspaceId,
            delegationType: 'workspace',
          },
          foreground: true,
        });

        return {
          content: JSON.stringify({
            taskId: result.taskId,
            targetAgent: result.targetAgent,
            workspace: workspace.name,
            status: 'dispatched',
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `委托失败: ${msg}`, isError: true };
      }
    },
  };
}

function createCrossTeamSummaryTool(deps: DelegationToolsDeps): ToolDefinition {
  const inputSchema = z.object({
    workspaceIds: z.array(z.string()).optional().describe('要汇总的工作区 ID 列表，不指定则汇总全部'),
    timeRange: z.string().optional().describe('时间范围，如 "7d", "24h", "30d"'),
  });

  return {
    name: 'cross_team_summary',
    description: '汇总多个工作区/团队的近期活动',
    inputSchema,
    dangerLevel: 'safe',
    execute: async (input: unknown): Promise<ToolResult> => {
      const parsed = inputSchema.parse(input);

      const allWorkspaces = deps.workspaceManager.list({ status: 'active' });
      const targetIds = parsed.workspaceIds ?? allWorkspaces.map(ws => ws.id);

      const rangeMs = parseTimeRange(parsed.timeRange ?? '7d');
      const since = Date.now() - rangeMs;

      const summary: Array<{
        workspaceId: string;
        name: string;
        lead: string | null;
        memberCount: number;
        recentDelegations: number;
        successRate: number;
      }> = [];

      for (const wsId of targetIds) {
        const ws = deps.workspaceManager.get(wsId);
        if (!ws) continue;

        const lead = deps.workspaceRouter.getTeamLead(wsId);
        const members = deps.workspaceRouter.getMembers(wsId);

        const stats = deps.db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
          FROM delegation_history
          WHERE workspace_id = ? AND created_at > ?
        `).get(wsId, since) as { total: number; successes: number } | undefined;

        summary.push({
          workspaceId: wsId,
          name: ws.name,
          lead,
          memberCount: members.length,
          recentDelegations: stats?.total ?? 0,
          successRate: stats && stats.total > 0 ? stats.successes / stats.total : 0,
        });
      }

      return { content: JSON.stringify(summary, null, 2) };
    },
  };
}

function createListTeamsTool(deps: DelegationToolsDeps): ToolDefinition {
  const inputSchema = z.object({});

  return {
    name: 'list_teams',
    description: '列出所有工作区及其团队负责人',
    inputSchema,
    dangerLevel: 'safe',
    execute: async (): Promise<ToolResult> => {
      const workspaces = deps.workspaceManager.list({ status: 'active' });

      const teams = workspaces.map(ws => ({
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        lead: deps.workspaceRouter.getTeamLead(ws.id),
        members: deps.workspaceRouter.getMembers(ws.id).map(m => ({
          name: m.agentName,
          role: m.role,
        })),
      }));

      return { content: JSON.stringify(teams, null, 2) };
    },
  };
}

function parseTimeRange(range: string): number {
  const match = range.match(/^(\d+)(h|d|w|m)$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'w': return value * 7 * 24 * 60 * 60 * 1000;
    case 'm': return value * 30 * 24 * 60 * 60 * 1000;
    default: return 7 * 24 * 60 * 60 * 1000;
  }
}
