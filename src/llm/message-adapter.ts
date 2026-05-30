import type {
  ModelMessage,
  ModelContentBlock,
  ModelToolDef,
  ModelToolCall,
  ModelStopReason,
  ModelUsage,
} from '../contracts/model.js';
import type {
  ModelMessage as AiModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from '@ai-sdk/provider-utils';
import { jsonSchema, tool, type JSONSchema7 } from 'ai';
import type { ToolSet, FinishReason, LanguageModelUsage } from 'ai';

// ==========================================
// ModelMessage[] → AI SDK ModelMessage[]
// ==========================================

export function toAiMessages(messages: ModelMessage[]): AiModelMessage[] {
  // Build toolUseId → toolName lookup from all assistant messages
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          toolNameMap.set(block.id, block.name);
        }
      }
    }
  }

  const result: AiModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : blocksToText(msg.content) });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        // Check if this is a tool_result message (user role with tool results in Anthropic format)
        const toolResults = msg.content.filter((b): b is Extract<ModelContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
        const textBlocks = msg.content.filter((b): b is Extract<ModelContentBlock, { type: 'text' }> => b.type === 'text');

        if (toolResults.length > 0) {
          const parts: ToolResultPart[] = toolResults.map((tr) => ({
            type: 'tool-result' as const,
            toolCallId: tr.toolUseId,
            toolName: toolNameMap.get(tr.toolUseId) ?? 'unknown',
            output: tr.isError
              ? { type: 'error-text' as const, value: tr.content }
              : { type: 'text' as const, value: tr.content },
          }));
          result.push({ role: 'tool', content: parts });
        }
        if (textBlocks.length > 0) {
          const parts: TextPart[] = textBlocks.map((t) => ({ type: 'text' as const, text: t.text }));
          result.push({ role: 'user', content: parts });
        }
        if (toolResults.length === 0 && textBlocks.length === 0) {
          result.push({ role: 'user', content: blocksToText(msg.content) });
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        const parts: Array<TextPart | ToolCallPart> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({
              type: 'tool-call',
              toolCallId: block.id,
              toolName: block.name,
              input: block.input,
            });
          }
        }
        result.push({ role: 'assistant', content: parts.length > 0 ? parts : '' });
      }
      continue;
    }
  }

  return result;
}

// ==========================================
// AI SDK result → ChatResult fields
// ==========================================

export function mapFinishReason(reason: FinishReason): ModelStopReason {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool-calls': return 'tool_use';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}

export function mapUsage(usage: LanguageModelUsage): ModelUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
    cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
  };
}

export interface AiSdkToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export function mapToolCalls(toolCalls: AiSdkToolCall[]): ModelToolCall[] {
  return toolCalls.map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    input: tc.input,
  }));
}

export function buildContentBlocks(
  text: string,
  toolCalls: AiSdkToolCall[],
  reasoning?: string,
): ModelContentBlock[] {
  const blocks: ModelContentBlock[] = [];
  if (reasoning) {
    blocks.push({ type: 'thinking', thinking: reasoning, signature: '' });
  }
  if (text) {
    blocks.push({ type: 'text', text });
  }
  for (const tc of toolCalls) {
    blocks.push({ type: 'tool_use', id: tc.toolCallId, name: tc.toolName, input: tc.input });
  }
  return blocks;
}

// ==========================================
// ModelToolDef[] → AI SDK ToolSet (no execute)
// ==========================================

export function toAiTools(tools: ModelToolDef[]): ToolSet {
  const result: ToolSet = {};
  for (const t of tools) {
    result[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
    });
  }
  return result;
}

// ==========================================
// Helpers
// ==========================================

function blocksToText(blocks: ModelContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ModelContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
