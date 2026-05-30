import { describe, it, expect } from 'vitest';
import { ParallelTestHarness, type TimelineEntry } from './parallel-harness.js';

describe('ParallelTestHarness', () => {
  describe('assertPriorityOrder', () => {
    const harness = new ParallelTestHarness(null as any);

    it('passes when tasks complete in expected order', () => {
      const timeline: TimelineEntry[] = [
        { taskId: 'a', sessionId: 's1', startedAt: 100, completedAt: 200, durationMs: 100, message: 'msg1', response: 'r1' },
        { taskId: 'b', sessionId: 's2', startedAt: 100, completedAt: 300, durationMs: 200, message: 'msg2', response: 'r2' },
        { taskId: 'c', sessionId: 's3', startedAt: 100, completedAt: 400, durationMs: 300, message: 'msg3', response: 'r3' },
      ];

      expect(() => harness.assertPriorityOrder(timeline, ['a', 'b', 'c'])).not.toThrow();
    });

    it('throws when tasks complete in wrong order', () => {
      const timeline: TimelineEntry[] = [
        { taskId: 'a', sessionId: 's1', startedAt: 100, completedAt: 400, durationMs: 300, message: 'msg1', response: 'r1' },
        { taskId: 'b', sessionId: 's2', startedAt: 100, completedAt: 200, durationMs: 100, message: 'msg2', response: 'r2' },
      ];

      expect(() => harness.assertPriorityOrder(timeline, ['a', 'b'])).toThrow();
    });

    it('throws when expected task not found', () => {
      const timeline: TimelineEntry[] = [
        { taskId: 'a', sessionId: 's1', startedAt: 100, completedAt: 200, durationMs: 100, message: 'msg1', response: 'r1' },
      ];

      expect(() => harness.assertPriorityOrder(timeline, ['a', 'missing'])).toThrow('not found');
    });
  });

  describe('getTimeline', () => {
    const harness = new ParallelTestHarness(null as any);

    it('renders empty timeline', () => {
      expect(harness.getTimeline([])).toBe('(empty timeline)');
    });

    it('renders timeline with entries', () => {
      const timeline: TimelineEntry[] = [
        { taskId: 'task-abcdefgh', sessionId: 's1', startedAt: 1000, completedAt: 1500, durationMs: 500, message: 'do something', response: 'done' },
        { taskId: 'task-12345678', sessionId: 's2', startedAt: 1100, completedAt: 1800, durationMs: 700, message: 'another task', response: 'ok' },
      ];

      const output = harness.getTimeline(timeline);
      expect(output).toContain('task-abc');
      expect(output).toContain('task-123');
      expect(output).toContain('500ms');
      expect(output).toContain('700ms');
    });
  });
});
