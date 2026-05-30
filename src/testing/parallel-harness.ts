import type { TestHarness, MessageResult } from './harness.js';

export interface TimelineEntry {
  taskId: string;
  sessionId: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  message: string;
  response: string;
}

export interface ParallelResult {
  results: MessageResult[];
  timeline: TimelineEntry[];
  totalDurationMs: number;
}

export class ParallelTestHarness {
  constructor(private readonly harness: TestHarness) {}

  async sendParallel(messages: string[], sessionPrefix?: string): Promise<ParallelResult> {
    const startTime = Date.now();
    const timeline: TimelineEntry[] = [];

    const promises = messages.map(async (message, idx) => {
      const sessionId = sessionPrefix ? `${sessionPrefix}-${idx}` : undefined;
      const msgStart = Date.now();

      const result = await this.harness.sendMessage(message, sessionId);

      timeline.push({
        taskId: result.taskId,
        sessionId: result.sessionId,
        startedAt: msgStart,
        completedAt: Date.now(),
        durationMs: Date.now() - msgStart,
        message,
        response: result.response,
      });

      return result;
    });

    const results = await Promise.all(promises);

    timeline.sort((a, b) => a.startedAt - b.startedAt);

    return {
      results,
      timeline,
      totalDurationMs: Date.now() - startTime,
    };
  }

  assertPriorityOrder(timeline: TimelineEntry[], expectedTaskOrder: string[]): void {
    const completionOrder = [...timeline]
      .sort((a, b) => a.completedAt - b.completedAt)
      .map(e => e.taskId);

    for (let i = 0; i < expectedTaskOrder.length; i++) {
      const expectedTask = expectedTaskOrder[i];
      const actualIdx = completionOrder.indexOf(expectedTask);
      if (actualIdx === -1) {
        throw new Error(`Expected task "${expectedTask}" in completion order, not found`);
      }
      if (actualIdx > i) {
        throw new Error(
          `Expected task "${expectedTask}" to complete at position ${i}, but was at ${actualIdx}`,
        );
      }
    }
  }

  getTimeline(entries: TimelineEntry[]): string {
    if (entries.length === 0) return '(empty timeline)';

    const earliest = Math.min(...entries.map(e => e.startedAt));
    const lines: string[] = [];

    for (const entry of entries) {
      const offset = entry.startedAt - earliest;
      const bar = '='.repeat(Math.max(1, Math.floor(entry.durationMs / 100)));
      lines.push(
        `[+${String(offset).padStart(5)}ms] ${entry.taskId.slice(0, 8)} |${bar}| ${entry.durationMs}ms "${entry.message.slice(0, 30)}"`,
      );
    }

    return lines.join('\n');
  }
}
