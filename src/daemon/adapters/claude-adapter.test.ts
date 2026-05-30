import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from './claude-adapter.js';

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter('/usr/local/bin/claude');

  describe('buildCommand', () => {
    it('builds basic command with prompt', () => {
      const spec = adapter.buildCommand({ prompt: 'Hello world' });
      expect(spec.cmd).toBe('/usr/local/bin/claude');
      expect(spec.args).toContain('--output-format');
      expect(spec.args).toContain('stream-json');
      expect(spec.args).toContain('-p');
      expect(spec.args).toContain('Hello world');
    });

    it('includes model flag when specified', () => {
      const spec = adapter.buildCommand({ prompt: 'test', model: 'claude-sonnet-4-5-20250514' });
      expect(spec.args).toContain('--model');
      expect(spec.args).toContain('claude-sonnet-4-5-20250514');
    });

    it('includes --continue for session resume', () => {
      const spec = adapter.buildCommand({ prompt: 'test', resumeSessionId: 'sess-abc123' });
      expect(spec.args).toContain('--continue');
      expect(spec.args).toContain('sess-abc123');
    });

    it('includes max-turns', () => {
      const spec = adapter.buildCommand({ prompt: 'test', maxTurns: 5 });
      expect(spec.args).toContain('--max-turns');
      expect(spec.args).toContain('5');
    });

    it('appends extraArgs', () => {
      const spec = adapter.buildCommand({ prompt: 'test', extraArgs: ['--allowedTools', 'Read,Write'] });
      expect(spec.args).toContain('--allowedTools');
      expect(spec.args).toContain('Read,Write');
    });
  });

  describe('parseLine', () => {
    it('returns null for empty line', () => {
      expect(adapter.parseLine('')).toBeNull();
      expect(adapter.parseLine('   ')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(adapter.parseLine('not json')).toBeNull();
    });

    it('parses system event with session_id', () => {
      const line = '{"type":"system","session_id":"sess-abc123"}';
      const event = adapter.parseLine(line);
      expect(event).not.toBeNull();
      expect(event).toMatchObject({
        kind: 'session_start',
        data: { kind: 'session_start', sessionId: 'sess-abc123' },
      });
    });

    it('parses assistant text message', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250514',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'text',
        data: { kind: 'text', text: 'Hello world' },
      });
    });

    it('parses assistant thinking block', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', text: 'Let me think...' }],
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'thinking',
        data: { kind: 'thinking', text: 'Let me think...' },
      });
    });

    it('parses assistant tool_use block', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: '/tmp/foo' } }],
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'tool_call',
        data: { kind: 'tool_call', toolName: 'Read', callId: 'call-1', input: { path: '/tmp/foo' } },
      });
    });

    it('parses multiple content blocks as array', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will read the file.' },
            { type: 'tool_use', id: 'call-2', name: 'Read', input: { path: '/tmp/bar' } },
          ],
        },
      });
      const events = adapter.parseLine(line);
      expect(Array.isArray(events)).toBe(true);
      expect(events).toHaveLength(2);
      expect((events as any[])[0].kind).toBe('text');
      expect((events as any[])[1].kind).toBe('tool_call');
    });

    it('parses user tool_result block', () => {
      const line = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file contents here' }],
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'tool_result',
        data: { kind: 'tool_result', callId: 'call-1', output: 'file contents here', success: true },
      });
    });

    it('parses result event with modelUsage', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-final',
        result: 'Task completed successfully',
        modelUsage: {
          'claude-sonnet-4-5-20250514': {
            inputTokens: 1200,
            outputTokens: 450,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
          },
        },
      });
      const events = adapter.parseLine(line);
      expect(Array.isArray(events)).toBe(true);
      const arr = events as any[];
      expect(arr).toHaveLength(2);

      expect(arr[0]).toMatchObject({
        kind: 'usage',
        data: {
          kind: 'usage',
          model: 'claude-sonnet-4-5-20250514',
          inputTokens: 1200,
          outputTokens: 450,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
        },
      });

      expect(arr[1]).toMatchObject({
        kind: 'completion',
        data: {
          kind: 'completion',
          text: 'Task completed successfully',
          success: true,
          sessionId: 'sess-final',
        },
      });
    });

    it('parses error result event', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Something went wrong',
        session_id: 'sess-err',
      });
      const events = adapter.parseLine(line);
      expect(Array.isArray(events)).toBe(true);
      const arr = events as any[];
      const completion = arr.find((e: any) => e.kind === 'completion');
      expect(completion.data.success).toBe(false);
    });

    it('ignores log events', () => {
      const line = JSON.stringify({
        type: 'log',
        log: { level: 'info', message: 'Starting task' },
      });
      expect(adapter.parseLine(line)).toBeNull();
    });
  });

  describe('extractSessionId', () => {
    it('returns session ID from system event', () => {
      const fresh = new ClaudeAdapter('/usr/local/bin/claude');
      expect(fresh.extractSessionId()).toBeUndefined();

      fresh.parseLine('{"type":"system","session_id":"sess-xyz"}');
      expect(fresh.extractSessionId()).toBe('sess-xyz');
    });

    it('updates session ID from result event', () => {
      const fresh = new ClaudeAdapter('/usr/local/bin/claude');
      fresh.parseLine('{"type":"system","session_id":"sess-1"}');
      fresh.parseLine(JSON.stringify({
        type: 'result',
        is_error: false,
        session_id: 'sess-2',
        result: 'done',
      }));
      expect(fresh.extractSessionId()).toBe('sess-2');
    });
  });
});
