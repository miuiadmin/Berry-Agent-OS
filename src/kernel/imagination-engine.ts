import type Database from 'better-sqlite3';
import type { LlmClient } from '../llm/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('imagination');

export interface SimulationInput {
  proposedChange: string;
  changeType: 'prompt_modification' | 'autonomous_action' | 'permission_judgment';
  context?: string;
}

export interface SimulationResult {
  shouldProceed: boolean;
  confidence: number;
  predictedImprovement: number;
  reasoning: string;
  historicalComparison: Array<{
    original: string;
    simulated: string;
    wouldImprove: boolean;
  }>;
}

const SIMULATION_PROMPT = `你是 Brain 的想象力引擎（Imagination Engine）。在执行改动前，你通过回放历史决策来预测改动效果。

## 任务

给定一个「拟议改动」和一组「历史决策」，评估如果当时使用改动后的规则，结果会更好还是更差。

## 输出格式（严格 JSON）

{
  "shouldProceed": true|false,
  "confidence": 0.0-1.0,
  "predictedImprovement": -1.0到1.0 (正=改善，负=恶化，0=无变化),
  "reasoning": "一句话总结判断依据",
  "comparisons": [
    {
      "caseIndex": 0,
      "original": "原始决策结果描述",
      "simulated": "模拟后的决策结果描述",
      "wouldImprove": true|false
    }
  ]
}

## 判断规则

1. **保守原则**: shouldProceed=true 仅当 predictedImprovement > 0.1 且 confidence >= 0.6
2. **样本不足**: 如果历史案例 < 3 个，confidence 不超过 0.5，shouldProceed=false
3. **退化检测**: 如果任何案例明确退化（当前正确→改后错误），shouldProceed=false
4. **无变化=不改**: 如果大多数案例无变化，shouldProceed=false（改动没有价值）
`;

export class ImaginationEngine {
  constructor(
    private readonly llm: LlmClient,
    private readonly db: Database.Database,
  ) {}

  async simulate(input: SimulationInput): Promise<SimulationResult> {
    const historicalCases = this.gatherHistoricalCases(input.changeType);

    if (historicalCases.length < 3) {
      return {
        shouldProceed: false,
        confidence: 0.3,
        predictedImprovement: 0,
        reasoning: '历史案例不足（<3），无法可靠预测',
        historicalComparison: [],
      };
    }

    const userPrompt = this.buildSimulationPrompt(input, historicalCases);

    try {
      const result = await this.llm.chat(
        [{ role: 'user', content: userPrompt }],
        {
          system: SIMULATION_PROMPT,
          maxTokens: 512,
          temperature: 0.1,
          agent: 'brain',
          purpose: 'brain_routing',
          modelTier: 'fast',
          sessionId: 'imagination',
        },
      );

      return this.parseResult(result.content);
    } catch (err) {
      logger.warn({ err }, 'Imagination simulation failed');
      return {
        shouldProceed: false,
        confidence: 0,
        predictedImprovement: 0,
        reasoning: `模拟失败: ${(err as Error).message}`,
        historicalComparison: [],
      };
    }
  }

  async simulatePromptChange(
    promptKey: string,
    currentPrompt: string,
    proposedPrompt: string,
    changeReason: string,
  ): Promise<SimulationResult> {
    return this.simulate({
      proposedChange: `Prompt "${promptKey}" 修改:\n\n原始:\n${currentPrompt.slice(0, 500)}\n\n修改为:\n${proposedPrompt.slice(0, 500)}\n\n原因: ${changeReason}`,
      changeType: 'prompt_modification',
      context: `prompt_key=${promptKey}`,
    });
  }

  async simulateAutonomousAction(
    capability: string,
    input: unknown,
    reason: string,
  ): Promise<SimulationResult> {
    return this.simulate({
      proposedChange: `自主执行 "${capability}" with input=${JSON.stringify(input).slice(0, 200)}\n原因: ${reason}`,
      changeType: 'autonomous_action',
    });
  }

  private gatherHistoricalCases(changeType: SimulationInput['changeType']): Array<Record<string, unknown>> {
    try {
      const decisionTypeMap: Record<string, string[]> = {
        prompt_modification: ['route', 'review'],
        autonomous_action: ['route', 'permission'],
        permission_judgment: ['permission'],
      };

      const types = decisionTypeMap[changeType] ?? ['route'];
      const placeholders = types.map(() => '?').join(',');

      return this.db.prepare(`
        SELECT decision_type, input_summary, output_json, outcome, confidence
        FROM brain_decisions
        WHERE decision_type IN (${placeholders})
          AND outcome IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 20
      `).all(...types) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  private buildSimulationPrompt(
    input: SimulationInput,
    cases: Array<Record<string, unknown>>,
  ): string {
    const caseDescriptions = cases.slice(0, 10).map((c, i) => {
      const output = tryParse(c.output_json as string);
      return `案例 ${i + 1}: [${c.decision_type}] 输入="${(c.input_summary as string).slice(0, 100)}" → 结果=${JSON.stringify(output).slice(0, 150)} outcome=${c.outcome}`;
    }).join('\n');

    return `## 拟议改动

${input.proposedChange}

## 历史决策案例（用这些回放测试改动效果）

${caseDescriptions}

请评估：如果当时使用「拟议改动」中的新规则/新行为，这些历史案例的结果会更好还是更差？`;
  }

  private parseResult(text: string): SimulationResult {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      const parsed = JSON.parse(match[0]);

      const comparisons = Array.isArray(parsed.comparisons)
        ? parsed.comparisons.map((c: any) => ({
            original: String(c.original ?? '').slice(0, 200),
            simulated: String(c.simulated ?? '').slice(0, 200),
            wouldImprove: Boolean(c.wouldImprove),
          }))
        : [];

      return {
        shouldProceed: Boolean(parsed.shouldProceed),
        confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
        predictedImprovement: typeof parsed.predictedImprovement === 'number'
          ? Math.min(1, Math.max(-1, parsed.predictedImprovement))
          : 0,
        reasoning: String(parsed.reasoning ?? '').slice(0, 300),
        historicalComparison: comparisons,
      };
    } catch {
      return {
        shouldProceed: false,
        confidence: 0,
        predictedImprovement: 0,
        reasoning: '无法解析模拟结果',
        historicalComparison: [],
      };
    }
  }
}

function tryParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return json; }
}
