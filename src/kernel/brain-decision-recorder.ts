import type Database from 'better-sqlite3';
import { genId } from '../utils/id.js';
import { evolutionMetrics } from '../observability/evolution-metrics.js';

export type BrainDecisionType = 'route' | 'review' | 'permission' | 'correction';

export interface RecordBrainDecisionInput {
  sessionId: string;
  decisionType: BrainDecisionType;
  inputSummary: string;
  outputJson: Record<string, unknown>;
  confidence?: number;
}

export class BrainDecisionRecorder {
  private insertStmt: Database.Statement | null = null;

  constructor(private readonly db: Database.Database) {}

  record(input: RecordBrainDecisionInput): string | null {
    try {
      if (!this.insertStmt) {
        this.insertStmt = this.db.prepare(`
          INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, confidence, outcome, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      const id = genId('bdec');
      const outcome = deriveOutcome(input.decisionType, input.outputJson);
      this.insertStmt.run(
        id,
        input.sessionId,
        input.decisionType,
        input.inputSummary.slice(0, 500),
        JSON.stringify(input.outputJson),
        input.confidence ?? null,
        outcome,
        Date.now(),
      );

      evolutionMetrics.brainDecisionRecorded.inc({ decision_type: input.decisionType });
      return id;
    } catch {
      return null;
    }
  }

  recordRouteDecision(sessionId: string, userMessage: string, decision: Record<string, unknown>): void {
    this.record({
      sessionId,
      decisionType: 'route',
      inputSummary: userMessage,
      outputJson: decision,
      confidence: typeof decision.confidence === 'number' ? decision.confidence : undefined,
    });

    if (decision.intent === 'chat' && !decision.targetAgent) {
      evolutionMetrics.brainFallback.inc();
    }
  }

  recordReviewDecision(sessionId: string, draftSummary: string, verdict: Record<string, unknown>): void {
    this.record({
      sessionId,
      decisionType: 'review',
      inputSummary: draftSummary,
      outputJson: verdict,
    });

    if (verdict.verdict === 'reject' || verdict.verdict === 'modify') {
      evolutionMetrics.brainCorrection.inc();
    }
  }

  recordPermissionDecision(sessionId: string, toolName: string, judgment: Record<string, unknown>): void {
    this.record({
      sessionId,
      decisionType: 'permission',
      inputSummary: `tool: ${toolName}`,
      outputJson: judgment,
    });

    evolutionMetrics.permissionJudge.inc({ verdict: judgment.allowed ? 'allowed' : 'denied' });
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
