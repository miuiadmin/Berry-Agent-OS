import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { evolutionMetrics } from '../observability/evolution-metrics.js';
import { getLogger } from '../utils/logger.js';
import { redactSensitiveData } from './sensitive-redactor.js';

const logger = getLogger('brain-decision-recorder');

/** Brain 决策类型 — cron_review 用于 §13.8 cron 任务自动审核记录 */
export type BrainDecisionType = 'route' | 'review' | 'permission' | 'correction' | 'aggregated_insight' | 'cron_review';

export interface RecordBrainDecisionInput {
  sessionId: string;
  decisionType: BrainDecisionType;
  inputSummary: string;
  outputJson: Record<string, unknown>;
  confidence?: number;
  /** 13.0 §12.6 + §3.7: 关联的 task ID（plan task / agent_task / session 任务） */
  taskId?: string;
  /** outcome 显式覆盖（默认按 decisionType + outputJson 推导） */
  outcome?: 'good' | 'bad' | 'neutral' | null;
}

export class BrainDecisionRecorder {
  private insertStmt: Database.Statement | null = null;

  constructor(private readonly db: Database.Database) {}

  record(input: RecordBrainDecisionInput): string | null {
    try {
      if (!this.insertStmt) {
        this.insertStmt = this.db.prepare(`
          INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, confidence, outcome, task_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      const id = genId('bdec');
      const outcome = input.outcome ?? deriveOutcome(input.decisionType, input.outputJson);
      this.insertStmt.run(
        id,
        input.sessionId,
        input.decisionType,
        input.inputSummary.slice(0, 500),
        JSON.stringify(input.outputJson),
        input.confidence ?? null,
        outcome,
        input.taskId ?? null,
        Date.now(),
      );

      evolutionMetrics.brainDecisionRecorded.inc({ decision_type: input.decisionType });
      return id;
    } catch (err) {
      logger.warn({ err, decisionType: input.decisionType, sessionId: input.sessionId }, 'brain-decision: insert failed');
      return null;
    }
  }

  recordRouteDecision(sessionId: string, userMessage: string, decision: Record<string, unknown>, taskId?: string): void {
    this.record({
      sessionId,
      decisionType: 'route',
      inputSummary: userMessage,
      outputJson: decision,
      confidence: typeof decision.confidence === 'number' ? decision.confidence : undefined,
      taskId,
    });

    if (decision.intent === 'chat' && !decision.targetAgent) {
      evolutionMetrics.brainFallback.inc();
    }
  }

  recordReviewDecision(sessionId: string, draftSummary: string, verdict: Record<string, unknown>, taskId?: string): void {
    // 13.0 §3.6 场景 E: 审核时对 verdict 中的字符串字段做敏感数据脱敏
    // 防止 Learning Agent 间接泄露的 token / 邮箱 / 身份证等被持久化到 brain_decisions
    const redaction = redactSensitiveData(JSON.stringify(verdict));
    let sanitizedVerdict = verdict;
    if (redaction.totalReplacements > 0) {
      try {
        sanitizedVerdict = JSON.parse(redaction.redacted);
        logger.warn({
          sessionId,
          taskId,
          detectedTypes: redaction.detectedTypes,
          count: redaction.totalReplacements,
        }, 'brain-decision: review verdict contained sensitive data, redacted before persist');
      } catch {
        // 解析失败时回退到原 verdict（fail-open）
        sanitizedVerdict = verdict;
      }
    }

    this.record({
      sessionId,
      decisionType: 'review',
      inputSummary: draftSummary,
      outputJson: sanitizedVerdict,
      taskId,
    });

    if (verdict.verdict === 'reject' || verdict.verdict === 'modify') {
      evolutionMetrics.brainCorrection.inc();
    }
  }

  recordPermissionDecision(sessionId: string, toolName: string, judgment: Record<string, unknown>, taskId?: string): void {
    this.record({
      sessionId,
      decisionType: 'permission',
      inputSummary: `tool: ${toolName}`,
      outputJson: judgment,
      taskId,
    });

    evolutionMetrics.permissionJudge.inc({ verdict: judgment.allowed ? 'allowed' : 'denied' });
  }

  /**
   * 13.0 §3.7: 查询指定 task 的所有 Brain 决策（用于升级式纠偏 + 用户还原回查）。
   */
  recallForTask(taskId: string, decisionType?: BrainDecisionType): Array<{
    id: string;
    inputSummary: string;
    outputJson: string;
    outcome: string | null;
    lesson: string | null;
    createdAt: number;
  }> {
    if (!taskId) return [];
    try {
      const sql = decisionType
        ? `SELECT id, input_summary AS inputSummary, output_json AS outputJson, outcome, lesson, created_at AS createdAt
           FROM brain_decisions
           WHERE task_id = ? AND decision_type = ?
           ORDER BY created_at DESC LIMIT 50`
        : `SELECT id, input_summary AS inputSummary, output_json AS outputJson, outcome, lesson, created_at AS createdAt
           FROM brain_decisions
           WHERE task_id = ?
           ORDER BY created_at DESC LIMIT 50`;
      const params = decisionType ? [taskId, decisionType] : [taskId];
      return this.db.prepare(sql).all(...params) as Array<{
        id: string; inputSummary: string; outputJson: string; outcome: string | null; lesson: string | null; createdAt: number;
      }>;
    } catch (err) {
      logger.warn({ err, taskId }, 'brain-decision: recallForTask failed');
      return [];
    }
  }

  updateLesson(decisionId: string, lesson: string): void {
    try {
      this.db.prepare(`UPDATE brain_decisions SET lesson = ?, resolved_at = ? WHERE id = ?`).run(lesson, Date.now(), decisionId);
    } catch (err) {
      logger.debug({ err, decisionId }, 'brain-decision: updateLesson skipped');
    }
  }

  recallForDecision(decisionType: string, limit = 5): Array<{ inputSummary: string; outputJson: string; outcome: string | null; lesson: string | null }> {
    try {
      // §8.2: Prioritize entries with lessons (regardless of time), then recent
      const withLessons = this.db.prepare(`
        SELECT input_summary AS inputSummary, output_json AS outputJson, outcome, lesson
        FROM brain_decisions
        WHERE decision_type = ? AND lesson IS NOT NULL AND lesson != ''
        ORDER BY created_at DESC LIMIT ?
      `).all(decisionType, Math.min(limit, 3)) as Array<{ inputSummary: string; outputJson: string; outcome: string | null; lesson: string | null }>;

      const remaining = limit - withLessons.length;
      if (remaining <= 0) return withLessons;

      const lessonIds = withLessons.length > 0
        ? withLessons.map(() => '?').join(',')
        : null;

      const recent = this.db.prepare(`
        SELECT input_summary AS inputSummary, output_json AS outputJson, outcome, lesson
        FROM brain_decisions
        WHERE decision_type = ? AND (lesson IS NULL OR lesson = '')
        ORDER BY created_at DESC LIMIT ?
      `).all(decisionType, remaining) as Array<{ inputSummary: string; outputJson: string; outcome: string | null; lesson: string | null }>;

      return [...withLessons, ...recent];
    } catch (err) {
      logger.warn({ err, decisionType }, 'brain-decision: recall failed, returning empty');
      return [];
    }
  }
}

function deriveOutcome(decisionType: BrainDecisionType, output: Record<string, unknown>): 'good' | 'bad' | 'neutral' | null {
  switch (decisionType) {
    case 'route':
      return output.confidence && (output.confidence as number) >= 0.8 ? 'good' : 'neutral';
    case 'review':
      if (output.verdict === 'approve') return 'good';
      if (output.verdict === 'reject') return 'bad';
      return 'neutral';
    case 'permission':
      return output.allowed ? 'good' : 'neutral';
    case 'correction':
      if (output.action === 'continue') return 'good';
      if (output.action === 'stop' || output.action === 'restart') return 'bad';
      return 'neutral';
    default:
      return null;
  }
}
