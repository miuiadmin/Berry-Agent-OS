import type { RuntimeAdapter, CommandSpec } from './types.js';
import type { NormalizedExternalEvent } from '../../contracts/daemon-events.js';
import type { DaemonTaskInput } from '../../contracts/daemon-protocol.js';

const MAX_SESSION_ID_LEN = 256;
const MAX_OUTPUT_LEN = 500_000;

interface OpenCodeToolState {
  status: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

interface OpenCodePart {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: OpenCodeToolState;
  tokens?: { input: number; output: number; cache?: { read: number; write: number } };
}

interface OpenCodeEvent {
  type: 'step_start' | 'text' | 'tool_use' | 'error' | 'step_finish';
  timestamp?: number;
  sessionID?: string;
  part: OpenCodePart;
  error?: { name?: string; data?: { message?: string } };
}

export class OpenCodeAdapter implements RuntimeAdapter {
  readonly name = 'opencode';
  private sessionId: string | undefined;
  private command: string;

  constructor(command: string) {
    this.command = command;
  }

  buildCommand(input: DaemonTaskInput): CommandSpec {
    const args = [
      'run',
      '--format', 'json',
      '--dangerously-skip-permissions',
    ];

    if (input.model) {
      args.push('--model', input.model);
    }
    if (input.extraArgs) {
      args.push(...input.extraArgs);
    }

    args.push(input.prompt);

    const env: Record<string, string> = {};

    return { cmd: this.command, args, env };
  }

  parseLine(line: string): NormalizedExternalEvent | NormalizedExternalEvent[] | null {
    if (!line.trim()) return null;

    let event: OpenCodeEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }

    const ts = event.timestamp ?? Date.now();
    const isFirstSession = !this.sessionId && !!event.sessionID;

    if (event.sessionID && !this.sessionId && event.sessionID.length <= MAX_SESSION_ID_LEN) {
      this.sessionId = event.sessionID;
    }

    switch (event.type) {
      case 'step_start':
        if (isFirstSession && event.sessionID) {
          return { kind: 'session_start', timestamp: ts, data: { kind: 'session_start', sessionId: event.sessionID } };
        }
        return null;

      case 'text':
        if (event.part.text) {
          return { kind: 'text', timestamp: ts, data: { kind: 'text', text: event.part.text } };
        }
        return null;

      case 'tool_use':
        return this.parseToolUse(event.part, ts);

      case 'error':
        return {
          kind: 'error',
          timestamp: ts,
          data: { kind: 'error', message: event.error?.data?.message ?? event.error?.name ?? 'Unknown error' },
        };

      case 'step_finish':
        return this.parseStepFinish(event.part, ts);

      default:
        return null;
    }
  }

  extractSessionId(): string | undefined {
    return this.sessionId;
  }

  private parseToolUse(part: OpenCodePart, ts: number): NormalizedExternalEvent | NormalizedExternalEvent[] | null {
    if (!part.tool || !part.callID) return null;

    const events: NormalizedExternalEvent[] = [];

    if (part.state?.input) {
      events.push({
        kind: 'tool_call',
        timestamp: ts,
        data: { kind: 'tool_call', toolName: part.tool, callId: part.callID, input: part.state.input },
      });
    }

    if (part.state?.status === 'completed' && part.state.output !== undefined) {
      let output = typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output);
      if (output.length > MAX_OUTPUT_LEN) output = output.slice(0, MAX_OUTPUT_LEN);
      events.push({
        kind: 'tool_result',
        timestamp: ts,
        data: { kind: 'tool_result', callId: part.callID, output, success: true },
      });
    } else if (part.state?.status === 'failed') {
      let output = typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output ?? '');
      if (output.length > MAX_OUTPUT_LEN) output = output.slice(0, MAX_OUTPUT_LEN);
      events.push({
        kind: 'tool_result',
        timestamp: ts,
        data: { kind: 'tool_result', callId: part.callID, output, success: false },
      });
    }

    if (events.length === 0) return null;
    if (events.length === 1) return events[0];
    return events;
  }

  private parseStepFinish(part: OpenCodePart, ts: number): NormalizedExternalEvent | null {
    if (!part.tokens) return null;

    return {
      kind: 'usage',
      timestamp: ts,
      data: {
        kind: 'usage',
        inputTokens: part.tokens.input,
        outputTokens: part.tokens.output,
        cacheReadTokens: part.tokens.cache?.read,
        cacheWriteTokens: part.tokens.cache?.write,
      },
    };
  }
}
