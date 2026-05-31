import { IpcChildChannel } from '../kernel/ipc.js';
import { initDb, getDb, closeDb } from '../memory/index.js';
import { createLlmClient } from '../llm/index.js';
import type { IpcMessage } from '../kernel/types.js';
import type {
  AgentTaskPayload,
  AgentTaskResultPayload,
  TaskAcknowledgePayload,
  TaskStartedPayload,
} from '../contracts/tasks.js';
import type { AgentAskUserPayload, AgentUserReplyPayload } from '../contracts/routing.js';
import type { AgentName } from '../contracts/agents.js';
import type { TurnCorrectionPayload } from '../contracts/delegation.js';
import { loadConfig } from '../kernel/config.js';
import type { LlmClient } from '../llm/index.js';

export interface AskUserOptions {
  options?: string[];
  context?: string;
  timeoutMs?: number;
}

export interface ModuleAgentContext {
  llm: LlmClient;
  ipc: IpcChildChannel;
  askUser: (question: string, opts?: AskUserOptions) => Promise<string>;
  getPendingCorrection: () => TurnCorrectionPayload | null;
  reportUncertainty: (reason: string) => void;
}

export type ModuleTaskHandler = (payload: AgentTaskPayload, context: ModuleAgentContext) => Promise<Record<string, unknown>>;

export function startModuleAgent(handler: ModuleTaskHandler): void {
  const name = process.env.AGENT_NAME as AgentName | undefined;
  if (!name) throw new Error('AGENT_NAME 环境变量未设置');

  const config = loadConfig();
  initDb();
  const ipc = new IpcChildChannel(name);
  const llm = createLlmClient(config.llm, { db: getDb(), ipc, defaultAgent: name });

  const heartbeatInterval = setInterval(() => {
    ipc.send('agent.heartbeat', 'core', { name, uptime: process.uptime() });
  }, config.heartbeatIntervalMs);

  const pendingAskCallbacks = new Map<string, (reply: string) => void>();
  let pendingCorrection: TurnCorrectionPayload | null = null;

  ipc.onMessage('turn.correction', (msg: IpcMessage) => {
    pendingCorrection = msg.payload as TurnCorrectionPayload;
  });

  ipc.onMessage('agent.user_reply', (msg: IpcMessage) => {
    const payload = msg.payload as AgentUserReplyPayload;
    const cb = pendingAskCallbacks.get(payload.taskId);
    if (cb) {
      pendingAskCallbacks.delete(payload.taskId);
      cb(payload.reply);
    }
  });

  const processedTasks = new Set<string>();

  ipc.onMessage('agent.task', async (msg: IpcMessage) => {
    const payload = msg.payload as AgentTaskPayload;
    if (processedTasks.has(payload.taskId)) return;
    processedTasks.add(payload.taskId);
    ipc.send('task.acknowledge', 'core', { taskId: payload.taskId } satisfies TaskAcknowledgePayload);
    ipc.send('task.started', 'core', { taskId: payload.taskId } satisfies TaskStartedPayload);

    const askUser = (question: string, opts?: AskUserOptions): Promise<string> => {
      return new Promise((resolve, reject) => {
        const timeoutMs = opts?.timeoutMs ?? 120000;
        const timeout = setTimeout(() => {
          pendingAskCallbacks.delete(payload.taskId);
          reject(new Error('用户回复超时'));
        }, timeoutMs);

        pendingAskCallbacks.set(payload.taskId, (reply) => {
          clearTimeout(timeout);
          resolve(reply);
        });

        ipc.send('agent.ask_user', 'core', {
          sessionId: payload.sessionId,
          taskId: payload.taskId,
          question,
          options: opts?.options,
          context: opts?.context,
        } satisfies AgentAskUserPayload, msg.correlationId ?? msg.id);
      });
    };

    try {
      const outputPayload = await handler(payload, {
        llm,
        ipc,
        askUser,
        getPendingCorrection: () => {
          const c = pendingCorrection;
          pendingCorrection = null;
          return c;
        },
        reportUncertainty: (reason: string) => {
          ipc.send('task.telemetry', 'core', { kind: 'uncertainty', taskId: payload.taskId, reason });
        },
      });
      ipc.send('agent.task.result', 'core', {
        taskId: payload.taskId,
        ok: true,
        outputPayload,
      } satisfies AgentTaskResultPayload, msg.correlationId ?? msg.id);
    } catch (err) {
      ipc.send('agent.task.result', 'core', {
        taskId: payload.taskId,
        ok: false,
        error: (err as Error).message,
      } satisfies AgentTaskResultPayload, msg.correlationId ?? msg.id);
    }
  });

  ipc.onMessage('agent.shutdown', () => {
    clearInterval(heartbeatInterval);
    ipc.destroy();
    closeDb();
    process.exit(0);
  });

  // Register AFTER all message handlers are set up to avoid race condition
  ipc.send('agent.register', 'core', { name, pid: process.pid });

  process.on('SIGTERM', () => {
    clearInterval(heartbeatInterval);
    ipc.destroy();
    closeDb();
    process.exit(0);
  });
}

export { getDb };
