import { execSync } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { MCP_RESTART_DELAY_MS } from '../lib/time-constants.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServerConfig } from './contract.js';
import { buildSafeEnv } from './security.js';
import { getLogger } from '../utils/logger.js';
import { killProcessSafely, isProcessAlive as checkAlive } from '../lib/process-utils.js';

const logger = getLogger('mcp-transport');

// ─── Transport Factory ──────────────────────────────────────────

export interface TransportResult {
  transport: Transport;
  type: 'stdio' | 'http' | 'websocket';
  pid?: number;
}

export function createTransport(config: McpServerConfig, authProvider?: OAuthClientProvider): TransportResult {
  if (config.command && config.command.length > 0) {
    return createStdioTransport(config);
  }

  if (config.url) {
    if (/^wss?:\/\//i.test(config.url)) {
      return createWebSocketTransport(config);
    }
    return createHttpTransport(config, authProvider);
  }

  throw new Error(`MCP server "${config.name}": 必须指定 command 或 url`);
}

function createStdioTransport(config: McpServerConfig): TransportResult {
  const [command, ...args] = config.command!;
  const env = buildSafeEnv(config.env);

  const transport = new StdioClientTransport({
    command,
    args,
    env,
    stderr: 'pipe',
  });

  return { transport, type: 'stdio' };
}

function createHttpTransport(config: McpServerConfig, authProvider?: OAuthClientProvider): TransportResult {
  const url = new URL(config.url!);
  const headers: Record<string, string> = { ...config.headers };

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers,
    },
    authProvider,
  });

  return { transport, type: 'http' };
}

function createWebSocketTransport(config: McpServerConfig): TransportResult {
  const url = new URL(config.url!);
  const transport = new WebSocketClientTransport(url);
  return { transport, type: 'websocket' };
}

// ─── Process Manager ────────────────────────────────────────────

export class ProcessManager {
  private activePids = new Map<string, number>();
  private orphanPids = new Set<number>();

  track(serverName: string, pid: number): void {
    this.activePids.set(serverName, pid);
  }

  getActivePid(serverName: string): number | undefined {
    return this.activePids.get(serverName);
  }

  async cleanup(serverName: string): Promise<void> {
    const pid = this.activePids.get(serverName);
    if (!pid) return;
    this.activePids.delete(serverName);

    try {
      const descendants = this.getDescendants(pid);
      const allPids = [pid, ...descendants];

      for (const p of allPids) {
        killProcessSafely(p, 'SIGTERM');
      }

      await new Promise(resolve => setTimeout(resolve, MCP_RESTART_DELAY_MS));

      for (const p of allPids) {
        if (checkAlive(p)) {
          killProcessSafely(p, 'SIGKILL');
          this.orphanPids.add(p);
        }
      }
    } catch (err) {
      logger.debug({ err, serverName, pid }, '进程清理异常');
    }
  }

  async cleanupAll(): Promise<void> {
    const names = [...this.activePids.keys()];
    await Promise.all(names.map(name => this.cleanup(name)));

    for (const pid of this.orphanPids) {
      killProcessSafely(pid, 'SIGKILL');
    }
    this.orphanPids.clear();
  }

  private getDescendants(pid: number): number[] {
    try {
      const output = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', timeout: 5000 });
      return output.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
    } catch {
      return [];
    }
  }

}
