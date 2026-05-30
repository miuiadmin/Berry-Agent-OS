import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./knowledge.js', () => ({
  addKnowledge: vi.fn(() => ({ id: 'k1' })),
  dismissKnowledge: vi.fn(),
}));

vi.mock('./search.js', () => ({
  searchKnowledge: vi.fn(() => []),
}));

vi.mock('./context-builder.js', () => ({
  buildMemoryContext: vi.fn(() => ({ records: [], conversationHistory: [] })),
}));

vi.mock('./conversations.js', () => ({
  saveMessage: vi.fn(),
  getHistory: vi.fn(() => []),
}));

vi.mock('./evolution.js', () => ({
  extractMemories: vi.fn(async () => {}),
  extractMemoriesBatch: vi.fn(async () => {}),
  consolidateMemories: vi.fn(async () => {}),
}));

import { MemoryRuntime } from './runtime.js';
import { addKnowledge, dismissKnowledge } from './knowledge.js';
import { searchKnowledge } from './search.js';
import { buildMemoryContext } from './context-builder.js';
import { saveMessage, getHistory } from './conversations.js';

function makeRuntime(overrides = {}) {
  return new MemoryRuntime({
    evolutionEnabled: true,
    consolidationInterval: 50,
    maxResults: 5,
    ...overrides,
  });
}

describe('MemoryRuntime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('search', () => {
    it('delegates to searchKnowledge', () => {
      const rt = makeRuntime();
      rt.search({ query: 'test', type: 'preference', limit: 3 });
      expect(searchKnowledge).toHaveBeenCalledWith('test', { type: 'preference', limit: 3 });
    });

    it('uses maxResults as default limit', () => {
      const rt = makeRuntime({ maxResults: 10 });
      rt.search({ query: 'q' } as any);
      expect(searchKnowledge).toHaveBeenCalledWith('q', expect.objectContaining({ limit: 10 }));
    });
  });

  describe('add', () => {
    it('delegates to addKnowledge', () => {
      const rt = makeRuntime();
      rt.add({ type: 'preference', summary: 'likes dark mode', detail: '', confidence: 0.8, importance: 0.5, evidence_kind: 'explicit' });
      expect(addKnowledge).toHaveBeenCalledWith(expect.objectContaining({
        type: 'preference',
        summary: 'likes dark mode',
        source: 'tool',
      }));
    });
  });

  describe('delete', () => {
    it('delegates to dismissKnowledge', () => {
      const rt = makeRuntime();
      rt.delete({ id: 'k123' });
      expect(dismissKnowledge).toHaveBeenCalledWith('k123');
    });
  });

  describe('buildContextFrame', () => {
    it('returns context from buildMemoryContext', () => {
      const rt = makeRuntime();
      const frame = rt.buildContextFrame('s1', 'hello');
      expect(buildMemoryContext).toHaveBeenCalledWith('s1', 'hello', 'auto_recall', expect.objectContaining({ maxRecords: 5 }));
      expect(frame).toEqual({ records: [], conversationHistory: [] });
    });

    it('returns undefined on error', () => {
      (buildMemoryContext as any).mockImplementation(() => { throw new Error('db error'); });
      const rt = makeRuntime();
      const frame = rt.buildContextFrame('s1', 'hello');
      expect(frame).toBeUndefined();
    });
  });

  describe('saveConversationTurn', () => {
    it('saves both user and assistant messages', () => {
      const rt = makeRuntime();
      rt.saveConversationTurn('s1', 'hi', 'hello');
      expect(saveMessage).toHaveBeenCalledWith('s1', 'user', 'hi');
      expect(saveMessage).toHaveBeenCalledWith('s1', 'assistant', 'hello');
    });
  });

  describe('getRecentTurns', () => {
    it('pairs user/assistant messages into turns', () => {
      (getHistory as any).mockReturnValue([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd' },
      ]);
      const rt = makeRuntime();
      const turns = rt.getRecentTurns('s1', 5);
      expect(turns).toEqual([
        { userMessage: 'a', response: 'b' },
        { userMessage: 'c', response: 'd' },
      ]);
    });

    it('skips incomplete pairs', () => {
      (getHistory as any).mockReturnValue([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]);
      const rt = makeRuntime();
      const turns = rt.getRecentTurns('s1');
      expect(turns).toEqual([{ userMessage: 'a', response: 'b' }]);
    });
  });

  describe('queueEvolution', () => {
    it('is a no-op when evolution disabled', () => {
      const rt = makeRuntime({ evolutionEnabled: false });
      rt.queueEvolution('s1', 'hi', 'hello');
      expect(rt.getEvolutionFailures()).toBe(0);
    });

    it('flushes at batch size', async () => {
      const rt = makeRuntime();
      for (let i = 0; i < 5; i++) {
        rt.queueEvolution('s1', `msg${i}`, `resp${i}`);
      }
      await vi.advanceTimersByTimeAsync(0);
      const { extractMemoriesBatch } = await import('./evolution.js');
      expect(extractMemoriesBatch).toHaveBeenCalled();
    });

    it('flushes single item on timer', async () => {
      const rt = makeRuntime();
      rt.queueEvolution('s1', 'msg', 'resp');

      await vi.advanceTimersByTimeAsync(30_000);
      const { extractMemories } = await import('./evolution.js');
      expect(extractMemories).toHaveBeenCalledWith('msg', 'resp', 's1');
    });

    it('triggers consolidation at interval', async () => {
      const rt = makeRuntime({ evolutionEnabled: true, consolidationInterval: 2 });
      rt.queueEvolution('s1', 'a', 'b');
      rt.queueEvolution('s1', 'c', 'd');
      await vi.advanceTimersByTimeAsync(0);
      const { consolidateMemories } = await import('./evolution.js');
      expect(consolidateMemories).toHaveBeenCalled();
    });
  });

  describe('waitForEvolutionIdle', () => {
    it('returns true when no pending tasks', async () => {
      const rt = makeRuntime({ evolutionEnabled: false });
      const idle = await rt.waitForEvolutionIdle(1000);
      expect(idle).toBe(true);
    });

    it('waits for pending evolution to complete', async () => {
      const rt = makeRuntime();
      for (let i = 0; i < 5; i++) {
        rt.queueEvolution('s1', `m${i}`, `r${i}`);
      }

      const idlePromise = rt.waitForEvolutionIdle(5000);
      await vi.advanceTimersByTimeAsync(100);
      const idle = await idlePromise;
      expect(idle).toBe(true);
    });
  });
});
