/**
 * RealTestClient — 真实测试客户端
 *
 * 像前端一样通过 HTTP CRUD API + WebSocket 与后端交互。
 * 用于第 3 层"真实测试"。
 */
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createHermeticEnv, type HermeticEnv } from './hermetic-env.js';
import { resolveRealTestConfig, applyRealTestEnv, type AppliedRealTestEnv } from '../cli/real-test-profile.js';
import { CoreService } from '../kernel/core-service.js';
import { getDb } from '../memory/index.js';
import type Database from 'better-sqlite3';

// --- Types ---

export interface ConversationInfo {
  sessionId: string;
  messageCount: number;
  lastActive: number;
  firstMessage?: string;
  title?: string;
}

export interface AgentInfo {
  name: string;
  status: string;
  description?: string;
  kind?: string;
  version?: string;
}

export interface TaskInfo {
  id: string;
  taskType: string;
  status: string;
  targetAgent: string;
  createdAt: number;
}

export interface SendMessageResult {
  response: string;
  sessionId: string;
}

export interface RealTestClientOptions {
  timeoutMs?: number;
}

// --- Helpers ---

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get free port')));
      }
    });
    server.on('error', reject);
  });
}

// --- RealTestClient ---

export class RealTestClient {
  private env: HermeticEnv | null = null;
  private applied: AppliedRealTestEnv | null = null;
  private service: CoreService | null = null;
  private baseUrl = '';
  private wsUrl = '';
  private options: Required<RealTestClientOptions>;

  constructor(options?: RealTestClientOptions) {
    this.options = {
      timeoutMs: options?.timeoutMs ?? 120_000,
    };
  }

  async start(): Promise<void> {
    // 1. Find free port for HTTP server
    const port = await findFreePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.wsUrl = `ws://127.0.0.1:${port}`;

    // 2. Setup real test credentials + hermetic environment
    const config = resolveRealTestConfig({ profile: 'override' });
    this.applied = applyRealTestEnv(config);

    // 3. Write config with web enabled on our free port
    const configYaml = [
      'heartbeatTimeoutMs: 120000',
      'requestTimeoutMs: 120000',
      'web:',
      '  enabled: true',
      `  port: ${port}`,
      '  host: 127.0.0.1',
    ].join('\n');
    writeFileSync(join(this.applied.config.appHome, 'config.yaml'), configYaml);

    // 4. Start CoreService
    this.service = new CoreService();
    await this.service.start();

    // 5. Wait for health endpoint to respond
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (this.service) {
      await this.service.stop();
      this.service = null;
    }
    if (this.applied) {
      this.applied.cleanup();
      this.applied = null;
    }
  }

  // --- HTTP CRUD API ---

  async getHealth(): Promise<{ ok: boolean; uptime: number; agents: number }> {
    return this.httpGet('/api/health');
  }

  async listConversations(params?: { limit?: number; offset?: number; search?: string }): Promise<ConversationInfo[]> {
    const qs = buildQueryString(params);
    return this.httpGet(`/api/conversations${qs}`);
  }

  async getConversationMessages(sid: string, limit?: number): Promise<unknown[]> {
    const qs = limit ? `?limit=${limit}` : '';
    return this.httpGet(`/api/conversations/${sid}${qs}`);
  }

  async deleteConversation(sid: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${sid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`DELETE /api/conversations/${sid} failed: HTTP ${res.status}`);
  }

  async renameConversation(sid: string, title: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/conversations/${sid}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`PUT /api/conversations/${sid} failed: HTTP ${res.status}`);
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.httpGet('/api/agents');
  }

  async listTasks(params?: { limit?: number; offset?: number; status?: string }): Promise<{ items: TaskInfo[]; total: number }> {
    const qs = buildQueryString(params);
    return this.httpGet(`/api/tasks${qs}`);
  }

  // --- WebSocket 消息发送 ---

  async sendMessage(sid: string, text: string): Promise<SendMessageResult> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}/ws?sessionId=${sid}`);
      let buffer = '';

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`sendMessage timeout (${this.options.timeoutMs}ms)`));
      }, this.options.timeoutMs);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'message',
          text,
          sessionId: sid,
          permissionMode: 'allow-all',
        }));
      });

      ws.on('message', (data: WebSocket.Data) => {
        buffer += data.toString();
        // Process complete JSON messages (may receive multiple in one frame)
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.type === 'result') {
              clearTimeout(timer);
              ws.close();
              resolve({
                response: msg.response as string,
                sessionId: msg.sessionId as string,
              });
              return;
            } else if (msg.type === 'error') {
              clearTimeout(timer);
              ws.close();
              reject(new Error(`WebSocket error: ${msg.error}`));
              return;
            }
          } catch {
            // partial JSON, continue
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on('close', () => {
        clearTimeout(timer);
      });
    });
  }

  // --- DB access (for assertions) ---

  getDb(): Database.Database {
    return getDb();
  }

  // --- Private ---

  private async httpGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET ${path} failed: HTTP ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const health = await this.getHealth();
        if (health.ok && health.agents >= 2) return;
      } catch {
        // server not yet up, retry
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('RealTestClient: timed out waiting for server ready');
  }
}

// --- Utility ---

function buildQueryString(params?: Record<string, unknown>): string {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}
