import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import type Database from 'better-sqlite3';

let dbRef: Database.Database | null = null;

export function setSessionToolsDb(db: Database.Database): void {
  dbRef = db;
}

function getDb(): Database.Database {
  if (!dbRef) throw new Error('Session tools DB not initialized — call setSessionToolsDb first');
  return dbRef;
}

const searchHistorySchema = z.object({
  query: z.string().min(2).describe('搜索关键词'),
  limit: z.number().optional().default(5).describe('返回会话数'),
  dateFrom: z.string().optional().describe('起始日期（ISO 格式，如 2025-01-01）'),
  dateTo: z.string().optional().describe('结束日期（ISO 格式）'),
});

export const searchHistoryTool: ToolDefinition = {
  name: 'search_history',
  description: '搜索历史对话。在过往会话中查找相关片段。用于回顾之前讨论过的内容。',
  inputSchema: searchHistorySchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { query, limit, dateFrom, dateTo } = searchHistorySchema.parse(input);

    try {
      const db = getDb();

      const ftsQuery = query
        .split(/\s+/)
        .filter(w => w.length > 0)
        .map(w => `"${w.replace(/"/g, '')}"`)
        .join(' OR ');

      if (!ftsQuery) {
        return { content: '搜索词过短', isError: true };
      }

      // 对话内联（doc 22）：历史搜索走 message_blocks_fts（消灭双轨制后对话内容唯一在新表）。
      // JOIN messages 取 role / created_at 供片段前缀与排序。date 过滤保留。
      const conditions: string[] = ['message_blocks_fts MATCH ?'];
      const params: unknown[] = [ftsQuery];

      if (dateFrom) {
        conditions.push('m.created_at >= ?');
        params.push(new Date(dateFrom).getTime());
      }
      if (dateTo) {
        conditions.push('m.created_at <= ?');
        params.push(new Date(dateTo).getTime());
      }

      const whereClause = conditions.join(' AND ');
      params.push(limit * 10);

      const rows = db.prepare(`
        SELECT f.session_id AS session_id, m.role AS role, f.content AS content, m.created_at AS created_at
        FROM message_blocks_fts f
        JOIN messages m ON m.id = f.message_id
        WHERE ${whereClause}
        ORDER BY rank, m.created_at DESC
        LIMIT ?
      `).all(...params) as Array<{ session_id: string; role: string; content: string; created_at: number }>;

      if (rows.length === 0) {
        return { content: `未找到与 "${query}" 相关的历史对话` };
      }

      // Group by session
      const sessions = new Map<string, { fragments: string[]; at: number }>();
      for (const row of rows) {
        const entry = sessions.get(row.session_id) ?? { fragments: [], at: 0 };
        if (entry.fragments.length < 3) {
          const prefix = row.role === 'user' ? '用户' : 'AI';
          entry.fragments.push(`  [${prefix}] ${row.content.slice(0, 150)}`);
        }
        if (row.created_at > entry.at) entry.at = row.created_at;
        sessions.set(row.session_id, entry);
      }

      const sorted = [...sessions.entries()]
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, limit);

      const output = sorted.map(([sid, data]) => {
        const date = new Date(data.at).toLocaleDateString();
        return `[${date}] 会话 ${sid.slice(0, 8)}...\n${data.fragments.join('\n')}`;
      }).join('\n\n');

      return { content: `找到 ${sessions.size} 个相关会话:\n\n${output}` };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table')) {
        return { content: '历史搜索不可用（FTS 索引未创建）', isError: true };
      }
      return { content: `搜索失败: ${msg}`, isError: true };
    }
  },
};
