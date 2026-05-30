import type { LearningSignal } from './types.js';

const SKILL_HINTS = [
  '以后',
  '每次',
  '长期',
  '我喜欢',
  '我希望',
  '偏好',
  '习惯',
  '规则',
  '请记住',
];

const PLUGIN_HINTS = [
  '插件',
  '工具',
  '自动化',
  '一键',
  '批量',
  '定时',
  '集成',
  'workflow',
  'hook',
];

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

function makeSafeTargetName(name: string, kind: LearningSignal['kind']): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  const suffix = kind === 'skill' ? 'skill' : 'plugin';
  if (!cleaned) return kind === 'skill' ? 'generated-skill' : 'generated-plugin';
  return cleaned.endsWith(`-${suffix}`) ? cleaned : `${cleaned}-${suffix}`;
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

function summarizePreference(userMessage: string): string {
  return userMessage.replace(/\s+/g, ' ').trim().slice(0, 240);
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
