import type { CapabilityBus } from './capability-bus.js';
import type { CapabilityExecutor, DangerLevel } from './contract.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('bus:mcp-adapter');

export interface McpToolInfo {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface IMcpToolExecutor {
  execute(serverName: string, toolName: string, input: unknown): Promise<unknown>;
}

export function registerMcpToolsOnBus(
  bus: CapabilityBus,
  tools: McpToolInfo[],
  executor: IMcpToolExecutor,
): string[] {
  const registered: string[] = [];

  for (const tool of tools) {
    const capabilityName = `mcp_${sanitize(tool.serverName)}_${sanitize(tool.toolName)}`;
    if (bus.has(capabilityName)) continue;

    const dangerLevel = inferDangerLevel(tool);

    const capExecutor: CapabilityExecutor = async (input) => {
      return executor.execute(tool.serverName, tool.toolName, input);
    };

    try {
      bus.register({
        name: capabilityName,
        description: `[MCP: ${tool.serverName}] ${tool.description}`,
        dangerLevel,
        provider: { type: 'builtin', name: `mcp-${tool.serverName}` },
        inputSchema: tool.inputSchema as any,
      }, capExecutor);
      registered.push(capabilityName);
    } catch {
      // skip duplicates
    }
  }

  if (registered.length > 0) {
    logger.info({ count: registered.length }, 'MCP tools registered on Bus');
  }
  return registered;
}

export function unregisterMcpServerFromBus(bus: CapabilityBus, serverName: string): void {
  const prefix = `mcp_${sanitize(serverName)}_`;
  const caps = bus.discover({ providerType: 'builtin' });
  for (const cap of caps) {
    if (cap.name.startsWith(prefix)) {
      bus.unregister(cap.name);
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function inferDangerLevel(tool: McpToolInfo): DangerLevel {
  const desc = (tool.description + tool.toolName).toLowerCase();
  if (desc.includes('delete') || desc.includes('write') || desc.includes('execute') || desc.includes('run')) {
    return 'moderate';
  }
  if (desc.includes('admin') || desc.includes('drop') || desc.includes('destroy')) {
    return 'dangerous';
  }
  return 'safe';
}
