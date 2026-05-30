import { createLlmClient } from '../llm/client.js';
import { loadConfig } from '../kernel/config.js';
import { addKnowledge, listKnowledge, updateKnowledge, supersedeKnowledge, promoteKnowledge, pruneKnowledge, type AddKnowledgeInput, type KnowledgeType, type EvidenceKind } from './knowledge.js';
import { logEpisode } from './episodes.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('evolution');
const config = loadConfig();
const llm = createLlmClient(config.llm);

const EXTRACTION_PROMPT = `你是一个记忆提取引擎。分析以下对话，提取可以长期记住的用户知识。

规则：
- 只提取明确的、有长期价值的信息
- 不要提取临时性的任务细节
- type 必须是: identity, preference, goal, project, habit, decision, constraint, relationship, fact, reflection
- summary: 简短中文摘要（一句话概括）
- detail: 完整细节描述（可以多句话），如果只有一句话可以留空
- evidence_kind: direct（用户明确说的）、inferred（推断的）
- confidence: 0-1，用户明确说的给 0.8+，推断的给 0.4-0.6
- importance: 0-1，影响日常交互的给 0.7+

返回 JSON 数组（可以为空数组如果没有可提取的信息）：
[{"type": "...", "summary": "...", "detail": "...", "evidence_kind": "direct|inferred", "confidence": 0.8, "importance": 0.7}]

对话内容：
用户: {user_message}
助手: {assistant_response}

仅返回 JSON 数组，不要有其他文字。`;

const CONSOLIDATION_PROMPT = `你是一个记忆整理引擎。分析以下知识条目，找出可以合并或存在冲突的条目。

规则：
- 同一主题的多条记忆应该合并为一条更完整的
- 信息冲突时，保留更新的（updated_at 更大的）
- 返回需要操作的列表

知识条目：
{entries}

返回 JSON 数组（可以为空）：
[{"action": "merge", "keep_id": "...", "remove_id": "...", "merged_summary": "...", "merged_detail": "..."}]

仅返回 JSON 数组，不要有其他文字。`;

export async function extractMemoriesBatch(
  turns: Array<{ sessionId: string; userMessage: string; assistantResponse: string }>,
): Promise<void> {
  if (turns.length === 1) {
    return extractMemories(turns[0].userMessage, turns[0].assistantResponse, turns[0].sessionId);
  }

  const conversationText = turns.map((t, i) =>
    `--- 对话 ${i + 1} (session: ${t.sessionId}) ---\n用户: ${t.userMessage}\n助手: ${t.assistantResponse}`,
  ).join('\n\n');

  const prompt = EXTRACTION_PROMPT
    .replace('用户: {user_message}\n助手: {assistant_response}', conversationText);

  try {
    let extracted = await callAndParse(prompt, { maxTokens: 2048 });
    if (!extracted) {
      extracted = await callAndParse(prompt, { maxTokens: 2048 });
    }
    if (!extracted || extracted.length === 0) return;

    const sessionId = turns[turns.length - 1].sessionId;
    for (const item of extracted) {
      if (!isValidExtraction(item)) continue;
      const entry = addKnowledge({
        type: item.type as KnowledgeType,
        summary: item.summary as string,
        detail: (item.detail as string) || undefined,
        evidenceKind: (item.evidence_kind as EvidenceKind) ?? 'inferred',
        confidence: item.confidence as number | undefined,
        importance: item.importance as number | undefined,
        provenance: `session:${sessionId}`,
      });
      logEpisode(sessionId, 'memory_extracted', `提取记忆: [${item.type}] ${item.summary} (scope=${entry.scope})`);
    }

    logger.info({ count: extracted.length, turns: turns.length }, '批量记忆提取完成');
  } catch (err) {
    logger.error({ err, turns: turns.length }, '批量记忆提取失败');
  }
}

export async function extractMemories(userMessage: string, assistantResponse: string, sessionId: string): Promise<void> {
  try {
    const prompt = EXTRACTION_PROMPT
      .replace('{user_message}', userMessage)
      .replace('{assistant_response}', assistantResponse);

    let extracted = await callAndParse(prompt);
    if (!extracted) {
      logger.debug({ sessionId }, '记忆提取首次解析失败，重试');
      extracted = await callAndParse(prompt);
    }
    if (!extracted || extracted.length === 0) return;

    for (const item of extracted) {
      if (!isValidExtraction(item)) continue;
      const entry = addKnowledge({
        type: item.type as KnowledgeType,
        summary: item.summary as string,
        detail: (item.detail as string) || undefined,
        evidenceKind: (item.evidence_kind as EvidenceKind) ?? 'inferred',
        confidence: item.confidence as number | undefined,
        importance: item.importance as number | undefined,
        provenance: `session:${sessionId}`,
      });
      logEpisode(sessionId, 'memory_extracted', `提取记忆: [${item.type}] ${item.summary} (scope=${entry.scope})`);
    }

    logger.info({ count: extracted.length, sessionId }, '记忆提取完成');
  } catch (err) {
    logger.error({ err, sessionId }, '记忆提取失败');
  }
}

export async function consolidateMemories(): Promise<void> {
  try {
    const entries = listKnowledge({ scope: 'active' });
    if (entries.length < 3) {
      promoteKnowledge();
      pruneKnowledge();
      return;
    }

    const entriesText = entries.map((e) =>
      `[${e.id}] type=${e.type} summary="${e.summary}" detail="${e.detail ?? ''}" confidence=${e.confidence} updated_at=${e.updatedAt}`,
    ).join('\n');

    const prompt = CONSOLIDATION_PROMPT.replace('{entries}', entriesText);
    let actions = await callAndParse(prompt, { maxTokens: 1024, temperature: 0.2 });
    if (!actions) {
      logger.debug('记忆合并首次解析失败，重试');
      actions = await callAndParse(prompt, { maxTokens: 1024, temperature: 0.2 });
    }
    if (!actions || actions.length === 0) {
      promoteKnowledge();
      pruneKnowledge();
      return;
    }

    for (const action of actions) {
      if (action.action === 'merge' && action.keep_id && action.remove_id) {
        supersedeKnowledge(action.remove_id as string, action.keep_id as string);
        const updates: { summary?: string; detail?: string } = {};
        if (action.merged_summary) updates.summary = action.merged_summary as string;
        if (action.merged_detail) updates.detail = action.merged_detail as string;
        if (Object.keys(updates).length > 0) {
          updateKnowledge(action.keep_id as string, updates);
        }
      }
    }

    promoteKnowledge();
    pruneKnowledge();
    logger.info({ actions: actions.length }, '记忆整理完成');
  } catch (err) {
    logger.error({ err }, '记忆整理失败');
  }
}

async function callAndParse(
  prompt: string,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<Record<string, unknown>[] | null> {
  const result = await llm.chat(
    [{ role: 'user', content: prompt }],
    { maxTokens: opts.maxTokens ?? 1024, temperature: opts.temperature ?? 0.3 },
  );
  return parseJsonArray(result.content);
}

function parseJsonArray(text: string): Record<string, unknown>[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    logger.warn({ rawLength: text.length, preview: text.slice(0, 200) }, 'LLM 返回无法匹配 JSON 数组');
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) {
      logger.warn({ parsed }, 'LLM 返回的 JSON 不是数组');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn({ err, raw: match[0].slice(0, 300) }, 'JSON 解析失败');
    return null;
  }
}

function isValidExtraction(item: Record<string, unknown>): boolean {
  const validTypes = ['identity', 'preference', 'goal', 'project', 'habit', 'decision', 'constraint', 'relationship', 'fact', 'reflection'];
  if (typeof item.type !== 'string' || !validTypes.includes(item.type)) return false;
  if (typeof item.summary !== 'string' || item.summary.trim().length === 0) return false;
  if (item.confidence !== undefined) {
    if (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1) return false;
  }
  if (item.importance !== undefined) {
    if (typeof item.importance !== 'number' || item.importance < 0 || item.importance > 1) return false;
  }
  if (item.evidence_kind !== undefined) {
    if (item.evidence_kind !== 'direct' && item.evidence_kind !== 'inferred') return false;
  }
  return true;
}
