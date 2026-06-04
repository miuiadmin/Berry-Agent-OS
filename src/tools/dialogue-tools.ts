/**
 * dialogue 工具 — Conversation Agent 与其他 Agent 进行多轮对话的工具。
 *
 * 设计：
 * - 每次调用 = 一轮对话（发消息 + 等回复）
 * - 取消机制通过外部传入的 AbortSignal（session 级别）自然贯通
 * - 无模块级可变状态，所有状态由闭包作用域持有
 */

import type { ToolDefinition, ToolResult } from './types.js';
import type { IpcChildChannel } from '../kernel/ipc.js';
import type { IpcMessage } from '../kernel/types.js';
import type { DialogueMessagePayload, DialogueToolInput } from '../contracts/dialogue.js';
import { DIALOGUE_DEFAULTS } from '../contracts/dialogue.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { z } from 'zod';

const logger = getLogger('dialogue-tools');

/**
 * 创建 dialogue 工具集。
 *
 * @param ipc Conversation Agent 的 IPC 通道
 * @param getSignal 获取当前 session 的 AbortSignal（由 conversation entry 通过闭包提供）
 * @param getCorrelationId 获取当前请求的 correlationId（让 Kernel 能通过它找到 pending socket）
 */
export function createDialogueTools(
  ipc: IpcChildChannel,
  getSignal: () => AbortSignal | undefined,
  getCorrelationId: () => string | undefined,
): ToolDefinition[] {
  /** 等待 dialogue.reply 的 pending（dialogueId → resolve/reject），闭包作用域内，非全局 */
  const pendingReplies = new Map<string, {
    resolve: (payload: DialogueMessagePayload) => void;
    reject: (err: Error) => void;
  }>();

  // 注册 dialogue.reply handler（Kernel 转发来的目标 Agent 回复）
  ipc.onMessage('dialogue.reply', (msg: IpcMessage) => {
    const payload = msg.payload as DialogueMessagePayload;
    const pending = pendingReplies.get(payload.dialogueId);
    if (pending) {
      pendingReplies.delete(payload.dialogueId);
      pending.resolve(payload);
    }
  });

  const dialogueTool: ToolDefinition = {
    name: 'dialogue',
    description: '与其他智能体进行对话式协作。发送一条消息给目标智能体并等待回复。用于需要多轮交互的复杂任务（如编码、分析）。可在同一轮调用多次以并行询问不同目标 agent。',
    dangerLevel: 'safe',
    parallelizable: true,
    inputSchema: z.object({
      target: z.string().describe('目标智能体名称。可用：code（编码）、learning（记忆学习）'),
      message: z.string().describe('要发送的消息内容。应包含足够的上下文让目标智能体理解任务。'),
      context: z.record(z.string(), z.unknown()).optional().describe('可选：附加上下文信息'),
      dialogueId: z.string().optional().describe('可选：已有对话的 ID。首次对话不传，后续追问时传入以续接同一对话。'),
    }),
    execute: async (input: unknown): Promise<ToolResult> => {
      const { target, message, context, dialogueId: existingId } = input as DialogueToolInput;
      const dialogueId = existingId || genId('dlg');
      const signal = getSignal();

      try {
        const msg: DialogueMessagePayload = {
          dialogueId,
          sequenceNumber: -1, // Kernel 统一分配
          from: 'conversation',
          to: target,
          content: message,
          context,
        };

        // 用请求的 correlationId 作为 IPC correlationId，使 Kernel 能找到对应的 pending socket
        ipc.send('dialogue.send', 'core', msg, getCorrelationId() ?? dialogueId);

        const reply = await waitForReply(dialogueId, signal, pendingReplies);

        let content = reply.content;
        if (content.length > DIALOGUE_DEFAULTS.maxReplyChars) {
          content = content.slice(0, DIALOGUE_DEFAULTS.maxReplyChars) + '\n\n[... 回复已截断]';
        }

        const parts = [`[dialogue:${target}] ${content}`];
        if (reply.metadata?.needsClarification) parts.push('\n[需要澄清 — 可以追问或向用户确认]');
        parts.push(reply.metadata?.isFinal
          ? `\n[对话完成 — dialogueId: ${dialogueId}]`
          : `\n[dialogueId: ${dialogueId} — 可继续追问]`);

        return { content: parts.join('') };
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          return { content: `[dialogue:${target}] 对话被中断`, isError: true };
        }
        logger.error({ err, dialogueId, target }, 'dialogue:tool error');
        // 超时错误给出可操作建议，让 LLM 能自主决策而不是卡死
        const isTimeout = error.message.includes('timeout') || error.message.includes('closed');
        const hint = isTimeout
          ? `目标智能体 ${target} 响应超时。建议：直接用现有信息回复用户，或尝试用其他工具（如 write_file）自行完成任务。`
          : error.message;
        return { content: `[dialogue:${target}] 错误: ${hint}`, isError: true };
      }
    },
  };

  return [dialogueTool];
}

/** 等待 reply，同时监听超时和外部 signal */
function waitForReply(
  dialogueId: string,
  signal: AbortSignal | undefined,
  pendingReplies: Map<string, { resolve: (p: DialogueMessagePayload) => void; reject: (e: Error) => void }>,
): Promise<DialogueMessagePayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('dialogue reply timeout'));
    }, DIALOGUE_DEFAULTS.replyTimeoutMs);
    timer.unref();

    const onAbort = () => {
      cleanup();
      const err = new Error('dialogue aborted');
      err.name = 'AbortError';
      reject(err);
    };

    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pendingReplies.delete(dialogueId);
    }

    pendingReplies.set(dialogueId, {
      resolve: (payload) => { cleanup(); resolve(payload); },
      reject: (err) => { cleanup(); reject(err); },
    });
  });
}
