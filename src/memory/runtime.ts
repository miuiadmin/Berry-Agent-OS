import type { AppConfig } from '../contracts/config.js';
import { evolutionMetrics } from '../observability/evolution-metrics.js';
import type {
  AddKnowledgeInput,
  KnowledgeType,
  MemoryAddPayload,
  MemoryContextFrame,
  MemoryDeletePayload,
  MemoryQueryPayload,
  RecallSource,
} from '../contracts/memory.js';
import { addKnowledge, dismissKnowledge } from './knowledge.js';
import { searchKnowledge } from './search.js';
import { buildMemoryContext } from './context-builder.js';
// 对话内联（doc 22）：runtime 的对话读写都切到 messages+message_blocks——
// persistUserMessage（user 落库）/ getTimeline（读取）替代旧 conversations 读写。
// extractTextFromBlocks：Block[]→纯文本平铺（getRecentTurns 把内联模型还原为文本对用）。
import { persistUserMessage, getTimeline, extractTextFromBlocks } from './message-blocks-repo.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('memory-runtime');

export class MemoryRuntime {
  private turnCounter = 0;
  private evolutionFailures = 0;
  private pendingEvolution = new Set<Promise<void>>();
  private extractionBuffer: Array<{ sessionId: string; userMessage: string; assistantResponse: string }> = [];
  private extractionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly extractionFlushInterval = 30_000;
  private readonly extractionBatchSize = 5;

  constructor(private readonly config: AppConfig['memory']) {}

  search(payload: MemoryQueryPayload) {
    return searchKnowledge(payload.query, {
      type: payload.type,
      limit: payload.limit ?? this.config.maxResults,
    });
  }

  add(payload: MemoryAddPayload) {
    const input: AddKnowledgeInput = {
      type: payload.type,
      summary: payload.summary,
      detail: payload.detail,
      evidenceKind: payload.evidence_kind,
      confidence: payload.confidence,
      importance: payload.importance,
      source: 'tool',
      provenance: 'tool:memory_add',
    };
    return addKnowledge(input);
  }

  delete(payload: MemoryDeletePayload): void {
    dismissKnowledge(payload.id);
  }

  buildContextFrame(
    sessionId: string,
    userMessage: string,
    recallSource: RecallSource = 'auto_recall',
    runId?: string,
  ): MemoryContextFrame | undefined {
    try {
      const frame = buildMemoryContext(sessionId, userMessage, recallSource, {
        maxRecords: this.config.maxResults,
        runId,
      });
      if (frame && frame.records && frame.records.length > 0) {
        evolutionMetrics.memoryRecallHit.inc();
      } else {
        evolutionMetrics.memoryRecallMiss.inc();
      }
      return frame;
    } catch {
      evolutionMetrics.memoryRecallMiss.inc();
      return undefined;
    }
  }

  /**
   * 单独持久化一条 user 消息，专供 kernel 入口在 createPending 之后
   * 立即调用。幂等性由 clientMsgId 触发。
   *
   * 消灭双轨制（doc 22）：user 消息落 messages 表（persistUserMessage），
   * 而非旧 conversations——assistant 行不再与 user 合并写，各走单一漏斗
   * （user=入口 persistUserMessage；assistant=turn 终态 persistInlineBlocks）。
   */
  saveUserMessage(sessionId: string, content: string, options: { clientMsgId?: string } = {}): { id: string; deduplicated: boolean } {
    return persistUserMessage({ sessionId, content, clientMsgId: options.clientMsgId });
  }

  /**
   * 取最近 N 轮对话（user/assistant 文本对），供记忆提取 / 会话上下文。
   *
   * 消灭双轨制（doc 22）：从 messages+message_blocks 读（getTimeline），Block[] 平铺为文本对——
   * text block 抽为 content，其余 block（thinking/tool/delegation）忽略（记忆提取只需文本语义）。
   */
  getRecentTurns(sessionId: string, maxTurns = 5): Array<{ userMessage: string; response: string }> {
    const timeline = getTimeline(sessionId, { limit: maxTurns * 2 });
    const turns: Array<{ userMessage: string; response: string }> = [];
    for (let i = 0; i < timeline.length - 1; i += 1) {
      const cur = timeline[i];
      const nxt = timeline[i + 1];
      if (cur.role === 'user' && nxt?.role === 'assistant') {
        const userText = extractTextFromBlocks(cur.blocks);
        const assistantText = extractTextFromBlocks(nxt.blocks);
        if (userText && assistantText) turns.push({ userMessage: userText, response: assistantText });
      }
    }
    return turns.slice(-maxTurns);
  }

  queueEvolution(sessionId: string, userMessage: string, assistantResponse: string): void {
    if (!this.config.evolutionEnabled) return;

    this.turnCounter++;
    this.extractionBuffer.push({ sessionId, userMessage, assistantResponse });

    if (this.extractionBuffer.length >= this.extractionBatchSize) {
      this.flushExtraction();
    } else if (this.extractionTimer) {
      // Timer already running — item will be flushed when it fires
    } else {
      // Start a timer; if no more items arrive before it fires, flush the single item
      this.extractionTimer = setTimeout(() => this.flushExtraction(), this.extractionFlushInterval);
    }

    if (this.turnCounter % this.config.consolidationInterval === 0) {
      this.trackEvolution(import('./evolution.js')
        .then(({ consolidateMemories }) => consolidateMemories())
        .catch((err) => { this.evolutionFailures++; logger.warn({ err }, '记忆合并失败'); }));
    }
  }

  private flushExtraction(): void {
    if (this.extractionTimer) {
      clearTimeout(this.extractionTimer);
      this.extractionTimer = null;
    }
    if (this.extractionBuffer.length === 0) return;

    const batch = this.extractionBuffer.splice(0);
    if (batch.length === 1) {
      const { userMessage, assistantResponse, sessionId } = batch[0];
      this.trackEvolution(import('./evolution.js')
        .then(({ extractMemories }) => extractMemories(userMessage, assistantResponse, sessionId))
        .catch((err) => { this.evolutionFailures++; logger.warn({ err, sessionId }, '记忆提取失败'); }));
    } else {
      this.trackEvolution(import('./evolution.js')
        .then(({ extractMemoriesBatch }) => extractMemoriesBatch(batch))
        .catch((err) => { this.evolutionFailures++; logger.warn({ err }, '批量记忆提取失败'); }));
    }
  }

  getEvolutionFailures(): number {
    return this.evolutionFailures;
  }

  async waitForEvolutionIdle(timeoutMs = 30000): Promise<boolean> {
    this.flushExtraction();
    const deadline = Date.now() + timeoutMs;
    while (this.pendingEvolution.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;

      const settled = await Promise.race([
        Promise.allSettled([...this.pendingEvolution]).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remainingMs)),
      ]);
      if (!settled) return false;
    }
    return true;
  }

  private trackEvolution(task: Promise<void>): void {
    this.pendingEvolution.add(task);
    task.finally(() => {
      this.pendingEvolution.delete(task);
    });
  }
}

export type { KnowledgeType, MemoryContextFrame };
