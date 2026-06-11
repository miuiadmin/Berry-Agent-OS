import { IpcChildChannel } from '../kernel/ipc.js';
import { IpcJournal } from '../kernel/ipc-journal.js';
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
import { getLogger } from '../utils/logger.js';
import { safeSlice } from '../utils/safe-slice.js';
import type { LlmClient } from '../llm/index.js';
// 13.0: AgentPort — 所有 module agent 均可通过 ask_agent 向其他 agent 提问
import { createAgentPort } from './agent-port.js';
import { z } from 'zod';
import type { ToolResult } from '../tools/types.js';
import { registerTool } from '../tools/index.js';

const logger = getLogger('module-agent');

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
  /** 13.0 §12.2: 当前任务关联的 mission ID（Brain 路由或 task_ready 派发时设置） */
  missionId?: string;
  /** 13.0 §12.2: 当前任务关联的 plan task ID（如 t-1、t-2） */
  planTaskId?: string;
  /**
   * 13.0 §12.3: 渲染后的 mission 上下文文本，可直接注入 agent 的 system prompt。
   * 包含：mission goal、当前 task 描述、squad 角色、依赖任务状态等。
   * 当 missionId 存在时由基础设施自动渲染，agent 无需自行调用 MissionManager。
   */
  missionPrompt?: string;
  /**
   * 13.0 §5.3.14: 拒绝当前任务并建议替代 agent。
   * Kernel 会检查 reRoute 深度（最大 2 次），超过则降级为 askUser 让用户决定。
   * Agent 在 handler 中调用此函数后会 throw 终止当前任务执行。
   *
   * @param suggestedAgent 建议接手的 agent 名称（如 'code'、'skills'）
   * @param reason 拒绝原因（自然语言，供 Brain 观察队列记录）
   */
  rejectTask: (suggestedAgent: string, reason: string) => never;
}

export type ModuleTaskHandler = (payload: AgentTaskPayload, context: ModuleAgentContext) => Promise<Record<string, unknown>>;

export function startModuleAgent(handler: ModuleTaskHandler): void {
  const name = process.env.AGENT_NAME as AgentName | undefined;
  if (!name) throw new Error('AGENT_NAME 环境变量未设置');

  const config = resolveConfig(getConfigPath());
  initDb();
  const db = getDb();
  const ipc = new IpcChildChannel(name);
  // 注入 IPC journal：让 agent→core 方向的关键业务消息也能被 journal
  // 并支持崩溃后由 core 端重放
  ipc.setJournal(new IpcJournal(db));
  const providerRegistry = createProviderRegistry(config.llm, config.llm.channelsConfig);
  const llm = createLlmClient(config.llm, { db, ipc, defaultAgent: name, providerRegistry });

  const heartbeatInterval = setInterval(() => {
    ipc.send('agent.heartbeat', 'core', { name, uptime: process.uptime() });
  }, config.heartbeatIntervalMs);

  const pendingAskCallbacks = new Map<string, (reply: string) => void>();

  /**
   * L2: CAS 原子纠偏消费。
   *
   * 问题：read + null 是两步操作，Agent 崩溃后 IPC journal replay 会重复注入。
   * 修复：引入 correctionId 做 CAS 语义，每次消费记录 consumedAt 时间戳，
   * 调用方可通过 _correctionId 判断是否已被消费。
   */
  let pendingCorrection: TurnCorrectionPayload | null = null;
  let pendingCorrectionId: string | null = null;

  /**
   * M3: 纠偏历史记录（最近 5 条），用于冲突检测。
   * 当多条纠偏累积时，检查是否存在矛盾指令（如 "自主" vs "每次都问用户"）。
   */
  const correctionHistory: Array<TurnCorrectionPayload> = [];
  const CORRECTION_HISTORY_MAX = 5;

  /** M3: 矛盾关键词对（互斥指令） */
  const CONTRADICTION_PAIRS: Array<[string[], string[]]> = [
    [['自主', '独立决定', '不需要确认'], ['问用户', '确认', '必须询问', '请示']],
    [['简洁', '简短', '精简'], ['详细', '全面', '完整解释', '展开']],
    [['快速', '尽快', '优先速度'], ['仔细', '谨慎', '逐步', '确认']],
  ];

  /**
   * M3: 检查新纠偏是否与历史中的已有纠偏矛盾。
   * 返回检测到的矛盾描述，无矛盾返回 null。
   */
  function detectConflict(newInstruction: string): string | null {
    for (const [groupA, groupB] of CONTRADICTION_PAIRS) {
      const matchesA = (keywords: string[]) => keywords.some(k => newInstruction.includes(k));
      const newIsA = matchesA(groupA);
      const newIsB = matchesA(groupB);
      if (!newIsA && !newIsB) continue;

      for (const hist of correctionHistory) {
        const histInstruction = hist.instruction ?? '';
        const histIsA = matchesA(groupA);
        const histIsB = matchesA(groupB);
        // 矛盾：新指令在 A 组，历史在 B 组（或反之）
        if ((newIsA && histIsB) || (newIsB && histIsA)) {
          return `矛盾检测: 新指令 "${safeSlice(newInstruction, 60)}" 与历史 "${safeSlice(histInstruction, 60)}" 冲突`;
        }
      }
    }
    return null;
  }

  ipc.onMessage('turn.correction', (msg: IpcMessage) => {
    const correction = msg.payload as TurnCorrectionPayload;
    pendingCorrection = correction;
    pendingCorrectionId = msg.correlationId ?? msg.id ?? null;

    // M3: 新纠偏到达时检查冲突并记录日志
    if (correction.instruction) {
      const conflict = detectConflict(correction.instruction);
      if (conflict) {
        getLogger('module-agent').warn({ conflict, correctionId: pendingCorrectionId }, 'M3: 纠偏冲突检测');
      }
    }
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

  // 13.0 VF-1: 串行化任务队列 — 防止并发 agent.task 耗尽资源或竞争共享状态
  // 设计：每个任务追加到 taskQueue 末尾，前一个完成后才执行（Promise chain）
  let taskQueue: Promise<void> = Promise.resolve();

  /** 实际执行一个 agent.task，错误时上报后 swallow（让队列继续） */
  async function runAgentTask(payload: AgentTaskPayload, msg: IpcMessage): Promise<void> {
    ipc.send('task.acknowledge', 'core', { taskId: payload.taskId } satisfies TaskAcknowledgePayload);
    ipc.send('task.started', 'core', { taskId: payload.taskId } satisfies TaskStartedPayload);

    const askUser = (question: string, opts?: AskUserOptions): Promise<string> => {
      return new Promise((resolve, reject) => {
        const timeoutMs = opts?.timeoutMs ?? 300000; // §5.3.5: 5 分钟独立超时
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
      // 13.0 §12.3: 在 agent.task 路径渲染 mission 上下文（与 dialogue.send 路径对齐）
      // 当 Brain 通过 dispatchModuleTaskInternal 派发带 missionId 的任务时，
      // 基础设施自动渲染 MissionContext 摘要，agent 只需读取 context.missionPrompt 注入到 LLM prompt
      let missionPrompt: string | undefined;
      if (payload.missionId) {
        try {
          const { MissionManager } = await import('../kernel/mission-manager.js');
          const missionManager = new MissionManager();
          missionPrompt = missionManager.renderContext(
            payload.missionId,
            payload.planTaskId ?? '',
            name!,
          ) || undefined;
          // 发送 progress 通知前端：agent 已感知到 mission 任务
          ipc.send('task.progress', 'core', {
            taskId: payload.taskId,
            summary: missionPrompt
              ? `开始执行 mission 任务: ${missionPrompt.split('\n')[0]?.slice(0, 80) ?? payload.planTaskId ?? payload.missionId}`
              : `开始执行任务 (mission: ${payload.missionId})`,
          });
          logger.debug({ missionId: payload.missionId, planTaskId: payload.planTaskId, agent: name }, 'module-agent: mission context rendered for agent.task');
        } catch (err) {
          logger.warn({ err, missionId: payload.missionId }, 'module-agent: mission context rendering failed for agent.task');
        }
      }

      // 13.0 §5.3.14: rejectTask — Agent 拒绝任务并建议替代 agent。
      // 调用后直接 throw，终止当前 handler 执行。
      // Kernel 侧 handleTaskReject 会检查 reRoute 深度（最大 2 次），超过则降级为 askUser。
      const rejectTask = (suggestedAgent: string, reason: string): never => {
        ipc.send('task.reject', 'core', {
          taskId: payload.taskId,
          reason,
          suggestAgent: suggestedAgent,
        });
        throw new Error(`task_rejected: ${reason} (建议: ${suggestedAgent})`);
      };

      const outputPayload = await handler(payload, {
        llm,
        ipc,
        askUser,
        // 13.0 §12.2: 透传 mission 上下文到 agent handler
        missionId: payload.missionId,
        planTaskId: payload.planTaskId,
        missionPrompt,
        rejectTask,
        getPendingCorrection: () => {
          const c = pendingCorrection;
          const id = pendingCorrectionId;
          pendingCorrection = null;
          pendingCorrectionId = null;
          // L2: 附带 correctionId 和 consumedAt，调用方可做幂等判断
          if (c) {
            const consumed = { ...c, _correctionId: id, _consumedAt: Date.now() };
            // M3: 记录到纠偏历史（供冲突检测）
            correctionHistory.push(consumed);
            if (correctionHistory.length > CORRECTION_HISTORY_MAX) {
              correctionHistory.shift();
            }
            return consumed;
          }
          return null;
        },
        reportUncertainty: (reason: string) => {
          ipc.send('task.telemetry', 'core', { kind: 'uncertainty', taskId: payload.taskId, reason });
        },
      });

      // 13.0: 任务完成后发送 progress（让前端知道 agent 已完成，等待 Brain 审核）
      if (payload.missionId) {
        const summary = outputPayload?.summary ?? outputPayload?.response ?? '任务完成';
        ipc.send('task.progress', 'core', {
          taskId: payload.taskId,
          summary: `Mission 任务完成: ${String(summary).slice(0, 100)}`,
        });
      }

      ipc.send('agent.task.result', 'core', {
        taskId: payload.taskId,
        ok: true,
        outputPayload,
      } satisfies AgentTaskResultPayload, msg.correlationId ?? msg.id);
    } catch (err) {
      // 13.0: 任务失败时也通知 mission 进度
      if (payload.missionId) {
        ipc.send('task.progress', 'core', {
          taskId: payload.taskId,
          summary: `Mission 任务失败: ${(err as Error).message?.slice(0, 100)}`,
        });
      }

      ipc.send('agent.task.result', 'core', {
        taskId: payload.taskId,
        ok: false,
        error: (err as Error).message,
      } satisfies AgentTaskResultPayload, msg.correlationId ?? msg.id);
    }
  }

  ipc.onMessage('agent.task', (msg: IpcMessage) => {
    const payload = msg.payload as AgentTaskPayload;
    if (processedTasks.has(payload.taskId)) return;
    processedTasks.add(payload.taskId);

    // 串行化执行：新任务追加到队列末尾，等待前一个完成后才开始
    taskQueue = taskQueue.then(() => runAgentTask(payload, msg)).catch((err: Error) => {
      // 错误已在 runAgentTask 内部捕获并上报 agent.task.result，这里只 log 防止队列断裂
      logger.warn({ err, taskId: payload.taskId, agentName: name }, 'module-agent: queued task failed');
    });
  });

  // ─── 13.0 AgentPort: 所有 module agent 共享的 ask_agent 工具 ───
  // 允许任何 module agent 在 dialogue 场景下通过 LLM tool loop 向其他 agent 提问。
  // Code Agent 有自己的 ensureAgentPortTools()（带 saga、file lock 等额外逻辑），
  // 其他 agent 通过此共享注册获得基础跨 agent 通信能力。
  let sharedAgentPortRegistered = false;
  function ensureSharedAgentPort(): void {
    if (sharedAgentPortRegistered) return;
    sharedAgentPortRegistered = true;
    /** 创建共享 AgentPort（用于 ask_agent 工具） */
    const port = createAgentPort({
      ipc: ipc as any,
      agentName: name!,
      askUser: async (question: string, opts?: AskUserOptions) => {
        // 默认 5 分钟独立超时（§5.3.5）
        return new Promise((resolve, reject) => {
          const timeoutMs = opts?.timeoutMs ?? 300_000;
          const timeout = setTimeout(() => {
            reject(new Error('用户回复超时'));
          }, timeoutMs);
          // askUser 通过临时 taskId 注册回调
          const tempTaskId = `ask-${Date.now()}`;
          pendingAskCallbacks.set(tempTaskId, (reply) => {
            clearTimeout(timeout);
            resolve(reply);
          });
          ipc.send('agent.ask_user', 'core', {
            sessionId: 'agent-port',
            taskId: tempTaskId,
            question,
            options: opts?.options,
            context: opts?.context,
          } satisfies AgentAskUserPayload);
        });
      },
    });
    registerTool({
      name: 'ask_agent',
      description: '向另一个 Agent 提问获取信息。例如向 memory 查询用户偏好、向 learning 获取学习结果。适合需要跨 Agent 知识协作的场景。',
      dangerLevel: 'safe',
      inputSchema: z.object({
        target: z.string().describe('目标 Agent 名称，如 "memory"（查询用户知识库）、"learning"（查询学习结果）'),
        message: z.string().describe('要发送给目标 Agent 的消息，应包含足够的上下文'),
        context: z.record(z.string(), z.unknown()).optional().describe('可选：附加上下文信息'),
      }),
      async execute(input: unknown): Promise<ToolResult> {
        const { target, message, context: ctx } = input as { target: string; message: string; context?: Record<string, unknown> };
        try {
          const reply = await port.request({ to: target, content: message, context: ctx });
          return { content: `[${reply.from}] ${reply.content}` };
        } catch (err) {
          const errorMsg = (err as Error).message;
          const isTimeout = errorMsg.includes('timeout') || errorMsg.includes('不可用');
          const hint = isTimeout
            ? `${errorMsg}。建议：用现有信息继续完成任务，或使用其他工具自行获取信息。`
            : errorMsg;
          return { content: `ask_agent 失败: ${hint}`, isError: true };
        }
      },
    });
  }

  // ─── dialogue.send handler：接收来自 Conversation Agent 的对话消息 ───
  ipc.onMessage('dialogue.send', async (msg: IpcMessage) => {
    const payload = msg.payload as DialogueMessagePayload;
    const ephemeralTaskId = (payload.context as Record<string, unknown>)?._taskId as string | undefined;
    const sessionId = (payload.context as Record<string, unknown>)?._sessionId as string | undefined;

    // 13.0 §12.3: 从 dialogue context 读取 mission 信息，注入 MissionContext 摘要到 system prompt
    // Conversation Agent 在委派时会把当前 task 的 missionId/planTaskId 附带到 dialogue context
    const missionId = (payload.context as Record<string, unknown>)?.missionId as string | undefined;
    const planTaskId = (payload.context as Record<string, unknown>)?.planTaskId as string | undefined;

    try {
      // 13.0: 注册共享 AgentPort 工具（ask_agent），让 dialogue 场景下的 LLM 可向其他 agent 提问
      ensureSharedAgentPort();

      const userContent = payload.content;
      const messages = [{ role: 'user' as const, content: userContent }];

      const { runToolLoop: runLoop } = await import('../llm/tool-caller.js');
      const { getToolRegistry } = await import('../tools/index.js');
      const { toModelTools } = await import('../tools/types.js');
      // 每次读取最新 registry（Code Agent 的 locked tools 可能在首次 agent.task 后才注册）
      const agentTools = toModelTools(getToolRegistry());

      // 13.0 §12.3: 构建 system prompt 时注入 mission context（如果有活跃 mission）
      let systemPrompt = getDialogueSystemPrompt(name!);
      if (missionId) {
        try {
          const { MissionManager } = await import('../kernel/mission-manager.js');
          const missionManager = new MissionManager();
          const missionPrompt = missionManager.renderContext(missionId, planTaskId ?? '', name!);
          if (missionPrompt) {
            systemPrompt += `\n\n## 当前任务上下文\n\n${missionPrompt}`;
            logger.debug({ missionId, planTaskId, agent: name }, 'module-agent: mission context injected into system prompt');
          }
        } catch (err) {
          logger.warn({ err, missionId }, 'module-agent: mission context injection failed');
        }
      }

      const result = await runLoop({
        llm,
        messages,
        systemPrompt,
        tools: agentTools,
        config: { maxCalls: config.toolLoop.maxCalls, timeoutMs: config.toolLoop.timeoutMs },
        /**
         * 13.0 §3.10: dialogue 场景下的 Brain 纠偏消费。
         * Module Agent 在处理 dialogue.send 时也可能收到 Brain 纠偏
         * （如对话轮数过多、语义漂移等），通过 getPendingCorrection
         * 回调让 tool loop 每轮检查并应用。
         */
        getPendingCorrection: () => {
          const c = pendingCorrection;
          const id = pendingCorrectionId;
          pendingCorrection = null;
          pendingCorrectionId = null;
          if (c) {
            const consumed = { ...c, _correctionId: id, _consumedAt: Date.now() };
            correctionHistory.push(consumed);
            if (correctionHistory.length > CORRECTION_HISTORY_MAX) {
              correctionHistory.shift();
            }
            return consumed;
          }
          return null;
        },
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
          // 11.0: 推送 tool_call 到前端（与 conversation/entry.ts 对齐），
          // 让用户能在前端看到 code agent 的工具调用过程
          if (ephemeralTaskId) {
            ipc.send('task.telemetry', 'core', {
              kind: 'tool_call',
              taskId: ephemeralTaskId,
              toolName: record.name,
              input: safeSlice(record.input, 2000),
              result: safeSlice(record.result, 5000),
              isError: record.isError,
              durationMs: record.durationMs,
            });
          }
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

  // W1 修复：补齐 SIGINT 处理
  const agentCleanup = () => {
    clearInterval(heartbeatInterval);
    ipc.destroy();
    closeDb();
    process.exit(0);
  };

  ipc.onMessage('agent.shutdown', agentCleanup);
  process.on('SIGTERM', agentCleanup);
  process.on('SIGINT', agentCleanup);

  // Register AFTER all message handlers are set up to avoid race condition
  ipc.send('agent.register', 'core', { name, pid: process.pid });
}

export { getDb };

/**
 * 13.0: 根据当前 Agent 名称返回 dialogue 场景下的 systemPrompt。
 * 不同 Agent 在被其他 Agent 通过 AgentPort 提问时，需要使用不同的角色提示。
 */
function getDialogueSystemPrompt(agentName: string): string {
  const prompts: Record<string, string> = {
    memory: '你是一个记忆管理智能体。你的职责是查询和管理用户的知识库。根据收到的指令查询或操作记忆，给出简洁准确的结果。不要闲聊。',
    learning: '你是一个学习智能体。你的职责是从对话中提取用户偏好和知识。根据收到的指令执行学习任务，给出简洁的结果摘要。不要闲聊。',
    evolution: '你是一个能力进化引擎。你的职责是检测系统能力缺口并生成改进提案。根据收到的指令分析并给出建议。不要闲聊。',
    code: '你是一个专业的代码智能体。收到指令后执行任务，给出简洁的结果摘要。不要闲聊。',
    skills: '你是一个技能管理智能体。你的职责是发现、加载和执行技能。根据收到的指令操作技能，给出简洁的结果。不要闲聊。',
    'plugin-builder': '你是一个插件构建智能体。你的职责是根据需求生成插件包。根据收到的指令构建插件，给出简洁的结果。不要闲聊。',
  };
  return prompts[agentName] ?? `你是一个专业的智能体。收到指令后执行任务，给出简洁的结果摘要。不要闲聊。`;
}
