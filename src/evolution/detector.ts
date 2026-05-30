import type { LearningSignal } from './types.js';

const SKILL_HINTS = [
  '以后', '每次', '长期', '我喜欢', '我希望', '偏好', '习惯', '规则', '请记住',
];

const PLUGIN_HINTS = [
  '插件', '工具', '自动化', '一键', '批量', '定时', '集成', 'workflow', 'hook',
];

export interface EvolutionExtractionInput {
  userMessage: string;
  assistantResponse: string;
  toolCalls?: Array<{ name: string; input: string; result: string }>;
  sessionId?: string;
}

export interface EvolutionExtractionResult {
  userFacts: UserFact[];
  decisionFeedback: DecisionFeedback[];
  capabilityGaps: LearningSignal[];
}

export interface UserFact {
  type: 'identity' | 'preference' | 'goal' | 'project' | 'habit' | 'constraint' | 'fact';
  summary: string;
  detail?: string;
  confidence: number;
}

export interface DecisionFeedback {
  decisionType: 'route' | 'review' | 'permission' | 'correction';
  observation: string;
  suggestion: string;
  confidence: number;
}

export const EVOLUTION_EXTRACTION_PROMPT = `你是 Berry 智能体系统的进化分析器。分析以下对话轮次，提取三类信息。

## 输出格式（严格 JSON）
\`\`\`json
{
  "user_facts": [
    { "type": "preference|identity|goal|project|habit|constraint|fact", "summary": "简洁描述", "detail": "可选补充", "confidence": 0.0-1.0 }
  ],
  "decision_feedback": [
    { "decision_type": "route|review|permission|correction", "observation": "观察到什么", "suggestion": "建议如何改进", "confidence": 0.0-1.0 }
  ],
  "capability_gaps": [
    { "kind": "skill|plugin", "targetName": "kebab-case-name", "description": "能力描述", "observations": ["证据1"], "riskLevel": "low|medium|high" }
  ]
}
\`\`\`

## 提取规则
1. **user_facts**: 用户明确或隐含表达的长期信息（偏好、身份、习惯、约束）。不记录临时的一次性问题。confidence >= 0.7 才输出。
2. **decision_feedback**: 如果用户纠正了助手行为、对响应不满、或对话出现了 Brain 应该改进的决策模式。confidence >= 0.6 才输出。
3. **capability_gaps**: 当对话暴露了系统缺少的能力时（用户需要某工具/知识但系统没有）。不要对已满足的需求生成 gap。

如果本轮对话是普通闲聊或已圆满解决的简单问题，所有数组可以为空。宁缺毋滥。

## 对话内容
`;

export function buildExtractionMessages(input: EvolutionExtractionInput): string {
  let content = `用户: ${input.userMessage}\n\n助手: ${input.assistantResponse}`;
  if (input.toolCalls?.length) {
    content += '\n\n工具调用:';
    for (const tc of input.toolCalls.slice(0, 5)) {
      content += `\n- ${tc.name}(${tc.input.slice(0, 100)}) → ${tc.result.slice(0, 200)}`;
    }
  }
  return content;
}

export function parseExtractionResult(text: string): EvolutionExtractionResult {
  const result: EvolutionExtractionResult = { userFacts: [], decisionFeedback: [], capabilityGaps: [] };

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return result;
    const parsed = JSON.parse(jsonMatch[0]);

    if (Array.isArray(parsed.user_facts)) {
      result.userFacts = parsed.user_facts
        .filter((f: Record<string, unknown>) =>
          typeof f.type === 'string' && typeof f.summary === 'string' && typeof f.confidence === 'number' && f.confidence >= 0.7)
        .map((f: Record<string, unknown>) => ({
          type: f.type as UserFact['type'],
          summary: (f.summary as string).slice(0, 240),
          detail: typeof f.detail === 'string' ? (f.detail as string).slice(0, 500) : undefined,
          confidence: f.confidence as number,
        }))
        .slice(0, 5);
    }

    if (Array.isArray(parsed.decision_feedback)) {
      result.decisionFeedback = parsed.decision_feedback
        .filter((f: Record<string, unknown>) =>
          typeof f.decision_type === 'string' && typeof f.observation === 'string' && typeof f.confidence === 'number' && f.confidence >= 0.6)
        .map((f: Record<string, unknown>) => ({
          decisionType: f.decision_type as DecisionFeedback['decisionType'],
          observation: (f.observation as string).slice(0, 300),
          suggestion: typeof f.suggestion === 'string' ? (f.suggestion as string).slice(0, 300) : '',
          confidence: f.confidence as number,
        }))
        .slice(0, 3);
    }

    if (Array.isArray(parsed.capability_gaps)) {
      result.capabilityGaps = parsed.capability_gaps
        .filter((g: Record<string, unknown>) =>
          (g.kind === 'skill' || g.kind === 'plugin') && typeof g.targetName === 'string' && typeof g.description === 'string')
        .map((g: Record<string, unknown>) => ({
          kind: g.kind as 'skill' | 'plugin',
          targetName: makeSafeTargetName(g.targetName as string, g.kind as 'skill' | 'plugin'),
          description: (g.description as string).slice(0, 240),
          observations: Array.isArray(g.observations)
            ? (g.observations as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 5)
            : ['LLM 识别的能力缺口。'],
          riskLevel: g.riskLevel === 'low' || g.riskLevel === 'medium' || g.riskLevel === 'high'
            ? g.riskLevel
            : g.kind === 'skill' ? 'low' : 'medium',
        }))
        .slice(0, 3);
    }
  } catch {
    // parse failure → return empty result
  }

  return result;
}

// Legacy compatibility: synchronous keyword-based detection as fallback when LLM extractor is unavailable
export function detectLearningSignals(userMessage: string, assistantResponse: string): LearningSignal[] {
  const text = `${userMessage}\n${assistantResponse}`;
  const normalized = text.toLowerCase();
  const signals: LearningSignal[] = [];

  if (SKILL_HINTS.some((hint) => normalized.includes(hint.toLowerCase()))) {
    signals.push({
      kind: 'skill',
      targetName: makeTargetName(userMessage, 'conversation-preference', 'skill'),
      description: summarizePreference(userMessage),
      observations: [
        '用户表达了可复用的长期偏好或工作方式。',
        '该能力适合沉淀为 SKILL.md 指令，不需要可执行插件。',
      ],
      riskLevel: 'low',
    });
  }

  if (PLUGIN_HINTS.some((hint) => normalized.includes(hint.toLowerCase()))) {
    signals.push({
      kind: 'plugin',
      targetName: makeTargetName(userMessage, 'generated-tool', 'plugin'),
      description: summarizePreference(userMessage),
      observations: [
        '用户提到了工具、插件或自动化能力。',
        '该需求可能需要独立插件包承载可执行扩展。',
      ],
      riskLevel: normalized.includes('删除') || normalized.includes('执行命令') || normalized.includes('shell') ? 'high' : 'medium',
    });
  }

  return dedupeSignals(signals);
}

function summarizePreference(userMessage: string): string {
  return userMessage.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function makeTargetName(text: string, fallback: string, suffix: string): string {
  const asciiWords = text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2 && !['the', 'and', 'with'].includes(word))
    .slice(0, 4);
  if (asciiWords && asciiWords.length > 0) {
    return `${asciiWords.join('-').slice(0, 48)}-${suffix}`;
  }

  const keywords = [
    ['自进化', 'self-evolution'],
    ['测试', 'test'],
    ['报告', 'report'],
    ['证据', 'evidence'],
    ['插件', 'plugin'],
    ['工具', 'tool'],
    ['自动化', 'automation'],
    ['记忆', 'memory'],
    ['中文', 'chinese'],
  ] as const;
  const parts = keywords
    .filter(([keyword]) => text.includes(keyword))
    .map(([, slug]) => slug);
  if (parts.length > 0) return `${[...new Set(parts)].slice(0, 4).join('-')}-${suffix}`;
  return `${fallback}-${suffix}`;
}

function dedupeSignals(signals: LearningSignal[]): LearningSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}:${signal.targetName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseLearningSignalsFromText(text: string): LearningSignal[] {
  const parsed = parseJsonArray(text);
  if (!parsed) return [];
  return parsed
    .map((item): LearningSignal | null => {
      if (item.kind !== 'skill' && item.kind !== 'plugin') return null;
      if (typeof item.targetName !== 'string' || !item.targetName) return null;
      if (typeof item.description !== 'string' || !item.description) return null;
      const riskLevel = item.riskLevel === 'low' || item.riskLevel === 'medium' || item.riskLevel === 'high'
        ? item.riskLevel
        : item.kind === 'skill' ? 'low' : 'medium';
      return {
        kind: item.kind,
        targetName: makeSafeTargetName(item.targetName, item.kind),
        description: item.description.slice(0, 240),
        observations: Array.isArray(item.observations)
          ? item.observations.filter((value): value is string => typeof value === 'string').slice(0, 5)
          : ['LLM 提出自进化信号。'],
        riskLevel,
      };
    })
    .filter((signal): signal is LearningSignal => Boolean(signal));
}

function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function makeSafeTargetName(name: string, kind: 'skill' | 'plugin'): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9一-龥_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  const suffix = kind === 'skill' ? 'skill' : 'plugin';
  if (!cleaned) return kind === 'skill' ? 'generated-skill' : 'generated-plugin';
  return cleaned.endsWith(`-${suffix}`) ? cleaned : `${cleaned}-${suffix}`;
}
