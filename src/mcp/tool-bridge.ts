import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult } from '../tools/types.js';
import type { DangerLevel } from '../utils/types.js';
import type { McpServerConfig, CircuitState } from './contract.js';
import { scanToolDescription, sanitizeCredentials, truncateOutput } from './security.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('mcp-tools');

// ─── Tool Name Convention ───────────────────────────────────────

export function mcpToolFullName(serverName: string, toolName: string): string {
  return `mcp:${serverName}:${toolName}`;
}

export function parseMcpToolName(fullName: string): { serverName: string; toolName: string } | null {
  const match = fullName.match(/^mcp:([^:]+):(.+)$/);
  if (!match) return null;
  return { serverName: match[1], toolName: match[2] };
}

// ─── DangerLevel Inference ──────────────────────────────────────

export function inferDangerLevel(toolName: string, description: string, serverDefault: DangerLevel): DangerLevel {
  const name = toolName.toLowerCase();
  if (/^(read|get|list|search|query|describe|count|find|show|view)/.test(name)) return 'safe';
  if (/^(write|delete|execute|run|create|modify|drop|remove|kill|format|truncate|reset)/.test(name)) return 'dangerous';
  if (/destructive|irreversible|permanent|dangerous/i.test(description)) return 'dangerous';
  return serverDefault;
}

// ─── Tool Filtering ─────────────────────────────────────────────

export function filterMcpTools(tools: McpTool[], config: McpServerConfig): McpTool[] {
  const include = config.tools?.include;
  const exclude = config.tools?.exclude;

  return tools.filter(t => {
    if (include && include.length > 0 && !include.includes(t.name)) return false;
    if (exclude && exclude.length > 0 && exclude.includes(t.name)) return false;
    return true;
  });
}

// ─── MCP Tool → ToolDefinition Conversion ───────────────────────

export interface ToolBridgeContext {
  client: Client;
  config: McpServerConfig;
  getCircuitState: () => CircuitState;
  onError: (error: Error) => void;
}

export function mcpToolToDefinition(tool: McpTool, ctx: ToolBridgeContext): ToolDefinition {
  const fullName = mcpToolFullName(ctx.config.name, tool.name);
  const description = tool.description ?? '';
  const dangerLevel = inferDangerLevel(tool.name, description, ctx.config.dangerLevel as DangerLevel);

  scanToolDescription(ctx.config.name, tool.name, description);

  return {
    name: fullName,
    description: `[MCP:${ctx.config.name}] ${description}`.slice(0, 2048),
    inputSchema: z.record(z.string(), z.unknown()),
    dangerLevel,
    execute: createToolExecutor(tool.name, ctx),
  };
}

function createToolExecutor(toolName: string, ctx: ToolBridgeContext): (input: unknown) => Promise<ToolResult> {
  return async (input: unknown): Promise<ToolResult> => {
    const circuitState = ctx.getCircuitState();
    if (circuitState === 'open') {
      return { content: `[MCP:${ctx.config.name}] 服务不可用（熔断中）`, isError: true };
    }

    try {
      const result = await ctx.client.callTool(
        { name: toolName, arguments: (input as Record<string, unknown>) ?? {} },
        undefined,
        { timeout: ctx.config.timeout },
      );

      const content = extractTextContent(result.content as McpContent[]);
      const truncated = truncateOutput(content);

      return {
        content: truncated || '(empty response)',
        isError: !!result.isError,
      };
    } catch (err) {
      const error = err as Error;
      ctx.onError(error);
      const message = sanitizeCredentials(error.message);
      logger.warn({ serverName: ctx.config.name, toolName, error: message }, 'MCP 工具调用失败');
      return { content: `[MCP 错误] ${message}`, isError: true };
    }
  };
}

// ─── Content Extraction ─────────────────────────────────────────

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

function extractTextContent(content: McpContent[]): string {
  if (!content || !Array.isArray(content)) return '';

  return content.map(block => {
    if (block.type === 'text' && block.text) return block.text;
    if (block.type === 'image') return `[图片: ${block.mimeType ?? 'unknown'}]`;
    if (block.type === 'resource') return `[资源: ${block.mimeType ?? 'unknown'}]`;
    return '';
  }).filter(Boolean).join('\n');
}

// ─── Batch tool conversion helper ───────────────────────────────

export function convertMcpTools(tools: McpTool[], ctx: ToolBridgeContext): ToolDefinition[] {
  return tools.map(tool => mcpToolToDefinition(tool, ctx));
}
