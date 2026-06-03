import { IpcChildChannel } from '../kernel/ipc.js';
import { initDb, getDb, closeDb } from '../memory/index.js';
import { createLlmClient } from '../llm/index.js';
import { createProviderRegistry } from '../providers/registry.js';
import type { IpcMessage } from '../kernel/types.js';
import type {
  AgentTaskPayload,
  AgentTaskResultPayload,
  TaskAcknowledgePayload,
  TaskStartedPayload,
} from '../contracts/tasks.js';
import type { AgentAskUserPayload, AgentUserReplyPayload } from '../contracts/routing.js';
import type { DialogueMessagePayload } from '../contracts/dialogue.js';
import type { PermissionResultPayload } from '../contracts/permissions.js';
import type { AgentName } from '../contracts/agents.js';
import type { TurnCorrectionPayload } from '../contracts/delegation.js';
import { resolveConfig } from '../config/resolver.js';
import { getConfigPath } from '../utils/paths.js';
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

  const config = resolveConfig(getConfigPath());
  initDb();
  const ipc = new IpcChildChannel(name);
  const providerRegistry = createProviderRegistry(config.llm, config.llm.channelsConfig);
  const llm = createLlmClient(config.llm, { db: getDb(), ipc, defaultAgent: name, providerRegistry });

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

  // ─── dialogue.send handler：接收来自 Conversation Agent 的对话消息 ───
  // 提前缓存工具列表（避免每次 dialogue.send 到达时重复 zod→JSON schema 转换）
  let cachedDialogueTools: import('../contracts/model.js').ModelToolDef[] | null = null;
  async function getDialogueTools() {
    if (cachedDialogueTools) return cachedDialogueTools;
    const { getToolRegistry } = await import('../tools/index.js');
    const { toModelTools } = await import('../tools/types.js');
    cachedDialogueTools = toModelTools(getToolRegistry());
    return cachedDialogueTools;
  }

  ipc.onMessage('dialogue.send', async (msg: IpcMessage) => {
    const payload = msg.payload as DialogueMessagePayload;
    const ephemeralTaskId = (payload.context as Record<string, unknown>)?._taskId as string | undefined;
    const sessionId = (payload.context as Record<string, unknown>)?._sessionId as string | undefined;

    try {
      // 构造单轮 LLM 调用的 messages（不保留对话历史，Conversation 负责上下文）
      const userContent = payload.content;
      const messages = [{ role: 'user' as const, content: userContent }];

      // 执行 LLM 调用（含工具使用），推送 streaming telemetry
      const { runToolLoop: runLoop } = await import('../llm/tool-caller.js');
      const agentTools = await getDialogueTools();

      const result = await runLoop({
        llm,
        messages,
        systemPrompt: `你是一个专业的代码智能体。收到指令后执行任务，给出简洁的结果摘要。不要闲聊。`,
        tools: agentTools,
        config: { maxCalls: config.toolLoop.maxCalls, timeoutMs: config.toolLoop.timeoutMs },
        onChunk: ephemeralTaskId ? (text: string) => {
          ipc.send('task.telemetry', 'core', { kind: 'text_delta', taskId: ephemeralTaskId, text });
        } : undefined,
        onToolResult: ephemeralTaskId ? (toolName: string, isError: boolean) => {
          ipc.send('task.telemetry', 'core', { kind: 'tool_result', taskId: ephemeralTaskId, toolName, isError });
        } : undefined,
        requestPermission: async (toolName: string, toolInput: string, dangerLevel) => {
          const response = await ipc.request('permission.request', 'core', {
            toolName,
            toolInput,
            dangerLevel,
            taskId: ephemeralTaskId,
            sessionId, // dialogue 模式显式传递 sessionId
          }, config.requestTimeoutMs);
          const p = response.payload as PermissionResultPayload;
          return { allowed: p.allowed, reason: p.reason, tokenId: p.tokenId };
        },
        validatePermission: async (tokenId: string, toolName: string, toolInput: string) => {
          const response = await ipc.request('permission.validate', 'core', {
            tokenId,
            sessionId: sessionId ?? 'dialogue',
            toolName,
            toolInput,
          }, config.requestTimeoutMs);
          const p = response.payload as PermissionResultPayload;
          return { allowed: p.allowed, reason: p.reason };
        },
        consumePermission: async (tokenId: string) => {
          const response = await ipc.request('permission.consume', 'core', {
            tokenId,
          }, config.requestTimeoutMs);
          const p = response.payload as PermissionResultPayload;
          if (!p.allowed) throw new Error(p.reason ?? 'permission token 消费失败');
        },
        auditTool: (record) => {
          ipc.send('tool.audit', 'core', {
            sessionId: sessionId ?? 'dialogue',
            taskId: ephemeralTaskId ?? payload.dialogueId,
            toolName: record.name,
            toolInput: record.input,
            permissionToken: record.permissionToken,
            toolResult: record.result,
          });
        },
      });

      // 回复 Conversation
      // 根据回复内容判断是否最终结果（含有澄清/不确定关键词 → needsClarification）
      const needsClarification = /(?:需要.*(?:确认|提供|说明)|不确定|请问|unable to|need more)/i.test(result.finalContent);
      const reply: DialogueMessagePayload = {
        dialogueId: payload.dialogueId,
        sequenceNumber: payload.sequenceNumber + 1,
        from: name!,
        to: payload.from,
        content: result.finalContent,
        metadata: {
          isFinal: !needsClarification,
          needsClarification,
          confidence: needsClarification ? 0.4 : 0.85,
        },
      };
      ipc.send('dialogue.reply', 'core', reply, payload.dialogueId);
    } catch (err) {
      // 错误时也回复，让 Conversation 能做决策
      const reply: DialogueMessagePayload = {
        dialogueId: payload.dialogueId,
        sequenceNumber: payload.sequenceNumber + 1,
        from: name!,
        to: payload.from,
        content: `执行出错: ${(err as Error).message}`,
        metadata: { isFinal: false, needsClarification: true },
      };
      ipc.send('dialogue.reply', 'core', reply, payload.dialogueId);
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
