import type Database from 'better-sqlite3';

export interface RecalledInsight {
  id: string;
  category: string;
  title: string;
  content: string;
  confidence: number;
}

export function recallInsightsForDecision(
  db: Database.Database,
  decisionType: string,
  limit = 5,
): RecalledInsight[] {
  try {
    const categoryMapping: Record<string, string[]> = {
      route: ['routing', 'performance'],
      review: ['review', 'performance'],
      permission: ['permission'],
      correction: ['review', 'routing'],
    };

    const categories = categoryMapping[decisionType] ?? [decisionType];
    const placeholders = categories.map(() => '?').join(',');

    const rows = db.prepare(`
      SELECT id, category, title, content, confidence
      FROM system_insights
      WHERE status = 'validated' AND category IN (${placeholders})
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(...categories, limit) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      // Fall back to tentative insights if no validated ones
      const tentative = db.prepare(`
        SELECT id, category, title, content, confidence
        FROM system_insights
        WHERE status = 'tentative' AND category IN (${placeholders})
          AND confidence >= 0.6
        ORDER BY confidence DESC, updated_at DESC
        LIMIT ?
      `).all(...categories, Math.min(limit, 3)) as Array<Record<string, unknown>>;
      return tentative.map(rowToInsight);
    }

    return rows.map(rowToInsight);
  } catch {
    return [];
  }
}

export function formatInsightsBlock(insights: RecalledInsight[]): string {
  if (insights.length === 0) return '';

  const lines = insights.map((ins) => {
    const parsed = tryParseContent(ins.content);
    const suggestion = parsed?.suggestion ?? '';
    return `- [${ins.category}] ${ins.title}${suggestion ? ` → ${suggestion}` : ''}`;
  });

  return `\n## 系统洞察（来自历史决策学习）\n\n${lines.join('\n')}\n`;
}

export function markInsightAdopted(db: Database.Database, insightId: string): void {
  try {
    db.prepare(`
      UPDATE system_insights
      SET adopted_count = adopted_count + 1, last_adopted_at = ?, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), Date.now(), insightId);
  } catch {
    // best-effort
  }
}

function rowToInsight(row: Record<string, unknown>): RecalledInsight {
  return {
    id: row.id as string,
    category: row.category as string,
    title: row.title as string,
    content: row.content as string,
    confidence: row.confidence as number,
  };
}

function tryParseContent(content: string): { suggestion?: string } | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
