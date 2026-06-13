import { startResidentAgent } from '../../resident-agent.js';
import { getLogger } from '../../../utils/logger.js';
import type { ModelMessage } from '../../../contracts/model.js';
import { runToolLoop, type ToolCallRecord } from '../../../llm/tool-caller.js';
import { clearDynamicTools, getToolRegistry, registerTool } from '../../../tools/index.js';
import { toModelTools } from '../../../tools/types.js';
import type { ToolDefinition, ToolResult } from '../../../tools/types.js';
import { createMemoryTools } from '../../../tools/memory-tools.js';
import { createCapabilityTools } from '../../../tools/capability-tools.js';
import { createSkillTools } from '../../../tools/skill-tools.js';
import { createModelTools } from '../../../tools/model-tools.js';
import { createDialogueTools } from '../../../tools/dialogue-tools.js';
import { setCronToolsDb } from '../../../tools/cron-tools.js';
import { setSessionToolsDb } from '../../../tools/session-tools.js';
import { ContextManager } from '../../../llm/context-manager.js';
// 对话内联（doc 22）：消灭双轨制——user 消息与历史读取都切到 messages+message_blocks。
// persistUserMessage 写新表；getTimeline 读历史（Block[] 平铺为 ModelMessage）。
import { persistUserMessage, getTimeline } from '../../../memory/message-blocks-repo.js';
import type { Block } from '../../../contracts/message-blocks.js';
import { z } from 'zod';
import type { IpcMessage } from '../../../kernel/types.js';
import type { UserMessagePayload, DraftResponsePayload, FinalResponsePayload } from '../../../contracts/messaging.js';
import type { ReviewResult } from '../../../contracts/review.js';
import type { PermissionResultPayload, PermissionValidatePayload, PermissionConsumePayload } from '../../../contracts/permissions.js';
import type { ToolAuditPayload } from '../../../contracts/audit.js';
import type { MemoryContextFrame } from '../../../contracts/memory.js';
import type { TaskAcknowledgePayload, TaskStartedPayload } from '../../../contracts/tasks.js';
import type { DangerLevel } from '../../../tools/types.js';
import type { TurnCorrectionPayload } from '../../../contracts/delegation.js';

const DEFAULT_SYSTEM_PROMPT = `你是 Berry，一个有记忆和学习能力的个人 AI 助手。回答要简洁、友好、准确。

## 核心原则

**对话优先**：大多数用户消息只需要文字回复，不需要调用任何工具。只有当用户**明确要求**执行操作（如"帮我创建文件"、"运行测试"、"查看目录"）时才使用工具。

## 上下文优先级

1. **当前对话历史优先**：用户在本次对话中提到的信息，直接从对话上下文引用，不要调用 memory_query。
2. **记忆工具用于跨会话信息**：只有当用户询问之前会话中的信息、个人偏好或长期知识时，才使用 memory_query 查询。
3. 判断标准：如果信息已经出现在当前对话的消息历史中，直接引用；如果没有出现过，再查记忆。

## 工具使用

你可以使用以下工具：
- **文件系统**：read_file（带行号分页）、write_file、list_directory、delete_file
- **代码搜索**：search_files（glob 模式）、grep_files（正则跨文件搜索）
- **代码编辑**：edit_code（精确替换，需先读后写）
- **Shell**：run_command（持久工作目录，支持后台执行）
- **网络**：http_fetch、web_search（搜索互联网）、web_fetch（抓取网页为可读文本）
- **交互**：ask_user（结构化追问）、push_notification（通知用户）
- **监控**：monitor_start/stop/status（后台流式观察命令输出）
- **定时**：cron_create/delete/list（创建/管理定时任务）
- **历史**：search_history（搜索过往对话）
- **记忆**：memory_query/add/delete（跨会话记忆）
- **协作**：dialogue（与代码智能体等进行多轮对话式协作）
- **13.0 任务协调**：plan（读写共享任务计划）、squad（管理团队组织）

## dialogue 工具使用指南

\`dialogue\` 工具让你与其他智能体进行多轮对话。你是协调者——发指令、收结果、决定下一步。

**何时用 dialogue**：
- 用户要求编码/重构/修复 bug 等需要多步推理的任务
- 任务模糊，需要先了解现状再决策
- 需要分步执行并根据中间结果调整方向

**何时不用 dialogue**：
- 简单的文件读写、搜索、运行命令 → 直接用对应工具
- 纯对话/问答 → 直接回复
- 用户没有请求任何操作

**使用要点**：
1. 首次调用不传 dialogueId，后续追问传入返回的 dialogueId
2. 消息要包含足够上下文（目标智能体无状态，不记得之前说过什么）
3. 收到 needsClarification 时，判断自己能否回答；不确定就 ask_user
4. 不要无限追问——5 轮内解决大多数任务。如果超过 5 轮还没进展，总结现状回复用户
5. 多个不相关子任务可以分别开新 dialogue

## 13.0 Mission 协作指南

当系统提示中包含「当前 Mission 上下文」时，说明你正在参与一个多 Agent 协作的 mission。

**你的角色**：
- **协调者**：将 mission 任务委派给对应 Agent，收集结果，汇总给用户
- **汇报者**：使用 plan 工具查看 mission 进度，向用户报告已完成和进行中的任务
- **沟通者**：将用户的补充说明和修正传达给正在工作的 Agent

**mission 场景下的行为**：
1. 优先使用 plan 工具查看任务列表和依赖关系
2. 将具体工作委派给对应 Agent（code → 代码、learning → 学习、skills → 技能）
3. 收到 Agent 结果后，检查 plan 是否有后续依赖任务需要触发
4. 所有任务完成后，汇总结果给用户
5. 如果用户对某个任务不满意，可以重新委派或调整 plan

**严格规则**：
- 日常聊天、问候、闲聊、情感表达 → 直接文字回复，禁止调用工具
- 只有用户明确请求操作时才使用工具
- 不确定时用 ask_user 询问，而非猜测
- edit_code 前必须先 read_file 同一文件

始终使用用户正在使用的语言回答。`;

const MAX_SESSIONS = 64;

startResidentAgent(({ name, config, ipc, llm, db }) => {
  const logger = getLogger('conversation');
  setCronToolsDb(db);
  setSessionToolsDb(db);
  const memoryTools = createMemoryTools(ipc, config.requestTimeoutMs);
  const capabilityTools = createCapabilityTools(ipc, config.requestTimeoutMs);
  const currentSessionRef = { id: '' };
  const skillTools = createSkillTools(db, {
    onChange: () => ipc.send('skill.changed', 'core', {}),
    getSessionId: () => currentSessionRef.id || undefined,
    shellInjection: config.skills?.shellInjection ?? false,
  });
  const modelTools = createModelTools(ipc, currentSessionRef, config.requestTimeoutMs);

  /** per-session 的运行时状态（signal + correlationId），dialogue 工具通过 currentSessionRef.id 路由到正确 session */
  const sessionRunState = new Map<string, { signal: AbortSignal; correlationId: string }>();
  const dialogueTools = createDialogueTools(
    ipc,
    () => sessionRunState.get(currentSessionRef.id)?.signal,
    () => sessionRunState.get(currentSessionRef.id)?.correlationId,
  );

  clearDynamicTools([...memoryTools, ...capabilityTools, ...skillTools, ...modelTools, ...dialogueTools].map((tool) => tool.name));
  for (const tool of [...memoryTools, ...capabilityTools, ...skillTools, ...modelTools, ...dialogueTools]) {
    registerTool(tool);
  }

  const sessionHistories = new Map<string, ModelMessage[]>();
  const pendingDrafts = new Map<string, { sessionId: string; draft: string; toolCalls: ToolCallRecord[]; createdAt: number }>();
  const tools = toModelTools(getToolRegistry());
  const contextManager = new ContextManager();

  /**
   * 13.0 §3.10: Brain 纠偏消费基础设施。
   *
   * startResidentAgent 不像 startModuleAgent 内置纠偏消费，
   * 需要手动维护 pendingCorrection 状态和 IPC handler。
   *
   * Brain 通过 dialogue.observe / checkpoint.evaluate 检测问题后，
   * 发送 turn.correction IPC 消息到 Conversation Agent，
   * 存入此变量，由 getPendingCorrection 回调供 runToolLoop 每轮消费。
   */
  let pendingCorrection: TurnCorrectionPayload | null = null;
  let pendingCorrectionId: string | null = null;

  /** CAS 原子消费纠偏，供 runToolLoop 每轮调用 */
  const consumeCorrection = (): TurnCorrectionPayload | null => {
    const c = pendingCorrection;
    const id = pendingCorrectionId;
    pendingCorrection = null;
    pendingCorrectionId = null;
    if (c) {
      return { ...c, _correctionId: id, _consumedAt: Date.now() };
    }
    return null;
  };

  /**
   * 13.0 §3.10: 注册 turn.correction IPC handler。
   * Brain 的纠偏指令通过 orchestrator 转发到此 handler。
   * 纠偏存入 pendingCorrection 变量，等 runToolLoop 下一轮检查。
   */
  ipc.onMessage('turn.correction', (msg: IpcMessage) => {
    const correction = msg.payload as TurnCorrectionPayload;
    pendingCorrection = correction;
    pendingCorrectionId = msg.correlationId ?? msg.id ?? null;
    logger.info({ action: correction.action, instruction: correction.instruction?.slice(0, 100) }, 'conversation: 收到 Brain 纠偏');
  });

  /** per-session 互斥：新消息到达时 abort 旧 signal，tool loop 和 dialogue 自然终止 */
  const sessionLocks = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  const DRAFT_TTL_MS = 5 * 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of pendingDrafts) {
      if (now - entry.createdAt > DRAFT_TTL_MS) pendingDrafts.delete(id);
    }
  }, 60_000);

  ipc.onMessage('plugins.register_tools', (msg: IpcMessage) => {
    const pluginToolDefs = msg.payload as Array<{
      name: string;
      description: string;
      dangerLevel: DangerLevel;
      inputSchema: Record<string, unknown>;
    }>;
    for (const def of pluginToolDefs) {
      const tool: ToolDefinition = {
        name: def.name,
        description: def.description,
        inputSchema: z.record(z.string(), z.unknown()),
        dangerLevel: def.dangerLevel,
        execute: async (input: unknown): Promise<ToolResult> => {
          const response = await ipc.request('plugin.execute', 'core', {
            toolName: def.name,
            input,
          }, config.requestTimeoutMs);
          const result = response.payload as { ok: boolean; output?: Record<string, unknown>; error?: string };
          if (result.ok) {
            return { content: JSON.stringify(result.output) };
          }
          return { content: result.error ?? '插件执行失败', isError: true };
        },
      };
      registerTool(tool);
    }
    tools.push(...toModelTools(pluginToolDefs.map(d => ({
      name: d.name,
      description: d.description,
      inputSchema: z.record(z.string(), z.unknown()),
      dangerLevel: d.dangerLevel,
      execute: async () => ({ content: '' }),
    }))));
  });

  ipc.onMessage('user.message', async (msg: IpcMessage) => {
    const { sessionId, message, taskId, systemPrompt, contextFrames, modelTierOverride, intent, clientMsgId } = msg.payload as UserMessagePayload;
    const trackingId = msg.correlationId ?? msg.id;
    logger.debug({ sessionId, taskId, intent, msgLen: message.length, toolCount: tools.length, modelTier: modelTierOverride }, 'conversation:start');
    currentSessionRef.id = sessionId;

    // 互斥：abort 旧 session 的 tool loop（signal 传播到 dialogue 工具自然取消等待）
    const existing = sessionLocks.get(sessionId);
    if (existing) {
      existing.controller.abort();
      await existing.promise.catch(() => {});
    }
    const controller = new AbortController();
    sessionRunState.set(sessionId, { signal: controller.signal, correlationId: trackingId });

    const run = (async () => {

    if (taskId) {
      ipc.send('task.acknowledge', 'core', { taskId } satisfies TaskAcknowledgePayload);
    }

    if (!sessionHistories.has(sessionId)) {
      if (sessionHistories.size >= MAX_SESSIONS) {
        const oldest = sessionHistories.keys().next().value!;
        sessionHistories.delete(oldest);
      }
      // 11.0 启动预热：从 SQLite 加载该 session 的历史对话，注入 sessionHistories
      // 避免重启后丢失上下文；同时修复重启后第一条消息 history 为空导致的工具调用幻觉。
      // 对话内联（doc 22）：从 messages+message_blocks 读（getTimeline），Block[] 平铺为 ModelMessage——
      // text block 抽为 content（LLM 上下文用）；thinking/tool/delegation 不进 LLM 历史（避免噪音 + token 膨胀）。
      const timeline = getTimeline(sessionId, { limit: 50 });
      const initialHistory: ModelMessage[] = timeline
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.blocks
            .filter((b): b is Extract<Block, { type: 'text'; text: string }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
        }))
        .filter((m) => m.content.length > 0);
      sessionHistories.set(sessionId, initialHistory);
    }
    const history = sessionHistories.get(sessionId)!;
    let priorHistory = [...history];

    if (contextManager.needsCompression(priorHistory)) {
      const compressed = await contextManager.compress(priorHistory, llm.current);
      // 11.0：压缩只把被挤出的旧消息从 LLM context 移除（仅替换内存 history，不动 DB）。
      // 旧消息已持久化在 messages+message_blocks（消灭双轨制后对话唯一存储），压缩不影响落库，
      // 重新启动由 loadHistoryFromDb→getTimeline 读回。
      sessionHistories.set(sessionId, compressed);
      priorHistory = [...compressed];
    }

    const memoryContext = formatMemoryContextFrames(contextFrames);
    const messageForModel = memoryContext ? `${memoryContext}\n\n${message}` : message;
    history.push({ role: 'user', content: message });

    // 修复 C2/H8/H9：conversation agent 内部的第二道兜底闸门。
    // 即使 kernel 入口（handleMessage）已经落过 user 行，幂等的
    // saveUserMessage 会返回 deduplicated: true 并跳过真正的 INSERT。
    // 只有当 kernel 入口失败 / 网络丢包 / 重连时，这一行才真正写入。
    // 与 final.response 路径解耦 —— final 路径只补写 assistant 行。
    try {
      const result = persistUserMessage({ sessionId, content: message, clientMsgId });
      if (result.deduplicated) {
        logger.debug({ sessionId, clientMsgId, msgId: result.id }, 'conversation: user 消息已存在（kernel 入口已落盘）');
      } else {
        logger.debug({ sessionId, clientMsgId, msgId: result.id }, 'conversation: 兜底写入 user 消息');
      }
    } catch (err) {
      // 失败仅 warn，不阻塞 LLM 调用 —— 至少 history 还在内存里，
      // 重启时由 11.0 启动预热从 SQLite 加载回来。
      logger.warn({ err, sessionId, clientMsgId }, 'conversation: 兜底写入 user 消息失败');
    }

    if (taskId) {
      ipc.send('task.started', 'core', { taskId } satisfies TaskStartedPayload);
      ipc.send('task.progress', 'core', { taskId, summary: 'Conversation Agent 已开始生成回复' });
    }

    try {
      const streamingEnabled = config.streaming?.enabled !== false;
      const { StreamingScrubber } = await import('../../../llm/streaming-scrubber.js');
      const scrubber = new StreamingScrubber();

      // 13.0 §12.3: 如果当前会话有活跃 mission，注入 mission 上下文到 system prompt
      // 让 Conversation Agent 能感知 mission 进度、使用 plan/squad 工具协调任务
      let effectiveSystemPrompt = systemPrompt ? `${systemPrompt}\n\n${DEFAULT_SYSTEM_PROMPT}` : DEFAULT_SYSTEM_PROMPT;
      if (intent === 'mission' || message.includes('mission') || message.includes('任务进度') || message.includes('计划')) {
        try {
          const { MissionManager } = await import('../../../kernel/mission-manager.js');
          const missionManager = new MissionManager();
          // 列出所有活跃 mission，注入最新一个的上下文
          const missions = missionManager.listMissions();
          const activeMission = missions.find(m => m.status === 'in_progress' || m.status === 'created');
          if (activeMission) {
            const missionPrompt = missionManager.renderContext(activeMission.id, '', 'conversation');
            if (missionPrompt) {
              effectiveSystemPrompt += `\n\n## 当前活跃 Mission\n\n${missionPrompt}`;
              logger.debug({ missionId: activeMission.id, sessionId }, 'conversation: active mission context injected');
            }
          }
        } catch (err) {
          logger.warn({ err, sessionId }, 'conversation: mission context injection failed');
        }
      }

      const result = await runToolLoop({
        llm: llm.current,
        messages: [...priorHistory, { role: 'user', content: messageForModel }],
        systemPrompt: effectiveSystemPrompt,
        tools,
        signal: controller.signal,
        config: { maxCalls: config.toolLoop.maxCalls, timeoutMs: config.toolLoop.timeoutMs },
        /**
         * 13.0 §3.10: Brain 纠偏消费回调。
         * 让 tool loop 每轮检查 Brain 是否发了纠偏指令。
         * - action='adjust' + instruction → 注入 system message
         * - action='adjust' + forbiddenTools → 从工具列表移除
         * - action='stop' → 立即终止 tool loop
         */
        getPendingCorrection: consumeCorrection,
        onChunk: streamingEnabled ? (text: string) => {
          const scrubbed = scrubber.scrub(text);
          if (scrubbed && taskId) {
            ipc.send('task.telemetry', 'core', { kind: 'text_delta', taskId, text: scrubbed });
          }
        } : undefined,
        onReasoning: streamingEnabled && taskId ? (text: string) => {
          ipc.send('task.telemetry', 'core', { kind: 'reasoning_delta', taskId, text });
        } : undefined,
        onToolResult: taskId ? (toolName: string, isError: boolean) => {
          ipc.send('task.telemetry', 'core', { kind: 'tool_result', taskId, toolName, isError });
        } : undefined,
        onUncertainty: taskId ? (reason: string) => {
          ipc.send('task.telemetry', 'core', { kind: 'uncertainty', taskId, reason });
        } : undefined,
        chatContext: {
          agent: name,
          purpose: 'conversation',
          modelTier: modelTierOverride,
          sessionId,
          taskId,
          correlationId: trackingId,
        },
        async acquirePermission(toolName: string, toolInput: string, dangerLevel: DangerLevel) {
          const response = await ipc.request('permission.acquire', 'core', {
            toolName,
            toolInput,
            dangerLevel,
            taskId,
          }, config.requestTimeoutMs);
          const payload = response.payload as PermissionResultPayload;
          return { allowed: payload.allowed, reason: payload.reason, tokenId: payload.tokenId };
        },
        async requestPermission(toolName: string, toolInput: string, dangerLevel: DangerLevel) {
          const response = await ipc.request('permission.request', 'core', {
            toolName,
            toolInput,
            dangerLevel,
            taskId,
          }, config.requestTimeoutMs);
          const payload = response.payload as PermissionResultPayload;
          return { allowed: payload.allowed, reason: payload.reason, tokenId: payload.tokenId };
        },
        async validatePermission(tokenId: string, toolName: string, toolInput: string) {
          const response = await ipc.request('permission.validate', 'core', {
            tokenId,
            sessionId,
            toolName,
            toolInput,
          } satisfies PermissionValidatePayload, config.requestTimeoutMs);
          const payload = response.payload as PermissionResultPayload;
          return { allowed: payload.allowed, reason: payload.reason };
        },
        async consumePermission(tokenId: string) {
          const response = await ipc.request('permission.consume', 'core', {
            tokenId,
          } satisfies PermissionConsumePayload, config.requestTimeoutMs);
          const payload = response.payload as PermissionResultPayload;
          if (!payload.allowed) {
            throw new Error(payload.reason ?? 'permission token 消费失败');
          }
        },
        auditTool(record: ToolCallRecord) {
          ipc.send('tool.audit', 'core', {
            sessionId,
            taskId,
            correlationId: trackingId,
            toolName: record.name,
            toolInput: record.input,
            permissionToken: record.permissionToken,
            toolResult: record.result,
            isError: record.isError,
            dangerLevel: record.dangerLevel,
            durationMs: record.durationMs,
          } satisfies ToolAuditPayload);
          if (taskId) {
            ipc.send('task.telemetry', 'core', {
              kind: 'tool_call',
              taskId,
              toolName: record.name,
              input: record.input.slice(0, 2000),
              result: record.result.slice(0, 5000),
              isError: record.isError,
              durationMs: record.durationMs,
            });
          }
        },
      });

      const draft = result.finalContent;
      logger.debug({ sessionId, draftLen: draft.length, reasoningLen: result.reasoning?.length ?? 0, toolCalls: result.toolCalls.length, tools: result.toolCalls.map(tc => tc.name) }, 'conversation:draft');

      // Flush any remaining buffered text from the scrubber (e.g. short replies
      // that didn't exceed the <memory-context> tag length threshold during streaming).
      if (streamingEnabled && taskId) {
        const remaining = scrubber.flush();
        if (remaining) {
          ipc.send('task.telemetry', 'core', { kind: 'text_delta', taskId, text: remaining });
        }
      }

      pendingDrafts.set(trackingId, { sessionId, draft, toolCalls: result.toolCalls, createdAt: Date.now() });

      ipc.send('draft.response', 'core', {
        sessionId,
        draft,
        reasoning: result.reasoning,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, input: tc.input, result: tc.result })),
      } satisfies DraftResponsePayload, trackingId);
    } catch (err) {
      const isConfigError = (err as Error).name === 'ModelNotConfiguredError';
      const errorMsg = isConfigError
        ? (err as Error).message
        : `抱歉，处理过程中发生错误: ${(err as Error).message}`;
      ipc.send('final.response', 'core', {
        sessionId,
        response: errorMsg,
        reviewVerdict: 'approve',
      } satisfies FinalResponsePayload, trackingId);
    }

    })(); // end run IIFE
    sessionLocks.set(sessionId, { controller, promise: run });

    try {
      await run;
    } catch (err) {
      logger.error({ err, sessionId }, 'conversation:unexpected rejection');
    } finally {
      const current = sessionLocks.get(sessionId);
      if (current?.controller === controller) {
        sessionLocks.delete(sessionId);
      }
      if (sessionRunState.get(sessionId)?.signal === controller.signal) {
        sessionRunState.delete(sessionId);
      }
    }
  });

  ipc.onMessage('review.result', (msg: IpcMessage) => {
    const review = msg.payload as ReviewResult;
    const correlationId = msg.correlationId!;
    const pending = pendingDrafts.get(correlationId);

    if (!pending) return;
    pendingDrafts.delete(correlationId);

    let finalResponse: string;
    if (review.verdict === 'approve') {
      finalResponse = pending.draft;
    } else {
      finalResponse = review.finalResponse ?? pending.draft;
    }

    const history = sessionHistories.get(pending.sessionId);
    if (history) {
      history.push({ role: 'assistant', content: finalResponse });
    }

    // 13.0 灵魂版：将审核 reason 和原始初稿（modify/reject 时）一并传递，
    // 前端可展示"由 Brain 修改"徽章和 diff 还原
    const isModified = review.verdict !== 'approve';
    ipc.send('final.response', 'core', {
      sessionId: pending.sessionId,
      response: finalResponse,
      reviewVerdict: review.verdict,
      reviewReason: review.reason,
      originalDraft: isModified ? pending.draft : undefined,
    } satisfies FinalResponsePayload, correlationId);
  });

  // 13.0 §5.3.12: 用户还原 Brain 修改时更新会话历史（in-memory + DB）
  // Kernel 端 /api/brain/restore-original 路由会发 conversation.restore IPC
  // 同时也持久化到 conversations 表，让重启后 history 加载也是原始版本
  ipc.onMessage('conversation.restore', async (msg: IpcMessage) => {
    const { sessionId: restoreSessionId, taskId: restoreTaskId, originalResponse } = msg.payload as {
      sessionId: string;
      taskId: string;
      originalResponse: string;
    };
    if (!restoreSessionId || !originalResponse) return;

    // ① 更新 in-memory history（替换最后一条 assistant 消息）
    const history = sessionHistories.get(restoreSessionId);
    if (history && history.length > 0) {
      const lastIdx = history.length - 1;
      const last = history[lastIdx];
      if (last.role === 'assistant') {
        history[lastIdx] = { role: 'assistant', content: originalResponse };
        logger.debug({ sessionId: restoreSessionId, taskId: restoreTaskId }, 'conversation: history updated with original response');
      }
    }

    // ② 持久化到 message_blocks（让 11.0 启动预热加载的也是原始版本）
    // 对话内联（doc 22）：assistant 正文在 message_blocks 的 text block——还原初稿改写最后一条
    // assistant 消息的 text block（消灭双轨制后 conversations 不再是读取源）。
    try {
      const { replaceLastAssistantText } = await import('../../../memory/message-blocks-repo.js');
      replaceLastAssistantText(restoreSessionId, originalResponse);
    } catch (err) {
      logger.warn({ err, sessionId: restoreSessionId, taskId: restoreTaskId }, 'conversation: persist original response failed');
    }
  });
});

function formatMemoryContextFrames(frames?: MemoryContextFrame[]): string {
  const contextText = frames
    ?.map((frame) => frame.contextText.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!contextText) return '';
  return `<memory-context>\n[System: 以下是召回的记忆上下文，非用户新输入。作为参考信息使用。]\n${contextText}\n</memory-context>`;
}
