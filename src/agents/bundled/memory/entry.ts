import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';

startModuleAgent(async (payload: AgentTaskPayload, context) => {
  const input = payload.inputPayload;
  const taskType = String(input.taskType ?? 'memory_judge');
  const db = getDb();

  switch (taskType) {
    case 'memory_judge':
      return await handleMemoryJudge(payload, context, db);
    case 'memory_recall':
      return await handleMemoryRecall(payload, context, db);
    case 'memory_cleanup':
      return await handleMemoryCleanup(db);
    case 'memory_organize':
      return await handleMemoryOrganize(payload, context, db);
    default:
      return { kind: taskType, error: `Unknown memory task type: ${taskType}` };
  }
});

async function handleMemoryJudge(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { userMessage, assistantResponse, sessionId } = payload.inputPayload as {
    userMessage: string;
    assistantResponse: string;
    sessionId: string;
  };

  const result = await context.llm.chat(
    [{ role: 'user', content: buildJudgePrompt(userMessage, assistantResponse) }],
    {
      agent: 'memory',
      purpose: 'learning_review',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 512,
      temperature: 0.1,
    },
  );

  const facts = parseMemoryFacts(result.content);
  if (facts.length === 0) {
    return { kind: 'memory_judge', saved: 0, reason: 'no signal detected' };
  }

  let saved = 0;
  for (const fact of facts) {
    try {
      const existing = db.prepare(
        `SELECT id FROM knowledge WHERE summary = ? AND owner_key = 'user:owner' LIMIT 1`,
      ).get(fact.summary) as { id: string } | undefined;
      if (existing) continue;

      const { genId } = await import('../../../utils/id.js');
      db.prepare(`
        INSERT INTO knowledge (id, owner_key, type, summary, evidence_kind, source, confidence, created_at, updated_at, last_seen_at)
        VALUES (?, 'user:owner', ?, ?, 'inferred', 'conversation', ?, ?, ?, ?)
      `).run(genId('kn'), fact.type, fact.summary, fact.confidence, Date.now(), Date.now(), Date.now());
      saved++;
    } catch { /* skip duplicates */ }
  }

  return { kind: 'memory_judge', saved, facts: facts.map(f => f.summary) };
}

async function handleMemoryRecall(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const { query, sessionId } = payload.inputPayload as { query: string; sessionId: string };

  const rows = db.prepare(`
    SELECT id, type, summary, confidence FROM knowledge
    WHERE owner_key = 'user:owner'
    ORDER BY last_seen_at DESC LIMIT 20
  `).all() as Array<{ id: string; type: string; summary: string; confidence: number }>;

  if (rows.length === 0) return { kind: 'memory_recall', results: [] };

  const result = await context.llm.chat(
    [{ role: 'user', content: buildRecallPrompt(query, rows) }],
    {
      agent: 'memory',
      purpose: 'learning_review',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      maxTokens: 256,
      temperature: 0.0,
    },
  );

  const selectedIds = parseRecallSelection(result.content, rows);
  return { kind: 'memory_recall', results: selectedIds.map(id => rows.find(r => r.id === id)?.summary).filter(Boolean) };
}

async function handleMemoryCleanup(db: import('better-sqlite3').Database): Promise<Record<string, unknown>> {
  const staleThreshold = Date.now() - 90 * 86400_000;
  const result = db.prepare(`
    UPDATE knowledge SET source = 'archived'
    WHERE owner_key = 'user:owner' AND last_seen_at < ? AND source != 'archived'
  `).run(staleThreshold);
  return { kind: 'memory_cleanup', archived: result.changes };
}

async function handleMemoryOrganize(
  payload: AgentTaskPayload,
  context: { llm: import('../../../llm/client.js').LlmClient },
  db: import('better-sqlite3').Database,
): Promise<Record<string, unknown>> {
  const duplicates = db.prepare(`
    SELECT a.id AS id_a, b.id AS id_b, a.summary AS summary_a, b.summary AS summary_b
    FROM knowledge a JOIN knowledge b ON a.id < b.id
    WHERE a.owner_key = 'user:owner' AND b.owner_key = 'user:owner'
      AND a.type = b.type AND a.source != 'archived' AND b.source != 'archived'
    LIMIT 10
  `).all() as Array<{ id_a: string; id_b: string; summary_a: string; summary_b: string }>;

  if (duplicates.length === 0) return { kind: 'memory_organize', merged: 0 };

  let merged = 0;
  for (const dup of duplicates) {
    if (dup.summary_a === dup.summary_b) {
      db.prepare(`DELETE FROM knowledge WHERE id = ?`).run(dup.id_b);
      merged++;
    }
  }
  return { kind: 'memory_organize', merged };
}

function buildJudgePrompt(userMessage: string, assistantResponse: string): string {
  return `判断这轮对话是否包含值得长期记忆的信息。

规则：
- 只关注用户透露的身份/偏好/个人信息、用户表达的行为/工作方式期望
- 不存：环境错误、一次性任务叙述、容易重新发现的信息
- 没有信号 → 输出 []
- 有信号 → 输出 JSON 数组 [{type, summary, confidence}]

type 可选: identity, preference, goal, habit, constraint, fact

用户: ${userMessage.slice(0, 300)}
助手: ${assistantResponse.slice(0, 300)}`;
}

function buildRecallPrompt(query: string, rows: Array<{ id: string; summary: string }>): string {
  const list = rows.map((r, i) => `[${i}] ${r.summary}`).join('\n');
  return `从以下记忆中选出与当前查询最相关的（最多 5 条）。输出 JSON 数组（索引列表）。

查询: ${query}

记忆列表:
${list}`;
}

function parseMemoryFacts(text: string): Array<{ type: string; summary: string; confidence: number }> {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((f: any) => f.type && f.summary).map((f: any) => ({
      type: f.type,
      summary: String(f.summary).slice(0, 200),
      confidence: typeof f.confidence === 'number' ? f.confidence : 0.7,
    }));
  } catch { return []; }
}

function parseRecallSelection(text: string, rows: Array<{ id: string }>): string[] {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const indices = JSON.parse(match[0]);
    if (!Array.isArray(indices)) return [];
    return indices.filter((i: any) => typeof i === 'number' && i >= 0 && i < rows.length).map((i: number) => rows[i].id);
  } catch { return []; }
}
