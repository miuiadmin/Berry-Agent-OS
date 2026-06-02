import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cronCreateTool, cronDeleteTool, cronListTool, setCronToolsDb } from './cron-tools.js';

vi.mock('../cron/parser.js', () => ({
  computeNextRun: vi.fn((cron: string, fromMs: number) => {
    if (cron === 'invalid') return null;
    return fromMs + 60_000;
  }),
}));

vi.mock('../utils/id.js', () => ({
  genId: vi.fn(() => 'test_id_001'),
}));

const mockPrepareResult = {
  run: vi.fn(() => ({ changes: 1 })),
  all: vi.fn(() => []),
  get: vi.fn(),
};

const mockDb = {
  prepare: vi.fn(() => mockPrepareResult),
};

describe('cron tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue(mockPrepareResult);
    mockPrepareResult.run.mockReturnValue({ changes: 1 });
    mockPrepareResult.all.mockReturnValue([]);
    setCronToolsDb(mockDb as any);
  });

  describe('cron_create', () => {
    it('creates a task and returns id', async () => {
      const result = await cronCreateTool.execute({
        schedule: '0 9 * * *',
        prompt: '总结今日待办',
        description: '每日总结',
      });
      expect(result.content).toContain('test_id_001');
      expect(result.content).toContain('定时任务已创建');
      expect(result.content).toContain('0 9 * * *');
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('returns error for invalid cron expression', async () => {
      const result = await cronCreateTool.execute({
        schedule: 'invalid',
        prompt: 'test',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('无效 cron');
    });
  });

  describe('cron_delete', () => {
    it('deletes a task', async () => {
      const result = await cronDeleteTool.execute({ id: 'test_id_001' });
      expect(result.content).toContain('已删除');
    });

    it('returns error when task not found', async () => {
      mockPrepareResult.run.mockReturnValue({ changes: 0 });
      const result = await cronDeleteTool.execute({ id: 'nonexistent' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('未找到');
    });
  });

  describe('cron_list', () => {
    it('returns empty message when no tasks', async () => {
      const result = await cronListTool.execute({});
      expect(result.content).toContain('无定时任务');
    });

    it('lists tasks with details', async () => {
      mockPrepareResult.all.mockReturnValue([
        { id: 'id1', cron: '0 9 * * *', description: '早报', prompt: null, enabled: 1, last_run_at: null, next_run_at: Date.now() + 60000 },
      ]);

      const result = await cronListTool.execute({});
      expect(result.content).toContain('id1');
      expect(result.content).toContain('0 9 * * *');
      expect(result.content).toContain('早报');
    });
  });
});
