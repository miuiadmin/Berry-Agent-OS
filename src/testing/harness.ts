import { createConnection, type Socket } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHermeticEnv, type HermeticEnv } from './hermetic-env.js';
import { CoreService } from '../kernel/core-service.js';
import { TakeoverController } from './model-takeover.js';
import { IpcCapture } from './ipc-capture.js';
import type { TaskNotification } from '../contracts/infrastructure.js';
import { getDb } from '../memory/index.js';
import { getSocketPath } from '../utils/paths.js';
import type Database from 'better-sqlite3';
import type { StreamingChunk, StreamingResult } from './live-test-types.js';

export interface LiveContextHook {
  recordIO(direction: 'in' | 'out', type: string, payload: Record<string, unknown>): void;
}

export interface HarnessOptions {
  timeoutMs?: number;
  llmMode?: 'mock' | 'takeover' | 'live';
  liveContext?: LiveContextHook;
}

export interface MessageResult {
  response: string;
  sessionId: string;
  taskId: string;
}

export class TestHarness {
  private env: HermeticEnv | null = null;
  private service: CoreService | null = null;
  private socketPath: string = '';
  private options: Required<HarnessOptions>;

  constructor(options: HarnessOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 30000,
      llmMode: options.llmMode ?? 'mock',
      liveContext: options.liveContext ?? { recordIO: () => {} },
    };
  }

  async start(): Promise<void> {
    this.env = createHermeticEnv({ llmMode: this.options.llmMode });
    const isLive = this.options.llmMode === 'live';
    const configYaml = isLive
      ? 'heartbeatTimeoutMs: 120000\nrequestTimeoutMs: 120000\nweb:\n  enabled: false\n'
      : 'heartbeatTimeoutMs: 60000\nrequestTimeoutMs: 60000\nweb:\n  enabled: false\n';
    writeFileSync(join(this.env.appHome, 'config.yaml'), configYaml);
    this.service = new CoreService();
    await this.service.start();
    this.socketPath = getSocketPath();
    await this.waitReady();
  }

  async stop(): Promise<void> {
    if (this.service) {
      await this.service.stop();
      this.service = null;
    }
    if (this.env) {
      this.env.cleanup();
      this.env = null;
    }
  }

  async sendMessage(message: string, sessionId?: string): Promise<MessageResult> {
    const request = {
      type: 'message',
      message,
      sessionId,
      permissionMode: 'allow-all',
      streaming: false,
    };

    const result = await this.socketRequest(request);

    if (result.error) {
      throw new Error(`Harness message failed: ${result.error}`);
    }

    return {
      response: result.response as string,
      sessionId: result.sessionId as string,
      taskId: result.taskId as string,
    };
  }

  async sendMessageStreaming(message: string, sessionId?: string): Promise<StreamingResult> {
    const request = {
      type: 'message',
      message,
      sessionId,
      permissionMode: 'allow-all',
      streaming: true,
    };

    return new Promise((resolve, reject) => {
      const socket: Socket = createConnection(this.socketPath);
      const chunks: StreamingChunk[] = [];
      const startTime = Date.now();
      let buffer = '';

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Streaming timeout (${this.options.timeoutMs}ms)`));
      }, this.options.timeoutMs);

      socket.on('connect', () => {
        this.options.liveContext.recordIO('in', 'message', request as Record<string, unknown>);
        socket.write(JSON.stringify(request) + '\n');
      });

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            chunks.push({
              type: parsed.type as StreamingChunk['type'],
              raw: parsed,
              receivedAt: Date.now() - startTime,
            });

            if (parsed.type === 'result') {
              clearTimeout(timer);
              socket.end();
              this.options.liveContext.recordIO('out', 'result', parsed);
              resolve(buildStreamingResult(chunks, startTime));
            } else if (parsed.type === 'error') {
              clearTimeout(timer);
              socket.end();
              reject(new Error(`Stream error: ${(parsed as Record<string, unknown>).error}`));
            }
          } catch {
            // partial JSON, skip
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.on('end', () => {
        clearTimeout(timer);
        if (chunks.length === 0) {
          reject(new Error('Stream ended with no chunks'));
        } else if (!chunks.some(c => c.type === 'result')) {
          reject(new Error('Stream ended without result event'));
        }
      });
    });
  }

  async dispatchEvolutionTask(input: {
    taskType: 'learning_review' | 'skill_task' | 'plugin_task' | 'code_task';
    sessionId?: string;
    inputPayload?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.socketRequest({
      type: 'evolution.dispatch',
      taskType: input.taskType,
      sessionId: input.sessionId,
      requester: 'test',
      inputPayload: input.inputPayload ?? {},
    });
  }

  async getStatus(): Promise<Record<string, { status: string; pid: number; uptime: number }>> {
    const result = await this.socketRequest({ type: 'status' });
    return result.status as Record<string, { status: string; pid: number; uptime: number }>;
  }

  async waitIdle(maxWaitMs?: number): Promise<void> {
    const deadline = Date.now() + (maxWaitMs ?? this.options.timeoutMs);
    const db = this.getDb();

    while (Date.now() < deadline) {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM agent_tasks WHERE status NOT IN ('completed', 'failed', 'cancelled', 'timeout')`,
      ).get() as { cnt: number };

      if (row.cnt === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }

    const stuck = db.prepare(
      `SELECT id, status, target_agent, task_type FROM agent_tasks WHERE status NOT IN ('completed', 'failed', 'cancelled', 'timeout')`,
    ).all() as { id: string; status: string; target_agent: string; task_type: string }[];
    throw new Error(`waitIdle timeout: ${stuck.map(t => `${t.id}(${t.status}@${t.target_agent})`).join(', ')}`);
  }

  getDb(): Database.Database {
    return getDb();
  }

  setLiveContext(hook: LiveContextHook): void {
    this.options.liveContext = hook;
  }

  getAppHome(): string {
    if (!this.env) throw new Error('Harness not started');
    return this.env.appHome;
  }

  getEventBus(): import('../kernel/event-bus.js').EventBus | null {
    if (!this.service) return null;
    return this.service.getEventBus();
  }

  getTakeoverController(): TakeoverController | null {
    if (!this.service) return null;
    return this.service.getTakeoverController();
  }

  getLastNotification(taskId: string): TaskNotification | null {
    if (!this.service) return null;
    const notifier = this.service.getTaskNotifier();
    if (!notifier) return null;
    return notifier.getLastNotification(taskId);
  }

  getIpcCapture(): IpcCapture {
    return new IpcCapture(this.getDb());
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      try {
        const status = await this.getStatus();
        const agents = Object.values(status);
        const allReady = agents.length >= 2 && agents.every((a: any) => a?.status === 'ready');
        if (allReady) {
          return;
        }
      } catch {
        // socket not yet available, retry
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('waitReady timeout: agents not ready');
  }

  private socketRequest(data: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket: Socket = createConnection(this.socketPath);
      let buffer = '';

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Socket request timeout (${this.options.timeoutMs}ms)`));
      }, this.options.timeoutMs);

      socket.on('connect', () => {
        if (this.options.liveContext) {
          this.options.liveContext.recordIO('in', (data as Record<string, unknown>).type as string ?? 'message', data as Record<string, unknown>);
        }
        socket.write(JSON.stringify(data) + '\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              clearTimeout(timer);
              socket.end();
              if (this.options.liveContext) {
                this.options.liveContext.recordIO('out', parsed.type as string ?? 'result', parsed);
              }
              resolve(parsed);
            } catch (e) {
              clearTimeout(timer);
              reject(e);
            }
            return;
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

function buildStreamingResult(chunks: StreamingChunk[], startTime: number): StreamingResult {
  const progressEvents: StreamingResult['progressEvents'] = [];
  const textDeltas: string[] = [];
  let finalResponse = '';
  let sessionId = '';
  let taskId = '';

  for (const chunk of chunks) {
    if (chunk.type === 'progress') {
      progressEvents.push({
        status: chunk.raw.status as string,
        summary: chunk.raw.summary as string,
      });
    } else if (chunk.type === 'text_delta') {
      textDeltas.push(chunk.raw.text as string);
    } else if (chunk.type === 'result') {
      finalResponse = chunk.raw.response as string;
      sessionId = chunk.raw.sessionId as string;
      taskId = chunk.raw.taskId as string;
    }
  }

  const firstChunkMs = chunks.length > 0 ? chunks[0].receivedAt : 0;
  const totalMs = Date.now() - startTime;

  return {
    chunks,
    finalResponse,
    sessionId,
    taskId,
    progressEvents,
    textDeltas,
    totalChunks: chunks.length,
    firstChunkMs,
    totalMs,
  };
}
