import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from './opencode-adapter.js';

describe('OpenCodeAdapter', () => {
  const adapter = new OpenCodeAdapter('/usr/local/bin/opencode');

  describe('buildCommand', () => {
    it('builds basic command with prompt', () => {
      const spec = adapter.buildCommand({ prompt: 'Hello world' });
      expect(spec.cmd).toBe('/usr/local/bin/opencode');
      expect(spec.args).toContain('run');
      expect(spec.args).toContain('--format');
      expect(spec.args).toContain('json');
      expect(spec.args).toContain('Hello world');
    });

    it('includes model flag', () => {
      const spec = adapter.buildCommand({ prompt: 'test', model: 'gpt-4o' });
      expect(spec.args).toContain('--model');
      expect(spec.args).toContain('gpt-4o');
    });

    it('appends extraArgs before prompt', () => {
      const spec = adapter.buildCommand({ prompt: 'test', extraArgs: ['--no-color'] });
      const promptIdx = spec.args.indexOf('test');
      const extraIdx = spec.args.indexOf('--no-color');
      expect(extraIdx).toBeLessThan(promptIdx);
    });
  });

  describe('parseLine', () => {
    it('returns null for empty line', () => {
      expect(adapter.parseLine('')).toBeNull();
      expect(adapter.parseLine('   ')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(adapter.parseLine('not json at all')).toBeNull();
    });

    it('parses text event', () => {
      const line = JSON.stringify({
        type: 'text',
        timestamp: 1775116675833,
        sessionID: 'ses_abc',
        part: {
          id: 'prt_123',
          messageID: 'msg_456',
          sessionID: 'ses_abc',
          type: 'text',
          text: 'pong',
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'text',
        timestamp: 1775116675833,
        data: { kind: 'text', text: 'pong' },
      });
    });

    it('parses tool_use event with completed state (emits both call + result)', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        timestamp: 1775117187163,
        sessionID: 'ses_abc',
        part: {
          id: 'prt_123',
          messageID: 'msg_456',
          sessionID: 'ses_abc',
          type: 'tool',
          tool: 'bash',
          callID: 'call_BHA1',
          state: {
            status: 'completed',
            input: { command: 'pwd', description: 'Prints current working directory path' },
            output: '/tmp/multica\n',
          },
        },
      });
      const events = adapter.parseLine(line);
      expect(Array.isArray(events)).toBe(true);
      const arr = events as any[];
      expect(arr).toHaveLength(2);

      expect(arr[0]).toMatchObject({
        kind: 'tool_call',
        data: {
          kind: 'tool_call',
          toolName: 'bash',
          callId: 'call_BHA1',
          input: { command: 'pwd', description: 'Prints current working directory path' },
        },
      });

      expect(arr[1]).toMatchObject({
        kind: 'tool_result',
        data: {
          kind: 'tool_result',
          callId: 'call_BHA1',
          output: '/tmp/multica\n',
          success: true,
        },
      });
    });

    it('parses tool_use event with failed state', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        timestamp: 1775117200000,
        sessionID: 'ses_abc',
        part: {
          tool: 'bash',
          callID: 'call_FAIL',
          state: {
            status: 'failed',
            input: { command: 'rm -rf /' },
            output: 'Permission denied',
          },
        },
      });
      const events = adapter.parseLine(line);
      expect(Array.isArray(events)).toBe(true);
      const arr = events as any[];
      expect(arr).toHaveLength(2);
      expect(arr[1].data.success).toBe(false);
      expect(arr[1].data.output).toBe('Permission denied');
    });

    it('parses tool_use event with only input (pending state)', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        timestamp: 1775117187000,
        sessionID: 'ses_abc',
        part: {
          tool: 'read',
          callID: 'call_READ',
          state: {
            status: 'pending',
            input: { path: '/tmp/file.txt' },
          },
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'tool_call',
        data: { kind: 'tool_call', toolName: 'read', callId: 'call_READ' },
      });
    });

    it('parses error event', () => {
      const line = JSON.stringify({
        type: 'error',
        timestamp: 1775117233612,
        sessionID: 'ses_abc',
        error: {
          name: 'UnknownError',
          data: { message: 'Model not found: definitely/not-a-model.' },
        },
        part: {},
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'error',
        data: { kind: 'error', message: 'Model not found: definitely/not-a-model.' },
      });
    });

    it('parses error event with only name (no data)', () => {
      const line = JSON.stringify({
        type: 'error',
        timestamp: 1775117233612,
        sessionID: 'ses_abc',
        error: { name: 'ConnectionTimeout' },
        part: {},
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'error',
        data: { kind: 'error', message: 'ConnectionTimeout' },
      });
    });

    it('parses step_finish with token usage', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        timestamp: 1775116676180,
        sessionID: 'ses_abc',
        part: {
          id: 'prt_789',
          reason: 'stop',
          messageID: 'msg_456',
          sessionID: 'ses_abc',
          type: 'step-finish',
          tokens: {
            total: 14674,
            input: 14585,
            output: 89,
            reasoning: 82,
            cache: { write: 200, read: 1000 },
          },
        },
      });
      const event = adapter.parseLine(line);
      expect(event).toMatchObject({
        kind: 'usage',
        timestamp: 1775116676180,
        data: {
          kind: 'usage',
          inputTokens: 14585,
          outputTokens: 89,
          cacheReadTokens: 1000,
          cacheWriteTokens: 200,
        },
      });
    });

    it('returns null for step_finish without tokens', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        timestamp: 1775116676180,
        sessionID: 'ses_abc',
        part: { id: 'prt_789', type: 'step-finish' },
      });
      expect(adapter.parseLine(line)).toBeNull();
    });

    it('parses step_start and captures session ID', () => {
      const fresh = new OpenCodeAdapter('/usr/local/bin/opencode');
      const line = JSON.stringify({
        type: 'step_start',
        timestamp: 1775116675819,
        sessionID: 'ses_new',
        part: { id: 'prt_123', type: 'step-start' },
      });
      const event = fresh.parseLine(line);
      expect(event).toMatchObject({
        kind: 'session_start',
        data: { kind: 'session_start', sessionId: 'ses_new' },
      });
      expect(fresh.extractSessionId()).toBe('ses_new');
    });

    it('step_start returns null if session already known', () => {
      const fresh = new OpenCodeAdapter('/usr/local/bin/opencode');
      fresh.parseLine(JSON.stringify({
        type: 'step_start',
        timestamp: 1000,
        sessionID: 'ses_first',
        part: { type: 'step-start' },
      }));

      const second = fresh.parseLine(JSON.stringify({
        type: 'step_start',
        timestamp: 2000,
        sessionID: 'ses_first',
        part: { type: 'step-start' },
      }));
      expect(second).toBeNull();
    });

    it('returns null for tool_use without tool or callID', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        timestamp: 1000,
        sessionID: 'ses_abc',
        part: { state: { status: 'completed', input: {}, output: '' } },
      });
      expect(adapter.parseLine(line)).toBeNull();
    });
  });

  describe('extractSessionId', () => {
    it('returns undefined initially', () => {
      const fresh = new OpenCodeAdapter('/usr/local/bin/opencode');
      expect(fresh.extractSessionId()).toBeUndefined();
    });

    it('captures from text event sessionID field', () => {
      const fresh = new OpenCodeAdapter('/usr/local/bin/opencode');
      fresh.parseLine(JSON.stringify({
        type: 'text',
        timestamp: 1000,
        sessionID: 'ses_from_text',
        part: { text: 'hello' },
      }));
      expect(fresh.extractSessionId()).toBe('ses_from_text');
    });
  });
});
