import type { LearningSignal } from './types.js';
import type { LlmClient } from '../llm/index.js';
import { parseLearningSignalsFromText } from './detector-parser.js';
import { genId } from '../utils/id.js';
import type { Database } from 'better-sqlite3';

export interface EvolutionExtractionInput {
  sessionId: string;
  userMessage: string;
  assistantResponse: string;
  toolCalls?: Array<{ name: string; input?: string }>;
}

export interface EvolutionExtractionOutput {
  userFacts: UserFact[];
  decisionFeedback: DecisionFeedback[];
  capabilityGaps: LearningSignal[];
}

export interface UserFact {
  type: 'preference' | 'knowledge' | 'habit' | 'constraint' | 'goal';
  summary: string;
  confidence: number;
}

export interface DecisionFeedback {
  decisionType: 'route' | 'review' | 'permission';
  observation: string;
  sentiment: 'positive' | 'negative' | 'neutral';
}

const EXTRACTION_SYSTEM_PROMPT = `你是一个对话分析引擎。分析用户与助手的对话，从中提取三类信息。

输出严格 JSON 格式（无 markdown 包裹）：
{
  "user_facts": [
    {"type": "preference|knowledge|habit|constraint|goal", "summary": "简明描述", "confidence": 0.0-1.0}
  ],
  "decision_feedback": [
    {"decision_type": "route|review|permission", "observation": "对决策的反馈", "sentiment": "positive|negative|neutral"}
  ],
  "capability_gaps": [
    {"kind": "skill|plugin", "targetName": "kebab-case-name", "description": "简明描述", "observations": ["原因"], "riskLevel": "low|medium|high"}
  ]
}

提取规则：
- user_facts: 用户表达的长期偏好、习惯、知识、约束或目标。只提取明确表达的事实，不推测。
- decision_feedback: 用户对系统行为的反馈（如"不是这个意思"→路由错误，"太啰嗦"→审核反馈）。仅在用户明确表达不满或肯定时记录。
- capability_gaps: 用户需要但系统当前不具备的能力。"skill"用于知识型（如"每次都用这个格式"）；"plugin"用于需要代码执行的能力。

如果某类没有发现，返回空数组。宁可少提取，不可编造。`;

export class UnifiedEvolutionExtractor {
  constructor(
    private readonly llm: LlmClient,
    private readonly db: Database,
  ) {}

  async extract(input: EvolutionExtractionInput): Promise<EvolutionExtractionOutput> {
    const userPrompt = this.buildUserPrompt(input);

    try {
      const result = await this.llm.chat(
        [{ role: 'user', content: userPrompt }],
        {
          system: EXTRACTION_SYSTEM_PROMPT,
          maxTokens: 512,
          temperature: 0.0,
          agent: 'brain',
          purpose: 'evolution_extraction' as any,
          modelTier: 'fast',
        },
      );

      const parsed = this.parseResponse(result.content);
      if (parsed) {
        this.recordBrainDecision(input.sessionId, input.userMessage, parsed);
      }
      return parsed ?? { userFacts: [], decisionFeedback: [], capabilityGaps: [] };
    } catch {
      return { userFacts: [], decisionFeedback: [], capabilityGaps: [] };
    }
  }

  private buildUserPrompt(input: EvolutionExtractionInput): string {
    let prompt = `用户消息: ${input.userMessage.slice(0, 500)}\n助手回复: ${input.assistantResponse.slice(0, 500)}`;
    if (input.toolCalls && input.toolCalls.length > 0) {
      const tools = input.toolCalls.slice(0, 5).map(t => t.name).join(', ');
      prompt += `\n调用工具: ${tools}`;
    }
    return prompt;
  }

  private parseResponse(text: string): EvolutionExtractionOutput | null {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const raw = JSON.parse(jsonMatch[0]);

      const userFacts: UserFact[] = (raw.user_facts ?? [])
        .filter((f: any) => f && f.type && f.summary)
        .map((f: any) => ({
          type: f.type,
          summary: String(f.summary).slice(0, 200),
          confidence: typeof f.confidence === 'number' ? Math.min(1, Math.max(0, f.confidence)) : 0.5,
        }));

      const decisionFeedback: DecisionFeedback[] = (raw.decision_feedback ?? [])
        .filter((d: any) => d && d.decision_type && d.observation)
        .map((d: any) => ({
          decisionType: d.decision_type,
          observation: String(d.observation).slice(0, 200),
          sentiment: d.sentiment ?? 'neutral',
        }));

      const capabilityGaps: LearningSignal[] = parseLearningSignalsFromText(
        JSON.stringify(raw.capability_gaps ?? []),
      );

      return { userFacts, decisionFeedback, capabilityGaps };
    } catch {
      return null;
    }
  }

  private recordBrainDecision(sessionId: string, userMessage: string, output: EvolutionExtractionOutput): void {
    if (output.decisionFeedback.length === 0) return;
    try {
      for (const feedback of output.decisionFeedback) {
        this.db.prepare(`
          INSERT INTO brain_decisions (id, session_id, decision_type, input_summary, output_json, confidence, outcome, feedback_source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          genId('bdec'),
          sessionId,
          feedback.decisionType,
          userMessage.slice(0, 200),
          JSON.stringify(feedback),
          null,
          feedback.sentiment === 'negative' ? 'bad' : feedback.sentiment === 'positive' ? 'good' : 'neutral',
          'evolution_engine',
          Date.now(),
        );
      }
    } catch {
      // table may not exist during migration
    }
  }
}
