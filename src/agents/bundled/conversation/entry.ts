import { startResidentAgent } from '../../resident-agent.js';
import type { ModelMessage } from '../../../contracts/model.js';
import { runToolLoop, type ToolCallRecord } from '../../../llm/tool-caller.js';
import { clearDynamicTools, getToolRegistry, registerTool } from '../../../tools/index.js';
import { toModelTools } from '../../../tools/types.js';
import type { ToolDefinition, ToolResult } from '../../../tools/types.js';
import { createMemoryTools } from '../../../tools/memory-tools.js';
import { createCapabilityTools } from '../../../tools/capability-tools.js';
import { createSkillTools } from '../../../tools/skill-tools.js';
import { createModelTools } from '../../../tools/model-tools.js';
import { ContextManager } from '../../../llm/context-manager.js';
import { z } from 'zod';
import type { IpcMessage } from '../../../kernel/types.js';
import type { UserMessagePayload, DraftResponsePayload, FinalResponsePayload } from '../../../contracts/messaging.js';
import type { ReviewResult } from '../../../contracts/review.js';
import type { PermissionResultPayload, PermissionValidatePayload, PermissionConsumePayload } from '../../../contracts/permissions.js';
import type { ToolAuditPayload } from '../../../contracts/audit.js';
import type { MemoryContextFrame } from '../../../contracts/memory.js';
import type { TaskAcknowledgePayload, TaskStartedPayload } from '../../../contracts/tasks.js';
import type { DangerLevel } from '../../../tools/types.js';

const DEFAULT_SYSTEM_PROMPT = `你是 Berry，一个有记忆和学习能力的个人 AI 助手。回答要简洁、友好、准确。

## 核心原则

**对话优先**：大多数用户消息只需要文字回复，不需要调用任何工具。只有当用户**明确要求**执行操作（如"帮我创建文件"、"运行测试"、"查看目录"）时才使用工具。

## 上下文优先级

1. **当前对话历史优先**：用户在本次对话中提到的信息，直接从对话上下文引用，不要调用 memory_query。
2. **记忆工具用于跨会话信息**：只有当用户询问之前会话中的信息、个人偏好或长期知识时，才使用 memory_query 查询。
3. 判断标准：如果信息已经出现在当前对话的消息历史中，直接引用；如果没有出现过，再查记忆。

## 工具使用

你可以使用工具读取/写入文件、运行命令、发起网络请求。
**严格规则**：
- 日常聊天、问候、闲聊、情感表达 → 直接文字回复，禁止调用工具
- 只有用户明确请求文件操作、命令执行、信息查询时才使用工具
- 不确定时，优先用文字回复询问用户意图

始终使用用户正在使用的语言回答。`;

const MAX_SESSIONS = 64;

startResidentAgent(({ name, config, ipc, llm, db }) => {
  const memoryTools = createMemoryTools(ipc, config.requestTimeoutMs);
  const capabilityTools = createCapabilityTools(ipc, config.requestTimeoutMs);
  const currentSessionRef = { id: '' };
  const skillTools = createSkillTools(db, {
    onChange: () => ipc.send('skill.changed', 'core', {}),
    getSessionId: () => currentSessionRef.id || undefined,
    shellInjection: config.skills?.shellInjection ?? false,
  });
  const modelTools = createModelTools(ipc, currentSessionRef, config.requestTimeoutMs);
  clearDynamicTools([...memoryTools, ...capabilityTools, ...skillTools, ...modelTools].map((tool) => tool.name));
  for (const tool of [...memoryTools, ...capabilityTools, ...skillTools, ...modelTools]) {
    registerTool(tool);
  }

  const sessionHistories = new Map<string, ModelMessage[]>();
  const pendingDrafts = new Map<string, { sessionId: string; draft: string; toolCalls: ToolCallRecord[] }>();
  const tools = toModelTools(getToolRegistry());
  const contextManager = new ContextManager();

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
    const { sessionId, message, taskId, systemPrompt, contextFrames, modelTierOverride, intent } = msg.payload as UserMessagePayload;
    const trackingId = msg.correlationId ?? msg.id;
    currentSessionRef.id = sessionId;

    if (taskId) {
      ipc.send('task.acknowledge', 'core', { taskId } satisfies TaskAcknowledgePayload);
    }

    if (!sessionHistories.has(sessionId)) {
      if (sessionHistories.size >= MAX_SESSIONS) {
        const oldest = sessionHistories.keys().next().value!;
        sessionHistories.delete(oldest);
      }
      sessionHistories.set(sessionId, []);
    }
    const history = sessionHistories.get(sessionId)!;
    let priorHistory = [...history];

    if (contextManager.needsCompression(priorHistory)) {
      const compressed = await contextManager.compress(priorHistory, llm);
      sessionHistories.set(sessionId, compressed);
      priorHistory = [...compressed];
    }

    const memoryContext = formatMemoryContextFrames(contextFrames);
    const messageForModel = memoryContext ? `${memoryContext}\n\n${message}` : message;
    history.push({ role: 'user', content: message });

    if (taskId) {
      ipc.send('task.started', 'core', { taskId } satisfies TaskStartedPayload);
      ipc.send('task.progress', 'core', { taskId, summary: 'Conversation Agent 已开始生成回复' });
    }

    try {
      const streamingEnabled = config.streaming?.enabled !== false;
      const result = await runToolLoop({
        llm,
        messages: [...priorHistory, { role: 'user', content: messageForModel }],
        systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        tools,
        config: { maxCalls: Math.min(config.toolLoop.maxCalls, 10), timeoutMs: config.toolLoop.timeoutMs },
        onChunk: streamingEnabled ? (text: string) => {
          if (taskId) {
            ipc.send('task.telemetry', 'core', { kind: 'text_delta', taskId, text });
          }
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
        },
      });

      const draft = result.finalContent;
      pendingDrafts.set(trackingId, { sessionId, draft, toolCalls: result.toolCalls });

      ipc.send('draft.response', 'core', {
        sessionId,
        draft,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, input: tc.input, result: tc.result })),
      } satisfies DraftResponsePayload, trackingId);
    } catch (err) {
      const errorMsg = `抱歉，处理过程中发生错误: ${(err as Error).message}`;
      ipc.send('final.response', 'core', {
        sessionId,
        response: errorMsg,
        reviewVerdict: 'approve',
      } satisfies FinalResponsePayload, trackingId);
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

    ipc.send('final.response', 'core', {
      sessionId: pending.sessionId,
      response: finalResponse,
      reviewVerdict: review.verdict,
    } satisfies FinalResponsePayload, correlationId);
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
