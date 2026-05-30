import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRecorder, SessionReplayer, type SessionRecording } from './session-recorder.js';
import type { PendingModelRequest } from './model-takeover.js';

describe('SessionRecorder', () => {
  let recorder: SessionRecorder;

  beforeEach(() => {
    recorder = new SessionRecorder('test-session');
  });

  it('records exchanges when recording', () => {
    recorder.start();

    const req: PendingModelRequest = {
      requestId: 'req-1',
      agent: 'brain',
      purpose: 'routing',
      messages: [{ role: 'user', content: 'hello' }],
      promptHash: 'abc123',
      receivedAt: Date.now(),
    };

    recorder.recordExchange(req, 'response content');

    const recording = recorder.stop();
    expect(recording.sessionId).toBe('test-session');
    expect(recording.exchanges).toHaveLength(1);
    expect(recording.exchanges[0].response).toBe('response content');
    expect(recording.exchanges[0].agent).toBe('brain');
  });

  it('does not record when not started', () => {
    const req: PendingModelRequest = {
      requestId: 'req-1',
      agent: 'brain',
      purpose: 'routing',
      messages: [],
      promptHash: 'abc',
      receivedAt: Date.now(),
    };

    recorder.recordExchange(req, 'ignored');
    recorder.start();
    const recording = recorder.stop();
    expect(recording.exchanges).toHaveLength(0);
  });

  it('stop returns recording and stops further recording', () => {
    recorder.start();
    const recording = recorder.stop();
    expect(recording.recordedAt).toBeGreaterThan(0);

    const req: PendingModelRequest = {
      requestId: 'req-2',
      agent: 'code',
      purpose: 'task',
      messages: [],
      promptHash: 'def',
      receivedAt: Date.now(),
    };
    recorder.recordExchange(req, 'after stop');

    recorder.start();
    const fresh = recorder.stop();
    expect(fresh.exchanges).toHaveLength(0);
  });
});

describe('SessionReplayer', () => {
  const recording: SessionRecording = {
    sessionId: 'replay-session',
    exchanges: [
      {
        requestId: 'r1',
        agent: 'brain',
        purpose: 'routing',
        messages: [],
        promptHash: 'h1',
        response: 'first response',
        timestamp: 1000,
      },
      {
        requestId: 'r2',
        agent: 'conversation',
        purpose: 'chat',
        messages: [],
        promptHash: 'h2',
        response: 'second response',
        timestamp: 2000,
      },
    ],
    recordedAt: 3000,
  };

  it('tracks remaining exchanges', () => {
    const replayer = new SessionReplayer(recording);
    expect(replayer.remaining).toBe(2);
    expect(replayer.isComplete).toBe(false);
  });

  it('respondNext rejects when recording exhausted', async () => {
    const emptyRecording: SessionRecording = {
      sessionId: 's',
      exchanges: [],
      recordedAt: 0,
    };
    const replayer = new SessionReplayer(emptyRecording);
    const mockController = {} as any;
    await expect(replayer.respondNext(mockController)).rejects.toThrow('exhausted');
  });
});
