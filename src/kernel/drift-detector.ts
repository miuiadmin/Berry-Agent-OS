/**
 * 12.0 漂移检测器 — 在关键节点检测产出是否偏离用户原始意图。
 *
 * 使用 cheap model（fast tier）做轻量判断，通过 Brain IPC 调用 LLM。
 * 检测点：final_response（必选）、dialogue（每 3 轮）、task_result。
 */

import type Database from 'better-sqlite3';
import type { IntentAnchor, DriftSignal, DriftCheckpointType, DriftThresholds } from '../contracts/intent.js';
import { DEFAULT_DRIFT_THRESHOLDS } from '../contracts/intent.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { redactSecrets } from '../observability/redaction.js';
import { safeSlice } from '../utils/safe-slice.js';

const logger = getLogger('drift-detector');

/** Drift 检测请求载荷（Core → Brain） */
export interface DriftCheckRequestPayload {
  anchor: IntentAnchor;
  content: string;
  checkpointType: DriftCheckpointType;
}

/** Drift 检测结果载荷（Brain → Core） */
export interface DriftCheckResultPayload {
  signal: DriftSignal;
}

/** 构建漂移检测 prompt — Brain 内部使用 */
export function buildDriftCheckPrompt(anchor: IntentAnchor, content: string, checkpointType: DriftCheckpointType): string {
  const constraintsList = anchor.constraints.length > 0
    ? anchor.constraints.map(c => `- ${c}`).join('\n')
    : '无';

  return `你是一个意图对齐检测器。判断以下产出是否偏离了用户的原始意图。

## 用户原始意图
目标：${anchor.goal}
约束：
${constraintsList}
预期产出类型：${anchor.outputType}
核心实体：${anchor.entities.join('、') || '未指定'}

## 当前产出（${checkpointType}）
${safeSlice(content, 3000)}

## 判断
请评估当前产出与用户目标的对齐程度。只输出 JSON：
{"alignmentScore": <0-1>, "needsIntervention": <true/false>, "driftDescription": "<偏离描述或null>", "suggestedAction": "<continue|correct|verify|abort>"}`;
}

/** 解析 LLM 返回的漂移检测 JSON（容错） */
export function parseDriftCheckResult(llmOutput: string, checkpointType: DriftCheckpointType): DriftSignal {
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    const parsed = JSON.parse(jsonMatch[0]);

    const alignmentScore = typeof parsed.alignmentScore === 'number'
      ? Math.max(0, Math.min(1, parsed.alignmentScore))
      : 1;

    return {
      alignmentScore,
      needsIntervention: Boolean(parsed.needsIntervention),
      driftDescription: typeof parsed.driftDescription === 'string' ? parsed.driftDescription : undefined,
      suggestedAction: ['continue', 'correct', 'verify', 'abort'].includes(parsed.suggestedAction)
        ? parsed.suggestedAction
        : alignmentScore >= 0.7 ? 'continue' : alignmentScore >= 0.5 ? 'correct' : 'verify',
      checkpointType,
    };
  } catch {
    logger.debug({ output: safeSlice(llmOutput, 200) }, 'drift check parse failed, defaulting to aligned');
    return {
      alignmentScore: 1,
      needsIntervention: false,
      checkpointType,
    };
  }
}

/** 根据阈值为 DriftSignal 补充 suggestedAction（如果 LLM 未返回） */
export function applySuggestedAction(signal: DriftSignal, thresholds: DriftThresholds): DriftSignal {
  const threshold = thresholds[signal.checkpointType];
  if (!threshold) return signal;

  if (signal.alignmentScore < threshold.blockBelow) {
    return { ...signal, needsIntervention: true, suggestedAction: 'verify' };
  }
  if (signal.alignmentScore < threshold.warnBelow) {
    return { ...signal, needsIntervention: true, suggestedAction: 'correct' };
  }
  return { ...signal, needsIntervention: false, suggestedAction: 'continue' };
}

export class DriftDetector {
  private insertAnchorStmt: Database.Statement | null = null;
  private insertSignalStmt: Database.Statement | null = null;
  private thresholds: DriftThresholds;

  constructor(
    private readonly db: Database.Database,
    thresholds?: DriftThresholds,
  ) {
    this.thresholds = thresholds ?? DEFAULT_DRIFT_THRESHOLDS;
  }

  /** 更新阈值配置（运行时可调） */
  setThresholds(thresholds: DriftThresholds): void {
    this.thresholds = thresholds;
  }

  /** 记录意图锚点到 DB，返回 anchor ID */
  recordAnchor(
    anchor: IntentAnchor,
    rawMessage: string,
    sessionId: string,
    correlationId: string,
    routeReason?: string,
  ): string {
    try {
      if (!this.insertAnchorStmt) {
        this.insertAnchorStmt = this.db.prepare(`
          INSERT INTO intent_anchors (id, session_id, correlation_id, raw_message, goal, constraints_json, output_type, entities_json, route_reason, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      const id = genId('ianc');
      this.insertAnchorStmt.run(
        id,
        sessionId,
        correlationId,
        safeSlice(redactSecrets(rawMessage), 2000),
        safeSlice(anchor.goal, 500),
        JSON.stringify(anchor.constraints),
        anchor.outputType,
        JSON.stringify(anchor.entities),
        routeReason ? safeSlice(routeReason, 500) : null,
        Date.now(),
      );
      return id;
    } catch (err) {
      logger.error({ err }, 'recordAnchor failed');
      return '';
    }
  }

  /** 记录漂移信号到 DB */
  recordSignal(
    signal: DriftSignal,
    sessionId: string,
    correlationId: string,
    anchorId?: string,
  ): void {
    try {
      if (!this.insertSignalStmt) {
        this.insertSignalStmt = this.db.prepare(`
          INSERT INTO drift_signals (id, session_id, correlation_id, checkpoint_type, alignment_score, needs_intervention, drift_description, suggested_action, actual_action, intent_anchor_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      this.insertSignalStmt.run(
        genId('dsig'),
        sessionId,
        correlationId,
        signal.checkpointType,
        signal.alignmentScore,
        signal.needsIntervention ? 1 : 0,
        // 15.0 redact 盲区：drift_description / suggested_action 是 LLM 生成的分析文本，可能回显用户原文中的 secret
        signal.driftDescription != null ? redactSecrets(signal.driftDescription) : null,
        signal.suggestedAction != null ? redactSecrets(signal.suggestedAction) : null,
        null,
        anchorId ?? null,
        Date.now(),
      );
    } catch (err) {
      logger.error({ err }, 'recordSignal failed');
    }
  }

  /** 根据阈值评估一个已有的 DriftSignal 并补充 action */
  evaluate(signal: DriftSignal): DriftSignal {
    return applySuggestedAction(signal, this.thresholds);
  }
}
