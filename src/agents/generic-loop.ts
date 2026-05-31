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
import type { AgentName } from '../contracts/agents.js';
import type { ModelTier } from '../contracts/model.js';
import { loadConfig } from '../kernel/config.js';
import type { LlmClient } from '../llm/index.js';
import type { InvokeResult } from '../bus/contract.js';
import { genId } from '../utils/id.js';

export interface GenericAgentConfig {
  name: string;
  systemPrompt: string;
  capabilitiesProvided?: Array<{
    name: string;
    description: string;
    dangerLevel?: 'safe' | 'moderate' | 'dangerous';
  }>;
  capabilitiesRequired?: string[];
  modelTier?: ModelTier;
  maxTurns?: number;
  temperature?: number;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function startGenericAgent(config: GenericAgentConfig): void {
  const name = (process.env.AGENT_NAME ?? config.name) as AgentName;
  if (!name) throw new Error('Agent name not configured');

  const appConfig = loadConfig();
  initDb();
  const ipc = new IpcChildChannel(name);
  const llm = createLlmClient(appConfig.llm, { db: getDb(), ipc, defaultAgent: name });

  const heartbeatInterval = setInterval(() => {
    ipc.send('agent.heartbeat', 'core', { name, uptime: process.uptime() });
  }, appConfig.heartbeatIntervalMs);

  const processedTasks = new Set<string>();
  let availableTools: ToolDef[] = [];

  // Request capabilities from Bus on startup
  ipc.send('bus.capabilities.request', 'core', {
    agentName: name,
    required: config.capabilitiesRequired ?? [],
  });

  ipc.onMessage('bus.capabilities.response', (msg: IpcMessage) => {
    const payload = msg.payload as { tools: ToolDef[] };
    availableTools = payload.tools;
  });

  // Pending bus invocation callbacks
  const pendingInvokes = new Map<string, (result: InvokeResult) => void>();

  ipc.onMessage('bus.invoke.result', (msg: IpcMessage) => {
    const payload = msg.payload as InvokeResult & { invokeId?: string };
    const invokeId = msg.correlationId ?? payload.invokeId;
    if (invokeId) {
      const cb = pendingInvokes.get(invokeId);
      if (cb) {
        pendingInvokes.delete(invokeId);
        cb(payload);
      }
    }
  });

  ipc.onMessage('agent.task', async (msg: IpcMessage) => {
    const payload = msg.payload as AgentTaskPayload;
    if (processedTasks.has(payload.taskId)) return;
    processedTasks.add(payload.taskId);

    ipc.send('task.acknowledge', 'core', { taskId: payload.taskId } satisfies TaskAcknowledgePayload);
    ipc.send('task.started', 'core', { taskId: payload.taskId } satisfies TaskStartedPayload);

    const invokeBus = (capabilityName: string, input: unknown): Promise<InvokeResult> => {
      return new Promise((resolve) => {
        const invokeId = genId('binv');
        const timeout = setTimeout(() => {
          pendingInvokes.delete(invokeId);
          resolve({
            ok: false,
            error: `Bus invoke timeout for "${capabilityName}"`,
            auditId: '',
            durationMs: 30_000,
            provider: { type: 'builtin', name: 'timeout' },
          });
        }, 30_000);

        pendingInvokes.set(invokeId, (result) => {
          clearTimeout(timeout);
          resolve(result);
        });

        ipc.send('bus.invoke', 'core', {
          invokeId,
          capabilityName,
          input,
          callerAgent: name,
          sessionId: payload.sessionId,
        }, invokeId);
      });
    };

    try {
      const result = await runAgentLoop(llm, config, payload, availableTools, name, invokeBus);
      ipc.send('agent.task.result', 'core', {
        taskId: payload.taskId,
        ok: true,
        outputPayload: result,
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

  ipc.send('agent.register', 'core', { name, pid: process.pid });

  process.on('SIGTERM', () => {
    clearInterval(heartbeatInterval);
    ipc.destroy();
    closeDb();
    process.exit(0);
  });
}

async function runAgentLoop(
  llm: LlmClient,
  config: GenericAgentConfig,
  task: AgentTaskPayload,
  tools: ToolDef[],
  agentName: string,
  invokeBus: (name: string, input: unknown) => Promise<InvokeResult>,
): Promise<Record<string, unknown>> {
  const { ToolGuardrails } = await import('./tool-guardrails.js');
  const guardrails = new ToolGuardrails();
  const maxTurns = config.maxTurns ?? 10;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  const taskInput = typeof task.inputPayload === 'string'
    ? task.inputPayload
    : JSON.stringify(task.inputPayload);

  messages.push({ role: 'user', content: taskInput });

  for (let turn = 0; turn < maxTurns; turn++) {
    const modelTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const result = await llm.chat(messages, {
      system: config.systemPrompt,
      maxTokens: 4096,
      temperature: config.temperature ?? 0.3,
      tools: modelTools.length > 0 ? modelTools : undefined,
      agent: agentName as AgentName,
      purpose: 'conversation',
      modelTier: config.modelTier ?? 'default',
      sessionId: task.sessionId,
      taskId: task.taskId,
    });

    if (result.toolCalls.length === 0) {
      return { response: result.content, turns: turn + 1 };
    }

    // Tool Guardrails: check for deadloops before execution
    const toolResults: string[] = [];
    let turnTotalChars = 0;
    const PER_RESULT_LIMIT = 100_000;
    const PER_TURN_LIMIT = 200_000;

    for (const toolCall of result.toolCalls) {
      const guardrailCheck = guardrails.check(toolCall.name, toolCall.input);
      if (guardrailCheck.action === 'block') {
        return { response: result.content || `Blocked: ${guardrailCheck.reason}`, turns: turn + 1, blocked: true, blockReason: guardrailCheck.reason };
      }
      if (guardrailCheck.action === 'warn') {
        toolResults.push(`[${toolCall.id}] WARNING: ${guardrailCheck.reason}`);
        continue;
      }

      const invokeResult = await invokeBus(toolCall.name, toolCall.input);
      let content = invokeResult.ok
        ? (typeof invokeResult.data === 'string' ? invokeResult.data : JSON.stringify(invokeResult.data))
        : `Error: ${invokeResult.error}`;

      // §8.12 Tool output size limits: truncate oversized results
      if (content.length > PER_RESULT_LIMIT) {
        content = truncateWithHeadTail(content, PER_RESULT_LIMIT);
      }
      if (turnTotalChars + content.length > PER_TURN_LIMIT) {
        content = truncateWithHeadTail(content, PER_TURN_LIMIT - turnTotalChars);
      }
      turnTotalChars += content.length;

      toolResults.push(`[${toolCall.id}] ${!invokeResult.ok ? 'ERROR: ' : ''}${content}`);
    }

    messages.push({ role: 'assistant', content: result.content });
    messages.push({ role: 'user', content: toolResults.join('\n') });
  }

  // Budget Grace Call: give LLM one last chance to summarize
  return { response: 'Max turns reached', turns: maxTurns };
}

function truncateWithHeadTail(content: string, maxLength: number): string {
  if (content.length <= maxLength || maxLength <= 0) return content;
  const headSize = Math.floor(maxLength * 0.4);
  const tailSize = Math.floor(maxLength * 0.1);
  const trimmed = content.length - maxLength;
  return `${content.slice(0, headSize)}\n[... truncated ${trimmed} chars ...]\n${content.slice(-tailSize)}`;
}
