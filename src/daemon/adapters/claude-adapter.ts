import type { RuntimeAdapter, CommandSpec } from './types.js';
import type { NormalizedExternalEvent } from '../../contracts/daemon-events.js';
import type { DaemonTaskInput } from '../../contracts/daemon-protocol.js';

const MAX_SESSION_ID_LEN = 256;
const MAX_OUTPUT_LEN = 500_000;

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeMessage {
  role: string;
  model?: string;
  content: ClaudeContentBlock[];
}

interface ClaudeSDKEvent {
  type: 'assistant' | 'user' | 'system' | 'result' | 'log';
  message?: ClaudeMessage;
  session_id?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
  log?: { level: string; message: string };
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude-code';
  private sessionId: string | undefined;
  private command: string;

  constructor(command: string) {
    this.command = command;
  }

  buildCommand(input: DaemonTaskInput): CommandSpec {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '-p', input.prompt,
    ];

    if (input.model) {
      args.push('--model', input.model);
    }
    if (input.resumeSessionId) {
      args.push('--continue', input.resumeSessionId);
    }
    if (input.maxTurns) {
      args.push('--max-turns', String(input.maxTurns));
    }
    if (input.systemPrompt) {
      args.push('--system-prompt', input.systemPrompt);
    }
    if (input.extraArgs) {
      args.push(...input.extraArgs);
    }

    const env: Record<string, string> = {};
    if (input.cwd) {
      env.CLAUDE_CWD = input.cwd;
    }

    return { cmd: this.command, args, env };
  }

  parseLine(line: string): NormalizedExternalEvent | NormalizedExternalEvent[] | null {
    if (!line.trim()) return null;

    let event: ClaudeSDKEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    const now = Date.now();

    switch (event.type) {
      case 'system':
        if (event.session_id && event.session_id.length <= MAX_SESSION_ID_LEN) {
          this.sessionId = event.session_id;
          return { kind: 'session_start', timestamp: now, data: { kind: 'session_start', sessionId: event.session_id } };
        }
        return null;

      case 'assistant':
        return this.parseAssistantMessage(event.message, now);

      case 'user':
        return this.parseUserMessage(event.message, now);

      case 'result':
        return this.parseResult(event, now);

      case 'log':
        return null;

      default:
        return null;
    }
  }

  extractSessionId(): string | undefined {
    return this.sessionId;
  }

  private parseAssistantMessage(message: ClaudeMessage | undefined, ts: number): NormalizedExternalEvent | NormalizedExternalEvent[] | null {
    if (!message?.content) return null;

    const events: NormalizedExternalEvent[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            events.push({ kind: 'text', timestamp: ts, data: { kind: 'text', text: block.text } });
          }
          break;
        case 'thinking':
          if (block.text) {
            events.push({ kind: 'thinking', timestamp: ts, data: { kind: 'thinking', text: block.text } });
          }
          break;
        case 'tool_use':
          if (block.id && block.name) {
            events.push({
              kind: 'tool_call',
              timestamp: ts,
              data: { kind: 'tool_call', toolName: block.name, callId: block.id, input: block.input ?? {} },
            });
          }
          break;
      }
    }

    if (events.length === 0) return null;
    if (events.length === 1) return events[0];
    return events;
  }

  private parseUserMessage(message: ClaudeMessage | undefined, ts: number): NormalizedExternalEvent | NormalizedExternalEvent[] | null {
    if (!message?.content) return null;

    const events: NormalizedExternalEvent[] = [];

    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        let output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        if (output.length > MAX_OUTPUT_LEN) output = output.slice(0, MAX_OUTPUT_LEN);
        events.push({
          kind: 'tool_result',
          timestamp: ts,
          data: { kind: 'tool_result', callId: block.tool_use_id, output, success: true },
        });
      }
    }

    if (events.length === 0) return null;
    if (events.length === 1) return events[0];
    return events;
  }

  private parseResult(event: ClaudeSDKEvent, ts: number): NormalizedExternalEvent[] {
    const events: NormalizedExternalEvent[] = [];

    if (event.session_id) {
      this.sessionId = event.session_id;
    }

    if (event.modelUsage) {
      for (const [model, usage] of Object.entries(event.modelUsage)) {
        events.push({
          kind: 'usage',
          timestamp: ts,
          data: {
            kind: 'usage',
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadInputTokens,
            cacheWriteTokens: usage.cacheCreationInputTokens,
          },
        });
      }
    }

    events.push({
      kind: 'completion',
      timestamp: ts,
      data: {
        kind: 'completion',
        text: event.result ?? '',
        success: !event.is_error,
        sessionId: event.session_id,
      },
    });

    return events;
  }
}
