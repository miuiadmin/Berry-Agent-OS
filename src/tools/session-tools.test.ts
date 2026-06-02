import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchHistoryTool, setSessionToolsDb } from './session-tools.js';

const mockDb = {
  prepare: vi.fn(() => ({
    all: vi.fn(() => []),
    get: vi.fn(),
  })),
};

describe('search_history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionToolsDb(mockDb as any);
  });

  it('returns no-match message when empty results', async () => {
    const result = await searchHistoryTool.execute({ query: '重构讨论' });
    expect(result.content).toContain('未找到');
  });

  it('returns formatted results when matches exist', async () => {
    mockDb.prepare.mockReturnValue({
      all: vi.fn(() => [
        { session_id: 'sess_abc123', role: 'user', content: '我们讨论了重构方案', created_at: Date.now() - 86400000 },
        { session_id: 'sess_abc123', role: 'assistant', content: '好的，重构方案如下...', created_at: Date.now() - 86400000 + 1000 },
      ]),
    } as any);

    const result = await searchHistoryTool.execute({ query: '重构' });
    expect(result.content).toContain('找到');
    expect(result.content).toContain('重构方案');
    expect(result.content).toContain('sess_abc');
  });

  it('rejects query shorter than 2 chars via schema', async () => {
    await expect(searchHistoryTool.execute({ query: 'x' })).rejects.toThrow();
  });

  it('handles missing FTS table gracefully', async () => {
    mockDb.prepare.mockImplementation(() => {
      throw new Error('no such table: conversations_fts');
    });

    const result = await searchHistoryTool.execute({ query: '测试查询' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('FTS 索引未创建');
  });

  it('supports date range filtering', async () => {
    mockDb.prepare.mockReturnValue({ all: vi.fn(() => []) } as any);

    const result = await searchHistoryTool.execute({
      query: '测试',
      dateFrom: '2025-01-01',
      dateTo: '2025-06-01',
    });
    expect(result.content).toContain('未找到');
    // Verify the prepare was called (date params passed)
    expect(mockDb.prepare).toHaveBeenCalled();
  });
});
