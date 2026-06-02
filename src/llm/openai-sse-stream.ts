import type { StreamChunk } from './contract.js';
import type { ModelResponse, ModelContentBlock } from '../contracts/model.js';

export interface OpenAIStreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
}

function buildMessages(opts: OpenAIStreamOptions): Array<Record<string, unknown>> {
  const msgs: Array<Record<string, unknown>> = [];
  if (opts.system) {
    msgs.push({ role: 'system', content: opts.system });
  }
  for (const m of opts.messages) {
    if (typeof m.content === 'string') {
      msgs.push({ role: m.role, content: m.content });
      continue;
    }

    // Array content: convert Berry's internal format to OpenAI format
    const blocks = m.content as Array<Record<string, unknown>>;

    if (m.role === 'assistant') {
      // Extract text content (skip thinking blocks)
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text as string);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id as string,
            type: 'function',
            function: {
              name: block.name as string,
              arguments: typeof block.input === 'string' ? block.input as string : JSON.stringify(block.input),
            },
          });
        }
        // 'thinking' blocks are stripped — OpenAI API doesn't support them in history
      }

      const msg: Record<string, unknown> = { role: 'assistant' };
      msg.content = textParts.length > 0 ? textParts.join('') : null;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      msgs.push(msg);
    } else if (m.role === 'user') {
      // User messages may contain tool_result blocks → convert to tool role messages
      const textParts: string[] = [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          msgs.push({
            role: 'tool',
            tool_call_id: block.toolUseId ?? block.tool_use_id ?? '',
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          });
        } else if (block.type === 'text' && block.text) {
          textParts.push(block.text as string);
        }
      }
      if (textParts.length > 0) {
        msgs.push({ role: 'user', content: textParts.join('') });
      }
    } else {
      // Other roles: flatten to string
      const text = blocks
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text as string)
        .join('');
      msgs.push({ role: m.role, content: text || '' });
    }
  }
  return msgs;
}

interface SSEDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  role?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface SSEChoice {
  index: number;
  delta?: SSEDelta;
  finish_reason?: string | null;
}

interface SSEChunk {
  id?: string;
  choices?: SSEChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export async function* streamOpenAICompatible(opts: OpenAIStreamOptions): AsyncGenerator<StreamChunk> {
  let baseUrl = opts.baseUrl.replace(/\/$/, '');
  if (!baseUrl.match(/\/v\d+$/)) baseUrl += '/v1';
  const url = `${baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: buildMessages(opts),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.stopSequences?.length) body.stop = opts.stopSequences;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI-compatible API error ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const contentBlocks: ModelContentBlock[] = [];
  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
  let reasoningText = '';
  let contentText = '';
  let finishReason: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let reasoningStarted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let chunk: SSEChunk;
        try { chunk = JSON.parse(payload); } catch { continue; }

        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
          usage.outputTokens = chunk.usage.completion_tokens ?? 0;
          usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }

        const choice = chunk.choices?.[0];
        if (!choice?.delta) continue;
        const delta = choice.delta;

        // Reasoning: support both reasoning_content (DeepSeek/MiMo/GLM) and reasoning (OpenRouter)
        const rc = delta.reasoning_content ?? delta.reasoning;
        if (rc != null && rc !== '') {
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield { type: 'reasoning_start' };
          }
          reasoningText += rc;
          yield { type: 'reasoning_delta', text: rc };
        }

        // Text content — emit reasoning_end on first content after reasoning
        if (delta.content != null && delta.content !== '') {
          if (reasoningStarted) {
            reasoningStarted = false;
            yield { type: 'reasoning_end' };
          }
          contentText += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }

        // Tool calls
        if (delta.tool_calls) {
          if (reasoningStarted) {
            reasoningStarted = false;
            yield { type: 'reasoning_end' };
          }
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (tc.id && tc.function?.name) {
              toolBuffers.set(idx, { id: tc.id, name: tc.function.name, args: '' });
              yield { type: 'tool_use_start', id: tc.id, name: tc.function.name };
            }
            if (tc.function?.arguments) {
              const buf = toolBuffers.get(idx);
              if (buf) {
                buf.args += tc.function.arguments;
                yield { type: 'tool_use_delta', id: buf.id, partialJson: tc.function.arguments };
              }
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Close reasoning if stream ended while still in reasoning mode
  if (reasoningStarted) {
    yield { type: 'reasoning_end' };
  }

  // Finalize tool use blocks
  for (const [, buf] of toolBuffers) {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(buf.args || '{}'); } catch {}
    contentBlocks.push({ type: 'tool_use', id: buf.id, name: buf.name, input });
    yield { type: 'tool_use_done', id: buf.id, input };
    yield { type: 'content_block_stop' };
  }

  // Build final content blocks
  if (reasoningText) {
    contentBlocks.unshift({ type: 'thinking', thinking: reasoningText, signature: '' });
  }
  if (contentText) {
    contentBlocks.push({ type: 'text', text: contentText });
  }

  const stopReason = finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'stop' ? 'end_turn'
    : finishReason === 'length' ? 'max_tokens'
    : 'end_turn';

  const modelResponse: ModelResponse = {
    requestId: '',
    content: contentText,
    contentBlocks,
    toolCalls: [...toolBuffers.values()].map(b => {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(b.args || '{}'); } catch {}
      return { id: b.id, name: b.name, input };
    }),
    stopReason: stopReason as ModelResponse['stopReason'],
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: 0 },
    model: opts.model,
  };

  yield { type: 'message_done', response: modelResponse };
}

// === Non-streaming chat ===

export interface OpenAIChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
}

export async function chatOpenAICompatible(opts: OpenAIChatOptions): Promise<ModelResponse> {
  let baseUrl = opts.baseUrl.replace(/\/$/, '');
  if (!baseUrl.match(/\/v\d+$/)) baseUrl += '/v1';
  const url = `${baseUrl}/chat/completions`;

  const msgs = buildMessages(opts as unknown as OpenAIStreamOptions);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: msgs,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.stopSequences?.length) body.stop = opts.stopSequences;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI-compatible API error ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  };

  const choice = data.choices?.[0];
  const msg = choice?.message;
  const contentText = msg?.content ?? '';
  const reasoningText = msg?.reasoning_content ?? msg?.reasoning ?? '';
  const finishReason = choice?.finish_reason;

  const contentBlocks: ModelContentBlock[] = [];
  if (reasoningText) contentBlocks.push({ type: 'thinking', thinking: reasoningText, signature: '' });
  if (contentText) contentBlocks.push({ type: 'text', text: contentText });

  const toolCalls = (msg?.tool_calls ?? []).map(tc => {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
    contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    return { id: tc.id, name: tc.function.name, input };
  });

  const stopReason = finishReason === 'tool_calls' ? 'tool_use'
    : finishReason === 'stop' ? 'end_turn'
    : finishReason === 'length' ? 'max_tokens'
    : 'end_turn';

  return {
    requestId: '',
    content: contentText,
    contentBlocks,
    toolCalls,
    stopReason: stopReason as ModelResponse['stopReason'],
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreationTokens: 0,
    },
    model: opts.model,
    reasoning: reasoningText || undefined,
  };
}
